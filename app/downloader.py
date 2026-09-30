"""下载引擎：并发控制、代理支持、断点续传、大小上限过滤、进度回写。

设计要点：
- 用线程池执行下载，按设置里 concurrent 控制并发。
- 每个下载支持 http/https/socks5 代理（来自 settings.proxy_url）。
- 分块写入并实时更新 tasks 表的 progress（0~100）。
- 两个来源站点都直接给出 mp4 直链，因此无需外部解析器。
"""
import os
import re
import time
import shutil
import subprocess
import threading
import hashlib
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
import requests
from . import db
from . import config
from . import errors

_manager = None
CANCELLED = set()  # task id 集合，标记需取消

# ---- 代理熔断（circuit breaker）----
# 背景：代理一旦挂掉，排队中的几百个任务会在几分钟内被逐个打成「失败」，
# 白白消耗掉。这里做全局熔断：连续 N 次代理连接失败 → 全体暂停一段时间，
# 任务保持「等待重试」而不是失败；代理恢复后自动继续（并断点续传）。
PROXY_FAIL_TRIP = 2        # 连续多少次代理连接失败就熔断
PROXY_PAUSE_SEC = 120      # 熔断后暂停多久(秒)
PROXY_ERR_GIVEUP = 40      # 单任务累计代理错误达此数仍不通 → 放弃并标记失败
_LOCK = threading.Lock()
_PROXY_FAIL = 0
_PROXY_PAUSE_UNTIL = 0.0
_TASK_PROXY_ERR = set()    # 本次异常被判定为「代理连接失败」的任务 id


def _is_conn_error(e):
    """是否为连接阶段的错误（区分于传输中途断开）。"""
    if isinstance(e, (requests.exceptions.ConnectionError,
                      requests.exceptions.Timeout)):
        return True
    return type(e).__name__ in ("ProxyError", "ConnectTimeout", "ReadTimeout",
                                "ConnectionError", "Timeout")


def _note_proxy_failure(tid):
    """记录一次代理连接失败（仅在确实配置了代理时调用）。"""
    global _PROXY_FAIL, _PROXY_PAUSE_UNTIL
    with _LOCK:
        _PROXY_FAIL += 1
        if _PROXY_FAIL >= PROXY_FAIL_TRIP:
            _PROXY_PAUSE_UNTIL = time.time() + PROXY_PAUSE_SEC
            _PROXY_FAIL = 0
            print("[proxy] 连续代理失败，熔断暂停 %d 秒" % PROXY_PAUSE_SEC)
    _TASK_PROXY_ERR.add(tid)


def _note_proxy_success():
    global _PROXY_FAIL, _PROXY_PAUSE_UNTIL
    with _LOCK:
        _PROXY_FAIL = 0
        _PROXY_PAUSE_UNTIL = 0.0


def clear_proxy_breaker():
    """手动解除熔断（例如用户把代理总开关关掉、或换了新代理地址时）。"""
    _note_proxy_success()
    _TASK_PROXY_ERR.clear()


def _take_proxy_error(tid):
    """取出并清除该任务的「代理错误」标记。"""
    if tid in _TASK_PROXY_ERR:
        _TASK_PROXY_ERR.discard(tid)
        return True
    return False


def proxy_pause_remaining():
    """距离熔断结束还剩多少秒；0 表示未熔断。"""
    with _LOCK:
        return max(0.0, _PROXY_PAUSE_UNTIL - time.time())


def proxy_status():
    en = bool(db.get_settings().get("proxy_enabled", True))
    # 开关关掉后不该再显示「熔断暂停」：此时根本没有走代理，暂停也没有意义
    if not en:
        return {"paused": False, "remaining": 0, "enabled": False,
                "fails": _PROXY_FAIL, "message": "代理开关已关闭，当前直连"}
    left = proxy_pause_remaining()
    return {"paused": left > 0, "remaining": int(left),
            "enabled": True, "fails": _PROXY_FAIL,
            "message": ("代理不可用，已自动暂停，%d 秒后重试" % int(left)) if left > 0
                       else ("代理正常" if config.get_proxy_dict() else "代理已开启但未填地址")}


def test_proxy():
    """服务端自检：用当前代理真连一次，并与直连对比，结果全中文。"""
    proxies = config.get_proxy_dict()
    s = db.get_settings()
    enabled = bool(s.get("proxy_enabled", True))
    url = (s.get("proxy_url") or "").strip()
    target = "https://twixive.net/"
    out = {"configured": bool(proxies), "enabled": enabled, "proxy": url,
           "target": target, "ok": False, "ms": 0, "message": "", "direct": None}

    def probe(p):
        t0 = time.time()
        try:
            r = requests.get(target, proxies=p, timeout=(8, 15),
                             headers={"User-Agent": "Mozilla/5.0"})
            return {"ok": True, "status": r.status_code,
                    "ms": int((time.time() - t0) * 1000)}
        except Exception as e:  # noqa
            return {"ok": False, "ms": int((time.time() - t0) * 1000),
                    "error": errors.to_chinese(str(e))}

    if proxies:
        r = probe(proxies)
        out["ms"], out["ok"] = r["ms"], r["ok"]
        out["message"] = ("代理可用：%s 返回 %s，耗时 %d ms"
                          % (url, r.get("status"), r["ms"])) if r["ok"] \
            else ("代理不可用：%s（%s）" % (r.get("error"), url))
        # 代理可用即解除熔断
        if r["ok"]:
            _note_proxy_success()
    else:
        r = probe(None)
        out["ms"], out["ok"] = r["ms"], r["ok"]
        if not enabled:
            out["message"] = ("代理总开关已关闭，当前走直连（直连%s，耗时 %d ms）"
                              % ("可用" if r["ok"] else "失败", r["ms"]))
        else:
            out["message"] = ("未配置代理，直连可用（耗时 %d ms）" % r["ms"]) if r["ok"] \
                else ("未配置代理，且直连失败：%s" % r.get("error"))

    # 直连对照组，便于判断"是代理的问题还是网络的问题"
    d = probe(None)
    out["direct"] = {"ok": d["ok"], "ms": d["ms"],
                     "error": d.get("error", "")}
    return out

# ---- 实时下载速度（供面板悬浮窗显示）----
# _SPEED[tid] = [上次采样时刻, 上次已下字节]
# _SPEED_EMA[tid] = 指数平滑后的瞬时速度(B/s)
# _SPEED_TS[tid]  = 最后采样时刻（超过 8s 未更新视为停滞，速度归零）
_SPEED = {}
_SPEED_EMA = {}
_SPEED_TS = {}
_SPEED_WINDOW = 0.4   # 采样窗口(秒)
_SPEED_STALE = 8.0    # 超过该时长无新数据则认为停滞


def _tick_speed(tid, done):
    """每写入一块调用一次：以 ≥0.4s 的窗口算瞬时速度，再做指数平滑。"""
    now = time.time()
    _SPEED_TS[tid] = now
    st = _SPEED.get(tid)
    if st is None:
        _SPEED[tid] = [now, done]
        return
    last_t, last_b = st
    dt = now - last_t
    if dt >= _SPEED_WINDOW:
        inst = (done - last_b) / dt
        # 过滤异常值（续传回退、上限截断等）
        if 0 <= inst < 200 * 1024 * 1024:
            old = _SPEED_EMA.get(tid)
            _SPEED_EMA[tid] = inst if old is None else (0.55 * old + 0.45 * inst)
        _SPEED[tid] = [now, done]


def get_speed(tid):
    """返回该任务的实时速度(B/s)；停滞/未知则返回 0。"""
    ts = _SPEED_TS.get(tid, 0)
    if not ts or (time.time() - ts) > _SPEED_STALE:
        return 0
    return int(_SPEED_EMA.get(tid) or 0)


def clear_speed(tid):
    _SPEED.pop(tid, None)
    _SPEED_EMA.pop(tid, None)
    _SPEED_TS.pop(tid, None)


def cancel(tid):
    CANCELLED.add(tid)


def slugify(text):
    text = (text or "video").strip()
    text = re.sub(r'[\\/:*?"<>|]+', "_", text)
    text = re.sub(r'\s+', "_", text)
    return text[:80] or "video"


def url_uid(url):
    """由链接（去掉查询参数）派生短标识。

    作用：同一作者（标题=用户名）会有多个视频，若只用标题命名会撞名，
    导致带着上一个视频的半成品去续传 → 服务端返回 416。加上 uid 可彻底避免。
    """
    base = (url or "").split("?")[0]
    return hashlib.md5(base.encode("utf-8")).hexdigest()[:8]


def sanitize_filename(title, category, ext="mp4", uid=""):
    cat = slugify(category)
    name = slugify(title)
    if uid:
        name = "%s_%s" % (name, uid)
    base = f"{cat}/{name}" if cat else name
    return f"{base}.{ext}"


class DownloadManager:
    def __init__(self):
        self.executor = None
        self._rebuild()

    def _rebuild(self):
        s = db.get_settings()
        n = max(1, int(s.get("concurrent") or 1))
        if self.executor is None or self.executor._max_workers != n:
            if self.executor:
                self.executor.shutdown(wait=False)
            self.executor = ThreadPoolExecutor(max_workers=n)

    def enqueue(self, tid):
        # 排队期间就置为「等待中」并清掉上一次的报错文案：
        # 否则还没轮到线程的任务会一直显示重启前残留的「第 N 次失败…」
        try:
            t = db.get_task(tid)
            if t and t["status"] != "done":
                db.update_task(tid, status="pending", error="")
        except Exception:
            pass
        self._rebuild()
        self.executor.submit(self._run, tid)

    # ---- 核心下载 ----
    def _run(self, tid):
        """执行一次任务：失败按设置自动重试 N 次（配合断点续传从已下部分继续）。"""
        task = db.get_task(tid)
        if not task or tid in CANCELLED:
            if task:
                db.update_task(tid, status="cancelled")
            CANCELLED.discard(tid)
            return
        s = db.get_settings()
        # 常规尝试次数（设置里的「失败自动重试次数」+ 首次）
        base_attempts = max(0, int(s.get("retry_times") or 0)) + 1
        # 大文件在弱网下往往要靠续传一点点推进：只要每次都有新进展就再给机会
        resume_extra_limit = 8
        extra_used = 0
        last_done = -1
        tries = 0
        proxy_errs = 0
        db.update_task(tid, status="downloading", progress=0.0, error="")
        url = task["url"]
        category = task.get("category") or ""
        last = None
        try:
            while True:
                if tid in CANCELLED:
                    CANCELLED.discard(tid)
                    db.update_task(tid, status="cancelled")
                    return
                # 代理熔断：代理连续不可用时全体暂停，任务保持等待而不是被判失败
                pause = proxy_pause_remaining()
                if pause > 0:
                    db.update_task(
                        tid, status="downloading",
                        error="代理不可用，已自动暂停，%d 秒后重试" % int(pause))
                    time.sleep(min(pause, 5))
                    continue
                try:
                    self._download_direct(tid, url, category)
                    # 被大小上限跳过 / 已取消 / 已完成 → 不再重试
                    t = db.get_task(tid)
                    if t and t["status"] in ("skipped", "cancelled", "done"):
                        return
                    # 成功时清空 error：否则重试过程中写的「第 N 次失败…」会残留，
                    # 让已完成的任务看起来像是失败了
                    db.update_task(tid, status="done", progress=100.0, error="")
                    return
                except Exception as e:  # noqa
                    last = e
                    # 代理连接失败：不计入正常重试次数，退避后等代理恢复
                    if _take_proxy_error(tid):
                        proxy_errs += 1
                        if proxy_errs > PROXY_ERR_GIVEUP:
                            db.update_task(
                                tid, status="error",
                                error="代理长时间不可用，已放弃（%s）"
                                      % ((db.get_settings().get("proxy_url") or "未配置")))
                            return
                        db.update_task(
                            tid, status="downloading",
                            error="代理连接失败（第 %d 次），正在等待恢复" % proxy_errs)
                        time.sleep(min(10, 3 * proxy_errs))
                        continue
                    tries += 1  # 只有非代理错误才消耗重试次数
                    done_now = 0
                    t = db.get_task(tid)
                    if t:
                        done_now = int(t.get("size") or 0)
                    # 本次比上次多下了一点 → 说明续传在起作用，值得再来一次
                    advanced = done_now > last_done + 4096
                    last_done = max(last_done, done_now)
                    if tries < base_attempts:
                        db.update_task(
                            tid, status="downloading",
                            error="第 %d 次失败，准备重试（还剩 %d 次）"
                                  % (tries, base_attempts - tries))
                        time.sleep(min(5 * tries, 15))
                        continue
                    if advanced and extra_used < resume_extra_limit:
                        extra_used += 1
                        db.update_task(
                            tid, status="downloading",
                            error="下载中断，已下 %.1f MB，正在断点续传（第 %d 次）"
                                  % (done_now / 1048576.0, extra_used))
                        time.sleep(2)
                        continue
                    break
            # 报错翻译成中文后再落库，面板直接展示人话
            db.update_task(tid, status="error", error=errors.to_chinese(str(last)))
        finally:
            # 任务结束（成功/失败/取消/跳过）后不再计入实时速度
            clear_speed(tid)
            _TASK_PROXY_ERR.discard(tid)

    def _download_direct(self, tid, url, category):
        """直链下载：支持断点续传 + 单文件大小上限过滤。"""
        s = db.get_settings()
        proxies = config.get_proxy_dict()
        sess = config.build_session()
        max_mb = float(s.get("max_size_mb") or 0)
        max_bytes = int(max_mb * 1024 * 1024) if max_mb > 0 else 0

        title = task_title(tid)
        # uid 并入文件名：避免同一作者的多个视频撞名（否则续传偏移对不上 → 416）
        uid = url_uid(url)
        # 先用 URL 后缀猜扩展名，提前确定落盘路径（这样才能断点续传）
        guessed = self._ext_from_url(url)
        rel = sanitize_filename(title, category, guessed, uid)
        full = os.path.join(s["download_path"], rel)
        os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
        # 提前把落盘路径写库：这样下载中途取消/删除任务时也能定位并清掉半成品文件
        db.update_task(tid, path=rel)

        # 断点续传：已存在的半成品文件作为起点
        resume = os.path.getsize(full) if os.path.exists(full) else 0
        headers = {"Range": "bytes=%d-" % resume} if resume else {}

        def _get(hdr=None):
            """发起请求；连接阶段失败且配置了代理 → 记为代理失败（供熔断判断）。"""
            try:
                return sess.get(url, stream=True, proxies=proxies,
                                timeout=(15, 120), headers=hdr or {})
            except Exception as e:  # noqa
                if proxies and _is_conn_error(e):
                    _note_proxy_failure(tid)
                raise

        resp = _get(headers)
        if resume and resp.status_code == 416:
            # 断点无效（残留文件与当前链接不匹配），丢弃半成品从头下载
            resp.close()
            try:
                os.remove(full)
            except Exception:
                pass
            resume = 0
            resp = _get()
        # 能拿到响应头说明链路是通的，解除熔断计数
        _note_proxy_success()

        with resp as r:
            resumed = bool(resume and r.status_code == 206)
            if resume and not resumed:
                resume = 0  # 服务端忽略 Range，从头重下
            r.raise_for_status()
            real_ext = self._ext_from_response(r, url)
            length = int(r.headers.get("Content-Length", 0) or 0)
            if resumed:
                # Content-Range: bytes <start>-<end>/<total>
                m = re.search(r"/(\d+)\s*$", (r.headers.get("Content-Range", "") or "").strip())
                total = int(m.group(1)) if m else (resume + length)
            else:
                total = length

            # 大小上限：已知总大小时提前放弃
            if max_bytes and total and total > max_bytes:
                self._give_up_size(tid, full, total, max_mb)
                return

            done = resume
            with open(full, "ab" if resumed else "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 256):
                    if tid in CANCELLED:
                        CANCELLED.discard(tid)
                        db.update_task(tid, status="cancelled")
                        return
                    if not chunk:
                        continue
                    f.write(chunk)
                    done += len(chunk)
                    _tick_speed(tid, done)  # 实时速度采样
                    if max_bytes and done > max_bytes:
                        break  # 超过上限，放弃本次
                    if total:
                        db.update_task(tid, progress=round(done / total * 100, 1),
                                       size=done)
                    else:
                        db.update_task(tid, size=done)

            # 下载中才发现超限（服务端未提供总大小）
            if max_bytes and done > max_bytes:
                self._give_up_size(tid, full, done, max_mb)
                return

            # 扩展名与猜测不同且是全新写入时，重命名到正确扩展名
            if real_ext != guessed and not resumed:
                rel2 = sanitize_filename(title, category, real_ext, uid)
                full2 = os.path.join(s["download_path"], rel2)
                try:
                    os.makedirs(os.path.dirname(full2) or ".", exist_ok=True)
                    os.replace(full, full2)
                    rel = rel2
                except Exception:
                    pass
            # 时长上限：来源不提供时长，只能下完再探。超过则删文件、标记跳过。
            # 注意：仍会先把整段下完（与大小上限的「下到一半放弃」不同），
            # 因为时长要读完文件才能确定；设为 0 则不限制。
            max_min = float(s.get("max_duration_min") or 0)
            if max_min > 0:
                dur = _video_duration(full)
                if dur and dur > max_min * 60:
                    self._give_up_duration(tid, full, dur, max_min)
                    return
            db.update_task(tid, path=rel, size=done, progress=100.0)

    def _give_up_duration(self, tid, full, actual_sec, max_min):
        """超过时长上限：删掉已下文件并标记为「已跳过」，不保留也不重试。"""
        try:
            if os.path.exists(full):
                os.remove(full)
        except Exception:
            pass
        db.update_task(tid, status="skipped",
                       error="超过时长上限：%.1f 分钟 > 设置上限 %d 分钟，已跳过"
                             % (actual_sec / 60.0, int(max_min)))

    def _give_up_size(self, tid, full, actual, max_mb):
        """超过大小上限：删除半成品并标记为「已跳过」。"""
        try:
            if os.path.exists(full):
                os.remove(full)
        except Exception:
            pass
        db.update_task(tid, status="skipped",
                       error="超过大小上限：%.1f MB > 设置上限 %.0f MB，已跳过"
                             % (actual / 1048576.0, max_mb))

    def _ext_from_url(self, url):
        """从 URL 后缀猜扩展名（用于提前确定落盘路径以支持续传）。"""
        p = urllib.parse.urlparse(url)
        ext = os.path.splitext(p.path)[1]
        return ext.lstrip(".").lower() or "mp4"

    def _ext_from_response(self, resp, url):
        cd = resp.headers.get("Content-Disposition", "")
        m = re.search(r'filename\*?=(?:UTF-8\'\')?["\']?([^"\';]+)', cd, re.I)
        if m:
            ext = os.path.splitext(m.group(1))[1]
            if ext:
                return ext.lstrip(".").lower()
        p = urllib.parse.urlparse(url)
        ext = os.path.splitext(p.path)[1]
        if ext:
            return ext.lstrip(".").lower()
        ctype = resp.headers.get("Content-Type", "")
        return {"video/mp4": "mp4", "video/webm": "webm", "video/x-matroska": "mkv",
                "video/quicktime": "mov"}.get(ctype.lower(), "mp4")


# ---- 视频时长探测（用于「时长上限」过滤）----
# 来源站点不提供时长，只能等文件下完再读。优先 ffprobe（覆盖全格式），
# NAS 没装 ffmpeg 时退化到纯 Python 解析 MP4/m4v/mov 的 mvhd 盒（零依赖、不读媒体数据）。
def _mp4_duration(path):
    """从 MP4 家族文件的 mvhd 盒读取时长(秒)，失败/未知返回 0.0。

    只 seek 读盒头结构、跳过媒体数据，大文件也不占内存。mvhd 可能有 v0/v1
    两种布局，timescale 与 duration 偏移不同，这里都处理。
    """
    try:
        total = os.path.getsize(path)
    except Exception:
        return 0.0
    try:
        f = open(path, "rb")
    except Exception:
        return 0.0
    try:
        def walk(target, start, end):
            pos = start
            while pos + 8 <= end:
                f.seek(pos)
                h = f.read(8)
                if len(h) < 8:
                    return None
                size = int.from_bytes(h[:4], "big")
                typ = h[4:8]
                if size == 0:
                    break
                content = pos + 8
                if size == 1:                  # 64 位 largesize：再读 8 字节
                    ext = f.read(8)
                    if len(ext) < 8:
                        return None
                    size = int.from_bytes(ext, "big")
                    content = pos + 16
                if typ == target:
                    return content, size
                # moov 是容器盒，mvhd 直接挂在它下面，递归一层即可
                if typ == b"moov" and content < end:
                    res = walk(target, content, min(pos + size, total))
                    if res:
                        return res
                pos = pos + size
            return None

        res = walk(b"moov", 0, total)
        if not res:
            return 0.0
        mvhd_cs, mvhd_size = walk(b"mvhd", res[0], res[0] + res[1])
        if not mvhd_cs:
            return 0.0
        f.seek(mvhd_cs)
        data = f.read(min(mvhd_size, 64))
    except Exception:
        return 0.0
    finally:
        f.close()
    if len(data) < 20:
        return 0.0
    version = data[0]
    try:
        if version == 1:
            timescale = int.from_bytes(data[20:24], "big")
            duration = int.from_bytes(data[24:32], "big")
        else:
            timescale = int.from_bytes(data[12:16], "big")
            duration = int.from_bytes(data[16:20], "big")
    except Exception:
        return 0.0
    if timescale and duration:
        return duration / timescale
    return 0.0


def _video_duration(path):
    """读取视频时长(秒)。优先 ffprobe，否则用 MP4 解析；未知返回 0.0（绝不误删）。"""
    fp = shutil.which("ffprobe")
    if fp:
        try:
            out = subprocess.run(
                [fp, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nokey=1:noprint_wrappers=1", path],
                capture_output=True, text=True, timeout=30)
            d = float(out.stdout.strip())
            if d > 0:
                return d
        except Exception:
            pass
    return _mp4_duration(path)


def task_title(tid):
    t = db.get_task(tid)
    return t["title"] if t else tid


def manager():
    global _manager
    if _manager is None:
        _manager = DownloadManager()
    return _manager

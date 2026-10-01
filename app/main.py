"""FastAPI 主服务：静态面板 + REST 接口。

接口一览（前缀 /api）：
  GET  /                            面板首页
  GET  /api/settings               读取设置
  POST /api/settings               更新设置（含代理、并发、限速、重试、大小上限等）
  GET  /api/sources                已注册来源适配器列表
  GET  /api/categories             拉取分类（与本地监控状态合并）
  GET  /api/monitors               全部监控中的分类（**跨来源**，控制台用）
  POST /api/categories/monitor     开启/关闭某分类的监控（自动下载新内容）
  POST /api/fetch                  拉取某分类的视频列表 {category, page, limit}
  POST /api/download/selected      批量入队 {items:[{title,url,category,thumbnail}]}
  GET  /api/tasks                  任务列表（轮询进度）
  GET  /api/storage                磁盘占用统计（下载目录总大小 + 剩余空间）
  POST /api/tasks/{id}/cancel      取消
  POST /api/tasks/{id}/retry       重试单条
  POST /api/tasks/retry_failed     一键重试全部失败
  DELETE /api/tasks/{id}?purge=1   删除（purge=1 时连带文件移入回收站）
  POST /api/tasks/clear?purge=1    清除已完成/失败/已跳过（purge=1 文件移入回收站）
  GET  /api/recycle                回收站列表
  POST /api/recycle/restore        恢复 {id}（移回原目录）
  DELETE /api/recycle/{id}         彻底删除某条
  POST /api/recycle/empty          清空回收站
  POST /api/auto/run               立即执行一次巡检
  GET  /api/proxy/status           代理熔断状态（是否暂停、剩余秒数）
  POST /api/proxy/test             服务端自检代理连通性（含直连对照）
  GET  /api/library                视频库列表（扫盘 + 任务信息 + 收藏合并）
  GET  /api/media/stream           视频流（支持 Range，可拖动进度）
  POST /api/media/meta             写收藏 / 播放进度
  DELETE /api/media?path=          删除视频文件（连带任务记录与收藏）
"""
import os
import random
import shutil
import time
import uuid
import hashlib
from datetime import datetime, timezone
from fastapi import FastAPI, Request, Body
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from . import db
from . import downloader
from . import scheduler
from . import errors
from .sources import get_adapter, REGISTRY

BASE = os.path.dirname(__file__)
RECYCLE_DIR = os.path.join(db.DATA_DIR, ".recycle")   # 回收站目录（与下载同卷，rename 瞬时）
STATIC = os.path.join(BASE, "static")

app = FastAPI(title="TwiXive Panel")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def no_cache_middleware(request: Request, call_next):
    """禁止浏览器/代理缓存任何响应，避免旧页面残留。

    视频流除外：拖进度条会产生大量 Range 请求，禁缓存会让播放器每次重下已经
    缓冲过的片段，拖动明显发卡。视频内容按文件路径寻址且不会被改写，可以放手
    让浏览器缓存。
    """
    resp = await call_next(request)
    if request.url.path.startswith("/api/media/stream"):
        resp.headers["Cache-Control"] = "private, max-age=86400"
        return resp
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


def _resume_unfinished():
    """容器/进程重启后，把未完成的任务重新入队。

    下载线程不会随容器存活，若不重新入队，重启前排队（pending）或正在下载
    （downloading）的任务会一直卡着不动。已下过的部分仍在磁盘上，重新入队后
    会自动断点续传，不会从头重下。
    """
    try:
        n = 0
        for t in db.list_tasks(2000):
            if t["status"] in ("pending", "downloading"):
                downloader.manager().enqueue(t["id"])
                n += 1
        if n:
            print("[startup] 已重新入队未完成任务: %d" % n)
    except Exception as e:  # noqa
        print("[startup] resume tasks error:", e)


@app.on_event("startup")
def _startup():
    db.init()
    _resume_unfinished()
    scheduler.start()


# ---- 分类名 → 中文名/分组/所属来源 的全局映射 ----
# 控制台要展示**全部**监控中的分类，而分类名分散在不同来源适配器里
# （twixive 用 /new、/ranking/24h…，twivideo 用 ranking_24h…）。
# 适配器的 fetch_categories 都是本地静态列表（不发网络请求），所以直接遍历
# 所有来源建一张表，加个 TTL 缓存即可。
_LABEL_CACHE = {"t": 0.0, "map": {}}
_LABEL_TTL = 120


def _cat_label_map():
    now = time.time()
    if _LABEL_CACHE["map"] and now - _LABEL_CACHE["t"] < _LABEL_TTL:
        return _LABEL_CACHE["map"]
    m = {}
    for key in REGISTRY:
        try:
            for c in REGISTRY[key]().fetch_categories():
                m.setdefault(c["name"], {"label": c.get("label") or c["name"],
                                         "group": c.get("group", ""), "source": key})
        except Exception:
            continue
    _LABEL_CACHE.update(t=now, map=m)
    return m


# ---- 磁盘占用统计 ----
_STORAGE = {"t": 0.0, "data": None}
_STORAGE_TTL = 30


def _dir_stats(path):
    """递归统计目录内的文件数与总字节数。"""
    total, files = 0, 0
    for root, _dirs, names in os.walk(path):
        for n in names:
            try:
                total += os.stat(os.path.join(root, n)).st_size
                files += 1
            except Exception:
                continue
    return total, files


def _safe_remove(rel_path, root):
    """删除下载目录内的单个文件：先**移入回收站**（软删除），返回其字节数。

    安全约束：只处理 root 之内的**普通文件**。相对路径可能来自库里被改脏的
    记录（含 ../），一律先 realpath 再做前缀校验，越界直接跳过。
    移入回收站而非真删，误删可在「回收站」里一键恢复。
    """
    if not rel_path or not root:
        return 0
    root_r = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root_r, rel_path))
    if full == root_r or not full.startswith(root_r + os.sep):
        return 0
    if not os.path.isfile(full):
        return 0
    try:
        size = os.path.getsize(full)
        os.makedirs(RECYCLE_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = os.path.basename(full)
        dest = os.path.join(RECYCLE_DIR, f"{stamp}_{base}")
        # 同秒多次删除可能重名，加短随机后缀兜底，绝不覆盖已有文件
        while os.path.exists(dest):
            dest = os.path.join(RECYCLE_DIR, f"{stamp}_{uuid.uuid4().hex[:6]}_{base}")
        os.rename(full, dest)                      # 同卷内 rename 瞬时完成
        db.add_recycle(rel_path, dest, base, size, os.path.dirname(full))
    except Exception as e:
        print("[recycle] move to recycle bin failed:", e)
        return 0
    # 顺手清理因此变空的分类目录（非空会抛异常，正好跳过）
    d = os.path.dirname(full)
    while d and len(d) > len(root_r) and d.startswith(root_r):
        try:
            os.rmdir(d)
        except Exception:
            break
        d = os.path.dirname(d)
    return size


# ---- 视频库：扫盘 ----
VIDEO_EXT = (".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".ts", ".flv")
_LIB = {"t": 0.0, "files": None}
_LIB_TTL = 20


def _safe_full(rel_path, root=None):
    """把库里/前端传来的相对路径解析成下载目录内的绝对路径。

    越界（含 ../、绝对路径、指向目录外）一律返回 None —— 这条路径既用于
    播放也用于删除，必须挡死。
    """
    if not rel_path:
        return None
    root = root or db.get_settings().get("download_path") or ""
    if not root:
        return None
    root_r = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root_r, rel_path))
    if full == root_r or not full.startswith(root_r + os.sep):
        return None
    return full


def _scan_media():
    """递归扫下载目录，返回 {相对路径: (大小, 修改时间)}。

    以文件为准而不是以任务记录为准：库里存在没有任务记录的视频文件，反过来
    也有任务记录已删但文件还在的情况。视频库要展示的是「磁盘上真实有什么」。
    """
    root = db.get_settings().get("download_path") or ""
    out = {}
    if not root or not os.path.isdir(root):
        return out
    for base, _dirs, names in os.walk(root):
        for n in names:
            if not n.lower().endswith(VIDEO_EXT):
                continue
            full = os.path.join(base, n)
            try:
                st = os.stat(full)
            except Exception:
                continue
            out[os.path.relpath(full, root)] = (st.st_size, st.st_mtime)
    return out


def _lib_files():
    now = time.time()
    if _LIB["files"] is None or (now - _LIB["t"]) > _LIB_TTL:
        _LIB.update(t=now, files=_scan_media())
    return _LIB["files"]


def _cat_display(name):
    """分类名 → 中文显示名。

    任务记录里的分类名形如 `/new`，而磁盘目录是 sanitize 后的 `_new`；对没有
    任务记录的孤儿文件，目录名反查一次中文名，查不到就原样显示。
    """
    if not name:
        return "未分类"
    lm = _cat_label_map()
    for cand in (name, "/" + name.lstrip("_"), name.lstrip("/")):
        info = lm.get(cand)
        if info:
            return info.get("label") or cand
    return name


@app.get("/", response_class=HTMLResponse)
def index():
    with open(os.path.join(STATIC, "index.html"), encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/api/settings")
def get_settings():
    return db.get_settings()


@app.post("/api/settings")
async def post_settings(req: Request):
    patch = await req.json()
    out = db.set_settings(patch)
    # 代理开关关闭 / 换了代理地址 → 顺手解除熔断，否则会白等最长 2 分钟
    if "proxy_enabled" in patch or "proxy_url" in patch:
        if not out.get("proxy_enabled", True) or "proxy_url" in patch:
            downloader.clear_proxy_breaker()
    scheduler.reload()
    downloader.manager()._rebuild()
    return out


@app.get("/api/sources")
def sources():
    return [{"key": k, "name": REGISTRY[k]().name} for k in REGISTRY]


@app.get("/api/categories")
def categories():
    try:
        adapter = get_adapter()
        remote = adapter.fetch_categories()
    except Exception as e:
        remote = []
        print("[categories] fetch error:", e)
    # 同名可能有多条历史重复行（已启动去重，这里再兜一层）：只要有一条开着监控就算开着
    local = {}
    for c in db.list_categories():
        e = local.setdefault(c["name"], {"enabled": True, "monitored": False})
        e["monitored"] = e["monitored"] or bool(c.get("monitored"))
    merged = []
    for c in remote:
        loc = local.get(c["name"], {})
        merged.append({
            "name": c["name"],
            "label": c.get("label") or c["name"],
            "group": c.get("group", ""),
            "enabled": loc.get("enabled", True),
            "monitored": loc.get("monitored", False),
        })
    # 写入（保留中文 label / 分组 / 监控标记），丢弃历史脏分类
    db.upsert_categories([{"name": m["name"], "enabled": m["enabled"],
                           "monitored": m["monitored"]} for m in merged])
    return merged


@app.post("/api/categories/monitor")
async def monitor_category(req: Request):
    """开关某分类的监控。按名称操作，不依赖 id。"""
    body = await req.json()
    name = (body.get("name") or "").strip()
    if not name:
        return db.list_categories()
    return db.set_monitored_by_name(name, bool(body.get("monitored", False)))


@app.get("/api/monitors")
def monitors():
    """全部监控中的分类（跨来源），附中文名 / 分组 / 所属来源。

    之前控制台只显示「当前来源」的分类，切到 twixive 时 twivideo 里监控着的
    ranking_24h/3d/week 就全都不见了 —— 这就是「监控显示不全」的根因。
    """
    lm = _cat_label_map()
    out = []
    for c in db.list_monitored():
        info = lm.get(c["name"]) or {}
        out.append({
            "name": c["name"],
            "label": info.get("label") or c["name"],
            "group": info.get("group", ""),
            "source": info.get("source", ""),
            "known": bool(info),          # 是否还能在来源分类里找到（旧版命名会为 False）
            "last_checked": c.get("last_checked"),
        })
    out.sort(key=lambda x: (x["source"], x["group"], x["label"]))
    return out


@app.post("/api/fetch")
async def fetch(req: Request):
    """拉取某分类的视频列表。

    limit（每次加载条数）由前端下拉框给出（100~1000）；未传时取设置里的
    page_size。上限钳制到 1000，避免一次请求过大。
    """
    body = await req.json()
    category = body.get("category", "")
    try:
        limit = int(body.get("limit") or 0)
    except Exception:
        limit = 0
    if limit <= 0:
        try:
            limit = int(db.get_settings().get("page_size") or 100)
        except Exception:
            limit = 100
    limit = max(1, min(1000, limit))
    try:
        page = max(1, int(body.get("page", 1)))
    except Exception:
        page = 1
    # offset：已加载的原始条数，站点钳制 limit 时也不会错位
    try:
        offset = body.get("offset")
        offset = max(0, int(offset)) if offset is not None else None
    except Exception:
        offset = None
    try:
        adapter = get_adapter()
        res = adapter.fetch_page(category, page=page, limit=limit, offset=offset)
        videos = res.get("videos", [])
        has_more = bool(res.get("has_more", False)) and len(videos) > 0
    except Exception as e:
        return JSONResponse({"ok": False, "error": errors.to_chinese(str(e)), "videos": []})
    return {"ok": True, "videos": videos, "has_more": has_more, "page": page}


@app.post("/api/download/selected")
async def download_selected(req: Request):
    """批量入队：自动跳过重复（库里已有 或 本次提交内重复）。"""
    body = await req.json()
    items = body.get("items", [])
    ids, skipped, skipped_urls = [], 0, []
    seen = set()  # 本次提交内的去重
    for it in items:
        url = (it.get("url") or "").strip()
        if not url or url in seen:
            if url:
                skipped += 1
                skipped_urls.append(url)
            continue
        seen.add(url)
        # 避免重复下载：同地址且处于 等待/下载中/已完成/已跳过 状态时跳过
        if db.url_exists(url, ("pending", "downloading", "done", "skipped")):
            skipped += 1
            skipped_urls.append(url)
            continue
        tid = db.add_task(it.get("title", ""), url, it.get("category", ""),
                          it.get("thumbnail", ""))
        downloader.manager().enqueue(tid)
        ids.append(tid)
    return {"ok": True, "queued": len(ids), "skipped": skipped,
            "ids": ids, "skipped_urls": skipped_urls}


@app.get("/api/tasks")
def tasks():
    """任务列表。额外标注 monitored：该任务所属分类是否处于监控中，
    供前端「📡 监控」筛选用。"""
    ts = db.list_tasks()
    try:
        mon = {c["name"] for c in db.list_categories() if c.get("monitored")}
    except Exception:
        mon = set()
    for t in ts:
        t["monitored"] = t.get("category") in mon
        # 实时速度(B/s)，仅下载中才有值；供悬浮窗显示总网速
        t["speed"] = downloader.get_speed(t["id"]) if t["status"] == "downloading" else 0
    return ts


@app.get("/api/storage")
def storage(force: int = 0):
    """下载目录的真实磁盘占用（递归扫盘，30 秒缓存）+ 所在磁盘剩余空间。

    比「把 done 任务的 size 加起来」更真实：手动丢进目录的文件、删掉记录但
    没删文件的历史残留都被算进来；tracked 字段同时给出库里记录的大小供对照。
    """
    now = time.time()
    if force or not _STORAGE["data"] or (now - _STORAGE["t"]) > _STORAGE_TTL:
        path = db.get_settings().get("download_path") or ""
        try:
            total, files = _dir_stats(path) if path and os.path.isdir(path) else (0, 0)
        except Exception:
            total, files = 0, 0
        disk = {}
        try:
            u = shutil.disk_usage(path or "/")
            disk = {"total": u.total, "used": u.used, "free": u.free}
        except Exception:
            disk = {}
        tracked = 0
        try:
            for t in db.list_tasks():
                if t.get("status") == "done":
                    tracked += int(t.get("size") or 0)
        except Exception:
            tracked = 0
        _STORAGE.update(t=now, data={"bytes": total, "files": files, "tracked": tracked,
                                     "path": path, "disk": disk})
    return _STORAGE["data"]


# ---- 视频库 ----
@app.get("/api/library")
def library(cat: str = "", star: int = 0, q: str = "", page: int = 1,
            limit: int = 40, sort: str = "time", seed: str = ""):
    """视频库列表：扫盘（真实文件）+ 任务记录（标题/分类/原站链接）+ 收藏进度。

    正在下载/等待中的半成品会被排除，避免把没下完的文件当成可播放视频。
    """
    files = _lib_files()
    busy = db.busy_paths()
    tmap, votes = {}, {}
    for t in db.list_tasks(5000):
        p = t.get("path") or ""
        c = t.get("category") or ""
        # 目录名 → 分类名：分类名里的 "/" 在落盘时被换成了 "_"（/new → _new、
        # /ranking/24h → _ranking_24h），没法靠字符串反推（realtime 就不带斜杠）。
        # 用同目录下历史任务记录投票得出，孤儿文件才能归到正确的中文分类上。
        if p and c and os.sep in p:
            d = p.split(os.sep)[0]
            votes.setdefault(d, {})
            votes[d][c] = votes[d].get(c, 0) + 1
        if p and t.get("status") == "done" and p not in tmap:
            tmap[p] = t
    d2c = {d: max(v.items(), key=lambda x: x[1])[0] for d, v in votes.items()}
    meta = db.media_map()

    items = []
    for rel, (size, mtime) in files.items():
        if rel in busy:
            continue
        t = tmap.get(rel) or {}
        cat_name = t.get("category") or ""
        if not cat_name:
            head = rel.split(os.sep)[0] if os.sep in rel else ""
            cat_name = d2c.get(head) or head
        m = meta.get(rel) or {}
        items.append({
            "path": rel,
            "title": t.get("title") or os.path.splitext(os.path.basename(rel))[0],
            "category": cat_name,
            "cat_label": _cat_display(cat_name),
            "size": size,
            "mtime": datetime.fromtimestamp(mtime, timezone.utc).isoformat(),
            "url": t.get("url") or "",
            "thumb": t.get("thumbnail") or "",
            "star": bool(m.get("star")),
            "position": float(m.get("position") or 0.0),
            "duration": float(m.get("duration") or 0.0),
            "plays": int(m.get("plays") or 0),
        })

    # 分类计数（不受当前筛选影响，chips 上的数字才稳定）
    counts, star_count = {}, 0
    for it in items:
        counts[it["category"]] = counts.get(it["category"], 0) + 1
        if it["star"]:
            star_count += 1
    cats = [{"name": k, "label": _cat_display(k), "count": v}
            for k, v in sorted(counts.items(), key=lambda x: (-x[1], x[0]))]

    sel = items
    if cat:
        sel = [it for it in sel if it["category"] == cat]
    if star:
        sel = [it for it in sel if it["star"]]
    q = (q or "").strip().lower()
    if q:
        sel = [it for it in sel if q in it["title"].lower() or q in it["path"].lower()]
    if sort == "random":
        # 随客户端传来的 seed 做确定性洗牌：同一 seed 下分页结果稳定，
        # 滚动加载「加载更多」时不会前后两页顺序错乱。
        rnd = random.Random(seed or "twixive-lib")
        rnd.shuffle(sel)
    elif sort == "size":
        sel.sort(key=lambda x: -x["size"])
    elif sort == "name":
        sel.sort(key=lambda x: x["title"])
    else:                       # time：按文件落盘时间，新下的在前
        sel.sort(key=lambda x: x["mtime"], reverse=True)

    try:
        page = max(1, int(page))
        limit = max(1, min(200, int(limit)))
    except Exception:
        page, limit = 1, 40
    start = (page - 1) * limit
    chunk = sel[start:start + limit]
    return {"items": chunk, "total": len(sel), "all": len(items), "page": page,
            "has_more": start + limit < len(sel), "cats": cats,
            "star_count": star_count}


@app.get("/api/media/stream")
def media_stream(path: str, request: Request):
    """视频流，自己实现 HTTP Range（206/416）。

    Starlette 0.38 的 FileResponse 不带 Range 支持（实测只回 200 全量），
    而播放器拖动进度、跳到未缓冲位置全靠 206 —— 用 FileResponse 的话进度条
    一点就从头重下。这里手写：单段 Range + 512KB 分块流式吐数据。
    """
    full = _safe_full(path)
    if not full or not os.path.isfile(full):
        return JSONResponse({"ok": False, "error": "文件不存在或已被删除"},
                            status_code=404)
    size = os.path.getsize(full)
    ext = os.path.splitext(full)[1].lower()
    mime = {".webm": "video/webm", ".mkv": "video/x-matroska",
            ".mov": "video/quicktime"}.get(ext, "video/mp4")

    start, end, status = 0, max(0, size - 1), 200
    rh = request.headers.get("range") or ""
    if rh.startswith("bytes="):
        spec = rh[6:].split(",")[0].strip()          # 只处理单段
        try:
            a, _, b = spec.partition("-")
            if a:
                start = int(a)
                end = int(b) if b else size - 1
            elif b:                                   # bytes=-500 取末尾
                start = max(0, size - int(b))
                end = size - 1
        except Exception:
            start, end = 0, size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            return JSONResponse({"ok": False, "error": "请求范围超出文件大小"},
                                status_code=416,
                                headers={"Content-Range": "bytes */%d" % size})
        status = 206

    length = end - start + 1

    def iter_file():
        with open(full, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(512 * 1024, left))
                if not chunk:
                    break
                left -= len(chunk)
                yield chunk

    headers = {"Content-Length": str(length), "Accept-Ranges": "bytes"}
    if status == 206:
        headers["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
    return StreamingResponse(iter_file(), status_code=status,
                             media_type=mime, headers=headers)


@app.post("/api/media/meta")
async def media_meta(req: Request):
    """写收藏 / 播放进度。只更新显式传进来的字段。"""
    body = await req.json()
    p = (body.get("path") or "").strip()
    if not _safe_full(p):
        return {"ok": False, "error": "路径非法"}
    def num(k):
        v = body.get(k)
        try:
            return float(v) if v is not None else None
        except Exception:
            return None
    db.set_media(p, star=body.get("star"), position=num("position"),
                 duration=num("duration"), play=bool(body.get("play")))
    return {"ok": True}


@app.delete("/api/media")
def media_delete(path: str):
    """删除视频文件本身，连带清掉收藏记录和指向它的任务记录。

    文件先移入回收站（软删除），误删可恢复；这里只负责路径越界防护。
    """
    root = db.get_settings().get("download_path")
    freed = _safe_remove(path, root)
    db.delete_media(path)
    removed = db.delete_tasks_by_path(path)
    _LIB["t"] = 0        # 扫盘缓存立即失效
    _STORAGE["t"] = 0
    return {"ok": True, "freed": freed, "tasks_removed": removed}


@app.post("/api/tasks/{tid}/cancel")
def cancel_task(tid: str):
    downloader.cancel(tid)
    t = db.get_task(tid)
    if t and t["status"] in ("pending", "downloading"):
        db.update_task(tid, status="cancelled")
    return {"ok": True}


@app.delete("/api/tasks/{tid}")
def delete_task(tid: str, purge: int = 0):
    """删除任务记录；purge=1 时连带删除已落盘的源文件。

    下载中的任务先发取消信号（下载线程每写一块都会检查），再删记录，避免
    记录已删、线程还在往磁盘写。
    """
    t = db.get_task(tid)
    freed = 0
    if t and t["status"] in ("pending", "downloading"):
        downloader.cancel(tid)
        time.sleep(0.2)
    if purge and t:
        freed = _safe_remove(t.get("path"), db.get_settings().get("download_path"))
    db.delete_task(tid)
    _STORAGE["t"] = 0        # 占用缓存立即失效
    return {"ok": True, "freed": freed}


@app.post("/api/tasks/clear")
def clear_tasks(purge: int = 0):
    """清除已结束的任务；purge=1 时连同它们的源文件一起删除。"""
    freed = 0
    if purge:
        root = db.get_settings().get("download_path")
        for row in db.files_of_finished():
            freed += _safe_remove(row["path"], root)
    db.clear_finished()
    _STORAGE["t"] = 0
    return {"ok": True, "freed": freed}


# ---- 回收站（软删除：删除的源文件先移入回收站，可恢复 / 可彻底删 / 到期自动清）----
@app.get("/api/recycle")
def recycle_list():
    items = db.list_recycle()
    total = sum(i["size"] for i in items)
    return {"items": items, "count": len(items), "total_size": total}


@app.post("/api/recycle/restore")
def recycle_restore(body: dict = Body(...)):
    rid = body.get("id")
    r = db.get_recycle(rid)
    if not r:
        return {"ok": False, "error": "回收站条目不存在"}
    name = os.path.basename(r["rel_path"] or r["abs_path"])
    dest_dir = r["original_dir"]
    try:
        os.makedirs(dest_dir, exist_ok=True)
    except Exception:
        pass
    target = os.path.join(dest_dir, name)
    if os.path.exists(target):        # 目标已存在则改名，绝不覆盖
        target = os.path.join(dest_dir, f"{uuid.uuid4().hex[:8]}_{name}")
    try:
        os.rename(r["abs_path"], target)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    db.delete_recycle(rid)
    _STORAGE["t"] = 0
    return {"ok": True, "path": os.path.relpath(target, dest_dir)}


@app.delete("/api/recycle/{rid}")
def recycle_delete(rid: str):
    r = db.get_recycle(rid)
    if not r:
        return {"ok": False, "error": "回收站条目不存在"}
    try:
        if os.path.isfile(r["abs_path"]):
            os.remove(r["abs_path"])
    except Exception:
        pass
    db.delete_recycle(rid)
    _STORAGE["t"] = 0
    return {"ok": True}


@app.post("/api/recycle/empty")
def recycle_empty():
    n = 0
    for it in db.list_recycle():
        try:
            if os.path.isfile(it["abs_path"]):
                os.remove(it["abs_path"])
            n += 1
        except Exception:
            pass
        db.delete_recycle(it["id"])
    _STORAGE["t"] = 0
    return {"ok": True, "removed": n}


@app.post("/api/tasks/{tid}/retry")
def retry_one(tid: str):
    ok = db.retry_task(tid)
    if ok:
        downloader.manager().enqueue(tid)
    return {"ok": ok}


@app.post("/api/tasks/{tid}/force_download")
def force_download(tid: str):
    """强制下载（忽略大小上限）：把任务重新置为等待并把 force 置 1，
    下载器读到 force=1 会跳过大小上限检查。主要用于「已跳过」的任务。"""
    t = db.get_task(tid)
    if not t:
        return {"ok": False, "error": "任务不存在"}
    db.update_task(tid, status="pending", progress=0.0, error="", size=0, force=1)
    downloader.manager().enqueue(tid)
    return {"ok": True}


@app.post("/api/tasks/retry_failed")
def retry_failed():
    ids = db.retry_failed()
    m = downloader.manager()
    for tid in ids:
        m.enqueue(tid)
    return {"ok": True, "retried": len(ids), "ids": ids}


@app.post("/api/auto/run")
def auto_run():
    added = scheduler.run_once()
    return {"ok": True, "added": added}


@app.get("/api/proxy/status")
def proxy_status():
    """代理熔断状态：前端据此提示「代理不可用，已自动暂停」。"""
    return downloader.proxy_status()


@app.post("/api/proxy/test")
def proxy_test():
    """服务端自检：从面板所在机器真连一次目标站点，代理结果 + 直连对照。"""
    return downloader.test_proxy()

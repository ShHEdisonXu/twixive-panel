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
  DELETE /api/tasks/{id}?purge=1   删除（purge=1 时连带删除源文件）
  POST /api/tasks/clear?purge=1    清除已完成/失败/已跳过（purge=1 连文件一起删）
  POST /api/auto/run               立即执行一次巡检
  GET  /api/proxy/status           代理熔断状态（是否暂停、剩余秒数）
  POST /api/proxy/test             服务端自检代理连通性（含直连对照）
"""
import os
import shutil
import time
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from . import db
from . import downloader
from . import scheduler
from . import errors
from .sources import get_adapter, REGISTRY

BASE = os.path.dirname(__file__)
STATIC = os.path.join(BASE, "static")

app = FastAPI(title="TwiXive Panel")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def no_cache_middleware(request: Request, call_next):
    """禁止浏览器/代理缓存任何响应，避免旧页面残留。"""
    resp = await call_next(request)
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
    """删除下载目录内的单个文件，返回释放的字节数。

    安全约束：只删 root 之内的**普通文件**。相对路径可能来自库里被改脏的
    记录（含 ../），一律先 realpath 再做前缀校验，越界直接跳过。
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
        os.remove(full)
    except Exception:
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
            for t in db.list_tasks(5000):
                if t.get("status") == "done":
                    tracked += int(t.get("size") or 0)
        except Exception:
            tracked = 0
        _STORAGE.update(t=now, data={"bytes": total, "files": files, "tracked": tracked,
                                     "path": path, "disk": disk})
    return _STORAGE["data"]


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


@app.post("/api/tasks/{tid}/retry")
def retry_one(tid: str):
    ok = db.retry_task(tid)
    if ok:
        downloader.manager().enqueue(tid)
    return {"ok": ok}


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

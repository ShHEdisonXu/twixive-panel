"""定时自动下载调度器。

用轻量后台线程循环实现（不依赖 APScheduler，避免在线程中启动调度器时的死锁）：
- 当 settings.auto_enabled 为真时，按 auto_interval（分钟）周期性：
  拉取分类 → 取启用分类的视频 → 与已有任务去重 → 入队新视频。
- start()/stop() 控制后台线程；run_once() 可手动触发一次。
- 每次循环都从设置实时读取开关与间隔，改设置即时生效，无需重启。
"""
import threading
import time

from . import db
from . import downloader
from .sources import get_adapter, REGISTRY

_thread = None
_stop = False


def _existing_urls():
    """已出现过的视频 URL（任意状态），用于监控去重，避免重复下载。"""
    return {t["url"] for t in db.list_tasks(5000)}


def _seen(url):
    """该地址是否已在任何任务中出现过（含被大小上限跳过的）
    —— 监控只抓真正「新」的内容，绝不重复下载。"""
    if not url:
        return True
    return db.url_exists(url, ("pending", "downloading", "done", "error",
                               "cancelled", "skipped"))


def run_once():
    """执行一次自动抓取+入队，返回本次新增任务数。

    跨来源巡检，每个来源独立处理自己的分类：
    1) 任一来源中被标记为「监控」的分类 —— 始终巡检，独立于自动下载总开关；
       出现新视频（URL 未在任何历史任务中出现过）即自动入队下载。
    2) 启用了「自动下载」(auto_enabled) 时，所有分类都纳入巡检。
    """
    s = db.get_settings()
    auto_on = bool(s.get("auto_enabled"))
    local = {c["name"]: c for c in db.list_categories()}
    # 提前判断：没有任何监控且未开启自动下载则跳过，避免无谓请求
    if not auto_on and not any(c.get("monitored") for c in local.values()):
        return 0

    added = 0
    for key in REGISTRY:
        try:
            adapter = REGISTRY[key]()
        except Exception:
            continue
        try:
            cats = adapter.fetch_categories()
        except Exception:
            cats = []
        targets = set()
        for c in cats:
            name = c["name"]
            loc = local.get(name, {})
            if loc.get("monitored"):
                targets.add(name)
            elif auto_on and loc.get("enabled"):
                targets.add(name)
        for name in targets:
            try:
                vids = adapter.fetch_videos(name, limit=20)
            except Exception:
                vids = []
            for v in vids:
                url = v.get("url")
                if not url or _seen(url):
                    continue
                tid = db.add_task(v.get("title", name), url, name,
                                  v.get("thumbnail", ""))
                downloader.manager().enqueue(tid)
                added += 1
    return added


def _loop():
    while not _stop:
        s = db.get_settings()
        interval = max(1, int(s.get("auto_interval") or 60)) * 60
        # 以 1s 为粒度等待，保证 stop() 能及时响应
        for _ in range(interval):
            if _stop:
                return
            time.sleep(1)
        if _stop:
            return
        try:
            run_once()
        except Exception as e:  # noqa
            print("[scheduler] tick error:", e)


def start():
    global _thread, _stop
    if _thread and _thread.is_alive():
        return
    _stop = False
    _thread = threading.Thread(target=_loop, daemon=True)
    _thread.start()


def stop():
    global _stop
    _stop = True


def reload():
    """设置已实时生效，无需重建循环。保留接口以兼容 main.py。"""
    pass

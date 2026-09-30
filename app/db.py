"""SQLite 数据层：配置(settings)、分类(categories)、下载任务(tasks)。

使用环境变量 DATA_DIR 决定数据库与下载目录（Docker 中默认为 /data）。
所有写操作加线程锁，配合 uvicorn 多线程 workers 安全。
"""
import sqlite3
import os
import json
import threading
import hashlib
import uuid
from datetime import datetime, timezone

from . import errors  # 报错中文化（纯字符串处理，无循环依赖）

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "app.db")
_lock = threading.Lock()

# ---- 默认设置 ----
DEFAULT_SETTINGS = {
    "proxy_url": "",            # 例: http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
    "proxy_enabled": True,      # 代理总开关：关闭后即使填了地址也全部走直连
    "download_path": os.path.join(DATA_DIR, "downloads"),
    "concurrent": 3,            # 同时下载数
    "rate_delay": 2.0,          # 每个请求之间的礼貌延时(秒)
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "auto_enabled": False,      # 定时自动下载开关
    "auto_interval": 60,        # 巡检间隔(分钟)
    "source": "twixive",        # 当前启用的来源适配器 key
    "retry_times": 2,           # 下载失败自动重试次数（0=不重试），配合断点续传
    "max_size_mb": 0,           # 单文件大小上限(MB)，0=不限制；超过则跳过不下载
    "page_size": 100,           # 分类页每次拉取/加载多少条（100~1000）
}

# 已废弃的设置项（历史库里可能残留，启动时清理）
DEPRECATED_SETTINGS = ("proxy_type", "age_gate_accepted", "auto_categories")


def _now():
    return datetime.now(timezone.utc).isoformat()


def init():
    os.makedirs(DEFAULT_SETTINGS["download_path"], exist_ok=True)
    with _lock, sqlite3.connect(DB_PATH) as c:
        c.execute("""CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT)""")
        c.execute("""CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, last_checked TEXT,
            monitored INTEGER DEFAULT 0)""")
        # 兼容旧库：若已存在 categories 表但缺少 monitored 列则补上
        try:
            c.execute("ALTER TABLE categories ADD COLUMN monitored INTEGER DEFAULT 0")
        except Exception:
            pass
        c.execute("""CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY, title TEXT, url TEXT, category TEXT,
            status TEXT, progress REAL, size INTEGER, path TEXT,
            error TEXT, created_at TEXT)""")
        # 兼容旧库：补 thumbnail 列
        try:
            c.execute("ALTER TABLE tasks ADD COLUMN thumbnail TEXT DEFAULT ''")
        except Exception:
            pass
        # 视频库：以「文件相对路径」为主键记录收藏与播放进度。
        # 不能用 tasks.id 当主键 —— 库里存在没有任务记录的历史文件（扫盘比记录多
        # 出的那部分），任务记录被清掉后文件仍在，收藏和进度必须跟着文件走。
        c.execute("""CREATE TABLE IF NOT EXISTS media (
            path TEXT PRIMARY KEY, star INTEGER DEFAULT 0,
            position REAL DEFAULT 0, duration REAL DEFAULT 0,
            plays INTEGER DEFAULT 0, updated_at TEXT)""")
        # 写入缺省设置（仅当 key 不存在）
        for k, v in DEFAULT_SETTINGS.items():
            c.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)",
                      (k, json.dumps(v)))
        # 清理已废弃的设置项，避免界面/逻辑读到历史脏值
        c.execute("DELETE FROM settings WHERE key IN (%s)"
                  % ",".join("?" for _ in DEPRECATED_SETTINGS),
                  DEPRECATED_SETTINGS)
        # 一次性迁移：把历史英文报错翻译成中文（幂等，已含中文则跳过）
        try:
            rows = c.execute(
                "SELECT id, error FROM tasks WHERE error IS NOT NULL AND error<>''").fetchall()
            for tid, err in rows:
                if err and not errors.has_cjk(err):
                    c.execute("UPDATE tasks SET error=? WHERE id=?",
                              (errors.to_chinese(err), tid))
        except Exception:
            pass
        # 一次性清理：重试过程中写的「第 N 次失败…」「下载中断…正在断点续传」等中间
        # 状态，在最终成功后没被清掉，导致「已完成」里仍显示失败/中断文案。幂等。
        # 已完成直接清空；等待/下载中的任务重启后会重新入队重写，旧文案也无意义，
        # 一并清掉（含历史 bug 留下的「第 0 次失败」）。
        try:
            c.execute("UPDATE tasks SET error='' "
                      "WHERE status='done' AND error IS NOT NULL AND error<>''")
            c.execute("UPDATE tasks SET error='' "
                      "WHERE status IN ('pending','downloading') AND ("
                      "error LIKE '第 %次失败，准备重试%' "
                      "OR error LIKE '%正在断点续传%')")
        except Exception:
            pass
        # 一次性修复：清理历史重复分类行并统一为稳定 id（详见 _cat_id 注释）。
        # 同名保留「监控开着」的那条，其余删除，避免监控状态被重复行覆盖。
        try:
            rows = c.execute(
                "SELECT id, name, monitored, last_checked FROM categories").fetchall()
            best = {}
            for cid, name, mon, lc in rows:
                mon = int(mon or 0)
                cur = best.get(name)
                if cur is None or (mon, str(lc or "")) > (cur[0], str(cur[1] or "")):
                    best[name] = (mon, lc, cid)
            keep_ids = {v[2] for v in best.values()}
            for cid, name, _m, _l in rows:
                if cid not in keep_ids:
                    c.execute("DELETE FROM categories WHERE id=?", (cid,))
            for name, (_mon, _lc, cid) in best.items():
                new = _cat_id(name)
                if new != cid:
                    c.execute("DELETE FROM categories WHERE id=? AND name<>?", (new, name))
                    c.execute("UPDATE categories SET id=? WHERE id=?", (new, cid))
        except Exception:
            pass


# ---- settings ----
def get_settings():
    with _lock, sqlite3.connect(DB_PATH) as c:
        rows = c.execute("SELECT key, value FROM settings").fetchall()
    out = dict(DEFAULT_SETTINGS)
    for k, v in rows:
        try:
            out[k] = json.loads(v)
        except Exception:
            out[k] = v
    return out


def set_settings(patch: dict):
    with _lock, sqlite3.connect(DB_PATH) as c:
        for k, v in patch.items():
            c.execute("INSERT INTO settings(key, value) VALUES(?,?) "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                      (k, json.dumps(v)))
    return get_settings()


# ---- categories ----
def list_categories():
    with _lock, sqlite3.connect(DB_PATH) as c:
        rows = c.execute("SELECT id, name, enabled, last_checked, monitored FROM categories "
                         "ORDER BY name").fetchall()
    return [{"id": r[0], "name": r[1], "enabled": bool(r[2]),
             "last_checked": r[3], "monitored": bool(r[4])}
            for r in rows]


def _cat_id(name):
    """分类 id 必须由名称稳定派生。

    曾经用内置 hash(name) 生成，而 Python 的字符串 hash 每次进程启动都会随机
    （PYTHONHASHSEED），导致容器每重启一次同一个分类就 INSERT 出一条新记录：
    线上 categories 表膨胀到 248 行/32 个名字，而按名字取监控状态时「最后一条
    取胜」恰好取到 monitored=0 的重复行 —— 表现就是监控明明开着，图标却不亮。
    """
    return "cat_" + hashlib.md5((name or "").encode("utf-8")).hexdigest()[:12]


def upsert_categories(items: list):
    """items: [{name, enabled, monitored?}]，按 name 幂等写入。"""
    with _lock, sqlite3.connect(DB_PATH) as c:
        for it in items:
            cid = _cat_id(it["name"])
            mon = int(bool(it.get("monitored", False)))
            c.execute("""INSERT INTO categories(id, name, enabled, last_checked, monitored)
                         VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                         name=excluded.name, enabled=excluded.enabled,
                         monitored=excluded.monitored""",
                      (cid, it["name"], int(bool(it.get("enabled", True))), _now(), mon))
    return list_categories()


def set_category_monitored(cat_id, monitored):
    with _lock, sqlite3.connect(DB_PATH) as c:
        c.execute("UPDATE categories SET monitored=? WHERE id=?",
                  (int(bool(monitored)), cat_id))
    return list_categories()


def set_monitored_by_name(name, monitored):
    """按分类名开关监控（不依赖 id，避免任何 id 歧义）。"""
    with _lock, sqlite3.connect(DB_PATH) as c:
        c.execute("UPDATE categories SET monitored=? WHERE name=?",
                  (int(bool(monitored)), name))
        if c.execute("SELECT changes()").fetchone()[0] == 0:
            c.execute("""INSERT INTO categories(id, name, enabled, last_checked, monitored)
                         VALUES(?,?,?,?,?)""",
                      (_cat_id(name), name, 1, _now(), int(bool(monitored))))
    return list_categories()


def list_monitored():
    """所有处于监控中的分类（**跨来源**）。

    控制台「监控中分类」必须用这个而不是当前来源的分类列表：监控状态是按
    分类名存在库里的，而分类名属于不同来源（twixive 的 /new、twivideo 的
    ranking_24h…）。只看当前来源会把别的来源正在监控的分类漏掉 —— 表现就是
    「明明监控了 8 个，控制台只显示 5 个」。
    """
    with _lock, sqlite3.connect(DB_PATH) as c:
        rows = c.execute("SELECT id, name, monitored, last_checked FROM categories "
                         "WHERE monitored=1 ORDER BY name").fetchall()
    return [{"id": r[0], "name": r[1], "monitored": bool(r[2]),
             "last_checked": r[3]} for r in rows]


def category_names():
    """库里出现过的全部分类名（用于把监听的分类名解析回中文名）。"""
    with _lock, sqlite3.connect(DB_PATH) as c:
        rows = c.execute("SELECT name FROM categories").fetchall()
    return [r[0] for r in rows]


def files_of_finished():
    """返回所有「已结束」任务的落盘相对路径（用于连带删除源文件）。

    只取记录了 path 的任务；等待中/下载中的文件由下载线程持有，不在此列。
    """
    with _lock, sqlite3.connect(DB_PATH) as c:
        rows = c.execute("SELECT id, path FROM tasks WHERE status IN "
                         "('done','error','cancelled','skipped') "
                         "AND path IS NOT NULL AND path<>''").fetchall()
    return [{"id": r[0], "path": r[1]} for r in rows]


# ---- tasks ----
def new_task_id():
    return "task_" + uuid.uuid4().hex[:12]


def add_task(title, url, category, thumbnail=""):
    tid = new_task_id()
    with _lock, sqlite3.connect(DB_PATH) as c:
        c.execute("""INSERT INTO tasks(id, title, url, category, status, progress,
                     size, path, error, created_at, thumbnail)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                  (tid, title, url, category, "pending", 0.0, 0, "", "", _now(), thumbnail or ""))
    return tid


def list_tasks(limit=1000):
    with _lock, sqlite3.connect(DB_PATH) as c:
        rows = c.execute("SELECT id, title, url, category, status, progress, "
                         "size, path, error, created_at, thumbnail FROM tasks "
                         "ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [{"id": r[0], "title": r[1], "url": r[2], "category": r[3],
             "status": r[4], "progress": r[5], "size": r[6], "path": r[7],
             "error": r[8], "created_at": r[9], "thumbnail": r[10] or ""}
            for r in rows]


def url_exists(url, statuses=("pending", "downloading", "done")):
    """判断某视频地址是否已在指定状态的任务中（用于避免重复下载）。"""
    if not url:
        return False
    with _lock, sqlite3.connect(DB_PATH) as c:
        q = ",".join("?" for _ in statuses)
        rows = c.execute(
            f"SELECT 1 FROM tasks WHERE url=? AND status IN ({q}) LIMIT 1",
            (url,) + tuple(statuses)).fetchall()
    return bool(rows)


def retry_task(tid):
    """将失败/已取消的任务重置为等待中（供重试）。返回是否成功。"""
    t = get_task(tid)
    if not t:
        return False
    if t["status"] in ("pending", "downloading"):
        return False
    update_task(tid, status="pending", progress=0.0, error="", size=0)
    return True


def retry_failed():
    """重置所有失败/已取消任务为等待中，返回其 id 列表。"""
    with _lock, sqlite3.connect(DB_PATH) as c:
        rows = c.execute("SELECT id FROM tasks WHERE status IN ('error','cancelled')").fetchall()
    ids = [r[0] for r in rows]
    for tid in ids:
        update_task(tid, status="pending", progress=0.0, error="", size=0)
    return ids


def get_task(tid):
    rows = list_tasks(1000)
    return next((t for t in rows if t["id"] == tid), None)


def update_task(tid, **fields):
    allowed = {"title", "url", "category", "status", "progress", "size", "path", "error"}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if not fields:
        return
    with _lock, sqlite3.connect(DB_PATH) as c:
        cols = ", ".join(f"{k}=?" for k in fields)
        vals = list(fields.values()) + [tid]
        c.execute(f"UPDATE tasks SET {cols} WHERE id=?", vals)


def delete_task(tid):
    with _lock, sqlite3.connect(DB_PATH) as c:
        c.execute("DELETE FROM tasks WHERE id=?", (tid,))


def clear_finished():
    with _lock, sqlite3.connect(DB_PATH) as c:
        c.execute("DELETE FROM tasks WHERE status IN "
                  "('done','error','cancelled','skipped')")


# ---- media（视频库：收藏 / 播放进度）----
def media_map():
    """{相对路径: {star, position, duration, plays}}"""
    with _lock, sqlite3.connect(DB_PATH) as c:
        rows = c.execute("SELECT path, star, position, duration, plays "
                         "FROM media").fetchall()
    return {r[0]: {"star": bool(r[1]), "position": r[2] or 0.0,
                   "duration": r[3] or 0.0, "plays": r[4] or 0}
            for r in rows}


def set_media(path, star=None, position=None, duration=None, play=False):
    """写收藏/播放进度。只更新显式传入的字段，缺省不动。"""
    if not path:
        return
    sets, vals = [], []
    if star is not None:
        sets.append("star=?")
        vals.append(int(bool(star)))
    if position is not None:
        sets.append("position=?")
        vals.append(max(0.0, float(position)))
    if duration is not None:
        sets.append("duration=?")
        vals.append(max(0.0, float(duration)))
    if play:
        sets.append("plays=plays+1")
    sets.append("updated_at=?")
    vals.append(_now())
    with _lock, sqlite3.connect(DB_PATH) as c:
        c.execute("INSERT OR IGNORE INTO media(path, star, position, duration, plays, "
                  "updated_at) VALUES(?,?,?,?,?,?)", (path, 0, 0.0, 0.0, 0, _now()))
        c.execute("UPDATE media SET %s WHERE path=?" % ", ".join(sets), vals + [path])


def delete_media(path):
    with _lock, sqlite3.connect(DB_PATH) as c:
        c.execute("DELETE FROM media WHERE path=?", (path,))


def delete_tasks_by_path(path):
    """删除指向某个文件的全部任务记录（文件被删掉后记录已无意义）。"""
    if not path:
        return 0
    with _lock, sqlite3.connect(DB_PATH) as c:
        c.execute("DELETE FROM tasks WHERE path=?", (path,))
        return c.execute("SELECT changes()").fetchone()[0]


def busy_paths():
    """正在下载/等待中的任务落盘路径 —— 视频库要排除这些半成品。"""
    with _lock, sqlite3.connect(DB_PATH) as c:
        rows = c.execute("SELECT path FROM tasks WHERE status IN "
                         "('pending','downloading') AND path IS NOT NULL "
                         "AND path<>''").fetchall()
    return {r[0] for r in rows}

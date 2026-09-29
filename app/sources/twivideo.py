"""TwiVideo 来源适配器（X/Twitter 视频聚合站 https://twivideo.net）。

站点结构（已复原其真实导航到本项目）：
- 内容通过 AJAX 加载：POST /templates/view_lists.php
    参数：offset, limit, tag, type, order, le, ty, myarray, offset_int, view_token
    返回 HTML 片段，视频卡片为 .art_li，含 a.item_link[data-id] 与缩略图。
- 单条视频直链：GET /api/video.php?id=<id> → 302 跳转到 video.twimg.com 的 .mp4。
- 导航为查询参数式：?ranking(24h/3days/week) / ?realtime / ?archives。

分页：offset 递增（每次 +limit），返回条数 == limit 时认为还有更多。
解析失败返回空列表而不崩。settings 中的代理会被自动套用。
"""
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from bs4 import BeautifulSoup
from .. import db
from .. import config

BASE = "https://twivideo.net"

# 真实导航结构（顶层分组 + 子按钮），已复原进项目。
# 每个叶子: (中文显示名, 稳定 name, 分组, type[view_lists 参数], order[空串=省略])
NAV = [
    ("排行", [
        ("24時間ランキング", "ranking_24h", "ranking", "24"),
        ("3日間ランキング",   "ranking_3d",  "ranking", "72"),
        ("1週間ランキング",   "ranking_week", "ranking", "168"),
    ]),
    ("探索", [
        ("リアルタイム", "realtime", "realtime", ""),
        ("話題/アーカイブ", "archives", "archives", ""),
    ]),
]

_TOKEN = {"value": None, "ts": 0}
_TOKEN_TTL = 300  # 秒


def _leaves():
    out = []
    for group, items in NAV:
        for label, name, typ, order in items:
            out.append({"label": label, "name": name, "group": group,
                        "type": typ, "order": order})
    return out


def _session():
    sess = requests.Session()
    s = db.get_settings()
    sess.headers.update({
        "User-Agent": s.get("user_agent") or "Mozilla/5.0",
        "Accept-Language": "ja,en;q=0.8",
    })
    return sess


def _ensure_token(sess):
    now = time.time()
    if _TOKEN["value"] and (now - _TOKEN["ts"]) < _TOKEN_TTL:
        return _TOKEN["value"]
    try:
        r = sess.post(BASE + "/templates/ajax_view_token.php", timeout=30)
        tok = r.json().get("token") if r.ok else None
    except Exception:
        tok = None
    if tok:
        _TOKEN["value"] = tok
        _TOKEN["ts"] = now
    return tok


def _resolve_video_url(sess, vid):
    """GET /api/video.php?id=<id> → 302 Location 即直链 mp4。"""
    try:
        r = sess.get(f"{BASE}/api/video.php?id={vid}", timeout=30,
                     allow_redirects=False,
                     proxies=config.get_proxy_dict() or None)
        if r.status_code in (301, 302) and r.headers.get("Location"):
            return r.headers["Location"]
        # 某些 id 可能失效（400），跳过
        return ""
    except Exception:
        return ""


def _resolve_many(sess, ids, workers=8):
    """并发解析直链：一条一个请求，批量（100~1000 条）时串行会非常慢。"""
    out = {}
    if not ids:
        return out
    with ThreadPoolExecutor(max_workers=min(workers, len(ids))) as ex:
        futs = {ex.submit(_resolve_video_url, sess, i): i for i in ids}
        for f, i in futs.items():
            try:
                out[i] = f.result() or ""
            except Exception:
                out[i] = ""
    return out


def _fetch_page(name, page, limit, offset=None):
    start = offset if offset is not None else (page - 1) * limit
    leaf = next((l for l in _leaves() if l["name"] == name), None)
    if not leaf:
        return {"videos": [], "has_more": False, "page": page}
    sess = _session()
    token = _ensure_token(sess)
    proxies = config.get_proxy_dict() or None
    data = {
        "offset": start,
        "limit": limit,
        "tag": "null",
        "type": leaf["type"],
        "le": 1000,
        "ty": "p6",
        "myarray": "[]",
        "offset_int": start,
        "view_token": token or "",
    }
    if leaf["order"]:
        data["order"] = leaf["order"]
    try:
        r = sess.post(BASE + "/templates/view_lists.php", data=data,
                      timeout=40, proxies=proxies)
        r.encoding = r.encoding or "utf-8"
    except Exception as e:
        print("[twivideo:view_lists] 失败:", e)
        return {"videos": [], "has_more": False, "page": page}
    soup = BeautifulSoup(r.text, "html.parser")
    links = soup.select(".art_li a.item_link[data-id]")[:limit]
    ids, thumbs = [], {}
    for a in links:
        vid = a.get("data-id")
        if not vid:
            continue
        img = a.find("img")
        thumbs[vid] = (img.get("src") or "") if img else ""
        ids.append(vid)
    resolved = _resolve_many(sess, ids)
    videos = []
    for vid in ids:
        url = resolved.get(vid) or ""
        if not url:
            continue
        videos.append({"title": f"TWIVIDEO {vid}", "url": url, "thumbnail": thumbs.get(vid, "")})
    return {"videos": videos, "has_more": len(links) > 0 and len(videos) > 0, "page": page}


class TwivideoAdapter:
    key = "twivideo"
    name = "TwiVideo"

    def fetch_categories(self):
        return [{"name": lv["name"], "label": lv["label"], "group": lv["group"]}
                for lv in _leaves()]

    def fetch_videos(self, category, limit=20):
        return _fetch_page(category, 1, limit)["videos"]

    def fetch_page(self, category, page=1, limit=20, offset=None):
        return _fetch_page(category, page, limit, offset=offset)


def adapter():
    return TwivideoAdapter()

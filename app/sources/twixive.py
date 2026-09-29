"""TwiXive 来源适配器（X/Twitter 成人视频聚合站）。

⚠️ 该站点为成人内容聚合站，页面结构可能随时变化。本适配器针对当前 twixive.net
（Next.js 构架）做了适配，并已**复原其真实导航结构**（顶层导航按钮 + 子按钮）到本项目。

- 视频直链 API（支持分页/加载更多）：
    GET /api/rankings/video?kind=<new|trend|day>&limit=&offset=&days=
    需要 Referer/Origin/X-Requested-With 头（否则 403）。
- 服务端 HTML 兜底（首页/归档/隐藏/短视频等无独立 API 的分类）：
    解析 div.ranking-thumbnail-card + 内联 mp4 直链。

解析失败返回空列表而不崩。成年验证 cookie 始终携带（该站为成人站，必须带）。
"""
import re
from bs4 import BeautifulSoup
from .. import db
from .. import config

BASE = "https://twixive.net"

# 成年验证 cookie（按需修改）
AGE_COOKIE = {"agegate": "1", "age_confirmed": "1"}

# API 拉取所需的请求头（缺一则 403）
API_HEADERS = {
    "Referer": BASE + "/new",
    "Origin": BASE,
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "fetch",
}

# 真实导航结构（已复原进项目）。按用户要求只保留：
#   排行（内含 24小时/3日/7日 三个时间段小 tab）、趋势、新的
# 每个叶子: (中文显示名, 站点路径 name, kind[API类型,None=走HTML], days[仅day类型])
NAV = [
    ("排行", [
        ("24小时", "/ranking/24h", "day", 1),
        ("3日",    "/ranking/3days", "day", 3),
        ("7日",    "/ranking/7days", "day", 7),
    ]),
    ("趋势", [
        ("趋势", "/trend/videos", "trend", None),
    ]),
    ("新的", [
        ("新的", "/new", "new", None),
    ]),
]


def _leaves():
    out = []
    for group, items in NAV:
        for label, name, kind, days in items:
            out.append({"label": label, "name": name, "group": group,
                        "kind": kind, "days": days})
    return out


# 视频卡片 / 缩略图选择器（基于真实 DOM，仅 HTML 兜底用）
CARD_SEL = "div.ranking-thumbnail-card"
THUMB_SEL = "img.ranking-thumbnail-image"
MP4_RE = re.compile(r"https://video\.twimg\.com/amplify_video/(\d+)/[^\s\"'\\]+\.mp4")


def _cookies():
    # 成人站点 API 必须带年龄验证 cookie，否则 403；此处恒带（仅作年龄确认，无害）。
    return AGE_COOKIE


def _get(url, headers=None):
    sess = config.build_session()
    proxies = config.get_proxy_dict()
    h = dict(API_HEADERS)
    if headers:
        h.update(headers)
    resp = sess.get(url, cookies=_cookies(), proxies=proxies, headers=h, timeout=30)
    resp.encoding = resp.encoding or "utf-8"
    config.polite_sleep()
    return resp


def _category_url(name):
    if name and name.startswith("/"):
        return BASE + name
    return BASE + "/" + (name or "new").lstrip("/")


def _api_get(kind, days, offset, limit):
    params = {"kind": kind, "limit": limit, "offset": offset}
    if days:
        params["days"] = days
    try:
        sess = config.build_session()
        r = sess.get(
            BASE + "/api/rankings/video", params=params,
            cookies=_cookies(), proxies=config.get_proxy_dict(),
            headers=API_HEADERS, timeout=30)
        r.encoding = r.encoding or "utf-8"
        config.polite_sleep()
    except Exception as e:
        print("[twixive:api] 请求失败:", e)
        return []
    if not r.ok:
        print("[twixive:api] HTTP", r.status_code)
        return []
    try:
        j = r.json()
    except Exception:
        return []
    items = j.get("items") or []
    out = []
    for it in items:
        v = it.get("video") or {}
        url = v.get("url") or ""
        if not url:
            continue
        author = v.get("author") or {}
        title = author.get("name") or author.get("username") or v.get("id", "")
        out.append({
            "title": str(title)[:120],
            "url": url,
            "thumbnail": v.get("thumbnail") or "",
        })
    return out


def _html_get(name, limit):
    try:
        html = _get(_category_url(name)).text
    except Exception as e:
        print("[twixive:html] 请求失败:", e)
        return []
    mp4_map = {}
    for m in MP4_RE.finditer(html):
        mp4_map.setdefault(m.group(1), m.group(0))
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for card in soup.select(CARD_SEL):
        vid = (card.get("data-video-card-id") or "").strip()
        if not vid:
            continue
        img = card.select_one(THUMB_SEL)
        thumb = img.get("src") or "" if img else ""
        title = (img.get("alt") or "") if img else ""
        if not title:
            ua = card.select_one('a[href^="/user/"]')
            title = ua.get("href", "").replace("/user/", "") if ua else vid
        url = mp4_map.get(vid) or ""
        if not url:
            vs = card.select_one("video source[src], video[src]")
            if vs:
                url = vs.get("src") or ""
        if not url:
            continue
        out.append({"title": (title or vid)[:120], "url": url, "thumbnail": thumb})
        if len(out) >= limit:
            break
    return out


class TwixiveAdapter:
    key = "twixive"
    name = "TwiXive"

    def fetch_categories(self):
        # 1) 设置里手动指定的分类优先（逗号分隔，可填中文名或 /path）
        s = db.get_settings()
        custom = (s.get("twixive_categories") or "").strip()
        if custom:
            return [{"name": c.strip(), "label": c.strip(), "group": ""}
                    for c in custom.split(",") if c.strip()]
        # 2) 复原的真实导航结构
        return [{"name": lv["name"], "label": lv["label"], "group": lv["group"]}
                for lv in _leaves()]

    def fetch_videos(self, category, limit=20):
        leaf = next((l for l in _leaves() if l["name"] == category), None)
        if leaf and leaf["kind"]:
            return _api_get(leaf["kind"], leaf["days"], 0, limit)
        return _html_get(category, limit)

    def fetch_page(self, category, page=1, limit=20, offset=None):
        """offset 优先（按已加载条数取，站点钳制 limit 时也不会错位）。"""
        start = offset if offset is not None else (page - 1) * limit
        leaf = next((l for l in _leaves() if l["name"] == category), None)
        if leaf and leaf["kind"]:
            vids = _api_get(leaf["kind"], leaf["days"], start, limit)
            # 只要还拿得到内容就认为后面还有（前端会按 URL 去重，重复则停止）
            return {"videos": vids, "has_more": len(vids) > 0, "page": page}
        # HTML 兜底：仅第一页
        if start > 0:
            return {"videos": [], "has_more": False, "page": page}
        return {"videos": _html_get(category, limit), "has_more": False, "page": 1}


def adapter():
    return TwixiveAdapter()

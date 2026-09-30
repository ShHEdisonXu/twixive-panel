"""配置与 HTTP 辅助：从 db 读取设置，构建 requests 代理字典与共享 session。"""
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from . import db


def get_proxy_dict():
    """根据设置返回 requests 用的 proxies 字典；未配置或总开关关闭则返回 None。

    总开关（settings.proxy_enabled）关闭时，即使填了地址也一律直连 —— 方便
    代理临时挂掉时一键切直连，不用把地址删掉再重填。
    """
    s = db.get_settings()
    if not s.get("proxy_enabled", True):
        return None
    url = (s.get("proxy_url") or "").strip()
    if not url:
        return None
    # requests 的 proxies 按协议映射；socks5 需在地址里用 socks5:// 前缀
    return {"http": url, "https": url, "all": url}


def build_session():
    s = db.get_settings()
    sess = requests.Session()
    retry = Retry(total=3, backoff_factor=0.5,
                  status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=20)
    sess.mount("http://", adapter)
    sess.mount("https://", adapter)
    sess.headers.update({
        "User-Agent": s.get("user_agent") or "Mozilla/5.0",
        "Accept-Language": "ja,en;q=0.8",
    })
    return sess


def polite_sleep():
    import time
    s = db.get_settings()
    d = float(s.get("rate_delay") or 0)
    if d > 0:
        time.sleep(d)

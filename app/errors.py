"""把底层英文异常/报错翻译成中文人话，供面板直接展示。

设计：
- 纯字符串处理，无外部依赖，db / downloader 都能安全 import。
- 幂等：若原文已含中文则原样返回，避免重复翻译。
- 匹配不到的兜底为「下载失败：原文」，保证界面上不出现纯英文。
"""
import re

_CJK = re.compile(r"[\u4e00-\u9fff]")


def has_cjk(s):
    return bool(s and _CJK.search(s))


def to_chinese(msg):
    """把英文报错翻译成中文；已是中文则原样返回。"""
    if not msg:
        return msg or ""
    if has_cjk(msg):
        return msg
    low = msg.lower()

    # ---- HTTP 状态码 ----
    m = re.search(r"(\d{3})\s+(?:client|server) error", low) or \
        re.search(r"http\s*error\s*(\d{3})", low) or \
        re.search(r"status(?:\s+code)?[=: ]\s*(\d{3})", low)
    if m:
        code = m.group(1)
        return {
            "400": "请求无效（400）",
            "401": "需要登录/授权（401）",
            "403": "服务器拒绝访问（403）——可能需要年龄验证或链接已失效",
            "404": "视频不存在或已被删除（404）",
            "429": "请求过于频繁被限流（429），请降低并发或加大延时",
            "500": "远端服务器内部错误（500）",
            "502": "网关错误（502），代理或网络异常",
            "503": "服务暂时不可用（503），请稍后重试",
            "504": "网关超时（504），请稍后重试",
        }.get(code, "服务器返回异常状态码 %s" % code)

    # ---- 连接/传输中断 ----
    if "incompleteread" in low or "connection broken" in low:
        return "下载中断：连接被中途断开（网络不稳或文件过大）"
    if "chunkedencoding" in low or "response ended prematurely" in low:
        return "下载中断：数据传输不完整"
    if "remote end closed connection" in low or "connection aborted" in low \
            or "connection reset" in low:
        return "连接被服务端重置/关闭，下载未完成"
    if "bad status line" in low:
        return "服务端响应异常（Bad Status Line）"

    # ---- 代理 / SSL / 网络 ----
    if "proxyerror" in low or ("proxy" in low and "error" in low):
        return "代理连接失败，请检查代理设置"
    if "sslerror" in low or "certificate" in low:
        return "SSL/HTTPS 证书或握手失败"
    if "nameresolution" in low or "nodename nor servname" in low \
            or "name or service not known" in low or "failed to resolve" in low:
        return "域名解析失败，请检查网络/代理"
    if "connection refused" in low or "failed to establish" in low \
            or "connectionerror" in low or "network is unreachable" in low:
        return "网络连接失败（无法连接服务器）"
    if "timed out" in low or "timeout" in low:
        return "连接或读取超时，网络较慢"
    if "max retries" in low:
        return "重试次数超限，网络不稳定"

    # ---- 本地写入 ----
    if "no space left" in low:
        return "磁盘空间不足，无法保存"
    if "permission denied" in low or "read-only file system" in low:
        return "没有写入权限（下载目录不可写）"
    if "file name too long" in low:
        return "文件名过长，无法保存"
    if "not a directory" in low or "no such file or directory" in low:
        return "下载目录不存在"

    # ---- 解析 / 其他 ----
    if "expecting value" in low or "json" in low and "decode" in low:
        return "解析响应失败（返回内容不是有效数据）"
    if "invalid url" in low or "unsupported url scheme" in low or "no scheme" in low:
        return "链接无效或不受支持"

    return "下载失败：" + msg[:150]

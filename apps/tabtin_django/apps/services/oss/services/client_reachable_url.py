"""把指向本机环回地址的绝对 URL 改写成客户端实际可达的 Host。

Local OSS 的 ``LOCAL_OSS_PUBLIC_BASE_URL`` 默认是 ``http://127.0.0.1:6060/...``。
同机 Owner 没问题；LAN 上的 grantee 拿到后会打到自己电脑的 127.0.0.1，
出现 ``download failed: 404``（ 方案 A）。
"""

from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlparse, urlunparse

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "0.0.0.0"})


def _hostname_of(netloc_or_host: str) -> str:
    host = (netloc_or_host or "").strip().lower()
    if not host:
        return ""
    # Django get_host() 可能带端口；IPv6 形如 [::1]:6060
    if host.startswith("["):
        end = host.find("]")
        if end > 0:
            return host[1:end]
    if host.count(":") == 1:
        return host.split(":", 1)[0]
    return host


def is_loopback_host(hostname: str | None) -> bool:
    return _hostname_of(hostname or "") in _LOOPBACK_HOSTS


def rewrite_loopback_absolute_url_for_request(
    url: str,
    request: Optional[Any],
) -> str:
    """若 ``url`` 指向环回地址，而当前请求来自非环回 Host，则替换 netloc。

    - 非绝对 URL / 无 request / 原 Host 已非环回 → 原样返回
    - 请求本身也走环回（同机预览）→ 原样返回
    - scheme 跟随 ``request.is_secure()``（LAN dogfood 一般为 http）
    """
    value = (url or "").strip()
    if not value or request is None:
        return value

    parsed = urlparse(value)
    if not parsed.scheme or not parsed.netloc:
        return value
    if not is_loopback_host(parsed.hostname):
        return value

    try:
        request_host = str(request.get_host() or "").strip()
    except Exception:
        return value
    if not request_host or is_loopback_host(request_host):
        return value

    try:
        secure = bool(request.is_secure())
    except Exception:
        secure = parsed.scheme == "https"
    scheme = "https" if secure else "http"
    return urlunparse((
        scheme,
        request_host,
        parsed.path,
        parsed.params,
        parsed.query,
        parsed.fragment,
    ))

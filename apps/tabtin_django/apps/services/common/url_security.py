"""
URL 安全校验工具

提供 SSRF（Server-Side Request Forgery）防护：
- 阻止请求内网地址（10.x / 172.16-31.x / 192.168.x / 127.x / link-local）
- 阻止请求云元数据端点（169.254.169.254）
- 仅允许 http / https 协议
- resolve-and-pin 模式防止 DNS rebinding（TOCTOU）

所有需要根据用户输入发起 HTTP 请求的模块都应使用此工具：
- 新代码优先使用 ssrf_safe_request / ssrf_safe_request_async / ssrf_safe_urlopen
- 旧代码的 validate_url_ssrf 仍可用于纯校验（不发起请求的场景）
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from dataclasses import dataclass
from typing import Any, Collection, Dict, Optional, Union
from urllib.parse import urljoin, urlparse

logger = logging.getLogger(__name__)

_BLOCKED_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("::ffff:0:0/96"),
]

_BLOCKED_HOSTNAMES = {
    "metadata.google.internal",
    "metadata.internal",
}


# ── 旧 API（向后兼容）──────────────────────────────────────────


def validate_url_ssrf(url: str, *, allow_localhost: bool = False) -> Optional[str]:
    """
    校验 URL 是否安全（无 SSRF 风险）。

    Returns:
        None 表示通过，否则返回错误描述字符串。

    .. deprecated::
        存在 TOCTOU 漏洞（校验与连接之间可能发生 DNS rebinding）。
        新代码请使用 resolve_and_validate + ssrf_safe_request 系列函数。
    """
    if not url or not isinstance(url, str):
        return "URL 不能为空"

    from apps.services.common.unicode_security import sanitize_url_unicode
    url = sanitize_url_unicode(url)

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"不支持的协议: {parsed.scheme}"

    hostname = parsed.hostname
    if not hostname:
        return "无效的 URL: 缺少主机名"

    hostname_lower = hostname.lower()
    if hostname_lower in _BLOCKED_HOSTNAMES:
        return f"目标主机被禁止: {hostname}"

    if not allow_localhost and hostname_lower in ("localhost", "0.0.0.0"):
        return f"目标主机被禁止: {hostname}"

    try:
        addr_infos = socket.getaddrinfo(
            hostname, parsed.port or 443, proto=socket.IPPROTO_TCP
        )
    except socket.gaierror:
        return f"无法解析主机: {hostname}"

    for _family, _type, _proto, _canonname, sockaddr in addr_infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if not allow_localhost and _is_ip_blocked(ip):
            return f"目标地址属于受限网段"

    return None


def assert_url_safe(url: str, *, context: str = "") -> None:
    """
    校验 URL 安全性，不通过时抛出 ValueError。

    Args:
        url: 待校验的 URL
        context: 调用方描述，用于日志
    """
    error = validate_url_ssrf(url)
    if error:
        log_ctx = f" [{context}]" if context else ""
        logger.warning("SSRF 校验失败%s: url=%s reason=%s", log_ctx, url, error)
        raise ValueError(f"URL 安全校验失败: {error}")


# ── 新 API: Resolve-and-Pin ──────────────────────────────────────


@dataclass(frozen=True)
class ResolvedURL:
    """DNS 解析 + SSRF 校验后的安全连接信息。

    调用方应使用 pinned_url 建连，并设置 Host 头为 original_host。
    port 为 URL 中显式指定的端口号（未指定时为 None，默认端口在 pinned_url 中省略）。
    """

    original_url: str
    original_host: str
    resolved_ip: str
    scheme: str
    port: Optional[int]
    path_qs: str

    @property
    def pinned_url(self) -> str:
        """hostname 替换为已校验 IP 的 URL，用于实际建连。"""
        if ":" in self.resolved_ip:
            host_part = f"[{self.resolved_ip}]"
        else:
            host_part = self.resolved_ip
        netloc = f"{host_part}:{self.port}" if self.port else host_part
        return f"{self.scheme}://{netloc}{self.path_qs}"


def _is_ip_blocked(ip: Union[ipaddress.IPv4Address, ipaddress.IPv6Address]) -> bool:
    """检查 IP 是否在受限网段内，包括 IPv4-mapped/6to4/Teredo 隧道地址。"""
    addrs_to_check = [ip]
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped
        if mapped is not None:
            addrs_to_check.append(mapped)
        sixtofour = getattr(ip, "sixtofour", None)
        if sixtofour is not None:
            addrs_to_check.append(sixtofour)
        teredo = getattr(ip, "teredo", None)
        if teredo is not None:
            addrs_to_check.extend(teredo)
    for addr in addrs_to_check:
        for net in _BLOCKED_NETWORKS:
            if addr in net:
                return True
    return False


def resolve_and_validate(
    url: str,
    *,
    allow_localhost: bool = False,
    trusted_hosts: Optional[Collection[str]] = None,
) -> ResolvedURL:
    """DNS 解析 → 校验全部 IP → 返回 pin 后的连接信息。

    与 validate_url_ssrf 不同，返回值包含解析后的 IP，
    调用方应直接连接该 IP 以消除 TOCTOU 窗口。
    取 getaddrinfo 返回的第一个结果作为连接目标。

    Raises:
        ValueError: 校验失败时抛出，包含具体原因。
    """
    if not url or not isinstance(url, str):
        raise ValueError("URL 不能为空")

    from apps.services.common.unicode_security import sanitize_url_unicode
    url = sanitize_url_unicode(url)

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"不支持的协议: {parsed.scheme}")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("无效的 URL: 缺少主机名")

    hostname_lower = hostname.lower()
    if hostname_lower in _BLOCKED_HOSTNAMES:
        raise ValueError(f"目标主机被禁止: {hostname}")

    if not allow_localhost and hostname_lower in ("localhost", "0.0.0.0"):
        raise ValueError(f"目标主机被禁止: {hostname}")

    default_port = 443 if parsed.scheme == "https" else 80
    try:
        addr_infos = socket.getaddrinfo(
            hostname,
            parsed.port or default_port,
            proto=socket.IPPROTO_TCP,
        )
    except socket.gaierror:
        raise ValueError(f"无法解析主机: {hostname}")

    if not addr_infos:
        raise ValueError(f"无法解析主机: {hostname}")

    normalized_trusted_hosts = {host.lower() for host in (trusted_hosts or ())}
    host_is_trusted = hostname_lower in normalized_trusted_hosts
    for _fam, _typ, _proto, _cname, sockaddr in addr_infos:
        ip_obj = ipaddress.ip_address(sockaddr[0])
        if not allow_localhost and not host_is_trusted and _is_ip_blocked(ip_obj):
            raise ValueError("目标地址属于受限网段")

    resolved_ip = addr_infos[0][4][0]

    path_qs = parsed.path or "/"
    if parsed.query:
        path_qs += f"?{parsed.query}"
    if parsed.fragment:
        path_qs += f"#{parsed.fragment}"

    return ResolvedURL(
        original_url=url,
        original_host=hostname,
        resolved_ip=resolved_ip,
        scheme=parsed.scheme,
        port=parsed.port,
        path_qs=path_qs,
    )


# ── Transport Adapter（requests 库 IP 钉扎）───────────────────


class _SSRFPinnedAdapter:
    """requests HTTPAdapter 子类工厂，强制连接到预解析的安全 IP。

    延迟导入 requests 以避免模块级依赖。
    内部类定义缓存在 _adapter_cls 中，仅首次创建时执行。
    send() 会修改传入的 PreparedRequest.url 和 Host 头。
    """

    _adapter_cls = None

    @classmethod
    def create(cls, resolved: ResolvedURL, **kwargs):
        if cls._adapter_cls is None:
            from requests.adapters import HTTPAdapter

            class _Adapter(HTTPAdapter):
                def __init__(self, resolved: ResolvedURL, **kw):
                    self._resolved = resolved
                    super().__init__(**kw)

                def send(
                    self, request, stream=False, timeout=None,
                    verify=True, cert=None, proxies=None,
                ):
                    request.url = self._resolved.pinned_url
                    request.headers["Host"] = self._resolved.original_host
                    return super().send(
                        request,
                        stream=stream,
                        timeout=timeout,
                        verify=verify,
                        cert=cert,
                        proxies=proxies,
                    )

                def get_connection(self, url, proxies=None):
                    conn = super().get_connection(url, proxies)
                    _apply_sni_hostname(conn, self._resolved.original_host)
                    return conn

            cls._adapter_cls = _Adapter
        return cls._adapter_cls(resolved, **kwargs)


def pinned_ssl_context():
    """TLS 上下文：验证证书链，跳过主机名校验（连接目标是已验证的 pinned IP）。

    当 HTTP 请求连接到 resolve-and-pin 后的 IP 地址（而非原始域名）时使用。
    证书链仍需由受信 CA 签发（CERT_REQUIRED），但不检查证书的域名匹配
    （check_hostname=False），因为连接目标是我们已验证安全的 IP。
    """
    import ssl

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def _apply_sni_hostname(conn, hostname: str) -> None:
    """在 urllib3 连接池上设置 TLS SNI / 证书校验主机名。

    兼容 urllib3 1.x 和 2.x：
    - pool.server_hostname: 控制 TLS SNI 扩展
    - pool.assert_hostname: 控制证书 hostname 校验
    - pool.conn_kw['server_hostname']: urllib3 1.x 新建连接时透传
    """
    for attr in ("server_hostname", "assert_hostname"):
        if hasattr(conn, attr):
            setattr(conn, attr, hostname)
    conn_kw = getattr(conn, "conn_kw", None)
    if isinstance(conn_kw, dict):
        conn_kw["server_hostname"] = hostname


# ── 重定向安全处理 ─────────────────────────────────────────────


def _follow_redirect(
    status_code: int,
    location: str,
    current_url: str,
    current_method: str,
    redirects_followed: int,
    max_redirects: int,
    kwargs: Dict[str, Any],
) -> tuple:
    """处理重定向逻辑，返回 (new_url, new_method)。

    Raises:
        ValueError: 超过最大重定向次数
    """
    if redirects_followed >= max_redirects:
        raise ValueError(f"超过最大重定向次数 ({max_redirects})")

    if not location:
        raise StopIteration

    new_url = urljoin(current_url, location)
    new_method = current_method

    if status_code in (301, 302, 303):
        new_method = "GET"
        for key in ("data", "json", "content", "files"):
            kwargs.pop(key, None)

    return new_url, new_method


# ── 安全 HTTP 请求（requests 同步）─────────────────────────────


def ssrf_safe_request(
    method: str,
    url: str,
    *,
    allow_redirects: bool = False,
    max_redirects: int = 10,
    timeout: Union[int, float] = 15,
    allow_localhost: bool = False,
    headers: Optional[Dict[str, str]] = None,
    **kwargs: Any,
):
    """发起 SSRF 安全的 HTTP 请求（基于 requests）。

    通过 resolve-validate-pin 模式消除 DNS rebinding TOCTOU 窗口：
    1. DNS 解析获得 IP
    2. 校验 IP 不在内网/元数据网段
    3. 直接连接该 IP（设置 Host 头为原始域名）

    如果 allow_redirects=True，每次重定向都会重新解析并校验目标 IP。

    Returns:
        requests.Response
    Raises:
        ValueError: SSRF 校验失败 / 超过最大重定向次数
        requests.RequestException: 网络错误
    """
    import requests as _requests

    current_url = url
    current_method = method.upper()
    redirects_followed = 0

    while True:
        resolved = resolve_and_validate(
            current_url, allow_localhost=allow_localhost,
        )

        session = _requests.Session()
        adapter = _SSRFPinnedAdapter.create(resolved)
        session.mount("http://", adapter)
        session.mount("https://", adapter)

        req_headers = dict(headers or {})
        req_headers["Host"] = resolved.original_host

        resp = session.request(
            current_method,
            current_url,
            headers=req_headers,
            allow_redirects=False,
            timeout=timeout,
            **kwargs,
        )

        if not allow_redirects or not resp.is_redirect:
            return resp

        redirects_followed += 1
        try:
            current_url, current_method = _follow_redirect(
                resp.status_code,
                resp.headers.get("Location", ""),
                current_url,
                current_method,
                redirects_followed,
                max_redirects,
                kwargs,
            )
        except StopIteration:
            return resp


# ── 安全 HTTP 请求（httpx 异步）───────────────────────────────


async def ssrf_safe_request_async(
    method: str,
    url: str,
    *,
    allow_redirects: bool = False,
    max_redirects: int = 10,
    timeout: Union[int, float] = 15,
    allow_localhost: bool = False,
    trusted_hosts: Optional[Collection[str]] = None,
    headers: Optional[Dict[str, str]] = None,
    **kwargs: Any,
):
    """异步版 SSRF 安全 HTTP 请求（基于 httpx）。

    Returns:
        httpx.Response
    Raises:
        ValueError: SSRF 校验失败 / 超过最大重定向次数
        httpx.HTTPError: 网络错误
    """
    import httpx

    current_url = url
    current_method = method.upper()
    redirects_followed = 0

    while True:
        resolved = resolve_and_validate(
            current_url,
            allow_localhost=allow_localhost,
            trusted_hosts=trusted_hosts,
        )

        req_headers = dict(headers or {})
        req_headers["Host"] = resolved.original_host

        verify: Any = True
        if resolved.scheme == "https":
            verify = pinned_ssl_context()

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            follow_redirects=False,
            verify=verify,
        ) as client:
            resp = await client.request(
                current_method,
                resolved.pinned_url,
                headers=req_headers,
                **kwargs,
            )

        if not allow_redirects or not resp.is_redirect:
            return resp

        redirects_followed += 1
        try:
            current_url, current_method = _follow_redirect(
                resp.status_code,
                resp.headers.get("location", ""),
                current_url,
                current_method,
                redirects_followed,
                max_redirects,
                kwargs,
            )
        except StopIteration:
            return resp


# ── 安全 URL 下载（urllib.request 替代）────────────────────────


class _NoRedirectHandler:
    """urllib.request redirect handler 替代，禁止自动重定向。

    延迟继承以避免模块级导入 urllib.request。
    """

    _handler_cls = None

    @classmethod
    def get_handler_class(cls):
        if cls._handler_cls is None:
            import urllib.request as _ureq

            class _Handler(_ureq.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    raise ValueError(f"重定向被禁止（SSRF 防护）: {newurl}")

            cls._handler_cls = _Handler
        return cls._handler_cls


def ssrf_safe_urlopen(
    url: str,
    *,
    timeout: Union[int, float] = 15,
    data: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
    method: Optional[str] = None,
    allow_localhost: bool = False,
    max_read_bytes: Optional[int] = None,
) -> bytes:
    """安全的 urllib.request.urlopen 替代，返回响应 body bytes。

    通过 resolve-validate-pin 消除 TOCTOU，禁止自动重定向。
    适用于下载文件、字体、图片等场景。

    Raises:
        ValueError: SSRF 校验失败 / 重定向被阻止
        urllib.error.URLError: 网络错误
    """
    import urllib.request

    resolved = resolve_and_validate(url, allow_localhost=allow_localhost)

    req_headers = dict(headers or {})
    req_headers["Host"] = resolved.original_host
    req_headers.setdefault("User-Agent", "TabTin/1.0")

    req = urllib.request.Request(
        resolved.pinned_url,
        data=data,
        headers=req_headers,
    )
    if method:
        req.method = method

    handler_cls = _NoRedirectHandler.get_handler_class()
    opener = urllib.request.build_opener(handler_cls)

    open_kwargs: Dict[str, Any] = {"timeout": timeout}

    if resolved.scheme == "https":
        https_handler = urllib.request.HTTPSHandler(context=pinned_ssl_context())
        opener = urllib.request.build_opener(handler_cls, https_handler)

    with opener.open(req, **open_kwargs) as resp:
        if max_read_bytes is not None:
            return resp.read(max_read_bytes)
        return resp.read()

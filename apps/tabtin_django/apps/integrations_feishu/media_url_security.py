"""飞书媒体 URL 下载安全策略（防 SSRF / 超大响应）。

仅允许 HTTPS + 飞书/Lark CDN hostname allowlist；每一跳重定向都重新校验；
流式读取并在过程中执行字节上限。任意用户可控 URL 不得绕过本模块直连。
"""

from __future__ import annotations

import ipaddress
import logging
from typing import FrozenSet
from urllib.parse import urljoin, urlparse

from apps.services.common.url_security import resolve_and_validate, ssrf_safe_request

logger = logging.getLogger(__name__)

# 精确 hostname 或「.<suffix>」子域；禁止字符串 contains 匹配。
_FEISHU_MEDIA_HOST_SUFFIXES: FrozenSet[str] = frozenset(
    {
        "feishu.cn",
        "lark.cn",
        "feishucdn.com",
        "larksuite.com",
        "larksuitecdn.com",
        "feishuusercontent.com",
        "larksuiteusercontent.com",
    }
)


class FeishuMediaURLError(ValueError):
    """媒体 URL 未通过安全策略。"""


def is_allowed_feishu_media_hostname(hostname: str) -> bool:
    host = (hostname or "").strip().lower().rstrip(".")
    if not host:
        return False
    try:
        # IP literal 一律拒绝（须走域名 allowlist）
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    for suffix in _FEISHU_MEDIA_HOST_SUFFIXES:
        if host == suffix or host.endswith("." + suffix):
            return True
    return False


def validate_feishu_media_url(url: str) -> str:
    """校验待下载的飞书媒体 URL；通过则返回规范化字符串，否则抛 FeishuMediaURLError。"""
    raw = (url or "").strip()
    if not raw:
        raise FeishuMediaURLError("URL 为空")

    parsed = urlparse(raw)
    if parsed.scheme != "https":
        raise FeishuMediaURLError("仅允许 HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise FeishuMediaURLError("不允许 URL 凭据")
    if parsed.port not in (None, 443):
        raise FeishuMediaURLError("不允许非常规端口")

    hostname = parsed.hostname
    if not hostname or not is_allowed_feishu_media_hostname(hostname):
        raise FeishuMediaURLError("hostname 不在飞书媒体 allowlist")

    # DNS + 私网 / 环回 / link-local 等
    try:
        resolve_and_validate(raw, allow_localhost=False)
    except ValueError as exc:
        raise FeishuMediaURLError(str(exc)) from exc

    return raw


def looks_like_feishu_media_url(url: str) -> bool:
    """轻量判断（不发 DNS）：是否像可尝试下载的飞书媒体 HTTPS URL。"""
    raw = (url or "").strip()
    if not raw:
        return False
    parsed = urlparse(raw)
    if parsed.scheme != "https":
        return False
    if parsed.username is not None or parsed.password is not None:
        return False
    if parsed.port not in (None, 443):
        return False
    return is_allowed_feishu_media_hostname(parsed.hostname or "")


def _body_chunk_iterator(resp):
    """按响应类型选择流式迭代器（httpx / requests / 测试桩）。"""
    module = getattr(type(resp), "__module__", "") or ""
    if module.startswith("httpx"):
        return resp.iter_bytes()
    if module.startswith("requests"):
        return resp.iter_content(chunk_size=64 * 1024)

    iter_bytes = getattr(resp, "iter_bytes", None)
    if callable(iter_bytes):
        return iter_bytes()
    iter_content = getattr(resp, "iter_content", None)
    if callable(iter_content):
        return iter_content(chunk_size=64 * 1024)

    data = getattr(resp, "content", b"") or b""
    return [data] if data else []


def stream_read_response(resp, *, max_bytes: int) -> bytes:
    """从 requests/httpx 响应流式读取，超过 max_bytes 立即中止。"""
    if max_bytes <= 0:
        raise FeishuMediaURLError("无效的大小上限")

    chunks: list[bytes] = []
    total = 0
    for chunk in _body_chunk_iterator(resp):
        if not chunk:
            continue
        if not isinstance(chunk, (bytes, bytearray)):
            continue
        total += len(chunk)
        if total > max_bytes:
            close = getattr(resp, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:  # noqa: BLE001 — best-effort
                    pass
            raise FeishuMediaURLError(f"响应超过 {max_bytes} 字节上限")
        chunks.append(bytes(chunk))
    return b"".join(chunks)


def download_feishu_media_url(
    url: str,
    *,
    max_bytes: int,
    timeout: float = 30.0,
    max_redirects: int = 5,
) -> bytes:
    """安全下载飞书媒体直链：每跳 allowlist + SSRF resolve-and-pin，流式硬上限。"""
    current = validate_feishu_media_url(url)
    redirects = 0

    while True:
        resp = ssrf_safe_request(
            "GET",
            current,
            allow_redirects=False,
            timeout=timeout,
            stream=True,
        )
        if getattr(resp, "is_redirect", False) or (
            300 <= getattr(resp, "status_code", 0) < 400
            and resp.headers.get("Location")
        ):
            redirects += 1
            if redirects > max_redirects:
                raise FeishuMediaURLError(f"超过最大重定向次数 ({max_redirects})")
            location = resp.headers.get("Location") or ""
            if not location:
                raise FeishuMediaURLError("重定向缺少 Location")
            current = validate_feishu_media_url(urljoin(current, location))
            close = getattr(resp, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:  # noqa: BLE001
                    pass
            continue

        status = getattr(resp, "status_code", 0)
        if status >= 400:
            raise FeishuMediaURLError(f"下载失败 HTTP {status}")
        return stream_read_response(resp, max_bytes=max_bytes)

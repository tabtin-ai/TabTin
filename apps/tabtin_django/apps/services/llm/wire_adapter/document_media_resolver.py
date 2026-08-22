"""解析聊天文档 ``file_url`` 为可上传字节。

优先复用图片  / 视频  的本机 OSS 直读规则；不走 loopback HTTP。
公网 URL 复用 ``image_fetcher`` 的 SSRF 白名单校验后 HTTP 拉取。
也支持 ``data:`` URL（runtime 偶发 base64 DocumentBlock）。
"""

from __future__ import annotations

import base64
import binascii
import logging
import mimetypes
from typing import NamedTuple, Optional
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from .image_fetcher import (
    ImageFetchError,
    _extract_host,
    _is_trusted_local_oss_url,
    _local_oss_provider_enabled,
    _validate_fetch_url,
)
from .provider_media_upload import (
    DEFAULT_DOCUMENT_MAX_BYTES,
    infer_filename_from_url,
)

logger = logging.getLogger(__name__)

DOCUMENT_FETCH_TIMEOUT_S = 60.0


class DocumentBytes(NamedTuple):
    content: bytes
    filename: str
    mime_type: str


class DocumentResolveError(Exception):
    """无法把 file_url 解析为本地/可读字节。"""

    def __init__(self, reason: str, detail: str = ""):
        self.reason = reason
        self.detail = detail
        super().__init__(detail or reason)


_DOC_EXT_MIME = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".json": "application/json",
}


def _infer_document_mime(filename: str, content_type: Optional[str] = None) -> str:
    if content_type:
        ct = content_type.split(";", 1)[0].strip().lower()
        if ct and ct != "application/octet-stream":
            return ct
    lower = (filename or "").lower()
    for ext, mime in _DOC_EXT_MIME.items():
        if lower.endswith(ext):
            return mime
    guessed, _ = mimetypes.guess_type(filename or "")
    if guessed:
        return guessed
    return "application/octet-stream"


def resolve_document_bytes(
    url: str,
    *,
    max_size_bytes: int = DEFAULT_DOCUMENT_MAX_BYTES,
    fallback_filename: str = "document.bin",
) -> DocumentBytes:
    """把 file_url 解析为字节。

    覆盖：本机 dev OSS ``local-object``、``data:`` URL、白名单公网 CDN/OSS。
    """
    if not url or not isinstance(url, str):
        raise DocumentResolveError("invalid_url", "empty document url")

    if url.startswith("data:"):
        return _read_data_url_document(
            url,
            max_size_bytes=max_size_bytes,
            fallback_filename=fallback_filename,
        )

    if _is_trusted_local_oss_url(url) and _local_oss_provider_enabled():
        return _read_local_oss_document(
            url,
            max_size_bytes=max_size_bytes,
            fallback_filename=fallback_filename,
        )

    return _fetch_remote_document(
        url,
        max_size_bytes=max_size_bytes,
        fallback_filename=fallback_filename,
    )


def _read_data_url_document(
    url: str,
    *,
    max_size_bytes: int,
    fallback_filename: str,
) -> DocumentBytes:
    # data:[<mime>][;base64],<payload>
    try:
        header, payload = url.split(",", 1)
    except ValueError as exc:
        raise DocumentResolveError("invalid_url", "malformed data url") from exc
    meta = header[5:] if header.startswith("data:") else header
    parts = meta.split(";")
    mime = parts[0].strip() if parts and parts[0].strip() else "application/octet-stream"
    is_b64 = any(p.strip().lower() == "base64" for p in parts[1:])
    try:
        content = base64.b64decode(payload) if is_b64 else unquote(payload).encode("utf-8")
    except (binascii.Error, ValueError) as exc:
        raise DocumentResolveError("invalid_url", f"data url decode failed: {exc}") from exc
    if len(content) > max_size_bytes:
        raise DocumentResolveError(
            "oversize",
            f"data url document oversize: {len(content)} bytes > {max_size_bytes}",
        )
    ext = mimetypes.guess_extension(mime.split(";", 1)[0]) or ""
    filename = fallback_filename
    if ext and not filename.lower().endswith(ext):
        stem = filename.rsplit(".", 1)[0] if "." in filename else filename
        filename = f"{stem}{ext}"
    return DocumentBytes(content=content, filename=filename, mime_type=mime)


def _read_local_oss_document(
    url: str,
    *,
    max_size_bytes: int,
    fallback_filename: str,
) -> DocumentBytes:
    parsed = urlparse(url)
    object_key = (parse_qs(parsed.query).get("object_key") or [""])[0]
    if not object_key:
        raise DocumentResolveError("invalid_url", "local oss url missing object_key")

    from apps.services.oss.services.factory import get_oss_service

    result = get_oss_service().download_file(object_key)
    if not result.get("success") or not result.get("data"):
        raise DocumentResolveError(
            "not_found",
            f"local oss object not found: {object_key}",
        )
    data = result["data"]
    content = data.get("content", b"") or b""
    if len(content) > max_size_bytes:
        raise DocumentResolveError(
            "oversize",
            f"local oss document oversize: {len(content)} bytes > {max_size_bytes}",
        )

    filename = fallback_filename or infer_filename_from_url(
        url, fallback=unquote(object_key.rsplit("/", 1)[-1])
    )
    mime = _infer_document_mime(filename, data.get("content_type"))
    return DocumentBytes(content=content, filename=filename, mime_type=mime)


def _fetch_remote_document(
    url: str,
    *,
    max_size_bytes: int,
    fallback_filename: str,
) -> DocumentBytes:
    """白名单公网 URL → HTTP GET 字节（复用 image_fetcher SSRF 守卫）。"""
    try:
        _validate_fetch_url(url)
    except ImageFetchError as exc:
        reason = "unsupported_url" if exc.reason == "forbidden_url" else exc.reason
        raise DocumentResolveError(
            reason,
            exc.detail or f"document url rejected: {exc.reason}",
        ) from exc

    host = _extract_host(url)
    try:
        with httpx.Client(timeout=DOCUMENT_FETCH_TIMEOUT_S, follow_redirects=True) as client:
            resp = client.get(url)
    except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.PoolTimeout) as exc:
        raise DocumentResolveError(
            "unreadable",
            f"fetch document timeout host={host}: {exc}",
        ) from exc
    except httpx.HTTPError as exc:
        raise DocumentResolveError(
            "unreadable",
            f"fetch document network error host={host}: {exc}",
        ) from exc

    final_url = str(getattr(resp, "url", "") or "")
    if final_url.startswith(("http://", "https://")) and final_url != url:
        try:
            _validate_fetch_url(final_url)
        except ImageFetchError as exc:
            raise DocumentResolveError(
                "unsupported_url",
                exc.detail or "document redirect target not allowlisted",
            ) from exc

    if resp.status_code != 200:
        raise DocumentResolveError(
            "unreadable",
            f"fetch document got HTTP {resp.status_code} host={host}",
        )

    content = resp.content or b""
    if len(content) > max_size_bytes:
        raise DocumentResolveError(
            "oversize",
            f"remote document oversize: {len(content)} bytes > {max_size_bytes}",
        )
    if not content:
        raise DocumentResolveError("unreadable", f"empty document body host={host}")

    filename = infer_filename_from_url(url, fallback=fallback_filename or "document.bin")
    mime = _infer_document_mime(filename, resp.headers.get("content-type"))
    logger.info(
        "[document_media_resolver] fetched remote document host=%s bytes=%d filename=%s",
        host,
        len(content),
        filename,
    )
    return DocumentBytes(content=content, filename=filename, mime_type=mime)

"""解析聊天 video_url 为可上传/可内联字节。

优先复用图片  的本机 OSS 直读规则；不走 loopback HTTP。
公网 URL 复用 ``image_fetcher`` 的 SSRF 白名单校验后 HTTP 拉取（与
``document_media_resolver``  对齐）。也支持 ``data:video/...``。
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
    DEFAULT_VIDEO_MAX_BYTES,
    infer_filename_from_url,
)

logger = logging.getLogger(__name__)

VIDEO_FETCH_TIMEOUT_S = 180.0


class VideoBytes(NamedTuple):
    content: bytes
    filename: str
    mime_type: str


class VideoResolveError(Exception):
    """无法把 video_url 解析为本地/可读字节。"""

    def __init__(self, reason: str, detail: str = ""):
        self.reason = reason
        self.detail = detail
        super().__init__(detail or reason)


_VIDEO_EXT_MIME = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".m4v": "video/x-m4v",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".wmv": "video/x-ms-wmv",
    ".3gp": "video/3gpp",
    ".3gpp": "video/3gpp",
    ".flv": "video/x-flv",
}


def _infer_video_mime(filename: str, content_type: Optional[str] = None) -> str:
    if content_type:
        ct = content_type.split(";", 1)[0].strip().lower()
        if ct.startswith("video/"):
            return ct
    lower = (filename or "").lower()
    for ext, mime in _VIDEO_EXT_MIME.items():
        if lower.endswith(ext):
            return mime
    guessed, _ = mimetypes.guess_type(filename or "")
    if guessed and guessed.startswith("video/"):
        return guessed
    return "video/mp4"


def resolve_video_bytes(
    url: str,
    *,
    max_size_bytes: int = DEFAULT_VIDEO_MAX_BYTES,
    fallback_filename: str = "video.mp4",
) -> VideoBytes:
    """把 video_url 解析为字节。

    覆盖：本机 dev OSS ``local-object``、``data:`` URL、白名单公网 CDN/OSS。
    """
    if not url or not isinstance(url, str):
        raise VideoResolveError("invalid_url", "empty video url")

    if url.startswith("data:"):
        return _read_data_url_video(
            url,
            max_size_bytes=max_size_bytes,
            fallback_filename=fallback_filename,
        )

    if _is_trusted_local_oss_url(url) and _local_oss_provider_enabled():
        return _read_local_oss_video(url, max_size_bytes=max_size_bytes)

    return _fetch_remote_video(
        url,
        max_size_bytes=max_size_bytes,
        fallback_filename=fallback_filename,
    )


def _read_data_url_video(
    url: str,
    *,
    max_size_bytes: int,
    fallback_filename: str,
) -> VideoBytes:
    try:
        header, payload = url.split(",", 1)
    except ValueError as exc:
        raise VideoResolveError("invalid_url", "malformed data url") from exc
    meta = header[5:] if header.startswith("data:") else header
    parts = meta.split(";")
    mime = parts[0].strip() if parts and parts[0].strip() else "video/mp4"
    is_b64 = any(p.strip().lower() == "base64" for p in parts[1:])
    try:
        content = base64.b64decode(payload) if is_b64 else unquote(payload).encode("utf-8")
    except (binascii.Error, ValueError) as exc:
        raise VideoResolveError("invalid_url", f"data url decode failed: {exc}") from exc
    if len(content) > max_size_bytes:
        raise VideoResolveError(
            "oversize",
            f"data url video oversize: {len(content)} bytes > {max_size_bytes}",
        )
    filename = infer_filename_from_url(url, fallback=fallback_filename or "video.mp4")
    if not any(filename.lower().endswith(ext) for ext in _VIDEO_EXT_MIME):
        ext = mimetypes.guess_extension(mime.split(";", 1)[0]) or ".mp4"
        stem = filename.rsplit(".", 1)[0] if "." in filename else filename
        filename = f"{stem}{ext}"
    return VideoBytes(
        content=content,
        filename=filename,
        mime_type=_infer_video_mime(filename, mime),
    )


def _read_local_oss_video(url: str, *, max_size_bytes: int) -> VideoBytes:
    parsed = urlparse(url)
    object_key = (parse_qs(parsed.query).get("object_key") or [""])[0]
    if not object_key:
        raise VideoResolveError("invalid_url", "local oss url missing object_key")

    from apps.services.oss.services.factory import get_oss_service

    result = get_oss_service().download_file(object_key)
    if not result.get("success") or not result.get("data"):
        raise VideoResolveError(
            "not_found",
            f"local oss object not found: {object_key}",
        )
    data = result["data"]
    content = data.get("content", b"") or b""
    if len(content) > max_size_bytes:
        raise VideoResolveError(
            "oversize",
            f"local oss video oversize: {len(content)} bytes > {max_size_bytes}",
        )

    filename = infer_filename_from_url(
        url, fallback=unquote(object_key.rsplit("/", 1)[-1])
    )
    mime = _infer_video_mime(filename, data.get("content_type"))
    return VideoBytes(content=content, filename=filename, mime_type=mime)


def _fetch_remote_video(
    url: str,
    *,
    max_size_bytes: int,
    fallback_filename: str,
) -> VideoBytes:
    """白名单公网 URL → HTTP GET 字节（复用 image_fetcher SSRF 守卫）。"""
    try:
        _validate_fetch_url(url)
    except ImageFetchError as exc:
        reason = "unsupported_url" if exc.reason == "forbidden_url" else exc.reason
        raise VideoResolveError(
            reason,
            exc.detail or f"video url rejected: {exc.reason}",
        ) from exc

    host = _extract_host(url)
    try:
        with httpx.Client(timeout=VIDEO_FETCH_TIMEOUT_S, follow_redirects=True) as client:
            resp = client.get(url)
    except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.PoolTimeout) as exc:
        raise VideoResolveError(
            "unreadable",
            f"fetch video timeout host={host}: {exc}",
        ) from exc
    except httpx.HTTPError as exc:
        raise VideoResolveError(
            "unreadable",
            f"fetch video network error host={host}: {exc}",
        ) from exc

    final_url = str(getattr(resp, "url", "") or "")
    if final_url.startswith(("http://", "https://")) and final_url != url:
        try:
            _validate_fetch_url(final_url)
        except ImageFetchError as exc:
            raise VideoResolveError(
                "unsupported_url",
                exc.detail or "video redirect target not allowlisted",
            ) from exc

    if resp.status_code != 200:
        raise VideoResolveError(
            "unreadable",
            f"fetch video got HTTP {resp.status_code} host={host}",
        )

    content = resp.content or b""
    if len(content) > max_size_bytes:
        raise VideoResolveError(
            "oversize",
            f"remote video oversize: {len(content)} bytes > {max_size_bytes}",
        )
    if not content:
        raise VideoResolveError("unreadable", f"empty video body host={host}")

    filename = infer_filename_from_url(url, fallback=fallback_filename or "video.mp4")
    mime = _infer_video_mime(filename, resp.headers.get("content-type"))
    logger.info(
        "[video_media_resolver] fetched remote video host=%s bytes=%d filename=%s",
        host,
        len(content),
        filename,
    )
    return VideoBytes(content=content, filename=filename, mime_type=mime)

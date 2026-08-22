"""通用上游 Files API / data-URL 媒体上传。

由 ``ImageCaps`` / ``VideoCaps`` / ``DocumentCaps`` 的 ``upload_mode`` +
``files_api`` 配置驱动，不绑定具体 provider_key。例如 Moonshot/Kimi：

- endpoint=``/files``
- purpose=``video``（视频）/ ``file-extract``（文档）或其它可配 purpose
- url_scheme=``ms://``（视频引用）；文档走 extract 文本注入，不依赖 scheme

参见官方：大文件先上传，再以 ``{url_scheme}{file_id}`` 引用；
小图/小视频可用 ``inline_base64``（``data:{mime};base64,...``）；
文档 Q&A 用 ``purpose=file-extract`` + ``GET /files/{id}/content``。
"""

from __future__ import annotations

import base64
import hashlib
import logging
import mimetypes
from typing import Optional
from urllib.parse import unquote, urlparse

import httpx

logger = logging.getLogger(__name__)

DEFAULT_VIDEO_MAX_BYTES = 100 * 1024 * 1024
DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024
DEFAULT_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024
DEFAULT_UPLOAD_TIMEOUT_S = 180.0
FILE_EXTRACT_CACHE_PREFIX = "llm:file_extract:"
PDF_LOCAL_EXTRACT_CACHE_PREFIX = "llm:pdf_local_extract:v2:"
FILE_EXTRACT_CACHE_TTL_S = 24 * 3600


def infer_filename_from_url(url: str, fallback: str = "media.bin") -> str:
    try:
        path = unquote(urlparse(url).path)
        name = path.rsplit("/", 1)[-1]
        if name and "." in name:
            return name
    except Exception:
        pass
    return fallback


def to_provider_file_url(file_id: str, url_scheme: str) -> str:
    """``file_id`` + scheme → 上游可引用的 URL（如 ``ms://file-xxx``）。"""
    fid = (file_id or "").strip()
    if not fid:
        raise ValueError("empty file_id")
    scheme = (url_scheme or "").strip() or "ms://"
    if not scheme.endswith("://") and not scheme.endswith(":"):
        if "://" not in scheme:
            scheme = f"{scheme}://"
    if fid.startswith(scheme):
        return fid
    return f"{scheme}{fid}"


def upload_media_bytes(
    *,
    api_base: str,
    api_key: str,
    content: bytes,
    filename: str,
    purpose: str,
    endpoint: str = "/files",
    id_field: str = "id",
    max_size_bytes: int = DEFAULT_VIDEO_MAX_BYTES,
    timeout_s: float = DEFAULT_UPLOAD_TIMEOUT_S,
    default_mime: str = "application/octet-stream",
    mime_prefix: Optional[str] = None,
) -> str:
    """multipart 上传到 ``{api_base}{endpoint}``，返回响应中的 file id。"""
    if not api_base:
        raise ValueError("missing api_base for media upload")
    if not api_key:
        raise ValueError("missing api_key for media upload")
    if not content:
        raise ValueError("empty media content")
    if len(content) > max_size_bytes:
        raise ValueError(
            f"media oversize: {len(content)} bytes > {max_size_bytes}"
        )

    name = (filename or "media.bin").strip() or "media.bin"
    mime, _ = mimetypes.guess_type(name)
    if mime_prefix:
        if not mime or not str(mime).startswith(mime_prefix):
            mime = default_mime
    elif not mime:
        mime = default_mime

    path = endpoint if str(endpoint).startswith("/") else f"/{endpoint}"
    url = f"{api_base.rstrip('/')}{path}"
    headers = {"Authorization": f"Bearer {api_key}"}
    files = {"file": (name, content, mime)}
    data = {"purpose": purpose or "file"}

    logger.info(
        "[provider_media_upload] uploading bytes=%d filename=%s purpose=%s endpoint=%s",
        len(content),
        name,
        purpose,
        path,
    )
    with httpx.Client(timeout=timeout_s) as client:
        resp = client.post(url, headers=headers, files=files, data=data)

    if resp.status_code >= 400:
        detail = (resp.text or "")[:300]
        raise RuntimeError(
            f"files upload failed status={resp.status_code}: {detail}"
        )

    payload = resp.json()
    file_id = payload.get(id_field or "id") if isinstance(payload, dict) else None
    if not file_id:
        raise RuntimeError(f"files upload missing {id_field!r}: {payload!r}")
    logger.info(
        "[provider_media_upload] uploaded file_id=%s bytes=%d",
        file_id,
        len(content),
    )
    return str(file_id)


def to_data_url(content: bytes, mime_type: str, *, fallback_mime: str) -> str:
    mime = (mime_type or fallback_mime).split(";", 1)[0].strip().lower()
    if "/" not in mime:
        mime = fallback_mime
    encoded = base64.b64encode(content).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def to_data_video_url(content: bytes, mime_type: str) -> str:
    """官方 quickstart 形态：``data:video/{ext};base64,...``。"""
    mime = (mime_type or "video/mp4").split(";", 1)[0].strip().lower()
    if not mime.startswith("video/"):
        mime = "video/mp4"
    return to_data_url(content, mime, fallback_mime="video/mp4")


def to_data_image_url(content: bytes, mime_type: str) -> str:
    """官方图片形态：``data:image/{ext};base64,...``。"""
    mime = (mime_type or "image/png").split(";", 1)[0].strip().lower()
    if not mime.startswith("image/"):
        mime = "image/png"
    return to_data_url(content, mime, fallback_mime="image/png")


def fetch_file_extract_content(
    *,
    api_base: str,
    api_key: str,
    file_id: str,
    endpoint: str = "/files",
    timeout_s: float = DEFAULT_UPLOAD_TIMEOUT_S,
) -> str:
    """``GET {api_base}{endpoint}/{file_id}/content`` → 提取文本。"""
    if not api_base:
        raise ValueError("missing api_base for file extract")
    if not api_key:
        raise ValueError("missing api_key for file extract")
    fid = (file_id or "").strip()
    if not fid:
        raise ValueError("empty file_id for file extract")

    path = endpoint if str(endpoint).startswith("/") else f"/{endpoint}"
    url = f"{api_base.rstrip('/')}{path.rstrip('/')}/{fid}/content"
    headers = {"Authorization": f"Bearer {api_key}"}

    logger.info(
        "[provider_media_upload] fetching file extract content file_id=%s",
        fid,
    )
    with httpx.Client(timeout=timeout_s) as client:
        resp = client.get(url, headers=headers)

    if resp.status_code >= 400:
        detail = (resp.text or "")[:300]
        raise RuntimeError(
            f"files content failed status={resp.status_code}: {detail}"
        )

    text = resp.text if resp.text is not None else ""
    logger.info(
        "[provider_media_upload] file extract content file_id=%s chars=%d",
        fid,
        len(text),
    )
    return text


def delete_uploaded_file(
    *,
    api_base: str,
    api_key: str,
    file_id: str,
    endpoint: str = "/files",
    timeout_s: float = 30.0,
) -> None:
    """尽力删除上游文件，释放 Files API 配额（失败只打日志）。"""
    fid = (file_id or "").strip()
    if not api_base or not api_key or not fid:
        return
    path = endpoint if str(endpoint).startswith("/") else f"/{endpoint}"
    url = f"{api_base.rstrip('/')}{path.rstrip('/')}/{fid}"
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        with httpx.Client(timeout=timeout_s) as client:
            resp = client.delete(url, headers=headers)
        if resp.status_code >= 400:
            logger.warning(
                "[provider_media_upload] delete file failed file_id=%s status=%s",
                fid,
                resp.status_code,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[provider_media_upload] delete file error file_id=%s err=%s",
            fid,
            exc,
        )


def extract_document_text_via_files_api(
    *,
    api_base: str,
    api_key: str,
    content: bytes,
    filename: str,
    purpose: str = "file-extract",
    endpoint: str = "/files",
    id_field: str = "id",
    max_size_bytes: int = DEFAULT_DOCUMENT_MAX_BYTES,
    timeout_s: float = DEFAULT_UPLOAD_TIMEOUT_S,
    max_extract_chars: Optional[int] = 200_000,
    use_cache: bool = True,
    cleanup_remote: bool = True,
) -> str:
    """上传文档 → 拉取 extract 文本 →（可选）删远程文件 / 写缓存。

    Moonshot 官方文档 Q&A 路径；返回可注入 messages 的纯文本。
    """
    if content.startswith(b"%PDF-"):
        try:
            cached_pdf = (
                _file_extract_cache_get(content, prefix=PDF_LOCAL_EXTRACT_CACHE_PREFIX)
                if use_cache
                else None
            )
            if cached_pdf is not None:
                return _truncate_extract(cached_pdf, max_extract_chars)

            from .pdf_text_extractor import extract_pdf_text_for_model

            local_text = extract_pdf_text_for_model(
                content,
                filename=filename,
                max_chars=max_extract_chars,
            )
            if use_cache:
                _file_extract_cache_put(
                    content,
                    local_text,
                    prefix=PDF_LOCAL_EXTRACT_CACHE_PREFIX,
                )
            logger.info(
                "[provider_media_upload] local PDF extract bytes=%d chars=%d",
                len(content),
                len(local_text),
            )
            return local_text
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[provider_media_upload] local PDF extract failed; "
                "falling back to provider Files API: %s",
                exc,
            )

    if use_cache:
        cached = _file_extract_cache_get(content)
        if cached is not None:
            return _truncate_extract(cached, max_extract_chars)

    file_id = upload_media_bytes(
        api_base=api_base,
        api_key=api_key,
        content=content,
        filename=filename,
        purpose=purpose or "file-extract",
        endpoint=endpoint,
        id_field=id_field,
        max_size_bytes=max_size_bytes,
        timeout_s=timeout_s,
        default_mime="application/octet-stream",
    )
    try:
        text = fetch_file_extract_content(
            api_base=api_base,
            api_key=api_key,
            file_id=file_id,
            endpoint=endpoint,
            timeout_s=timeout_s,
        )
    finally:
        if cleanup_remote:
            delete_uploaded_file(
                api_base=api_base,
                api_key=api_key,
                file_id=file_id,
                endpoint=endpoint,
            )

    if use_cache:
        _file_extract_cache_put(content, text)
    return _truncate_extract(text, max_extract_chars)


def _truncate_extract(text: str, max_chars: Optional[int]) -> str:
    if max_chars is None or max_chars <= 0:
        return text
    if len(text) <= max_chars:
        return text
    return (
        text[:max_chars]
        + f"\n\n…[文档提取已截断，原文约 {len(text)} 字符，保留前 {max_chars} 字符]"
    )


def _file_extract_cache_key(
    content: bytes,
    *,
    prefix: str = FILE_EXTRACT_CACHE_PREFIX,
) -> str:
    digest = hashlib.sha256(content).hexdigest()
    return f"{prefix}{digest}"


def _file_extract_cache_get(
    content: bytes,
    *,
    prefix: str = FILE_EXTRACT_CACHE_PREFIX,
) -> Optional[str]:
    try:
        from django.core.cache import cache

        value = cache.get(_file_extract_cache_key(content, prefix=prefix))
        if isinstance(value, str):
            logger.info(
                "[provider_media_upload] file extract cache hit bytes=%d chars=%d",
                len(content),
                len(value),
            )
            return value
    except Exception as exc:  # noqa: BLE001
        logger.debug("[provider_media_upload] file extract cache get skip: %s", exc)
    return None


def _file_extract_cache_put(
    content: bytes,
    text: str,
    *,
    prefix: str = FILE_EXTRACT_CACHE_PREFIX,
) -> None:
    try:
        from django.core.cache import cache

        cache.set(
            _file_extract_cache_key(content, prefix=prefix),
            text,
            timeout=FILE_EXTRACT_CACHE_TTL_S,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[provider_media_upload] file extract cache put skip: %s", exc)

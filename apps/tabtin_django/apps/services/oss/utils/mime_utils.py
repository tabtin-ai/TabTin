"""
MIME ↔ 扩展名工具函数

从 settings.OSS_MIME_TO_EXTENSIONS 派生，提供统一的 MIME→扩展名推断。
"""
from __future__ import annotations

import mimetypes
import re
import sys
from functools import lru_cache


_MIME_TYPE_RE = re.compile(
    r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$"
)


@lru_cache(maxsize=1)
def _mime_to_ext_map() -> dict[str, str]:
    """从 OSS_MIME_TO_EXTENSIONS 构建 MIME→首选扩展名 的 dict"""
    from django.conf import settings
    raw: dict[str, list[str]] = getattr(settings, 'OSS_MIME_TO_EXTENSIONS', {})
    return {mime: exts[0] for mime, exts in raw.items() if exts}


def extension_for_mime(content_type: str, fallback: str = 'bin') -> str:
    """从 MIME 类型推断文件扩展名（不带 .）"""
    return _mime_to_ext_map().get(content_type.lower(), fallback)


def normalize_mime_type(value: str | None) -> str:
    """Return a safe MIME value for storage/headers."""
    candidate = (value or "").split(";", 1)[0].strip().lower()
    if len(candidate) <= 100 and _MIME_TYPE_RE.fullmatch(candidate):
        return candidate
    return "application/octet-stream"


def resolve_mime_type(
    declared_mime: str | None,
    file_name: str | None = None,
) -> str:
    """Resolve a storage-safe MIME type from the declaration and filename."""
    normalized_declared = normalize_mime_type(declared_mime)
    if normalized_declared != "application/octet-stream":
        return normalized_declared

    guessed_mime, _ = mimetypes.guess_type(file_name or "")
    return normalize_mime_type(guessed_mime)


def detect_mime_from_buffer(
    file_content: bytes,
    fallback: str = "application/octet-stream",
) -> str:
    """Detect MIME without importing libmagic during module import.

    python-magic loads a native library via ctypes. On the Windows dev runtime
    used by Git Bash/Daphne this can crash the process, so Windows uses the
    caller-provided fallback instead of attempting native detection.
    """
    normalized_fallback = normalize_mime_type(fallback)
    if sys.platform == "win32":
        return normalized_fallback
    try:
        import magic as _magic
        return normalize_mime_type(_magic.from_buffer(file_content, mime=True))
    except Exception:
        return normalized_fallback


def detect_mime_from_file(
    file_path: str,
    fallback: str = "application/octet-stream",
) -> str:
    """Detect MIME for a path using the same Windows-safe fallback policy."""
    normalized_fallback = normalize_mime_type(fallback)
    if sys.platform == "win32":
        return normalized_fallback
    try:
        import magic as _magic
        return normalize_mime_type(_magic.from_file(file_path, mime=True))
    except Exception:
        return normalized_fallback


def _on_setting_changed(**kwargs):
    if kwargs.get('setting') == 'OSS_MIME_TO_EXTENSIONS':
        _mime_to_ext_map.cache_clear()


try:
    from django.test.signals import setting_changed
    setting_changed.connect(_on_setting_changed)
except ImportError:
    pass

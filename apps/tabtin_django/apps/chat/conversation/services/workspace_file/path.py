"""会话工作区本地文件路径规范化。

对齐前端 ``turnArtifactPathOps.canonicalizeArtifactRelativePath`` /
``isDeliverableRelativePath``，供写时索引与预览鉴权共用。
"""

from __future__ import annotations

import re
from typing import Optional

TEMP_DIR_SEGMENTS = frozenset({"tmp", "temp", ".tmp", ".temp"})
_DRIVE_PREFIX_RE = re.compile(r"^[a-zA-Z]:[\\/]")
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def strip_shell_path_quotes(value: str) -> str:
    cleaned = str(value or "").strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {"'", '"'}:
        return cleaned[1:-1]
    return cleaned


def canonicalize_artifact_relative_path(input_path: str) -> Optional[str]:
    cleaned = strip_shell_path_quotes(input_path).strip()
    if not cleaned:
        return None
    if cleaned.startswith("/") or cleaned.startswith("~") or _DRIVE_PREFIX_RE.match(cleaned):
        return None
    if _SCHEME_RE.match(cleaned):
        return None

    segments = cleaned.replace("\\", "/").split("/")
    out: list[str] = []
    for seg in segments:
        if not seg or seg == ".":
            continue
        if seg == "..":
            if not out:
                return None
            out.pop()
            continue
        out.append(seg)
    if not out:
        return None
    return "/".join(out)


def is_deliverable_relative_path(path: str) -> bool:
    canonical = canonicalize_artifact_relative_path(path)
    if canonical is None:
        canonical = path.replace("\\", "/")
    segments = [seg for seg in canonical.split("/") if seg]
    if not segments:
        return False
    if segments[0].lower() in TEMP_DIR_SEGMENTS:
        return False
    if any(seg.startswith(".") for seg in segments):
        return False
    filename = segments[-1]
    dot = filename.rfind(".")
    if dot <= 0 or dot == len(filename) - 1:
        return False
    return True


def basename_of(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    cleaned = strip_shell_path_quotes(path)
    parts = [p for p in re.split(r"[\\/]", cleaned) if p]
    return parts[-1] if parts else None

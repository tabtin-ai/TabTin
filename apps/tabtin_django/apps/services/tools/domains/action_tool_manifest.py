from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List

from django.conf import settings

from apps.services.repo_root import get_repo_root

logger = logging.getLogger(__name__)

DEFAULT_RELATIVE_PATHS = [
    Path("packages/action-tools/manifest.json"),
    Path("packages/action-tools/dist/manifest.json"),
]


def _resolve_manifest_path() -> Path:
    override = os.getenv("ACTION_TOOLS_MANIFEST_PATH")
    if override:
        return Path(override)
    repo_root = get_repo_root()
    for relative in DEFAULT_RELATIVE_PATHS:
        candidate = repo_root / relative
        if candidate.exists():
            return candidate
    return repo_root / DEFAULT_RELATIVE_PATHS[0]


def _normalize_manifest(data: Any, manifest_path: Path) -> Dict[str, Any]:
    if isinstance(data, dict):
        tools = data.get("tools")
        tool_cap_map = data.get("toolCapabilityMap")
        if isinstance(tools, list):
            result: Dict[str, Any] = {
                "generated_at": data.get("generated_at"),
                "tools": tools,
                "path": str(manifest_path),
            }
            if isinstance(tool_cap_map, dict):
                result["toolCapabilityMap"] = tool_cap_map
            return result
    if isinstance(data, list):
        return {
            "generated_at": None,
            "tools": data,
            "path": str(manifest_path),
        }
    return {
        "generated_at": None,
        "tools": [],
        "path": str(manifest_path),
        "error": "invalid_manifest_format",
    }


@lru_cache(maxsize=1)
def load_action_tool_manifest() -> Dict[str, Any]:
    manifest_path = _resolve_manifest_path()
    if not manifest_path.exists():
        logger.warning("[ActionToolsManifest] manifest not found: %s", manifest_path)
        return {
            "generated_at": None,
            "tools": [],
            "path": str(manifest_path),
            "error": "manifest_not_found",
        }
    try:
        raw = manifest_path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except Exception as exc:
        logger.warning("[ActionToolsManifest] manifest load failed: %s", exc)
        return {
            "generated_at": None,
            "tools": [],
            "path": str(manifest_path),
            "error": "manifest_load_failed",
        }
    return _normalize_manifest(data, manifest_path)


def refresh_action_tool_manifest() -> Dict[str, Any]:
    load_action_tool_manifest.cache_clear()
    return load_action_tool_manifest()


def get_action_tool_manifest() -> List[dict]:
    return load_action_tool_manifest().get("tools", [])


def get_tool_capability_map() -> Dict[str, str]:
    """从 manifest.json 的 toolCapabilityMap 获取 tool_name → capability 映射。
    如果 manifest 中没有该字段（未重新生成），返回空字典。"""
    return load_action_tool_manifest().get("toolCapabilityMap") or {}


__all__ = [
    "load_action_tool_manifest",
    "refresh_action_tool_manifest",
    "get_action_tool_manifest",
    "get_tool_capability_map",
]

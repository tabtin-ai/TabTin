from __future__ import annotations

import json
import os
import logging
from functools import lru_cache
from typing import Iterable, Set, Dict, Any

logger = logging.getLogger(__name__)


def _normalize_items(items: Iterable[Any]) -> Set[str]:
    result: Set[str] = set()
    for item in items:
        if not isinstance(item, str):
            continue
        value = item.strip()
        if value:
            result.add(value)
    return result


def normalize_optional_tool_allowlist(raw: Any) -> Dict[str, Any]:
    allow_all = False
    tools: Set[str] = set()
    apps: Set[str] = set()

    def apply_item(token: str) -> None:
        nonlocal allow_all, tools, apps
        token = token.strip()
        if not token:
            return
        if token in {"*", "all", "ALL"}:
            allow_all = True
            return
        lower = token.lower()
        if lower.startswith("tool:"):
            tools.add(token.split(":", 1)[1].strip())
            return
        if lower.startswith("app:") or lower.startswith("appid:"):
            apps.add(token.split(":", 1)[1].strip())
            return
        # Fallback: allow by tool name or app id
        tools.add(token)
        apps.add(token)

    if not raw:
        return {"allow_all": False, "tools": [], "apps": []}

    try:
        if isinstance(raw, str) and (raw.startswith("{") or raw.startswith("[")):
            raw = json.loads(raw)
        if isinstance(raw, dict):
            allow_all = bool(raw.get("allow_all") or raw.get("allowAll"))
            tools = _normalize_items(raw.get("tools", []))
            apps = _normalize_items(raw.get("apps", []))
            return {"allow_all": allow_all, "tools": sorted(tools), "apps": sorted(apps)}
        if isinstance(raw, list):
            for item in raw:
                apply_item(str(item))
            return {"allow_all": allow_all, "tools": sorted(tools), "apps": sorted(apps)}
        if isinstance(raw, str):
            for item in raw.split(","):
                apply_item(item)
            return {"allow_all": allow_all, "tools": sorted(tools), "apps": sorted(apps)}
    except Exception:
        logger.warning("[OptionalTools] Failed to parse allowlist (raw=%r)", raw, exc_info=True)
    return {"allow_all": allow_all, "tools": sorted(tools), "apps": sorted(apps)}


def merge_optional_tool_allowlists(*allowlists: Dict[str, Any]) -> Dict[str, Any]:
    allow_all = False
    tools: Set[str] = set()
    apps: Set[str] = set()
    for raw in allowlists:
        if not raw:
            continue
        allow_all = allow_all or bool(raw.get("allow_all"))
        tools.update(raw.get("tools") or [])
        apps.update(raw.get("apps") or [])
    return {"allow_all": allow_all, "tools": tools, "apps": apps}


def resolve_optional_tool_policy(allowlist: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """
    合并可选工具 allowlist。
    规则：全局 allowlist 与项目级 allowlist 取并集；任一 allow_all 即放开全部。
    """
    merged = merge_optional_tool_allowlists(load_optional_tool_allowlist(), allowlist or {})
    return {
        "allow_all": bool(merged.get("allow_all")),
        "tools": set(merged.get("tools") or set()),
        "apps": set(merged.get("apps") or set()),
    }


def _summarize_policy(policy: Dict[str, Any]) -> Dict[str, Any]:
    tools = list(policy.get("tools") or [])
    apps = list(policy.get("apps") or [])
    tools.sort()
    apps.sort()
    return {
        "allow_all": bool(policy.get("allow_all")),
        "tool_count": len(tools),
        "app_count": len(apps),
        "tools_preview": tools[:5],
        "apps_preview": apps[:5],
    }

@lru_cache(maxsize=1)
def load_optional_tool_allowlist() -> Dict[str, Any]:
    raw = os.getenv("OPTIONAL_TOOL_ALLOWLIST", "").strip()
    return normalize_optional_tool_allowlist(raw)


def is_optional_tool_allowed(
    tool_name: str | None,
    app_id: str | None,
    *,
    allowlist: Dict[str, Any] | None = None,
    audit: bool = False,
) -> bool:
    policy = resolve_optional_tool_policy(allowlist)
    if policy.get("allow_all"):
        return True
    tools = policy.get("tools") or set()
    apps = policy.get("apps") or set()
    if tool_name and tool_name in tools:
        return True
    if app_id and app_id in apps:
        return True
    if audit:
        summary = _summarize_policy(policy)
        logger.info(
            "[Tools] optional tool blocked: tool=%s app=%s allow_all=%s tools=%s apps=%s",
            tool_name or "",
            app_id or "",
            summary.get("allow_all"),
            summary.get("tools_preview"),
            summary.get("apps_preview"),
        )
    return False


__all__ = [
    "load_optional_tool_allowlist",
    "normalize_optional_tool_allowlist",
    "merge_optional_tool_allowlists",
    "resolve_optional_tool_policy",
    "is_optional_tool_allowed",
]

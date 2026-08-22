from __future__ import annotations

from typing import List, Optional, Set

from apps.services.tools.domains.action_tool_manifest import get_action_tool_manifest
from apps.tabtinspace.services.app_settings_service import AppSettingsService


def resolve_enabled_action_app_ids(
    user_id: Optional[str],
    space_id: Optional[str],
) -> Optional[List[str]]:
    """
    根据用户与 Space 返回允许的 action-tools appId 列表。
    - 返回 None 表示不做过滤
    - 返回 [] 表示全部禁用
    """
    if not user_id or not space_id:
        return None

    tools = get_action_tool_manifest()
    app_ids: Set[str] = {
        tool.get("appId")
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("appId"), str) and tool.get("appId")
    }
    if not app_ids:
        return None

    try:
        return AppSettingsService.resolve_enabled_app_ids(
            user_id=str(user_id),
            space_id=str(space_id),
            available_app_ids=app_ids,
        )
    except Exception:
        return None


def resolve_enabled_app_ids_for_agent(
    user_id: Optional[str],
    space_id: Optional[str],
    available_app_ids: Optional[Set[str]] = None,
) -> tuple[Optional[List[str]], dict]:
    """
    返回 (允许的 appId 列表, optional tools allowlist)
    """
    if not user_id or not space_id:
        return None, {}

    try:
        allowed = AppSettingsService.resolve_enabled_app_ids(
            user_id=str(user_id),
            space_id=str(space_id),
            available_app_ids=available_app_ids,
        )
    except Exception:
        return None, {}

    allowlist = AppSettingsService.resolve_optional_tool_allowlist(
        user_id=str(user_id),
        space_id=str(space_id),
    )
    return allowed, allowlist


__all__ = ["resolve_enabled_action_app_ids", "resolve_enabled_app_ids_for_agent"]

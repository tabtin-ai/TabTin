"""Agent 展示名解析。"""

from __future__ import annotations

from typing import Any


OWNER_NAME_TOKEN = "{owner}"


def _resolve_owner_name(agent: Any) -> str:
    owner = getattr(agent, "owner_user", None)
    if owner is None:
        organization = getattr(agent, "organization", None)
        owner = getattr(organization, "owner", None)
    if owner is None:
        return ""

    get_display_name = getattr(owner, "get_display_name", None)
    if callable(get_display_name):
        display_name = str(get_display_name() or "").strip()
        if display_name:
            return display_name

    return str(
        getattr(owner, "nickname", None)
        or getattr(owner, "username", None)
        or ""
    ).strip()


def resolve_agent_display_name(agent: Any) -> str:
    """展开模板 Agent 名称中的 owner 占位符。"""
    name = str(getattr(agent, "name", "") or "")
    if OWNER_NAME_TOKEN not in name:
        return name
    return name.replace(OWNER_NAME_TOKEN, _resolve_owner_name(agent)).strip()

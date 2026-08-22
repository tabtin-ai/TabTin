"""Agent API 序列化。"""

from __future__ import annotations

from apps.agent.schemas import AgentOut, AgentSummaryOut

_RESOLVE_PERSONAL_RULES = object()


def serialize_agent_summary(agent) -> dict:
    """列表专用摘要序列化。

    与 :func:`serialize_agent` 的关键区别：不解析 ``personal_rules``
    （避免每行一次 ``UserProfile`` 查询形成 N+1）、不解析完整
    ``agent_config`` / memory 配置。``custom_rules`` 随表字段带出，
    供 Composer Agent 下拉副行直接展示人设。
    """
    from apps.agent.display_name import resolve_agent_display_name

    data = AgentSummaryOut.model_validate(agent).model_dump()
    data["display_name"] = resolve_agent_display_name(agent)
    return data


def serialize_agent(
    agent,
    *,
    workspace=None,
    personal_rules=_RESOLVE_PERSONAL_RULES,
) -> dict:
    """将 Agent ORM 实例序列化为 API dict。"""
    from apps.agent.display_name import resolve_agent_display_name
    from apps.tabtinspace.memory_defaults import resolve_full_memory_config

    data = AgentOut.model_validate(agent).model_dump()
    data["display_name"] = resolve_agent_display_name(agent)
    ac = data.get("agent_config") or {}
    ac["memory"] = resolve_full_memory_config(ac.get("memory"))
    data["agent_config"] = ac

    from apps.services.agent_engine.services.prompt_forward_service import (
        PromptForwardService,
    )

    owner_id = (
        getattr(agent, "owner_user_id", None)
        or getattr(getattr(agent, "organization", None), "owner_id", None)
    )
    data["personal_rules"] = (
        PromptForwardService.resolve_personal_rules_by_owner_id(owner_id)
        if personal_rules is _RESOLVE_PERSONAL_RULES
        else personal_rules
    )

    from apps.services.common.agent_governance_resolver import resolve_allow_yolo_mode

    org = getattr(agent, "organization", None)
    data["organization_allow_member_yolo"] = resolve_allow_yolo_mode(
        getattr(org, "settings", None) if org else None
    )
    return data

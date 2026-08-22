"""
SubagentPolicy - 子 Agent 模型/思考/工具策略
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple
import logging

from apps.services.agent_engine.configuration import OrchestrationConfiguration
from apps.services.common.thread_context import (
    get_subagent_tool_policy,
    is_subagent_context,
)

logger = logging.getLogger(__name__)

ALLOWED_THINKING_LEVELS = {"off", "low", "medium", "high"}


@dataclass(frozen=True)
class SubagentToolPolicy:
    allow: Optional[Tuple[str, ...]] = None
    deny: Optional[Tuple[str, ...]] = None
    source: Optional[Dict[str, Any]] = None


def _normalize_text(value: Optional[str]) -> str:
    return (value or "").strip()


def normalize_tool_name(value: Optional[str]) -> str:
    return _normalize_text(value).lower()


def normalize_tool_list(values: Optional[Iterable[Any]]) -> List[str]:
    if not values:
        return []
    seen = set()
    normalized: List[str] = []
    for item in values:
        name = normalize_tool_name(str(item) if item is not None else "")
        if not name or name in seen:
            continue
        seen.add(name)
        normalized.append(name)
    return normalized


def normalize_thinking_level(value: Optional[str]) -> Optional[str]:
    raw = _normalize_text(value).lower()
    if not raw:
        return None
    if raw in ALLOWED_THINKING_LEVELS:
        return raw
    return None


def _merge_unique(*lists: Iterable[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for items in lists:
        for item in items:
            name = normalize_tool_name(item)
            if not name or name in seen:
                continue
            seen.add(name)
            out.append(name)
    return out


def resolve_subagent_tool_policy_from_record(
    record: Dict[str, Any],
    config: OrchestrationConfiguration,
) -> SubagentToolPolicy:
    explicit_allow = normalize_tool_list(record.get("allowed_tools"))
    config_allow = normalize_tool_list(config.subagent_tool_allowlist)
    config_deny = normalize_tool_list(config.subagent_tool_denylist)

    allow = _merge_unique(config_allow, explicit_allow)
    deny = _merge_unique(config_deny)

    allow_tuple = tuple(allow) if allow else None
    deny_tuple = tuple(deny) if deny else None
    source = {
        "config_allow": config_allow,
        "config_deny": config_deny,
        "explicit_allow": explicit_allow,
    }
    return SubagentToolPolicy(allow=allow_tuple, deny=deny_tuple, source=source)


def _is_tool_allowed(name: str, policy: SubagentToolPolicy) -> bool:
    normalized = normalize_tool_name(name)
    if not normalized:
        return True
    if policy.deny and normalized in policy.deny:
        return False
    if policy.allow:
        if "*" in policy.allow:
            return True
        return normalized in policy.allow
    return True


def apply_tool_policy(tools: List[Any], policy: Optional[SubagentToolPolicy]) -> List[Any]:
    if not policy:
        return tools
    filtered: List[Any] = []
    for tool in tools:
        name = getattr(tool, "name", None) or getattr(tool, "tool_name", None)
        if _is_tool_allowed(str(name) if name is not None else "", policy):
            filtered.append(tool)
    return filtered


def filter_subagent_tools(tools: List[Any]) -> List[Any]:
    if not tools:
        return tools
    if not is_subagent_context():
        return tools
    policy = get_subagent_tool_policy()
    if policy is None:
        try:
            config = OrchestrationConfiguration.from_settings()
            policy = resolve_subagent_tool_policy_from_record({}, config)
        except Exception as exc:
            logger.warning("[SubagentPolicy] Failed to load default policy: %s", exc)
            policy = None
    return apply_tool_policy(tools, policy)


def _is_valid_model_id(model_id: str) -> bool:
    if not model_id:
        return False
    try:
        from apps.services.llm.models import LLMModel
        from apps.services.llm.services.capability_guard import apply_chat_model_filter

        # v0.1：LLMProvider.is_active 字段已删（0022），可路由 = routing_enabled。
        return apply_chat_model_filter(
            LLMModel.objects.filter(id=model_id, provider__routing_enabled=True),
        ).exists()
    except Exception as exc:
        logger.warning("[SubagentPolicy] Model validation failed: %s", exc)
        return False


def resolve_subagent_model_id(params: Dict[str, Any]) -> Tuple[Optional[str], Dict[str, Any]]:
    config: OrchestrationConfiguration = params["config"]
    model_override: Optional[str] = _normalize_text(params.get("model_override"))
    agent_name: Optional[str] = _normalize_text(params.get("agent_name"))
    app_id: Optional[str] = _normalize_text(params.get("app_id"))
    parent_model_id: Optional[str] = _normalize_text(params.get("parent_model_id"))

    candidates: List[Tuple[str, str]] = []
    if model_override:
        candidates.append(("override", model_override))
    if agent_name:
        agent_model = _normalize_text(config.subagent_model_by_agent.get(agent_name))
        if agent_model:
            candidates.append(("agent", agent_model))
    if app_id:
        app_model = _normalize_text(config.subagent_model_by_app.get(app_id))
        if app_model:
            candidates.append(("app", app_model))
    if parent_model_id:
        candidates.append(("parent", parent_model_id))
    if config.subagent_default_model_id:
        candidates.append(("subagent_default", _normalize_text(config.subagent_default_model_id)))
    if config.default_model_id:
        candidates.append(("default", _normalize_text(config.default_model_id)))

    warnings: List[str] = []
    tried: List[Dict[str, str]] = []
    for source, model_id in candidates:
        if not model_id:
            continue
        tried.append({"source": source, "model_id": model_id})
        if _is_valid_model_id(model_id):
            return model_id, {"source": source, "warnings": warnings, "candidates": tried}
        warnings.append(f"{source}:{model_id} invalid")

    return None, {"source": None, "warnings": warnings, "candidates": tried}


def resolve_subagent_thinking_level(params: Dict[str, Any]) -> Tuple[Optional[str], Dict[str, Any]]:
    config: OrchestrationConfiguration = params["config"]
    thinking_override: Optional[str] = _normalize_text(params.get("thinking_override"))
    agent_name: Optional[str] = _normalize_text(params.get("agent_name"))
    app_id: Optional[str] = _normalize_text(params.get("app_id"))

    candidates: List[Tuple[str, str]] = []
    if thinking_override:
        candidates.append(("override", thinking_override))
    if agent_name:
        agent_level = _normalize_text(config.subagent_thinking_by_agent.get(agent_name))
        if agent_level:
            candidates.append(("agent", agent_level))
    if app_id:
        app_level = _normalize_text(config.subagent_thinking_by_app.get(app_id))
        if app_level:
            candidates.append(("app", app_level))
    if config.subagent_default_thinking_level:
        candidates.append(("subagent_default", _normalize_text(config.subagent_default_thinking_level)))

    warnings: List[str] = []
    tried: List[Dict[str, str]] = []
    for source, level in candidates:
        if not level:
            continue
        tried.append({"source": source, "thinking_level": level})
        normalized = normalize_thinking_level(level)
        if normalized:
            return normalized, {"source": source, "warnings": warnings, "candidates": tried}
        warnings.append(f"{source}:{level} invalid")

    return None, {"source": None, "warnings": warnings, "candidates": tried}


__all__ = [
    "ALLOWED_THINKING_LEVELS",
    "SubagentToolPolicy",
    "normalize_tool_list",
    "normalize_thinking_level",
    "resolve_subagent_tool_policy_from_record",
    "filter_subagent_tools",
    "resolve_subagent_model_id",
    "resolve_subagent_thinking_level",
]

"""Proxy 出网前 Runtime Profile 解析（W2c）。

把 body 里的用户意图解析为 canonical ``reasoning_effort``，写入
``upstream_body``，再交给既有 ``wire_adapter._normalize_reasoning_param``。

硬约束:

- **不**把 ``thinking_mode`` / ``performance_profile`` 写入 upstream_body
- **不**持久化 ResolvedRuntime
- ``tool_choice`` 已存在时跳过（门禁轮由 agent-runtime 关思考；本层不覆盖）
- Session 只存意图（W2b）；本模块只读 body、只改本次 upstream
- 仅存在真实执行相关 intent 时才 resolve；``v`` / ``performance_profile``
  **单独**不构成信号（避免 PP-only 被 schema 默认成 standard）
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .capability import read_model_capability
from .resolver import resolve_runtime_profile
from .schema import (
    EFFORT_OFF,
    EFFORT_ON,
    ResolvedRuntime,
    RuntimeDowngrade,
    RuntimeProfile,
    parse_profile,
)

#: 触发 Proxy resolve 的执行相关 intent 键（不含版本号 / P1 策略意图）。
_RESOLVE_SIGNAL_KEYS = frozenset({
    "thinking_mode",
    "reasoning_effort",
    "max_output_tokens",
})


def apply_runtime_profile_resolution(
    upstream_body: Dict[str, Any],
    body: Dict[str, Any],
    *,
    model_instance: Any = None,
    model_label: str = "",
) -> Tuple[Optional[ResolvedRuntime], List[Dict[str, Any]]]:
    """解析意图 → 写入 canonical ``reasoning_effort``。

    Returns:
        (resolved, downgrade_events) — resolved 仅供调用方观测/测试，
        **不得**写回 Session；events 形态对齐 wire_adapter capability_downgrade。
    """
    # 门禁 / 强制工具轮：客户端已删 overrides 并写 thinking=disabled；
    # 服务端不得再注入 effort。
    if upstream_body.get("tool_choice") is not None:
        _strip_non_canonical_thinking_fields(upstream_body)
        return None, []

    raw = _extract_profile_raw(body)
    if raw is None:
        # 无执行相关 intent（含 PP-only / 仅 v）：不 resolve，并清掉误入的产品字段
        _strip_non_canonical_thinking_fields(upstream_body)
        return None, []

    profile = parse_profile(raw, strict=False)
    capabilities_config = None
    if model_instance is not None:
        capabilities_config = getattr(model_instance, "capabilities_config", None)
    capability = read_model_capability(capabilities_config)
    label = model_label or _model_label(model_instance) or "当前模型"

    resolved = resolve_runtime_profile(
        profile, capability, model_label=label,
    )
    _apply_resolved_effort(upstream_body, resolved, profile)
    _strip_non_canonical_thinking_fields(upstream_body)

    events = [
        _downgrade_to_sse_event(event, model_name=label)
        for event in resolved.downgrades
    ]
    return resolved, events


def _extract_profile_raw(body: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """双读 runtime_profile / model_param_overrides / 顶层 reasoning_effort。"""
    runtime_profile = body.get("runtime_profile")
    if isinstance(runtime_profile, dict) and _has_profile_signal(runtime_profile):
        return runtime_profile

    overrides = body.get("model_param_overrides")
    if isinstance(overrides, dict) and _has_profile_signal(overrides):
        return overrides

    if body.get("reasoning_effort") is not None:
        return {"reasoning_effort": body.get("reasoning_effort")}

    return None


def _has_profile_signal(raw: Dict[str, Any]) -> bool:
    """是否存在真实执行相关 intent。

    - ``thinking_mode`` / ``reasoning_effort`` / ``max_output_tokens`` 非空 → 进入 resolve
    - 仅 ``v`` / ``performance_profile`` → **不**进入（missing thinking ≠ standard）
    """
    return any(
        raw.get(key) is not None
        for key in _RESOLVE_SIGNAL_KEYS
    )


def _apply_resolved_effort(
    upstream_body: Dict[str, Any],
    resolved: ResolvedRuntime,
    profile: RuntimeProfile,
) -> None:
    if resolved.thinking_enabled and resolved.resolved_effort:
        upstream_body["reasoning_effort"] = resolved.resolved_effort
        return

    # 二进制 / 始终开启：无梯子时写 on，由 wire 翻译为 thinking.type=enabled
    if resolved.thinking_enabled and resolved.resolved_effort is None:
        upstream_body["reasoning_effort"] = EFFORT_ON
        return

    # 显式关闭且模型允许 → 交给 wire_adapter 翻译为 disabled / enable_thinking=false
    if (
        not resolved.thinking_enabled
        and profile.reasoning_effort in (None, EFFORT_OFF)
        and profile.thinking_mode == "off"
        and not resolved.downgraded
    ):
        upstream_body["reasoning_effort"] = EFFORT_OFF
        return

    upstream_body.pop("reasoning_effort", None)


def _strip_non_canonical_thinking_fields(upstream_body: Dict[str, Any]) -> None:
    """防御:绝不把产品意图字段送进 wire / 上游。"""
    upstream_body.pop("thinking_mode", None)
    upstream_body.pop("performance_profile", None)


def _downgrade_to_sse_event(
    event: RuntimeDowngrade,
    *,
    model_name: str,
) -> Dict[str, Any]:
    return {
        "event": "capability_downgrade",
        "stage": "runtime_profile",
        "feature": event.feature,
        "capability": event.feature,
        "fallback_to": event.fallback_to,
        "reason": event.reason,
        "message": event.message,
        "user_message": event.message,
        "model_name": model_name,
        "requested": event.requested,
    }


def _model_label(model_instance: Any) -> str:
    if model_instance is None:
        return ""
    return str(
        getattr(model_instance, "model_name", None)
        or getattr(model_instance, "display_name", None)
        or ""
    )


__all__ = ["apply_runtime_profile_resolution"]

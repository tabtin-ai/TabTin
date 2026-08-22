"""意图 → 执行参数的解析(纯函数)。

把今天散在各 adapter 里、方向互相矛盾的兜底集中到一处,统一为
**就近向下取 + 显式降级事件**(product-policy §3)。

W2a 契约:

```
resolve_user_runtime(raw intent, model capability [, global peer])
  → ResolvedRuntime(
        resolved_thinking_mode, resolved_effort,
        downgraded, notice, ...
    )
```

**本模块仍不被 Session / Proxy / UI 调用。** 纯函数 + 单测先行。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .capability import ModelRuntimeCapability, read_model_capability
from .schema import (
    EFFORT_LADDER,
    EFFORT_OFF,
    RuntimeDowngrade,
    RuntimeProfile,
    ResolvedRuntime,
    THINKING_MODE_TO_EFFORT,
    effort_to_thinking_mode,
    parse_profile,
)

_FEATURE_THINKING = "reasoning"
_FEATURE_OUTPUT_BUDGET = "output_budget"


def resolve_user_runtime(
    raw_profile: Optional[Dict[str, Any]],
    capabilities_config: Optional[Dict[str, Any]],
    *,
    global_peer_capabilities_config: Optional[Dict[str, Any]] = None,
    model_label: str = "",
    strict: bool = False,
) -> ResolvedRuntime:
    """RuntimeProfileResolver 主入口(W2a 契约)。

    输入:用户意图原始 dict + 模型 ``capabilities_config``(+ 可选全局同名声明)。
    输出:``ResolvedRuntime``(含 resolved thinking mode / effort / downgraded / notice)。
    """
    profile = parse_profile(raw_profile, strict=strict)
    capability = read_model_capability(
        capabilities_config,
        global_peer_capabilities_config=global_peer_capabilities_config,
    )
    return resolve_runtime_profile(
        profile, capability, model_label=model_label,
    )


def resolve_runtime_profile(
    profile: RuntimeProfile,
    capability: ModelRuntimeCapability,
    *,
    model_label: str = "",
) -> ResolvedRuntime:
    """把用户意图解析成某个模型上可执行的运行参数。

    不变量:返回的 ``resolved_effort`` 要么是 None(思考未开启),
    要么落在 ``capability.thinking.effort_levels`` 内。

    ``model_label`` 只用于降级文案,不参与任何判定。
    """
    downgrades: List[RuntimeDowngrade] = []
    label = model_label or "当前模型"

    requested_effort = _requested_effort(profile)
    thinking_enabled, resolved_effort = _resolve_thinking(
        requested_effort, capability, label, downgrades,
    )
    max_output_tokens = _resolve_output_budget(
        profile.max_output_tokens, capability, label, downgrades,
    )

    events = tuple(downgrades)
    return ResolvedRuntime(
        thinking_enabled=thinking_enabled,
        resolved_effort=resolved_effort,
        resolved_thinking_mode=effort_to_thinking_mode(
            thinking_enabled=thinking_enabled,
            resolved_effort=resolved_effort,
        ),
        downgraded=bool(events),
        notice=events[0].message if events else None,
        context_tier_id=profile.context_tier_id,
        max_output_tokens=max_output_tokens,
        downgrades=events,
    )


def _requested_effort(profile: RuntimeProfile) -> str:
    """第一步(与模型无关):显式 effort 覆盖 thinking_mode 推导。"""
    if profile.reasoning_effort is not None:
        return profile.reasoning_effort
    return THINKING_MODE_TO_EFFORT.get(profile.thinking_mode, "medium")


def _resolve_thinking(
    requested: str,
    capability: ModelRuntimeCapability,
    label: str,
    downgrades: List[RuntimeDowngrade],
) -> Tuple[bool, Optional[str]]:
    thinking = capability.thinking
    levels = thinking.effort_levels

    if not thinking.supported:
        # 模型完全不支持思考。用户本来也没想开 → 不算降级,静默即可;
        # 用户明确想开 → 必须告知,否则就是"点了没反应"。
        if requested != EFFORT_OFF:
            downgrades.append(RuntimeDowngrade(
                feature=_FEATURE_THINKING,
                reason="thinking_not_controllable",
                requested=requested,
                fallback_to=None,
                message=f"{label}不支持调节思考强度。",
            ))
        return False, None

    if not levels:
        # 二进制思考：无 intensity ladder。resolved_effort 保持 None，
        # Proxy 写 EFFORT_ON / EFFORT_OFF 给 wire。
        if requested == EFFORT_OFF:
            if thinking.off_supported:
                return False, None
            downgrades.append(RuntimeDowngrade(
                feature=_FEATURE_THINKING,
                reason="thinking_off_unsupported",
                requested=EFFORT_OFF,
                fallback_to=None,
                message="该模型始终思考，无法关闭。",
            ))
            return True, None
        return True, None

    if requested == EFFORT_OFF:
        if thinking.off_supported:
            return False, None
        # 「始终推理」且有强度梯子(K3 等):关不掉,给最低档 + 明确告知(D3)。
        fallback = thinking.lowest_effort
        downgrades.append(RuntimeDowngrade(
            feature=_FEATURE_THINKING,
            reason="thinking_off_unsupported",
            requested=EFFORT_OFF,
            fallback_to=fallback,
            message="该模型始终思考，本轮已按最低强度执行。",
        ))
        return True, fallback

    if requested in levels:
        return True, requested

    fallback = _nearest_available(requested, levels)
    if fallback is None:
        # levels 非空时 _nearest_available 必有返回;留作防御。
        return False, None
    downgrades.append(RuntimeDowngrade(
        feature=_FEATURE_THINKING,
        reason="effort_level_unavailable",
        requested=requested,
        fallback_to=fallback,
        message="当前模型不支持你选择的思考强度，本轮已按可用档执行。",
    ))
    return True, fallback


def _nearest_available(
    requested: str,
    levels: Tuple[str, ...],
) -> Optional[str]:
    """就近取可用档:**先向下**,取不到再向上。"""
    if requested not in EFFORT_LADDER:
        # 非 canonical 强度值(理论上 parse_profile 已拦下)→ 给最低档,不猜。
        return levels[0] if levels else None

    index = EFFORT_LADDER.index(requested)
    for candidate in reversed(EFFORT_LADDER[:index]):
        if candidate in levels:
            return candidate
    for candidate in EFFORT_LADDER[index + 1:]:
        if candidate in levels:
            return candidate
    return None


def _resolve_output_budget(
    requested: Optional[int],
    capability: ModelRuntimeCapability,
    label: str,
    downgrades: List[RuntimeDowngrade],
) -> Optional[int]:
    if requested is None:
        return None
    ceiling = capability.max_output_tokens
    if ceiling is None or requested <= ceiling:
        return requested
    downgrades.append(RuntimeDowngrade(
        feature=_FEATURE_OUTPUT_BUDGET,
        reason="output_budget_exceeds_model_max",
        requested=str(requested),
        fallback_to=str(ceiling),
        message="输出长度已按当前模型上限调整。",
    ))
    return ceiling


__all__ = [
    "resolve_runtime_profile",
    "resolve_user_runtime",
]

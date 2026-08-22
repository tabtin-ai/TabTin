"""模型侧的 Runtime Profile 能力读取。

回答的问题是「**这个模型能选什么**」,与 ``wire_adapter.reasoning``
（「**怎么发**给上游」）严格分工,两者不允许互相推导 —— 详见
``docs/model-runtime/runtime-profile-design.md`` §5.2 /
``runtime-profile-product-policy.md`` §4–§6。

读取优先级(W2a / D5):

1. 本模型显式 ``capabilities_config.runtime_profile`` 声明
2. 否则:全局同名 ready 模型的声明(``global_peer_capabilities_config``)→ 继承
3. 否则:从 ``wire_adapter.reasoning`` **保守**缺省推导(不含 ``max``)
4. 完全无 wire 请求级开关 → 隐藏思考控件(``supported=False``)

``max`` 仅当声明(或继承的声明)显式列出才开放;缺省推导永不含 ``max``。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

from .schema import (
    EFFORT_LADDER,
    EFFORT_OFF,
    THINKING_MODE_DEEP,
    THINKING_MODE_STANDARD,
    THINKING_MODES,
)

#: 缺省推导给出的强度档 —— **刻意不含 max**(D2 / R1)。
_DEFAULT_INFERRED_EFFORT_LEVELS: Tuple[str, ...] = ("low", "medium", "high")
_DEFAULT_INFERRED_EFFORT: str = "medium"
#: forced-thinking 模型默认可选档(隐藏关闭,D3)。
_FORCED_THINKING_SELECTABLE: Tuple[str, ...] = (
    THINKING_MODE_STANDARD,
    THINKING_MODE_DEEP,
)


@dataclass(frozen=True)
class ThinkingCapability:
    """模型的思考能力（三轴分离）。

    - ``supported``:是否支持思考（thinking_supported）。False → UI 不渲染思考区。
    - ``off_supported``:用户是否可关闭思考（thinking_toggle / 关侧）。
      False = 始终开启（如 K2.7-code / K3）。
    - ``effort_levels``:是否支持强度档（reasoning_effort_supported）。
      空元组 = 无 low/medium/high/max 梯子（如 K2.5/K2.6 二进制开关）。
      **空 levels 不再意味着不支持思考**。
    - ``default_effort``:有梯子时的默认强度；二进制模型为 None。
    - ``user_selectable``:UI 可点的 ``thinking_mode`` 子集。
      空 = 不展示可点控件（可配合 Catalog ``always_on`` 显示只读态）。
      显式 ``[]`` 与「未声明」不同：未声明时 off 不支持会默认 standard/deep。
    """

    supported: bool = False
    off_supported: bool = True
    effort_levels: Tuple[str, ...] = ()
    default_effort: Optional[str] = None
    user_selectable: Tuple[str, ...] = ()

    @property
    def lowest_effort(self) -> Optional[str]:
        """该模型最低可用强度档(用于 off 不支持时的降级目标)。"""
        return self.effort_levels[0] if self.effort_levels else None

    @property
    def effort_supported(self) -> bool:
        """是否存在厂商 reasoning_effort / 强度梯子。"""
        return bool(self.effort_levels)


@dataclass(frozen=True)
class ModelRuntimeCapability:
    """模型的 Runtime Profile 能力全貌。"""

    thinking: ThinkingCapability = ThinkingCapability()
    max_output_tokens: Optional[int] = None
    #: True = 来自本模型 ``capabilities_config.runtime_profile`` 显式声明。
    declared: bool = False
    #: True = 无本模型声明,从全局同名 ready 模型继承(D5)。
    inherited: bool = False


def read_model_capability(
    capabilities_config: Optional[Dict[str, Any]],
    *,
    global_peer_capabilities_config: Optional[Dict[str, Any]] = None,
) -> ModelRuntimeCapability:
    """从 ``LLMModel.capabilities_config`` 读出 runtime 能力。

    ``global_peer_capabilities_config``:同 model id 的全局 ready 模型配置,
    供 BYOK / 无声明模型继承(调用方负责查找;本函数不做 DB 查询)。
    """
    local = _read_local(capabilities_config)
    if local is not None:
        return local

    peer = _read_declared_peer(global_peer_capabilities_config)
    if peer is not None:
        return peer

    return _infer_from_wire_adapter(
        capabilities_config.get("wire_adapter")
        if isinstance(capabilities_config, dict)
        else None
    )


def _read_local(
    capabilities_config: Optional[Dict[str, Any]],
) -> Optional[ModelRuntimeCapability]:
    if not isinstance(capabilities_config, dict):
        return None
    declared = capabilities_config.get("runtime_profile")
    if isinstance(declared, dict) and declared:
        return _read_declared(declared, inherited=False)
    return None


def _read_declared_peer(
    peer_config: Optional[Dict[str, Any]],
) -> Optional[ModelRuntimeCapability]:
    if not isinstance(peer_config, dict):
        return None
    declared = peer_config.get("runtime_profile")
    if not isinstance(declared, dict) or not declared:
        return None
    cap = _read_declared(declared, inherited=True)
    # 同名全局若声明了思考不可用 → 仍算「有声明」,BYOK 跟随隐藏。
    return cap


def _read_declared(
    runtime_profile: Dict[str, Any],
    *,
    inherited: bool,
) -> ModelRuntimeCapability:
    raw_thinking = runtime_profile.get("thinking")
    thinking = (
        _read_declared_thinking(raw_thinking)
        if isinstance(raw_thinking, dict)
        else ThinkingCapability()
    )

    raw_budget = runtime_profile.get("output_budget")
    max_output = None
    if isinstance(raw_budget, dict) and raw_budget.get("supported") is not False:
        max_output = _coerce_positive_int(raw_budget.get("max"))

    return ModelRuntimeCapability(
        thinking=thinking,
        max_output_tokens=max_output,
        declared=not inherited,
        inherited=inherited,
    )


def _read_declared_thinking(raw: Dict[str, Any]) -> ThinkingCapability:
    supported = raw.get("supported") is True
    if not supported:
        return ThinkingCapability(supported=False)

    levels = _clean_effort_levels(raw.get("effort_levels"))
    off_supported = raw.get("off_supported") is not False
    selectable_raw = raw.get("user_selectable")
    user_selectable = _clean_user_selectable(
        selectable_raw,
        off_supported=off_supported,
        explicit=isinstance(selectable_raw, (list, tuple)),
    )

    if not levels:
        # 二进制 / 始终开启：支持思考，但不存在 intensity ladder。
        return ThinkingCapability(
            supported=True,
            off_supported=off_supported,
            effort_levels=(),
            default_effort=None,
            user_selectable=user_selectable,
        )

    default_effort = _coerce_level(raw.get("default_effort"), levels)
    if default_effort is None:
        # 没声明或声明了不在 levels 里的默认档 → 取最低档,不擅自升档。
        default_effort = levels[0]

    return ThinkingCapability(
        supported=True,
        off_supported=off_supported,
        effort_levels=levels,
        default_effort=default_effort,
        user_selectable=user_selectable,
    )


def _infer_from_wire_adapter(
    wire_adapter: Any,
) -> ModelRuntimeCapability:
    """缺省推导:无声明且无同名可继承时,从协议层推保守默认。

    完全无请求级开关 → 隐藏(禁止激进 inferred,D5)。
    """
    if not isinstance(wire_adapter, dict):
        return ModelRuntimeCapability()
    reasoning = wire_adapter.get("reasoning")
    if not isinstance(reasoning, dict):
        return ModelRuntimeCapability()

    if reasoning.get("enabled") is not True:
        return ModelRuntimeCapability()

    param_path = reasoning.get("param_path")
    if not isinstance(param_path, str) or not param_path.strip():
        # 响应侧有 reasoning 内容,但请求侧没有开关 → 无法按档位控制。
        return ModelRuntimeCapability()

    return ModelRuntimeCapability(
        thinking=ThinkingCapability(
            supported=True,
            off_supported=True,
            effort_levels=_DEFAULT_INFERRED_EFFORT_LEVELS,
            default_effort=_DEFAULT_INFERRED_EFFORT,
            user_selectable=THINKING_MODES,
        ),
        max_output_tokens=None,
        declared=False,
        inherited=False,
    )


def _clean_effort_levels(raw: Any) -> Tuple[str, ...]:
    """规整声明的强度档:去非法值(含 xhigh)、去重、按 canonical 强度升序。

    ``off`` 不是强度档(它由 ``off_supported`` 表达),声明里出现也剔除。
    """
    if not isinstance(raw, (list, tuple)):
        return ()
    seen = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        normalized = item.strip().lower()
        if normalized in EFFORT_LADDER:
            seen.add(normalized)
    return tuple(level for level in EFFORT_LADDER if level in seen)


def _clean_user_selectable(
    raw: Any,
    *,
    off_supported: bool,
    explicit: bool = False,
) -> Tuple[str, ...]:
    if not isinstance(raw, (list, tuple)):
        # 未声明:off 不支持时隐藏关闭(D3);否则三档全开。
        return THINKING_MODES if off_supported else _FORCED_THINKING_SELECTABLE
    seen = set()
    for item in raw:
        if isinstance(item, str) and item.strip().lower() in THINKING_MODES:
            seen.add(item.strip().lower())
    modes = tuple(mode for mode in THINKING_MODES if mode in seen)
    if not off_supported:
        modes = tuple(mode for mode in modes if mode != "off")
        # 显式 ``[]``：只读始终开启（K2.7-code），不要回退成 standard/deep。
        if not modes and not explicit:
            modes = _FORCED_THINKING_SELECTABLE
    return modes


def _coerce_level(value: Any, allowed: Tuple[str, ...]) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized == EFFORT_OFF:
        return None
    return normalized if normalized in allowed else None


def _coerce_positive_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


__all__ = [
    "ThinkingCapability",
    "ModelRuntimeCapability",
    "read_model_capability",
]

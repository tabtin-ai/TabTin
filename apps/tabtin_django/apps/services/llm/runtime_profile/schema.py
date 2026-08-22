"""Canonical Runtime Profile —— 用户意图层的数据结构与校验。

设计依据:``docs/model-runtime/runtime-profile-design.md`` §3
产品政策:``docs/model-runtime/runtime-profile-product-policy.md``
Phase 2 W2a: v2 schema + ``upgrade_v1_to_v2``（仍不接线 Session/Proxy）。

分层原则:**持久化意图,不持久化解析结果**。

- ``RuntimeProfile`` = 用户表达的意图(``thinking_mode`` 等),跨模型稳定,
  切模型不失效,可落库。
- ``ResolvedRuntime`` = 针对某个具体模型解析出的执行参数,每次请求现算,
  不落库。

canonical 值域是**封闭枚举**。厂商私有值(``xhigh`` / ``enable_thinking`` /
``thinking.budget_tokens`` ...)一律不进这一层 —— 它们由
``wire_adapter`` 在出网前生成。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

# --- 版本 ------------------------------------------------------------------

#: 新写入一律 v2。读路径兼容无 ``v`` 的 v1 扁平 ``reasoning_effort``。
PROFILE_VERSION_V2 = 2

# --- canonical 值域 --------------------------------------------------------

#: 用户意图三档(产品语言:关闭 / 标准 / 深度)。任何模型都有这三档的语义,
#: 不支持的模型由 resolver 决定降级行为,UI 档数不因模型缩水。
THINKING_MODE_OFF = "off"
THINKING_MODE_STANDARD = "standard"
THINKING_MODE_DEEP = "deep"
THINKING_MODES: Tuple[str, ...] = (
    THINKING_MODE_OFF,
    THINKING_MODE_STANDARD,
    THINKING_MODE_DEEP,
)

#: canonical effort:关闭 + 四个强度档。
EFFORT_OFF = "off"
#: 二进制思考「开启」哨兵（无厂商 intensity ladder 时写给 wire）。
#: 不是 EFFORT_LADDER 成员；仅 Proxy → wire_adapter 消费。
EFFORT_ON = "on"
#: 强度阶梯(不含 off),**按强度升序**——resolver 的"就近向下取"依赖这个顺序。
EFFORT_LADDER: Tuple[str, ...] = ("low", "medium", "high", "max")
#: 完整值域(含 off)。
EFFORT_LEVELS: Tuple[str, ...] = (EFFORT_OFF,) + EFFORT_LADDER

#: 意图 → canonical effort 的默认推导(与模型无关,resolver 第一步)。
THINKING_MODE_TO_EFFORT: Dict[str, str] = {
    THINKING_MODE_OFF: EFFORT_OFF,
    THINKING_MODE_STANDARD: "medium",
    THINKING_MODE_DEEP: "high",
}

#: v1 别名 → canonical effort(读兼容)。
_V1_EFFORT_ALIASES: Dict[str, str] = {
    "none": EFFORT_OFF,
    "disabled": EFFORT_OFF,
}


class InvalidRuntimeProfile(ValueError):
    """profile 原始数据不符合 canonical 值域(仅 strict 模式抛出)。"""


# --- 用户意图层 ------------------------------------------------------------

@dataclass(frozen=True)
class RuntimeProfile:
    """用户意图(持久化层)。

    - ``thinking_mode``:主控,三档恒定。
    - ``reasoning_effort``:高级覆盖。``None`` = 由 ``thinking_mode`` 推导;
      非 None 时**覆盖**推导结果。普通用户路径恒为 None。
    - ``context_tier_id``:正交维度;接线时 Session 列优先,本字段读忽略写不落库。
    - ``max_output_tokens``:高级覆盖,``None`` = 用 catalog 默认。
    - ``version``:序列化版本;落库时 ``to_json`` 写 ``"v": 2``。
    """

    thinking_mode: str = THINKING_MODE_STANDARD
    reasoning_effort: Optional[str] = None
    context_tier_id: Optional[str] = None
    max_output_tokens: Optional[int] = None
    version: int = PROFILE_VERSION_V2

    def to_json(self) -> Dict[str, Any]:
        """序列化成可落库的 v2 dict(用于 ``ChatSession.model_param_overrides``)。

        接线前本函数仅供单测 / 懒升级调用;不自动写库。
        """
        return {
            "v": PROFILE_VERSION_V2,
            "thinking_mode": self.thinking_mode,
            "reasoning_effort": self.reasoning_effort,
            "context_tier_id": self.context_tier_id,
            "max_output_tokens": self.max_output_tokens,
        }


def upgrade_v1_to_v2(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """把 v1 / 过渡形态升级为可落库的 v2 dict(**不改库**,供写入口懒升级)。

    映射(Phase 2 计划 §3.3 + product-policy):

    | v1 ``reasoning_effort`` | ``thinking_mode`` | 是否保留 effort 覆盖 |
    |-------------------------|-------------------|----------------------|
    | ``off`` / ``none`` / ``disabled`` | ``off`` | 否 |
    | ``medium`` | ``standard`` | 否(由 mode 推导) |
    | ``low`` | ``standard`` | **是**(三档推不出 low,保留以免静默变贵) |
    | ``high`` | ``deep`` | 否 |
    | ``max`` | ``deep`` | **是**(三档推不出 max) |
    | ``xhigh`` / 非法 | ``deep``(宽松) | 否(不进 canonical) |

    已是 v2(含 ``"v": 2`` 或已有 ``thinking_mode``)时走 ``parse_profile`` 规范化后
    再 ``to_json``。
    """
    if raw is None or not isinstance(raw, dict):
        return RuntimeProfile().to_json()

    if _is_v2_shape(raw):
        return parse_profile(raw, strict=False).to_json()

    effort_raw = raw.get("reasoning_effort")
    mode, effort_override = _v1_effort_to_intent(effort_raw)
    profile = RuntimeProfile(
        thinking_mode=mode,
        reasoning_effort=effort_override,
        context_tier_id=_parse_tier(raw.get("context_tier_id"), strict=False),
        max_output_tokens=_parse_output_budget(
            raw.get("max_output_tokens"), strict=False,
        ),
        version=PROFILE_VERSION_V2,
    )
    return profile.to_json()


def parse_profile(
    raw: Optional[Dict[str, Any]],
    *,
    strict: bool = False,
) -> RuntimeProfile:
    """把存量 / 请求里的原始 dict 解析成 canonical profile。

    ``strict=False``(默认,读路径用):非法值按"当它没写"处理,回退默认档,
    保证老数据 / 脏数据不会让会话打不开。
    ``strict=True``(写路径用):非法值抛 ``InvalidRuntimeProfile``,
    避免把脏数据写进库。

    **v1 存量兼容**:无 ``v``、无 ``thinking_mode``、仅有 ``reasoning_effort`` 时,
    按 ``upgrade_v1_to_v2`` 同款反推填充 ``thinking_mode``;``max`` 保留为高级覆盖,
    其余可推导档清覆盖。``xhigh`` 等厂商私有值不进 canonical。
    """
    if raw is None:
        return RuntimeProfile()
    if not isinstance(raw, dict):
        if strict:
            raise InvalidRuntimeProfile(
                f"profile 必须是 dict,收到 {type(raw).__name__}"
            )
        return RuntimeProfile()

    version = _parse_version(raw.get("v"), strict=strict)

    if not _is_v2_shape(raw) and "thinking_mode" not in raw:
        # v1 扁平:用升级表反推意图,再构 profile(读路径不落库)。
        mode, effort = _v1_effort_to_intent(raw.get("reasoning_effort"))
        if strict and raw.get("reasoning_effort") is not None:
            # 严格写路径不应再收纯 v1;若仍收到,至少校验 effort 可识别。
            _parse_effort(raw.get("reasoning_effort"), strict=True)
        return RuntimeProfile(
            thinking_mode=mode,
            reasoning_effort=effort,
            context_tier_id=_parse_tier(raw.get("context_tier_id"), strict=strict),
            max_output_tokens=_parse_output_budget(
                raw.get("max_output_tokens"), strict=strict,
            ),
            version=PROFILE_VERSION_V2,
        )

    mode = _parse_thinking_mode(raw.get("thinking_mode"), strict=strict)
    effort = _parse_effort(raw.get("reasoning_effort"), strict=strict)
    tier = _parse_tier(raw.get("context_tier_id"), strict=strict)
    budget = _parse_output_budget(raw.get("max_output_tokens"), strict=strict)

    return RuntimeProfile(
        thinking_mode=mode,
        reasoning_effort=effort,
        context_tier_id=tier,
        max_output_tokens=budget,
        version=version,
    )


def _is_v2_shape(raw: Dict[str, Any]) -> bool:
    version = raw.get("v")
    if version == PROFILE_VERSION_V2 or version == str(PROFILE_VERSION_V2):
        return True
    # 过渡脏数据:无 v 但已有 thinking_mode → 按 v2 字段解释。
    return "thinking_mode" in raw


def _parse_version(value: Any, *, strict: bool) -> int:
    if value is None:
        return PROFILE_VERSION_V2
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        if strict:
            raise InvalidRuntimeProfile(f"v={value!r} 不是合法版本号")
        return PROFILE_VERSION_V2
    if parsed == PROFILE_VERSION_V2:
        return PROFILE_VERSION_V2
    if strict:
        raise InvalidRuntimeProfile(
            f"v={parsed} 不受支持;写路径仅接受 {PROFILE_VERSION_V2}"
        )
    return PROFILE_VERSION_V2


def _v1_effort_to_intent(
    value: Any,
) -> Tuple[str, Optional[str]]:
    """v1 effort → (thinking_mode, optional advanced override)。"""
    if value is None:
        return THINKING_MODE_STANDARD, None
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return THINKING_MODE_DEEP, None
    normalized = str(value).strip().lower()
    normalized = _V1_EFFORT_ALIASES.get(normalized, normalized)
    if normalized == EFFORT_OFF:
        return THINKING_MODE_OFF, None
    if normalized == "low":
        # 三档推不出 low;清覆盖会变成 medium(更贵),违反「不静默变贵」。
        return THINKING_MODE_STANDARD, "low"
    if normalized == "medium":
        return THINKING_MODE_STANDARD, None
    if normalized == "high":
        return THINKING_MODE_DEEP, None
    if normalized == "max":
        # 三档推不出 max → 保留高级覆盖。
        return THINKING_MODE_DEEP, "max"
    # xhigh / 未知:宽松落到 deep,不保留非法覆盖(D4)。
    return THINKING_MODE_DEEP, None


def _parse_thinking_mode(value: Any, *, strict: bool) -> str:
    if value is None:
        return THINKING_MODE_STANDARD
    normalized = str(value).strip().lower()
    if normalized in THINKING_MODES:
        return normalized
    if strict:
        raise InvalidRuntimeProfile(
            f"thinking_mode={value!r} 不在 {THINKING_MODES}"
        )
    return THINKING_MODE_STANDARD


def _parse_effort(value: Any, *, strict: bool) -> Optional[str]:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    normalized = _V1_EFFORT_ALIASES.get(normalized, normalized)
    if normalized in EFFORT_LEVELS:
        return normalized
    if strict:
        raise InvalidRuntimeProfile(
            f"reasoning_effort={value!r} 不在 {EFFORT_LEVELS}"
        )
    return None


def _parse_tier(value: Any, *, strict: bool) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        if strict:
            raise InvalidRuntimeProfile(
                f"context_tier_id 必须是字符串,收到 {type(value).__name__}"
            )
        return None
    normalized = value.strip()
    return normalized or None


def _parse_output_budget(value: Any, *, strict: bool) -> Optional[int]:
    if value is None:
        return None
    # bool 是 int 子类,但 True/False 显然不是 token 数。
    if isinstance(value, bool):
        if strict:
            raise InvalidRuntimeProfile("max_output_tokens 不接受布尔值")
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        if strict:
            raise InvalidRuntimeProfile(
                f"max_output_tokens={value!r} 不是整数"
            )
        return None
    if parsed <= 0:
        if strict:
            raise InvalidRuntimeProfile(
                f"max_output_tokens={parsed} 必须为正数"
            )
        return None
    return parsed


# --- 解析结果层 ------------------------------------------------------------

@dataclass(frozen=True)
class RuntimeDowngrade:
    """一次显式降级。字段命名对齐 ``wire_adapter`` 的 capability_downgrade 事件,

    方便阶段二直接喂给 ``_append_capability_downgrade_event`` / CapabilityBanners。
    """

    feature: str
    reason: str
    requested: Optional[str]
    fallback_to: Optional[str]
    message: str


@dataclass(frozen=True)
class ResolvedRuntime:
    """针对具体模型的解析结果(不持久化)。

    W2a 契约字段:

    - ``resolved_thinking_mode``:本轮生效的产品三档(由 resolved effort 反推,
      **不等于**持久化意图;意图仍在 ``RuntimeProfile``)。
    - ``resolved_effort``:canonical 强度;``thinking_enabled=False`` 时为 None。
    - ``downgraded``:是否发生任何降级 / 钳制。
    - ``notice``:主提示文案(首条 downgrade.message);无降级则为 None。
    - ``downgrades``:完整事件列表(机器可读 reason)。
    """

    thinking_enabled: bool = False
    resolved_effort: Optional[str] = None
    resolved_thinking_mode: str = THINKING_MODE_OFF
    downgraded: bool = False
    notice: Optional[str] = None
    context_tier_id: Optional[str] = None
    max_output_tokens: Optional[int] = None
    downgrades: Tuple[RuntimeDowngrade, ...] = field(default_factory=tuple)


def effort_to_thinking_mode(
    *,
    thinking_enabled: bool,
    resolved_effort: Optional[str],
) -> str:
    """把解析后的 effort 反推成产品三档(仅用于 ResolvedRuntime 展示)。"""
    if not thinking_enabled:
        return THINKING_MODE_OFF
    # 二进制开启：无梯子时 resolved_effort 为 None / on → 产品档 standard（开启）
    if resolved_effort in (None, EFFORT_OFF, EFFORT_ON):
        return THINKING_MODE_STANDARD
    if resolved_effort in ("low", "medium"):
        return THINKING_MODE_STANDARD
    # high / max → deep
    return THINKING_MODE_DEEP


__all__ = [
    "PROFILE_VERSION_V2",
    "THINKING_MODE_OFF",
    "THINKING_MODE_STANDARD",
    "THINKING_MODE_DEEP",
    "THINKING_MODES",
    "EFFORT_OFF",
    "EFFORT_ON",
    "EFFORT_LADDER",
    "EFFORT_LEVELS",
    "THINKING_MODE_TO_EFFORT",
    "InvalidRuntimeProfile",
    "RuntimeProfile",
    "RuntimeDowngrade",
    "ResolvedRuntime",
    "effort_to_thinking_mode",
    "parse_profile",
    "upgrade_v1_to_v2",
]

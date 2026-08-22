"""Session ``model_param_overrides`` 的 v2 持久化契约（W2b）。

职责边界:

- **写**:归一化为 v2 落库形态;v1 自动升级;禁止双事实源
- **读**:响应层投影 ``reasoning_effort``,旧客户端不崩
- **不**:调用 Proxy resolver、不写 resolved、不碰 Catalog / UI

双事实源规则(product-policy + W2b):

- 库内以 ``thinking_mode`` 为意图主控
- ``reasoning_effort`` **仅**在无法由 mode 推导时保留(高级覆盖,如 ``max`` / ``low``)
- 禁止同时持久化「mode + 与之等价的 derived effort」(例如 deep + high)
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .schema import (
    EFFORT_LEVELS,
    PROFILE_VERSION_V2,
    THINKING_MODE_TO_EFFORT,
    InvalidRuntimeProfile,
    RuntimeProfile,
    parse_profile,
    upgrade_v1_to_v2,
)

#: 写路径接受的 v1 别名(读路径 upgrade 仍更宽松)。
_WRITABLE_EFFORT_ALIASES = {
    "none": "off",
    "disabled": "off",
}

#: P1 响应策略意图（与 thinking 正交；Resolver/Proxy 不消费，仅持久化）。
PERFORMANCE_PROFILE_VALUES = frozenset({"fast", "balanced", "quality"})

_PROFILE_INPUT_KEYS = frozenset({
    "v",
    "thinking_mode",
    "reasoning_effort",
    "max_output_tokens",
    "performance_profile",
})


class InvalidModelParamOverrides(ValueError):
    """写路径非法的 model_param_overrides。"""


def normalize_model_param_overrides_for_storage(
    raw: Any,
) -> Dict[str, Any]:
    """把客户端写入归一化为可落库的 v2 dict。

    - ``{}`` / 仅 ``reasoning_effort: null`` → 清空 ``{}``
    - v1 ``{reasoning_effort: high}`` → ``{v:2, thinking_mode: deep, ...}``
    - v2 校验封闭枚举;非法抛 ``InvalidModelParamOverrides``
    - 保留 ``performance_profile``（P1 意图键；不进 Resolver）
    - **不**把 schema / Catalog 默认 ``thinking_mode`` 写入 Session
      （PP-only → ``{v:2, performance_profile}``，无 ``thinking_mode``）
    - 剥离 ``context_tier_id`` 及其他未知键
    """
    if not isinstance(raw, dict):
        raise InvalidModelParamOverrides(
            f"model_param_overrides 必须是 dict,收到 {type(raw).__name__}"
        )

    candidate = {
        key: raw[key] for key in _PROFILE_INPUT_KEYS if key in raw
    }
    if not candidate:
        return {}

    # performance_profile 与 thinking 正交：先抽出再走 thinking 归一化，最后写回。
    performance_profile: Optional[str] = None
    if "performance_profile" in candidate:
        performance_profile = _parse_performance_profile(
            candidate.pop("performance_profile"),
        )

    if not _has_explicit_thinking_intent(candidate):
        # 无思考意图：禁止注入 schema 默认 thinking_mode
        return _storage_without_thinking_mode(
            candidate,
            performance_profile=performance_profile,
        )

    try:
        if "reasoning_effort" in candidate:
            _validate_writable_effort(candidate.get("reasoning_effort"))
        if _is_v1_only_payload(candidate):
            profile = parse_profile(
                upgrade_v1_to_v2(candidate), strict=True,
            )
        else:
            profile = parse_profile(candidate, strict=True)
    except InvalidRuntimeProfile as exc:
        raise InvalidModelParamOverrides(str(exc)) from exc

    storage = runtime_profile_to_storage_dict(profile)
    if performance_profile is not None:
        storage["performance_profile"] = performance_profile
    return storage


def runtime_profile_to_storage_dict(profile: RuntimeProfile) -> Dict[str, Any]:
    """意图 → 落库 JSON(单事实源)。"""
    effort = _strip_redundant_effort(
        thinking_mode=profile.thinking_mode,
        reasoning_effort=profile.reasoning_effort,
    )
    payload: Dict[str, Any] = {
        "v": PROFILE_VERSION_V2,
        "thinking_mode": profile.thinking_mode,
        "reasoning_effort": effort,
    }
    if profile.max_output_tokens is not None:
        payload["max_output_tokens"] = profile.max_output_tokens
    return payload


def serialize_model_param_overrides_for_client(
    stored: Any,
) -> Optional[Dict[str, Any]]:
    """Session 读 / model-params 响应:v2 + 旧客户端兼容投影。

    投影出的 ``reasoning_effort`` **只存在于响应**,不写回库。
    ``performance_profile`` 若库内有合法值则原样回传。
    库内无 ``thinking_mode`` 时**不**用 schema 默认补进响应（展示缺省由 Catalog）。
    空 / 缺省 → ``None``(与历史 ``_session_to_schema`` 行为一致)。
    """
    if not stored:
        return None
    if not isinstance(stored, dict):
        return None

    performance_profile = _coerce_stored_performance_profile(
        stored.get("performance_profile"),
    )

    if not _has_explicit_thinking_intent(stored):
        result: Dict[str, Any] = {}
        if stored.get("max_output_tokens") is not None:
            result["max_output_tokens"] = stored["max_output_tokens"]
        if performance_profile is not None:
            result["performance_profile"] = performance_profile
        if not result:
            return None
        return {"v": PROFILE_VERSION_V2, **result}

    profile = parse_profile(stored, strict=False)
    storage = runtime_profile_to_storage_dict(profile)
    projected_effort = storage.get("reasoning_effort")
    if projected_effort is None:
        projected_effort = THINKING_MODE_TO_EFFORT.get(
            profile.thinking_mode, "medium",
        )
    result = {
        **storage,
        "reasoning_effort": projected_effort,
    }
    if performance_profile is not None:
        result["performance_profile"] = performance_profile
    return result


def maybe_upgrade_stored_overrides(stored: Any) -> Optional[Dict[str, Any]]:
    """切模型时可选:把库内 v1 懒升级为 v2,不调用 resolver。

    返回 ``None`` 表示无需改动;否则返回新的落库 dict。
    """
    if not isinstance(stored, dict) or not stored:
        return None
    try:
        normalized = normalize_model_param_overrides_for_storage(stored)
    except InvalidModelParamOverrides:
        return None
    if normalized == stored:
        return None
    return normalized


def _strip_redundant_effort(
    *,
    thinking_mode: str,
    reasoning_effort: Optional[str],
) -> Optional[str]:
    if reasoning_effort is None:
        return None
    derived = THINKING_MODE_TO_EFFORT.get(thinking_mode)
    if reasoning_effort == derived:
        return None
    return reasoning_effort


def _has_explicit_thinking_intent(candidate: Dict[str, Any]) -> bool:
    """用户是否显式表达了思考意图（含 v1 effort）。

    ``max_output_tokens`` / ``performance_profile`` / 仅 ``v`` **不算**思考意图，
    不得据此写入默认 ``thinking_mode``。
    """
    if candidate.get("thinking_mode") is not None:
        return True
    if candidate.get("reasoning_effort") is not None:
        return True
    return False


def _storage_without_thinking_mode(
    candidate: Dict[str, Any],
    *,
    performance_profile: Optional[str],
) -> Dict[str, Any]:
    """无思考意图时的落库：可带 budget / performance，绝不写 thinking_mode。"""
    storage: Dict[str, Any] = {}
    if candidate.get("max_output_tokens") is not None:
        try:
            profile = parse_profile(
                {"max_output_tokens": candidate.get("max_output_tokens")},
                strict=True,
            )
        except InvalidRuntimeProfile as exc:
            raise InvalidModelParamOverrides(str(exc)) from exc
        if profile.max_output_tokens is not None:
            storage["max_output_tokens"] = profile.max_output_tokens
    if performance_profile is not None:
        storage["performance_profile"] = performance_profile
    if not storage:
        return {}
    return {"v": PROFILE_VERSION_V2, **storage}


def _is_v1_only_payload(candidate: Dict[str, Any]) -> bool:
    return (
        "thinking_mode" not in candidate
        and "v" not in candidate
    )


def _validate_writable_effort(value: Any) -> None:
    """写路径拒绝厂商私有值 / 非字符串(如 xhigh、dict)。"""
    if value is None:
        return
    if not isinstance(value, str):
        raise InvalidModelParamOverrides(
            f"reasoning_effort 必须是字符串,收到 {type(value).__name__}"
        )
    normalized = value.strip().lower()
    normalized = _WRITABLE_EFFORT_ALIASES.get(normalized, normalized)
    if normalized not in EFFORT_LEVELS:
        raise InvalidModelParamOverrides(
            f"reasoning_effort={value!r} 不在 {EFFORT_LEVELS}"
        )


def _parse_performance_profile(value: Any) -> Optional[str]:
    """写路径校验 ``performance_profile``；``null`` 表示不落库。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidModelParamOverrides(
            f"performance_profile 必须是字符串,收到 {type(value).__name__}"
        )
    normalized = value.strip().lower()
    if normalized not in PERFORMANCE_PROFILE_VALUES:
        raise InvalidModelParamOverrides(
            f"performance_profile={value!r} 不在 "
            f"{sorted(PERFORMANCE_PROFILE_VALUES)}"
        )
    return normalized


def _coerce_stored_performance_profile(value: Any) -> Optional[str]:
    """读路径宽松：非法 / 缺失则省略，不抛。"""
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized not in PERFORMANCE_PROFILE_VALUES:
        return None
    return normalized


__all__ = [
    "InvalidModelParamOverrides",
    "PERFORMANCE_PROFILE_VALUES",
    "normalize_model_param_overrides_for_storage",
    "runtime_profile_to_storage_dict",
    "serialize_model_param_overrides_for_client",
    "maybe_upgrade_stored_overrides",
]

"""Catalog 对外暴露 Canonical Runtime Profile capability（W2e）。

只下发产品语义（thinking modes），**不下发** provider / wire 参数。
来源走 ``read_model_capability``：显式声明 → 同名 global peer → wire 保守推导。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .capability import ModelRuntimeCapability, ThinkingCapability, read_model_capability
from .schema import (
    THINKING_MODE_STANDARD,
    THINKING_MODES,
    effort_to_thinking_mode,
)


def serialize_runtime_profile_for_client(
    capabilities_config: Optional[Dict[str, Any]],
    *,
    global_peer_capabilities_config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """序列化 Catalog 字段 ``runtime_profile``。

    形状::

        {
          "thinking": {
            "supported": true,
            "modes": ["off", "standard", "deep"],
            "default_mode": "standard"
          }
        }

    - ``modes`` 来自 ``user_selectable``（forced thinking 不含 ``off``）
    - 无能力 / BYOK 无声明且无 peer → ``supported=false``、``modes=[]``
    - 绝不包含 ``param_path`` / ``wire_adapter`` / vendor 控件文案
    """
    capability = read_model_capability(
        capabilities_config,
        global_peer_capabilities_config=global_peer_capabilities_config,
    )
    return capability_to_catalog_runtime_profile(capability)


def capability_to_catalog_runtime_profile(
    capability: ModelRuntimeCapability,
) -> Dict[str, Any]:
    thinking = capability.thinking
    if not thinking.supported:
        return {
            "thinking": {
                "supported": False,
                "modes": [],
                "default_mode": THINKING_MODE_STANDARD,
            },
        }

    modes = [mode for mode in thinking.user_selectable if mode in THINKING_MODES]
    default_mode = _resolve_default_mode(thinking, modes)
    # 始终开启且无可点档：前端只读「思考始终开启」，勿当成「不支持思考」。
    always_on = (
        not thinking.off_supported
        and len(modes) == 0
    )
    payload: Dict[str, Any] = {
        "thinking": {
            "supported": True,
            "modes": modes,
            "default_mode": default_mode,
        },
    }
    if always_on:
        payload["thinking"]["always_on"] = True
    return payload


def _resolve_default_mode(
    thinking: ThinkingCapability,
    modes: list[str],
) -> str:
    if not modes:
        return THINKING_MODE_STANDARD

    if thinking.default_effort:
        candidate = effort_to_thinking_mode(
            thinking_enabled=True,
            resolved_effort=thinking.default_effort,
        )
        if candidate in modes:
            return candidate

    if THINKING_MODE_STANDARD in modes:
        return THINKING_MODE_STANDARD
    return modes[0]


__all__ = [
    "capability_to_catalog_runtime_profile",
    "serialize_runtime_profile_for_client",
]

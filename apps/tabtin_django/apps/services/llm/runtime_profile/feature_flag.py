"""Runtime Profile · Proxy 接线 feature flag（W2c）。

环境变量 ``LLM_RUNTIME_PROFILE_ENABLED``：

- 缺省 / true → ON：Proxy 走 ``resolve_user_runtime``，写出 canonical
  ``reasoning_effort`` 再交给既有 wire_adapter
- ``false`` / ``0`` / ``off`` / ``no`` → OFF：保持旧
  ``_merge_model_param_overrides``（只透传 ``reasoning_effort``）

可选模型级覆盖：``capabilities_config.runtime_profile.disabled=True``
时该模型强制走旧 merge（灰度回滚单模型）。
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

_DISABLE_TOKENS = {"false", "0", "off", "no", "disable", "disabled"}
_env_disabled_warned: bool = False


def is_runtime_profile_enabled(model_instance: Optional[Any] = None) -> bool:
    """综合判定当前 Proxy 请求是否走 Runtime Profile Resolver。"""
    global _env_disabled_warned
    env_value = os.environ.get("LLM_RUNTIME_PROFILE_ENABLED", "true").strip().lower()
    if env_value in _DISABLE_TOKENS:
        if not _env_disabled_warned:
            logger.warning(
                "[runtime_profile][feature_flag] DISABLED by env "
                "LLM_RUNTIME_PROFILE_ENABLED=%s — Proxy 回退旧 "
                "_merge_model_param_overrides（只透传 reasoning_effort）。",
                env_value,
            )
            _env_disabled_warned = True
        return False

    if model_instance is not None:
        config = getattr(model_instance, "capabilities_config", None) or {}
        if isinstance(config, dict):
            declared = config.get("runtime_profile")
            if isinstance(declared, dict) and declared.get("disabled") is True:
                model_label = (
                    getattr(model_instance, "model_name", None)
                    or str(getattr(model_instance, "id", "?"))
                )
                logger.info(
                    "[runtime_profile][feature_flag] disabled by model %s "
                    "(capabilities_config.runtime_profile.disabled=True)",
                    model_label,
                )
                return False

    return True


__all__ = ["is_runtime_profile_enabled"]

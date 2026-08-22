"""Canonical Runtime Profile —— 用户意图 → 模型可执行参数的解析层。

设计:``docs/model-runtime/runtime-profile-design.md``
产品政策:``docs/model-runtime/runtime-profile-product-policy.md``
Phase 2: W2a foundation · W2b persistence · W2c proxy · W2e catalog exposure

与 ``wire_adapter`` 的分工:

- 本模块回答「用户想要什么 / 这个模型能给什么」→ 产出 canonical ``resolved_effort``
- ``wire_adapter`` 回答「怎么发给上游」→ 把 canonical 值翻译成厂商参数
"""

from .capability import (
    ModelRuntimeCapability,
    ThinkingCapability,
    read_model_capability,
)
from .catalog import serialize_runtime_profile_for_client
from .feature_flag import is_runtime_profile_enabled
from .persistence import (
    InvalidModelParamOverrides,
    maybe_upgrade_stored_overrides,
    normalize_model_param_overrides_for_storage,
    serialize_model_param_overrides_for_client,
)
from .proxy_resolution import apply_runtime_profile_resolution
from .resolver import resolve_runtime_profile, resolve_user_runtime
from .schema import (
    EFFORT_LADDER,
    EFFORT_LEVELS,
    EFFORT_OFF,
    EFFORT_ON,
    PROFILE_VERSION_V2,
    InvalidRuntimeProfile,
    ResolvedRuntime,
    RuntimeDowngrade,
    RuntimeProfile,
    THINKING_MODE_DEEP,
    THINKING_MODE_OFF,
    THINKING_MODE_STANDARD,
    THINKING_MODES,
    THINKING_MODE_TO_EFFORT,
    effort_to_thinking_mode,
    parse_profile,
    upgrade_v1_to_v2,
)

__all__ = [
    "EFFORT_LADDER",
    "EFFORT_LEVELS",
    "EFFORT_OFF",
    "EFFORT_ON",
    "PROFILE_VERSION_V2",
    "InvalidModelParamOverrides",
    "InvalidRuntimeProfile",
    "ModelRuntimeCapability",
    "ResolvedRuntime",
    "RuntimeDowngrade",
    "RuntimeProfile",
    "THINKING_MODES",
    "THINKING_MODE_DEEP",
    "THINKING_MODE_OFF",
    "THINKING_MODE_STANDARD",
    "THINKING_MODE_TO_EFFORT",
    "ThinkingCapability",
    "apply_runtime_profile_resolution",
    "effort_to_thinking_mode",
    "is_runtime_profile_enabled",
    "maybe_upgrade_stored_overrides",
    "normalize_model_param_overrides_for_storage",
    "parse_profile",
    "read_model_capability",
    "resolve_runtime_profile",
    "resolve_user_runtime",
    "serialize_model_param_overrides_for_client",
    "serialize_runtime_profile_for_client",
    "upgrade_v1_to_v2",
]

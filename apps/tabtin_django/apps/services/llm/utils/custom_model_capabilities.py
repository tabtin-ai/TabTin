"""Custom chat model capability defaults shared by model CRUD boundaries."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .provider_profiles import list_provider_profiles


_MAIN_CHAT_DEFAULT_MAX_OUTPUT_TOKENS = 16_384
_STRUCTURED_CAPABILITY_PATHS = {
    "supports_streaming": ("wire", "stream_supported"),
    "supports_function_calling": ("tool", "enabled"),
    "supports_vision": ("image", "enabled"),
}


def _known_provider_profile(provider_name: str) -> dict[str, Any] | None:
    provider_key = str(provider_name or "").strip().lower()
    if not provider_key:
        return None
    return next(
        (
            item
            for item in list_provider_profiles()
            if str(item.get("provider") or "").strip().lower() == provider_key
        ),
        None,
    )


def _has_explicit_capability(config: dict[str, Any], capability: str) -> bool:
    if capability in config:
        return True
    structured_path = _STRUCTURED_CAPABILITY_PATHS.get(capability)
    if structured_path is None:
        return False
    section = config.get(structured_path[0])
    return isinstance(section, dict) and structured_path[1] in section


def ensure_custom_chat_json_capability(config: Any) -> dict[str, Any]:
    """Register the JSON-object capability required by background AI scenes."""
    normalized = deepcopy(config) if isinstance(config, dict) else {}
    normalized["supports_json_mode"] = True
    json_mode = normalized.get("json_mode")
    json_mode_config = dict(json_mode) if isinstance(json_mode, dict) else {}
    existing_modes = json_mode_config.get("modes")
    modes = list(existing_modes) if isinstance(existing_modes, (list, tuple)) else []
    if "json_object" not in modes:
        modes.append("json_object")
    json_mode_config["modes"] = modes
    normalized["json_mode"] = json_mode_config
    return normalized


def ensure_known_provider_chat_capabilities(
    *,
    provider_name: str,
    config: Any,
) -> dict[str, Any]:
    """Fill missing chat capabilities from an explicitly selected profile.

    Unknown provider names stay untouched.  Existing user declarations win over
    profile defaults; structured capability sections remain authoritative in the
    shared resolver.
    """
    normalized = deepcopy(config) if isinstance(config, dict) else {}
    profile = _known_provider_profile(provider_name)
    if profile is None:
        return normalized

    capabilities = profile.get("capabilities")
    if not isinstance(capabilities, dict):
        return normalized
    for capability, default_value in capabilities.items():
        if not _has_explicit_capability(normalized, capability):
            normalized[capability] = deepcopy(default_value)
    return normalized


def resolve_known_provider_chat_max_output_tokens(
    *,
    provider_name: str,
    context_window_tokens: int,
    explicit_max_output_tokens: int | None,
) -> int | None:
    """Bridge the existing model form's context-only limit for known profiles."""
    if explicit_max_output_tokens is not None:
        return explicit_max_output_tokens
    if _known_provider_profile(provider_name) is None:
        return None
    return min(context_window_tokens, _MAIN_CHAT_DEFAULT_MAX_OUTPUT_TOKENS)

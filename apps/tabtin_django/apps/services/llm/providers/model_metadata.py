"""Provider 声明中的模型级权威能力元数据。"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from apps.services.llm.registry import ProviderRegistry


def merge_authoritative_model_capabilities(
    *,
    provider_name: str,
    provider_scope: str,
    model_name: str,
    capabilities_config: dict[str, Any] | None,
) -> dict[str, Any]:
    """把精确 Official 模型声明合并进持久化能力配置。

    仅 ``scope=global`` 的 Provider 可继承 Registry 声明，避免同名个人/组织
    BYOK 或 relay 模型被平台 Catalog 元数据覆盖。
    """
    merged = deepcopy(capabilities_config or {})
    if provider_scope != "global":
        return merged

    provider = ProviderRegistry.get(provider_name)
    if provider is None:
        return merged
    declaration = next(
        (
            item
            for item in provider.static_models
            if item.model_name == model_name
        ),
        None,
    )
    if declaration is None or declaration.supports_json_mode is None:
        return merged

    merged["supports_json_mode"] = declaration.supports_json_mode
    json_mode = merged.get("json_mode")
    json_mode_config = dict(json_mode) if isinstance(json_mode, dict) else {}
    existing_modes = json_mode_config.get("modes")
    modes = list(existing_modes) if isinstance(existing_modes, (list, tuple)) else []
    for mode in declaration.json_modes:
        if mode not in modes:
            modes.append(mode)
    json_mode_config["modes"] = modes
    merged["json_mode"] = json_mode_config
    return merged


__all__ = ["merge_authoritative_model_capabilities"]

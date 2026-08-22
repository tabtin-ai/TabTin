"""统一实体查询门面 — 聚合 CORE_APPS / ChannelAdapterRegistry / ExtensionRegistry。

只读服务，所有方法均为 classmethod，不持有实例状态。
每次调用都实时从底层注册表查询，保证数据一致性。

用法：
    from apps.services.common.entity_query_service import EntityQueryService

    all_entities = EntityQueryService.list_all()
    channels = EntityQueryService.list_all(kind="channel")
    entity = EntityQueryService.get("telegram")
    manifests = EntityQueryService.list_manifests(kind="app")
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_EXTENSION_TYPE_TO_KIND = {
    "integration": "integration",
}


@dataclass
class EntityDescriptor:
    """统一的实体描述 — 所有类型实体的公共视图。"""

    id: str
    name: str
    kind: str  # "app" | "channel" | "integration" | "extension"
    description: str = ""
    icon: str = ""
    version: str = ""
    is_builtin: bool = True
    capabilities: Dict[str, bool] = field(default_factory=dict)
    config_schema: Dict[str, Any] = field(default_factory=dict)
    source: str = "builtin"
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_manifest(self) -> Dict[str, Any]:
        """转为 API 响应用的 manifest 格式。"""
        return asdict(self)


class EntityQueryService:
    """统一实体查询门面 — 聚合三个注册表的只读接口。

    不持有状态，所有方法都是类方法，实时从底层注册表查询。

    去重优先级：CORE_APPS > ChannelAdapterRegistry > ExtensionRegistry
    """

    @classmethod
    def get(cls, entity_id: str) -> Optional[EntityDescriptor]:
        """按 ID 查询实体（先查 CORE_APPS，再查 Channel，最后查 Extension）。"""
        from apps.services.common.app_registry import get_app

        app_def = get_app(entity_id)
        if app_def is not None:
            try:
                return cls._app_to_descriptor(app_def)
            except Exception:
                logger.warning("转换 App '%s' 失败", entity_id, exc_info=True)

        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

        adapter = ChannelAdapterRegistry.get(entity_id)
        if adapter is not None:
            try:
                return cls._channel_to_descriptor(adapter)
            except Exception:
                logger.warning("转换 Channel '%s' 失败", entity_id, exc_info=True)

        from apps.extensions.registry import ExtensionRegistry

        ext = ExtensionRegistry.get(entity_id)
        if ext is not None:
            try:
                desc = cls._extension_to_descriptor(ext)
                if desc is not None:
                    return desc
            except Exception:
                logger.warning("转换 Extension '%s' 失败", entity_id, exc_info=True)

        return None

    @classmethod
    def list_all(cls, kind: Optional[str] = None) -> List[EntityDescriptor]:
        """列出所有实体，可按 kind 过滤。

        去重规则：同一 ID 只保留优先级最高的来源。
        """
        seen: set[str] = set()
        results: List[EntityDescriptor] = []

        for desc in cls._iter_apps():
            if desc.id not in seen:
                seen.add(desc.id)
                results.append(desc)

        for desc in cls._iter_channels():
            if desc.id not in seen:
                seen.add(desc.id)
                results.append(desc)

        for desc in cls._iter_extensions():
            if desc is not None and desc.id not in seen:
                seen.add(desc.id)
                results.append(desc)

        if kind is not None:
            results = [d for d in results if d.kind == kind]

        return results

    @classmethod
    def list_manifests(cls, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        """返回所有实体的 manifest 格式数据（用于 API 响应）。"""
        return [d.to_manifest() for d in cls.list_all(kind=kind)]

    @classmethod
    def get_config_schema(cls, entity_id: str) -> Optional[Dict[str, Any]]:
        """获取实体的配置 schema。

        App 没有运行时配置 schema，返回空 dict。
        """
        desc = cls.get(entity_id)
        if desc is None:
            return None
        return desc.config_schema

    # =================================================================
    # 内部迭代器 — 逐注册表产出 EntityDescriptor
    # =================================================================

    @classmethod
    def _iter_apps(cls):
        from apps.services.common.app_registry import list_apps

        for app_def in list_apps():
            try:
                yield cls._app_to_descriptor(app_def)
            except Exception:
                logger.warning("转换 App '%s' 失败", app_def.id, exc_info=True)

    @classmethod
    def _iter_channels(cls):
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

        for adapter in ChannelAdapterRegistry.list_all():
            try:
                yield cls._channel_to_descriptor(adapter)
            except Exception:
                logger.warning(
                    "转换 Channel '%s' 失败", getattr(adapter, "id", "?"), exc_info=True
                )

    @classmethod
    def _iter_extensions(cls):
        from apps.extensions.constants import ExtensionType
        from apps.extensions.registry import ExtensionRegistry

        for ext in ExtensionRegistry.list_all():
            if getattr(ext, "extension_type", None) == ExtensionType.CHANNEL:
                continue
            try:
                yield cls._extension_to_descriptor(ext)
            except Exception:
                logger.warning(
                    "转换 Extension '%s' 失败", getattr(ext, "id", "?"), exc_info=True
                )

    # =================================================================
    # 内部转换方法
    # =================================================================

    @classmethod
    def _app_to_descriptor(cls, app_def) -> EntityDescriptor:
        """将 AppDefinition 转为 EntityDescriptor。"""
        return EntityDescriptor(
            id=app_def.id,
            name=app_def.name,
            kind="app",
            description=app_def.description,
            icon=app_def.icon,
            is_builtin=True,
            capabilities={
                "has_tools": bool(app_def.tool_domains),
                "has_prompt": app_def.has_prompt_section,
                "is_frontend_dependent": app_def.is_frontend_dependent,
            },
            extra={
                "tool_domains": list(app_def.tool_domains),
                "context_fields": [
                    {"name": f.name, "label": f.label, "is_resource_id": f.is_resource_id}
                    for f in app_def.context_fields
                ],
                "category": app_def.category,
                "order": app_def.order,
            },
        )

    @classmethod
    def _channel_to_descriptor(cls, adapter) -> EntityDescriptor:
        """将 ChannelAdapter 转为 EntityDescriptor。"""
        caps = adapter.capabilities
        cap_dict = (
            asdict(caps) if hasattr(caps, "__dataclass_fields__") else {}
        )
        chat_types = cap_dict.pop("chat_types", [])

        config_schema: Dict[str, Any] = {}
        if hasattr(adapter, "get_config_schema"):
            try:
                config_schema = adapter.get_config_schema()
            except Exception:
                logger.debug(
                    "获取 Channel '%s' config schema 失败",
                    adapter.id,
                    exc_info=True,
                )

        return EntityDescriptor(
            id=adapter.id,
            name=adapter.name,
            kind="channel",
            description=getattr(adapter, "description", ""),
            icon=getattr(adapter, "icon", ""),
            is_builtin=getattr(adapter, "is_builtin", True),
            capabilities=cap_dict,
            config_schema=config_schema,
            extra={"chat_types": chat_types},
        )

    @classmethod
    def _extension_to_descriptor(cls, ext) -> Optional[EntityDescriptor]:
        """将 BaseExtension 转为 EntityDescriptor。

        channel 类型的 Extension 返回 None（由 ChannelAdapterRegistry 覆盖）。
        """
        from apps.extensions.constants import ExtensionType

        ext_type = getattr(ext, "extension_type", "")
        if ext_type == ExtensionType.CHANNEL:
            return None

        kind = _EXTENSION_TYPE_TO_KIND.get(ext_type, "extension")

        caps = ext.capabilities
        cap_dict = (
            asdict(caps) if hasattr(caps, "__dataclass_fields__") else {}
        )

        config_schema: Dict[str, Any] = {}
        if hasattr(ext, "get_config_schema"):
            try:
                config_schema = ext.get_config_schema()
            except Exception:
                logger.debug(
                    "获取 Extension '%s' config schema 失败",
                    ext.id,
                    exc_info=True,
                )

        return EntityDescriptor(
            id=ext.id,
            name=ext.name,
            kind=kind,
            description=getattr(ext, "description", ""),
            icon=getattr(ext, "icon", ""),
            is_builtin=getattr(ext, "is_builtin", False),
            capabilities=cap_dict,
            config_schema=config_schema,
            source="builtin" if getattr(ext, "is_builtin", False) else "marketplace",
        )

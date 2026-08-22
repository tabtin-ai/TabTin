"""Extension 注册表

单例模式，在 Django AppConfig.ready() 时注册所有 Extension 实例。
参考 ChannelAdapterRegistry 的设计，但增加了按类型查询、工具注册联动等能力。
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

from apps.extensions.base import BaseExtension
from apps.extensions.public_api import public_api

logger = logging.getLogger(__name__)


@public_api("全局 Extension 注册表")
class ExtensionRegistry:
    """全局 Extension 注册表（线程安全、仅追加）。"""

    _extensions: Dict[str, BaseExtension] = {}
    _cli_commands: Dict[str, List[Dict]] = {}  # extension_id → CLI 命令列表

    # ------------------------------------------------------------------
    # 注册
    # ------------------------------------------------------------------

    @public_api("注册 Extension 实例到全局注册表")
    @classmethod
    def register(cls, extension: BaseExtension) -> None:
        ext_id = extension.id
        if ext_id in cls._extensions:
            logger.warning(
                "[ExtensionRegistry] 覆盖已有 Extension: %s", ext_id
            )
        cls._extensions[ext_id] = extension
        logger.info(
            "[ExtensionRegistry] 注册 Extension: %s (%s) type=%s",
            ext_id,
            extension.name,
            extension.extension_type,
        )

        # W6 (2026-05-04): Extension tools are no longer pushed into ToolHub.
        # Tool instances are discovered on-demand via ``extension.get_tools()``
        # (see ``apps.extensions.api._find_extension_tool``).
        if extension.capabilities.has_cli:
            cls._register_cli(extension)

    @classmethod
    def _register_cli(cls, extension: BaseExtension) -> None:
        """收集 Extension 的 CLI 命令声明，供 tabtin CLI 运行时查询。"""
        from dataclasses import asdict
        try:
            commands = extension.get_cli_commands()
            if not commands:
                return
            cmd_list = [asdict(cmd) for cmd in commands]
            cls._cli_commands[extension.id] = cmd_list
            logger.info(
                "[ExtensionRegistry] 已注册 %d 个 CLI 命令: extension=%s",
                len(cmd_list), extension.id,
            )
        except Exception:
            logger.warning(
                "[ExtensionRegistry] 注册 CLI 命令失败: extension=%s",
                extension.id, exc_info=True,
            )

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    @public_api("按 ID 查询已注册的 Extension")
    @classmethod
    def get(cls, extension_id: str) -> Optional[BaseExtension]:
        return cls._extensions.get(extension_id)

    @public_api("列出所有已注册的 Extension")
    @classmethod
    def list_all(cls) -> List[BaseExtension]:
        return list(cls._extensions.values())

    @classmethod
    def list_ids(cls) -> List[str]:
        return list(cls._extensions.keys())

    @classmethod
    def has(cls, extension_id: str) -> bool:
        return extension_id in cls._extensions

    @classmethod
    def list_by_type(cls, extension_type: str) -> List[BaseExtension]:
        return [
            ext
            for ext in cls._extensions.values()
            if ext.extension_type == extension_type
        ]

    @classmethod
    def list_with_cli(cls) -> List[BaseExtension]:
        """返回所有有 CLI 能力的 Extension。"""
        return [
            ext
            for ext in cls._extensions.values()
            if ext.capabilities.has_cli
        ]

    @public_api("返回所有 Extension CLI 命令声明")
    @classmethod
    def get_all_cli_commands(cls) -> List[Dict]:
        """返回所有 Extension CLI 命令（供 tabtin CLI 动态注册）。

        返回格式: [{"extension_id", "name", "description", "api_endpoint", ...}]
        """
        result = []
        for ext_id, commands in cls._cli_commands.items():
            for cmd in commands:
                result.append({"extension_id": ext_id, **cmd})
        return result

    @classmethod
    def list_with_events(cls) -> List[BaseExtension]:
        """返回所有有事件能力的 Extension。"""
        return [
            ext
            for ext in cls._extensions.values()
            if ext.capabilities.has_events
        ]

    @classmethod
    def get_manifest(cls, extension_id: str) -> Optional[Dict]:
        """返回 Extension 的完整 manifest（用于 API 暴露）。"""
        ext = cls._extensions.get(extension_id)
        if not ext:
            return None
        return {
            "id": ext.id,
            "name": ext.name,
            "description": ext.description,
            "icon": ext.icon,
            "type": ext.extension_type,
            "is_builtin": ext.is_builtin,
            "capabilities": {
                "has_tools": ext.capabilities.has_tools,
                "has_cli": ext.capabilities.has_cli,
                "has_events": ext.capabilities.has_events,
                "has_inbound_webhook": ext.capabilities.has_inbound_webhook,
                "has_ui": ext.capabilities.has_ui,
                "supports_oauth": ext.capabilities.supports_oauth,
                "supports_polling": ext.capabilities.supports_polling,
            },
            "config_schema": ext.get_config_schema(),
            "event_types": [
                {
                    "event_type": e.event_type,
                    "description": e.description,
                    "payload_fields": [
                        {
                            "key": pf.key,
                            "label": pf.label,
                            "type": pf.type,
                            "example": pf.example,
                        }
                        for pf in e.payload_fields
                    ],
                }
                for e in ext.get_event_types()
            ],
        }

    @classmethod
    def list_manifests(cls) -> List[Dict]:
        """返回所有已注册 Extension 的 manifest 列表。"""
        return [
            m for m in
            (cls.get_manifest(ext_id) for ext_id in cls._extensions)
            if m is not None
        ]

    # ------------------------------------------------------------------
    # 测试
    # ------------------------------------------------------------------

    @classmethod
    def _reset(cls) -> None:
        """仅供测试使用。"""
        cls._extensions = {}
        cls._cli_commands = {}

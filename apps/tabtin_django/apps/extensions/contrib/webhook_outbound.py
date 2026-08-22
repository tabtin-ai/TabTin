"""Webhook 出站 Extension

用户自定义 webhook URL，当系统事件发生时推送到指定 URL。
这是最简单的 Extension 类型 — 只有配置面和事件消费。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, TYPE_CHECKING

from apps.extensions.base import (
    BaseExtension,
    ConfigField,
    EventDescriptor,
    ExtensionCapabilities,
)
from apps.extensions.constants import ExtensionType

if TYPE_CHECKING:
    from apps.extensions.models import ExtensionConnection


class WebhookOutboundExtension(BaseExtension):

    @property
    def id(self) -> str:
        return "webhook_outbound"

    @property
    def name(self) -> str:
        return "Webhook 出站"

    @property
    def description(self) -> str:
        return "将系统事件推送到自定义 Webhook URL"

    @property
    def icon(self) -> str:
        return "webhook"

    @property
    def extension_type(self) -> str:
        return ExtensionType.INTEGRATION

    @property
    def capabilities(self) -> ExtensionCapabilities:
        return ExtensionCapabilities(
            has_tools=False,
            has_events=False,
            has_inbound_webhook=False,
            has_ui=False,
        )

    def get_config_fields(self) -> List[ConfigField]:
        return [
            ConfigField(key="url", label="Webhook URL", field_type="url", required=True),
            ConfigField(key="secret", label="签名密钥", field_type="password",
                        help_text="用于 HMAC-SHA256 签名验证"),
            ConfigField(key="events", label="订阅事件", field_type="string",
                        help_text="逗号分隔的事件类型，如 email.received,telegram.message_received"),
        ]

    def get_event_types(self) -> List[EventDescriptor]:
        return []

    def get_tools(self, connection: Optional["ExtensionConnection"] = None) -> list:
        return []

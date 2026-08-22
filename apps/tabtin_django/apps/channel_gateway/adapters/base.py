"""Abstract base class for channel adapters.

Each external messaging platform (Telegram, WeChat Work, DingTalk, …) implements
this interface so the channel_gateway can route messages uniformly.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from apps.extensions.base import ConfigField, EventDescriptor

from django.http import HttpRequest

from apps.channel_gateway.models import ChannelAccount
from apps.channel_gateway.schemas import ChannelInboundMessage

logger = logging.getLogger(__name__)

PeerKind = Literal["direct", "group", "channel", "thread"]


class WebhookChallengeResponse(Exception):
    """Raised by parse_webhook when a URL verification challenge is detected.

    The webhook view catches this and returns the challenge to the platform.

    If *raw_json* is ``True`` the view returns ``challenge`` as the raw HTTP
    body with ``content_type="application/json"`` instead of wrapping it in
    ``{"challenge": ...}``.  This is required for Discord's PING/PONG flow.
    """

    def __init__(self, challenge: str, *, raw_json: bool = False):
        super().__init__(challenge)
        self.challenge = challenge
        self.raw_json = raw_json


class WebhookRejectError(Exception):
    """Raised by adapters for unrecoverable webhook errors (bad signature, malformed body, etc.).

    The webhook view returns HTTP 400 for these, signalling the platform
    should NOT retry the delivery.
    """


@dataclass(frozen=True)
class ChannelCapabilities:
    """Declarative capability matrix — the gateway adapts behaviour accordingly."""

    chat_types: List[PeerKind] = field(default_factory=lambda: ["direct"])
    media: bool = False
    reactions: bool = False
    threads: bool = False
    polls: bool = False
    edit: bool = False
    unsend: bool = False
    native_commands: bool = False
    supports_polling: bool = False
    supports_webhook: bool = True


@dataclass(frozen=True)
class SendResult:
    """Outcome of a single outbound send attempt."""

    ok: bool
    provider_message_id: Optional[str] = None
    error: Optional[str] = None


@dataclass
class ProbeResult:
    """连通性检查结果 — ChannelAdapter 和 Extension 共用。

    ``display_name``：人类可读名称（如 "My Telegram Bot"）。
    ``bot_username``：机器标识（如 Telegram @username、飞书 open_id）。
    ``latency_ms``：由调用方（API 层）在计时后填入。
    ``bot_name``：``display_name`` 的只读别名，向后兼容。
    """

    ok: bool
    display_name: Optional[str] = None
    bot_username: Optional[str] = None
    error: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None
    latency_ms: Optional[float] = None

    @property
    def bot_name(self) -> Optional[str]:
        """向后兼容别名 → display_name。"""
        return self.display_name


class ChannelAdapter(ABC):
    """Base contract every channel adapter must satisfy.

    Lifecycle:
    1. ``validate_config`` — called when a user saves account settings.
    2. ``probe`` — called to verify credentials / connectivity.
    3. ``setup_webhook`` — called after account creation (if applicable).
    4. ``parse_webhook`` — called on every inbound webhook hit.
    5. ``send_text`` / ``send_media`` — called to deliver outbound messages.
    """

    # ------------------------------------------------------------------
    # Identity — subclasses set these as class attributes
    # ------------------------------------------------------------------

    @property
    @abstractmethod
    def id(self) -> str:
        """Unique channel identifier, e.g. ``"telegram"``."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable label, e.g. ``"Telegram Bot"``."""

    @property
    @abstractmethod
    def capabilities(self) -> ChannelCapabilities:
        ...

    @property
    def description(self) -> str:
        return ""

    @property
    def icon(self) -> str:
        return ""

    @property
    def is_builtin(self) -> bool:
        return True

    # ------------------------------------------------------------------
    # Config helpers
    # ------------------------------------------------------------------

    def get_config_fields(self) -> List[ConfigField]:
        """返回 ConfigField 列表，用于前端表单渲染。

        新渠道应覆盖此方法。
        默认实现：空列表（向后兼容现有 Adapter）。
        """
        return []

    @abstractmethod
    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        """Return a list of validation error strings (empty = valid)."""

    def get_config_schema(self) -> Dict[str, Any]:
        """JSON Schema for the front-end config form.

        如果子类覆盖了 ``get_config_fields()``，此方法自动从配置字段
        生成 JSON Schema（逻辑与 BaseExtension 一致）；否则返回空对象。
        每个 property 额外携带 ``x-field-type`` 扩展字段，
        值与 ConfigField.field_type 一致，方便前端精确判断输入控件类型。
        """
        fields = self.get_config_fields()
        if not fields:
            return {}

        properties: Dict[str, Any] = {}
        required: List[str] = []
        for f in fields:
            prop: Dict[str, Any] = {"title": f.label, "x-field-type": f.field_type}
            if f.field_type == "boolean":
                prop["type"] = "boolean"
            elif f.field_type == "select" and f.options:
                prop["type"] = "string"
                prop["enum"] = [o["value"] for o in f.options]
            else:
                prop["type"] = "string"
            if f.default is not None:
                prop["default"] = f.default
            if f.help_text:
                prop["description"] = f.help_text
            properties[f.key] = prop
            if f.required:
                required.append(f.key)

        return {
            "type": "object",
            "properties": properties,
            "required": required,
        }

    # ------------------------------------------------------------------
    # Connectivity
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        """Verify credentials and return bot identity info."""
        return ProbeResult(ok=False, error="probe not implemented")

    async def setup_webhook(
        self,
        account: ChannelAccount,
        webhook_url: str,
    ) -> bool:
        """Register the platform webhook. Return ``True`` on success."""
        return False

    async def remove_webhook(self, account: ChannelAccount) -> bool:
        """De-register the platform webhook."""
        return False

    # ------------------------------------------------------------------
    # Routing context extraction
    # ------------------------------------------------------------------

    def extract_routing_context(
        self,
        data: ChannelInboundMessage,
    ) -> Optional[Dict[str, Any]]:
        """Return adapter-specific routing context to be persisted in binding metadata.

        Adapters override this to declare which fields from an inbound message
        should be durably stored in ``ChannelBinding.metadata["_routing"]``,
        enabling outbound delivery even after Django cache expires.

        Default implementation returns ``None`` (nothing to persist).
        """
        return None

    # ------------------------------------------------------------------
    # Inbound
    # ------------------------------------------------------------------

    @abstractmethod
    def parse_webhook(
        self,
        request: HttpRequest,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """Parse a platform-specific webhook payload into the canonical schema.

        Return ``None`` to silently skip non-message updates (e.g. typing indicators).
        """

    async def poll_updates(
        self,
        account: ChannelAccount,
        offset: Any = None,
        timeout: int = 5,
    ) -> tuple[List[ChannelInboundMessage], Any]:
        """Poll the platform for new messages (for adapters that support polling).

        ``offset`` is an opaque cursor whose type varies per adapter
        (int for Telegram, str for iLink, etc.).

        Returns ``(messages, new_offset)``.  Default raises NotImplementedError.
        Only override if ``capabilities.supports_polling`` is True.
        """
        raise NotImplementedError(f"{self.id} does not support polling")

    # ------------------------------------------------------------------
    # Outbound
    # ------------------------------------------------------------------

    @abstractmethod
    async def send_text(
        self,
        account: ChannelAccount,
        to: str,
        text: str,
        *,
        reply_to: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> SendResult:
        ...

    async def send_media(
        self,
        account: ChannelAccount,
        to: str,
        media_url: str,
        *,
        caption: Optional[str] = None,
        mime_type: Optional[str] = None,
        reply_to: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> SendResult:
        """Default: fall back to sending a text link."""
        text = caption or media_url
        if caption and media_url:
            text = f"{caption}\n{media_url}"
        return await self.send_text(account, to, text, reply_to=reply_to, thread_id=thread_id)

    # ------------------------------------------------------------------
    # Typing indicator
    # ------------------------------------------------------------------

    async def send_typing(
        self,
        account: ChannelAccount,
        to: str,
        action: str = "typing",
    ) -> None:
        """Send a typing indicator to the peer. Override in subclasses.

        action: "typing" to start, "cancel" to stop.
        Default: no-op (most platforms don't expose this API).
        """
        pass

    # ------------------------------------------------------------------
    # Tool & event descriptors
    # ------------------------------------------------------------------

    def get_tools(self) -> list:
        """Return Agent-visible tools for this channel.

        W6 (2026-05-04): the LLM tool SSoT lives in the TS runtime, so channel
        adapters no longer ship Python BaseTool implementations. Subclasses can
        still override this if they need to expose extension-specific BaseTools
        via the Extension CLI bridge, but the default is now an empty list.
        """
        return []

    def get_tool_domain(self) -> str:
        """Domain identifier (kept for downstream wiring, e.g. extension CLI)."""
        return self.id

    def get_event_types(self) -> List[EventDescriptor]:
        """声明该渠道能产生的事件类型。

        默认实现：{id}.message_received 和 {id}.command_received，
        覆盖了绝大多数渠道的基本事件模型。子类可覆盖以添加更多事件。
        """
        from apps.extensions.base import EventDescriptor as _ED, PayloadField as _PF

        cid = self.id
        return [
            _ED(
                event_type=f"{cid}.message_received",
                description="收到用户消息",
                payload_fields=[
                    _PF(key="chat_id", label="会话 ID"),
                    _PF(key="sender_id", label="发送者 ID"),
                    _PF(key="text", label="消息内容"),
                    _PF(key="peer_kind", label="会话类型", example="direct"),
                    _PF(key="message_id", label="消息 ID"),
                ],
            ),
            _ED(
                event_type=f"{cid}.command_received",
                description="收到 Bot 命令（以 / 开头的消息）",
                payload_fields=[
                    _PF(key="text", label="命令内容", example="/help"),
                    _PF(key="chat_id", label="会话 ID"),
                    _PF(key="sender_id", label="发送者 ID"),
                ],
            ),
        ]

    # ------------------------------------------------------------------
    # Text utilities
    # ------------------------------------------------------------------

    def chunk_text(self, text: str, limit: int = 4096) -> List[str]:
        """Split long replies into platform-safe chunks."""
        if len(text) <= limit:
            return [text]
        chunks: List[str] = []
        while text:
            if len(text) <= limit:
                chunks.append(text)
                break
            split_at = text.rfind("\n", 0, limit)
            if split_at <= 0:
                split_at = limit
            chunks.append(text[:split_at])
            text = text[split_at:].lstrip("\n")
        return chunks

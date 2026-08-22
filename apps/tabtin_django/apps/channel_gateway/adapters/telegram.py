"""Telegram Bot API adapter.

Uses httpx to call the Telegram Bot API directly — no heavy third-party
framework dependency.  Supports both webhook parsing and outbound send.

Supports optional ``secret_token`` for webhook request verification via
the ``X-Telegram-Bot-Api-Secret-Token`` header.
"""

from __future__ import annotations

import hmac
import json
import logging
import re
from typing import Any, Dict, List, Optional

import httpx
from django.http import HttpRequest

from apps.channel_gateway.models import ChannelAccount
from apps.channel_gateway.schemas import (
    CHANNEL_PROTOCOL_VERSION,
    ChannelInboundMessage,
    ChannelMedia,
)

from .base import (
    ChannelAdapter,
    ChannelCapabilities,
    ProbeResult,
    SendResult,
)

logger = logging.getLogger(__name__)

TELEGRAM_API_BASE = "https://api.telegram.org"
TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]{30,}$")
TEXT_CHUNK_LIMIT = 4096


def _extract_bot_token(account: ChannelAccount) -> str:
    config = account.config or {}
    token = (config.get("bot_token") or "").strip()
    if not token:
        raise ValueError("bot_token not configured")
    return token


def _api_url(token: str, method: str) -> str:
    return f"{TELEGRAM_API_BASE}/bot{token}/{method}"


def _resolve_peer_kind(chat: Dict[str, Any]) -> str:
    chat_type = chat.get("type", "")
    if chat_type in ("group", "supergroup"):
        return "group"
    if chat_type == "channel":
        return "group"
    return "dm"


def _build_sender_id(from_user: Dict[str, Any] | None) -> str:
    if not from_user:
        return "unknown"
    return str(from_user.get("id", "unknown"))


def _extract_sender_meta(from_user: Dict[str, Any] | None) -> Dict[str, str]:
    """Pull display-useful fields from the Telegram ``from`` object."""
    if not from_user:
        return {}
    meta: Dict[str, str] = {}
    if from_user.get("username"):
        meta["sender_username"] = from_user["username"]
    first = from_user.get("first_name", "")
    last = from_user.get("last_name", "")
    name = f"{first} {last}".strip()
    if name:
        meta["sender_name"] = name
    return meta


def _extract_text(message: Dict[str, Any]) -> Optional[str]:
    return message.get("text") or message.get("caption")


def _extract_media(message: Dict[str, Any]) -> Optional[List[ChannelMedia]]:
    items: List[ChannelMedia] = []
    if message.get("photo"):
        best = max(message["photo"], key=lambda p: p.get("file_size", 0))
        items.append(ChannelMedia(kind="image", file_id=best.get("file_id")))
    if message.get("document"):
        doc = message["document"]
        items.append(
            ChannelMedia(
                kind="file",
                file_id=doc.get("file_id"),
                mime_type=doc.get("mime_type"),
                filename=doc.get("file_name"),
                size=doc.get("file_size"),
            )
        )
    if message.get("video"):
        vid = message["video"]
        items.append(
            ChannelMedia(
                kind="video",
                file_id=vid.get("file_id"),
                mime_type=vid.get("mime_type"),
                size=vid.get("file_size"),
            )
        )
    if message.get("voice"):
        voice = message["voice"]
        items.append(
            ChannelMedia(
                kind="audio",
                file_id=voice.get("file_id"),
                mime_type=voice.get("mime_type"),
                size=voice.get("file_size"),
            )
        )
    if message.get("audio"):
        audio = message["audio"]
        items.append(
            ChannelMedia(
                kind="audio",
                file_id=audio.get("file_id"),
                mime_type=audio.get("mime_type"),
                filename=audio.get("file_name"),
                size=audio.get("file_size"),
            )
        )
    if message.get("sticker"):
        stk = message["sticker"]
        items.append(ChannelMedia(kind="sticker", file_id=stk.get("file_id")))
    return items if items else None


class TelegramAdapter(ChannelAdapter):
    """Telegram Bot API channel adapter."""

    # ------------------------------------------------------------------
    # Identity
    # ------------------------------------------------------------------

    @property
    def id(self) -> str:
        return "telegram"

    @property
    def name(self) -> str:
        return "Telegram Bot"

    @property
    def description(self) -> str:
        return "通过 Telegram Bot 收发消息，将 Telegram 对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "telegram"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group"],
            media=True,
            reactions=True,
            threads=True,
            polls=True,
            native_commands=True,
            supports_polling=True,
        )

    # ------------------------------------------------------------------
    # Config
    # ------------------------------------------------------------------

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="bot_token",
                label="Bot Token",
                field_type="password",
                required=True,
                help_text="从 @BotFather 获取的 Bot Token",
            ),
            ConfigField(
                key="secret_token",
                label="Secret Token",
                field_type="password",
                help_text="Token for webhook request verification (1-256 chars, A-Za-z0-9_-)",
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        token = (config.get("bot_token") or "").strip()
        if not token:
            errors.append("bot_token is required")
        elif not TOKEN_RE.match(token):
            errors.append("bot_token format is invalid (expected <id>:<hash>)")
        if not (config.get("secret_token") or "").strip():
            errors.append("secret_token is required")
        return errors

    # ------------------------------------------------------------------
    # Connectivity
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        token = _extract_bot_token(account)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(_api_url(token, "getMe"))
                data = resp.json()
            if not data.get("ok"):
                return ProbeResult(
                    ok=False,
                    error=data.get("description", "getMe failed"),
                )
            bot = data.get("result", {})
            return ProbeResult(
                ok=True,
                bot_username=bot.get("username"),
                display_name=bot.get("first_name"),
                raw=bot,
            )
        except Exception as exc:
            return ProbeResult(ok=False, error=str(exc))

    async def setup_webhook(
        self,
        account: ChannelAccount,
        webhook_url: str,
    ) -> bool:
        token = _extract_bot_token(account)
        config = account.config or {}
        try:
            payload: Dict[str, Any] = {
                "url": webhook_url,
                "allowed_updates": [
                    "message",
                    "edited_message",
                    "channel_post",
                ],
            }
            secret = (config.get("secret_token") or "").strip()
            if secret:
                payload["secret_token"] = secret
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    _api_url(token, "setWebhook"),
                    json=payload,
                )
                data = resp.json()
            if data.get("ok"):
                logger.info("[TelegramAdapter] webhook set: %s", webhook_url)
                return True
            logger.warning(
                "[TelegramAdapter] setWebhook failed: %s",
                data.get("description"),
            )
            return False
        except Exception as exc:
            logger.error("[TelegramAdapter] setWebhook error: %s", exc)
            return False

    async def remove_webhook(self, account: ChannelAccount) -> bool:
        token = _extract_bot_token(account)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(_api_url(token, "deleteWebhook"))
                return resp.json().get("ok", False)
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Inbound
    # ------------------------------------------------------------------

    def parse_webhook(
        self,
        request: HttpRequest,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        config = account.config or {}
        secret = (config.get("secret_token") or "").strip()
        if not secret:
            logger.warning(
                "[TelegramAdapter] secret_token 未配置，拒绝处理 webhook (account=%s)",
                account.account_id,
            )
            return None
        header_token = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if not hmac.compare_digest(secret, header_token):
            logger.warning("[TelegramAdapter] secret_token mismatch")
            return None

        try:
            body = json.loads(request.body)
        except (json.JSONDecodeError, ValueError):
            logger.warning("[TelegramAdapter] invalid JSON body")
            return None

        message = body.get("message") or body.get("edited_message") or body.get("channel_post")
        if not message:
            return None

        chat = message.get("chat", {})
        chat_id = str(chat.get("id", ""))
        if not chat_id:
            return None

        text = _extract_text(message)
        media = _extract_media(message)
        if not text and not media:
            return None

        mentioned = False
        if chat.get("type") in ("group", "supergroup"):
            entities = message.get("entities") or []
            for ent in entities:
                if ent.get("type") in ("mention", "text_mention"):
                    mentioned = True
                    break

        metadata: Dict[str, Any] = {"mentioned": mentioned}
        metadata.update(_extract_sender_meta(message.get("from")))
        if message.get("reply_to_message"):
            metadata["reply_to_message_id"] = str(
                message["reply_to_message"].get("message_id", "")
            )

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=_resolve_peer_kind(chat),
            peer_id=chat_id,
            sender_id=_build_sender_id(message.get("from")),
            message_id=str(message.get("message_id", body.get("update_id", ""))),
            reply_to=(
                str(message["reply_to_message"]["message_id"])
                if message.get("reply_to_message")
                else None
            ),
            text=text,
            media=media,
            timestamp=message.get("date", 0),
            metadata=metadata,
        )

    # ------------------------------------------------------------------
    # Outbound
    # ------------------------------------------------------------------

    async def send_chat_action(
        self,
        account: ChannelAccount,
        chat_id: str,
        action: str = "typing",
    ) -> None:
        """Send a chat action indicator (e.g. ``typing``). Fire-and-forget."""
        token = _extract_bot_token(account)
        await self._call_api(token, "sendChatAction", {
            "chat_id": chat_id,
            "action": action,
        })

    async def send_text(
        self,
        account: ChannelAccount,
        to: str,
        text: str,
        *,
        reply_to: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> SendResult:
        token = _extract_bot_token(account)
        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_message_id: Optional[str] = None

        for chunk in chunks:
            payload: Dict[str, Any] = {
                "chat_id": to,
                "text": chunk,
                "parse_mode": "Markdown",
            }
            if reply_to and last_message_id is None:
                payload["reply_to_message_id"] = int(reply_to)
            if thread_id:
                try:
                    payload["message_thread_id"] = int(thread_id)
                except (ValueError, TypeError):
                    pass

            result = await self._call_api(token, "sendMessage", payload)
            if not result.ok and "parse" in (result.error or "").lower():
                payload.pop("parse_mode", None)
                result = await self._call_api(token, "sendMessage", payload)
            if not result.ok:
                return result
            last_message_id = result.provider_message_id

        return SendResult(ok=True, provider_message_id=last_message_id)

    async def send_media(
        self,
        account: ChannelAccount,
        to: str,
        media_url: str,
        *,
        caption: Optional[str] = None,
        mime_type: Optional[str] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        token = _extract_bot_token(account)
        is_image = (mime_type or "").startswith("image/") or any(
            media_url.lower().endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp")
        )
        method = "sendPhoto" if is_image else "sendDocument"
        key = "photo" if is_image else "document"

        payload: Dict[str, Any] = {"chat_id": to, key: media_url}
        if caption:
            payload["caption"] = caption[:1024]
        if reply_to:
            payload["reply_to_message_id"] = int(reply_to)

        return await self._call_api(token, method, payload)

    # ------------------------------------------------------------------
    # Polling (for local development without public URL)
    # ------------------------------------------------------------------

    async def poll_updates(
        self,
        account: ChannelAccount,
        offset: int = 0,
        timeout: int = 5,
    ) -> tuple[List[ChannelInboundMessage], int]:
        """Call Telegram ``getUpdates`` and return parsed messages + next offset.

        Returns ``(messages, new_offset)`` where *new_offset* should be persisted
        and passed back on the next call to avoid reprocessing.
        """
        token = _extract_bot_token(account)
        params: Dict[str, Any] = {
            "timeout": timeout,
            "allowed_updates": ["message", "edited_message", "channel_post"],
        }
        if offset:
            params["offset"] = offset

        try:
            async with httpx.AsyncClient(timeout=timeout + 10) as client:
                resp = await client.post(_api_url(token, "getUpdates"), json=params)
                data = resp.json()
        except Exception as exc:
            logger.error("[TelegramAdapter] getUpdates error: %s", exc)
            return [], offset

        if not data.get("ok"):
            logger.warning(
                "[TelegramAdapter] getUpdates failed: %s",
                data.get("description", "unknown"),
            )
            return [], offset

        updates: List[Dict[str, Any]] = data.get("result", [])
        if not updates:
            return [], offset

        messages: List[ChannelInboundMessage] = []
        new_offset = offset
        for update in updates:
            update_id = update.get("update_id", 0)
            if update_id >= new_offset:
                new_offset = update_id + 1

            msg = self.parse_update(update, account)
            if msg:
                messages.append(msg)

        return messages, new_offset

    def parse_update(
        self,
        update: Dict[str, Any],
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """Parse a raw Telegram Update dict into canonical inbound message.

        Unlike ``parse_webhook`` which reads from an HttpRequest body, this
        takes the already-decoded update dict — suitable for polling results.
        """
        message = (
            update.get("message")
            or update.get("edited_message")
            or update.get("channel_post")
        )
        if not message:
            return None

        chat = message.get("chat", {})
        chat_id = str(chat.get("id", ""))
        if not chat_id:
            return None

        text = _extract_text(message)
        media = _extract_media(message)
        if not text and not media:
            return None

        mentioned = False
        if chat.get("type") in ("group", "supergroup"):
            entities = message.get("entities") or []
            for ent in entities:
                if ent.get("type") in ("mention", "text_mention"):
                    mentioned = True
                    break

        metadata: Dict[str, Any] = {"mentioned": mentioned}
        metadata.update(_extract_sender_meta(message.get("from")))
        if message.get("reply_to_message"):
            metadata["reply_to_message_id"] = str(
                message["reply_to_message"].get("message_id", "")
            )

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=_resolve_peer_kind(chat),
            peer_id=chat_id,
            sender_id=_build_sender_id(message.get("from")),
            message_id=str(message.get("message_id", update.get("update_id", ""))),
            reply_to=(
                str(message["reply_to_message"]["message_id"])
                if message.get("reply_to_message")
                else None
            ),
            text=text,
            media=media,
            timestamp=message.get("date", 0),
            metadata=metadata,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _call_api(
        token: str,
        method: str,
        payload: Dict[str, Any],
    ) -> SendResult:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(_api_url(token, method), json=payload)
                data = resp.json()
            if data.get("ok"):
                msg = data.get("result", {})
                return SendResult(
                    ok=True,
                    provider_message_id=str(msg.get("message_id", "")),
                )
            description = data.get("description", "unknown error")
            logger.warning("[TelegramAdapter] %s failed: %s", method, description)
            return SendResult(ok=False, error=description)
        except Exception as exc:
            logger.error("[TelegramAdapter] %s error: %s", method, exc)
            return SendResult(ok=False, error=str(exc))

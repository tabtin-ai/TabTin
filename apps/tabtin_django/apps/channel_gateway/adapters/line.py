"""LINE Messaging API 渠道适配器。

使用 httpx 直接调用 LINE Messaging API，无需引入 LINE SDK。

支持：
- Webhook 事件回调解析（签名验证 + events[] 解析）
- 发送文本消息（reply / push 两种模式）
- 发送媒体消息（image / video / audio）
- 连通性 Probe（GET /v2/bot/info）
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
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

LINE_API_BASE = "https://api.line.me"
TEXT_CHUNK_LIMIT = 5000
REPLY_TOKEN_TTL_SECONDS = 30


def _extract_token(account: ChannelAccount) -> str:
    """从 account 配置提取 channel_access_token。"""
    config = account.config or {}
    token = (config.get("channel_access_token") or "").strip()
    if not token:
        raise ValueError("channel_access_token is required")
    return token


def _verify_signature(channel_secret: str, body: bytes, signature: str) -> bool:
    """验证 LINE Webhook 签名。

    LINE 签名 = base64(HMAC-SHA256(channel_secret, request_body))
    """
    if not channel_secret or not signature:
        return False
    try:
        mac = hmac.new(
            channel_secret.encode("utf-8"),
            body,
            hashlib.sha256,
        )
        expected = base64.b64encode(mac.digest()).decode("utf-8")
        return hmac.compare_digest(expected, signature)
    except Exception:
        return False


def _parse_media_from_event(message: dict) -> Optional[List[ChannelMedia]]:
    """从 LINE 消息事件提取媒体附件。"""
    msg_type = message.get("type", "")
    msg_id = message.get("id", "")

    kind_map = {
        "image": "image",
        "video": "video",
        "audio": "audio",
        "file": "file",
        "sticker": "sticker",
    }
    kind = kind_map.get(msg_type)
    if not kind or not msg_id:
        return None

    media = ChannelMedia(
        kind=kind,
        file_id=msg_id,
        filename=message.get("fileName"),
    )
    return [media]


def _determine_peer(source: dict) -> tuple[str, str, str]:
    """根据 source 判断会话类型，返回 (peer_kind, peer_id, sender_id)。"""
    source_type = source.get("type", "user")
    user_id = source.get("userId", "")

    if source_type == "group":
        return "group", source.get("groupId", ""), user_id or "unknown"
    elif source_type == "room":
        return "group", source.get("roomId", ""), user_id or "unknown"
    else:
        return "dm", user_id or "unknown", user_id or "unknown"


class LineAdapter(ChannelAdapter):
    """LINE Messaging API 渠道适配器。"""

    @property
    def id(self) -> str:
        return "line"

    @property
    def name(self) -> str:
        return "LINE"

    @property
    def description(self) -> str:
        return "通过 LINE Messaging API 收发消息，将 LINE 对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "line"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group"],
            media=True,
            threads=False,
        )

    # ------------------------------------------------------------------
    # 配置
    # ------------------------------------------------------------------

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="channel_access_token",
                label="Channel Access Token",
                field_type="password",
                required=True,
                help_text="LINE Developers Console 中的 Channel Access Token (长期)",
            ),
            ConfigField(
                key="channel_secret",
                label="Channel Secret",
                field_type="password",
                help_text="LINE Developers Console 中的 Channel Secret（用于 Webhook 签名验证）",
            ),
        ]

    def get_event_types(self) -> list:
        from apps.extensions.base import EventDescriptor, PayloadField
        return [
            EventDescriptor(
                event_type="line.message_received",
                description="收到 LINE 消息",
                payload_fields=[
                    PayloadField(key="peer_id", label="聊天 ID", example="U1234567890abcdef"),
                    PayloadField(key="sender_id", label="发送者 ID", example="U1234567890abcdef"),
                    PayloadField(key="text", label="消息内容", example="你好"),
                    PayloadField(key="msg_type", label="消息类型", example="text"),
                    PayloadField(key="peer_kind", label="会话类型", example="dm"),
                    PayloadField(key="message_id", label="消息 ID", example="325708"),
                ],
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        if not (config.get("channel_access_token") or "").strip():
            errors.append("channel_access_token is required")
        if not (config.get("channel_secret") or "").strip():
            errors.append("channel_secret is required")
        return errors

    # ------------------------------------------------------------------
    # 连通性
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        try:
            token = _extract_token(account)
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{LINE_API_BASE}/v2/bot/info",
                    headers={"Authorization": f"Bearer {token}"},
                )

            if resp.status_code != 200:
                return ProbeResult(
                    ok=False,
                    error=f"HTTP {resp.status_code}: {resp.text[:200]}",
                )

            data = resp.json()
            return ProbeResult(
                ok=True,
                display_name=data.get("displayName"),
                bot_username=data.get("basicId"),
                raw=data,
            )
        except Exception as exc:
            return ProbeResult(ok=False, error=str(exc))

    async def setup_webhook(
        self,
        account: ChannelAccount,
        webhook_url: str,
    ) -> bool:
        try:
            token = _extract_token(account)
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.put(
                    f"{LINE_API_BASE}/v2/bot/channel/webhook/endpoint",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    json={"endpoint": webhook_url},
                )
            return resp.status_code == 200
        except Exception as exc:
            logger.error("[LineAdapter] setup_webhook 失败: %s", exc)
            return False

    # ------------------------------------------------------------------
    # 入站
    # ------------------------------------------------------------------

    def parse_webhook(
        self,
        request: HttpRequest,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        try:
            body_bytes = request.body
            body = json.loads(body_bytes)
        except (json.JSONDecodeError, ValueError):
            logger.warning("[LineAdapter] 无效的 JSON body")
            return None

        config = account.config or {}
        channel_secret = (config.get("channel_secret") or "").strip()

        if not channel_secret:
            logger.warning("[LineAdapter] channel_secret 未配置，拒绝处理 webhook")
            return None
        signature = request.headers.get("X-Line-Signature", "")
        if not _verify_signature(channel_secret, body_bytes, signature):
            logger.warning("[LineAdapter] 签名验证失败")
            return None

        events = body.get("events", [])
        if not events:
            return None

        for event in events:
            result = self._parse_event(event, account)
            if result is not None:
                return result

        return None

    def _parse_event(
        self,
        event: dict,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """解析单个 LINE 事件。"""
        event_type = event.get("type", "")

        if event_type != "message":
            logger.debug("[LineAdapter] 忽略非 message 事件: %s", event_type)
            return None

        source = event.get("source", {})
        message = event.get("message", {})
        msg_type = message.get("type", "")

        peer_kind, peer_id, sender_id = _determine_peer(source)
        if not peer_id:
            return None

        text: Optional[str] = None
        media: Optional[List[ChannelMedia]] = None

        if msg_type == "text":
            text = message.get("text", "")
        elif msg_type == "sticker":
            text = f"[贴图] packageId={message.get('packageId')}, stickerId={message.get('stickerId')}"
            media = _parse_media_from_event(message)
        elif msg_type in ("image", "video", "audio", "file"):
            text = f"[{msg_type}]"
            media = _parse_media_from_event(message)
        else:
            logger.debug("[LineAdapter] 忽略未知消息类型: %s", msg_type)
            return None

        if not text and not media:
            return None

        reply_token = event.get("replyToken", "")
        timestamp_ms = event.get("timestamp", 0)
        timestamp = timestamp_ms // 1000 if timestamp_ms else int(time.time())

        metadata: Dict[str, Any] = {
            "msg_type": msg_type,
            "source_type": source.get("type", "user"),
        }
        if reply_token:
            metadata["reply_token"] = reply_token
            metadata["reply_token_ts"] = int(time.time())

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=peer_id,
            sender_id=sender_id,
            message_id=message.get("id", str(timestamp_ms)),
            text=text,
            media=media,
            timestamp=timestamp,
            metadata=metadata,
        )

    # ------------------------------------------------------------------
    # 出站
    # ------------------------------------------------------------------

    async def send_text(
        self,
        account: ChannelAccount,
        to: str,
        text: str,
        *,
        reply_to: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> SendResult:
        token = _extract_token(account)
        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_msg_id: Optional[str] = None

        for chunk in chunks:
            messages = [{"type": "text", "text": chunk}]
            result = await self._send_messages(token, to, messages, reply_to=reply_to)
            if not result.ok:
                return result
            last_msg_id = result.provider_message_id
            reply_to = None  # replyToken 只能使用一次

        return SendResult(ok=True, provider_message_id=last_msg_id)

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
        token = _extract_token(account)
        messages: List[Dict[str, Any]] = []

        is_image = (mime_type or "").startswith("image/") or any(
            media_url.lower().endswith(ext)
            for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp")
        )
        is_video = (mime_type or "").startswith("video/") or any(
            media_url.lower().endswith(ext)
            for ext in (".mp4", ".avi", ".mov")
        )
        is_audio = (mime_type or "").startswith("audio/") or any(
            media_url.lower().endswith(ext)
            for ext in (".mp3", ".m4a", ".wav", ".aac")
        )

        if is_image:
            messages.append({
                "type": "image",
                "originalContentUrl": media_url,
                "previewImageUrl": media_url,
            })
        elif is_video:
            messages.append({
                "type": "video",
                "originalContentUrl": media_url,
                "previewImageUrl": media_url,
            })
        elif is_audio:
            messages.append({
                "type": "audio",
                "originalContentUrl": media_url,
                "duration": 60000,
            })
        else:
            fallback = caption or media_url
            if caption and media_url:
                fallback = f"{caption}\n{media_url}"
            return await self.send_text(account, to, fallback, reply_to=reply_to)

        if caption:
            messages.append({"type": "text", "text": caption})

        return await self._send_messages(token, to, messages, reply_to=reply_to)

    # ------------------------------------------------------------------
    # 内部 API 辅助
    # ------------------------------------------------------------------

    @staticmethod
    async def _send_messages(
        token: str,
        to: str,
        messages: List[Dict[str, Any]],
        *,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        """发送消息，优先使用 reply，无 replyToken 时降级为 push。

        LINE reply API 的 replyToken 有效期极短（约 30 秒），
        此处通过 metadata 中的 reply_token 字段传递。
        """
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        if reply_to:
            result = await LineAdapter._try_reply(headers, reply_to, messages)
            if result.ok:
                return result
            logger.debug("[LineAdapter] reply 失败，降级为 push: %s", result.error)

        return await LineAdapter._push(headers, to, messages)

    @staticmethod
    async def _try_reply(
        headers: dict,
        reply_token: str,
        messages: List[Dict[str, Any]],
    ) -> SendResult:
        """尝试使用 replyToken 回复。"""
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{LINE_API_BASE}/v2/bot/message/reply",
                    headers=headers,
                    json={
                        "replyToken": reply_token,
                        "messages": messages[:5],  # LINE 单次最多 5 条
                    },
                )

            if resp.status_code == 200:
                return SendResult(ok=True, provider_message_id=None)

            data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            error = data.get("message", f"HTTP {resp.status_code}")
            return SendResult(ok=False, error=error)
        except Exception as exc:
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    async def _push(
        headers: dict,
        to: str,
        messages: List[Dict[str, Any]],
    ) -> SendResult:
        """使用 push API 主动推送消息。"""
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{LINE_API_BASE}/v2/bot/message/push",
                    headers=headers,
                    json={
                        "to": to,
                        "messages": messages[:5],
                    },
                )

            if resp.status_code == 200:
                return SendResult(ok=True, provider_message_id=None)

            data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            error = data.get("message", f"HTTP {resp.status_code}")
            logger.warning("[LineAdapter] push 失败: %s", error)
            return SendResult(ok=False, error=error)
        except Exception as exc:
            logger.error("[LineAdapter] push 异常: %s", exc)
            return SendResult(ok=False, error=str(exc))

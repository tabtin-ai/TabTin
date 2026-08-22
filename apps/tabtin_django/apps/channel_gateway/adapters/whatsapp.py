"""WhatsApp Cloud API 适配器。

基于 Meta Business Platform / WhatsApp Cloud API，使用 httpx 直接调用。
WhatsApp 适配器交互模式设计说明。

支持：
- Webhook 事件解析（messages, statuses）
- 签名验证（HMAC-SHA256）
- 发送文本消息
- 发送媒体消息（image/document/audio/video）
- 连通性 Probe
"""

from __future__ import annotations

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
    WebhookChallengeResponse,
)

logger = logging.getLogger(__name__)

WHATSAPP_API_BASE = "https://graph.facebook.com"
WHATSAPP_API_VERSION = "v17.0"
TEXT_CHUNK_LIMIT = 4096

# WhatsApp 消息类型 → ChannelMedia.kind 映射
_MEDIA_TYPE_MAP: Dict[str, str] = {
    "image": "image",
    "video": "video",
    "audio": "audio",
    "document": "file",
    "sticker": "sticker",
}


def _extract_config(account: ChannelAccount) -> Dict[str, str]:
    """从 account.config 提取 WhatsApp 配置字段。"""
    config = account.config or {}
    return {
        "access_token": (config.get("access_token") or "").strip(),
        "phone_number_id": (config.get("phone_number_id") or "").strip(),
        "verify_token": (config.get("verify_token") or "").strip(),
        "app_secret": (config.get("app_secret") or "").strip(),
    }


def _verify_webhook_signature(app_secret: str, body: bytes, signature_header: str) -> bool:
    """验证 WhatsApp webhook 的 X-Hub-Signature-256 签名。

    签名格式: sha256=<hex_digest>
    """
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected_sig = signature_header[len("sha256="):]
    computed = hmac.new(
        app_secret.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(computed, expected_sig)


def _api_url(phone_number_id: str, endpoint: str = "messages") -> str:
    """构造 WhatsApp Cloud API URL。"""
    return f"{WHATSAPP_API_BASE}/{WHATSAPP_API_VERSION}/{phone_number_id}/{endpoint}"


def _parse_media_from_message(msg: dict) -> Optional[List[ChannelMedia]]:
    """从 WhatsApp webhook 消息对象中提取媒体附件。"""
    items: List[ChannelMedia] = []

    for wa_type, kind in _MEDIA_TYPE_MAP.items():
        media_obj = msg.get(wa_type)
        if not media_obj or not isinstance(media_obj, dict):
            continue

        media_id = media_obj.get("id", "")
        if not media_id:
            continue

        items.append(ChannelMedia(
            kind=kind,
            file_id=media_id,
            mime_type=media_obj.get("mime_type"),
            filename=media_obj.get("filename"),
        ))

    return items if items else None


def _extract_text(msg: dict) -> Optional[str]:
    """从 WhatsApp 消息对象提取文本内容。"""
    msg_type = msg.get("type", "")

    if msg_type == "text":
        text_obj = msg.get("text", {})
        return text_obj.get("body", "") if isinstance(text_obj, dict) else None

    if msg_type == "reaction":
        reaction = msg.get("reaction", {})
        emoji = reaction.get("emoji", "")
        return f"[reaction: {emoji}]" if emoji else None

    # 媒体类消息可能携带 caption
    if msg_type in _MEDIA_TYPE_MAP:
        media_obj = msg.get(msg_type, {})
        if isinstance(media_obj, dict):
            return media_obj.get("caption")

    return None


class WhatsAppAdapter(ChannelAdapter):
    """WhatsApp Cloud API 渠道适配器。"""

    @property
    def id(self) -> str:
        return "whatsapp"

    @property
    def name(self) -> str:
        return "WhatsApp"

    @property
    def description(self) -> str:
        return "通过 WhatsApp Cloud API 收发消息，将 WhatsApp 对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "whatsapp"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct"],
            media=True,
            threads=False,
        )

    # ------------------------------------------------------------------
    # 配置校验
    # ------------------------------------------------------------------

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="access_token",
                label="Access Token",
                field_type="password",
                required=True,
                help_text="WhatsApp Cloud API 的永久访问令牌（System User Token）",
            ),
            ConfigField(
                key="phone_number_id",
                label="Phone Number ID",
                required=True,
                help_text="Meta Business 后台的 WhatsApp 电话号码 ID",
            ),
            ConfigField(
                key="verify_token",
                label="Verify Token",
                field_type="password",
                help_text="Webhook 验证令牌（在 Meta 后台配置 webhook 时设置的自定义字符串）",
            ),
            ConfigField(
                key="app_secret",
                label="App Secret",
                field_type="password",
                help_text="Meta App Secret，用于验证 webhook 请求签名",
            ),
        ]

    def get_event_types(self) -> list:
        from apps.extensions.base import EventDescriptor, PayloadField
        return [
            EventDescriptor(
                event_type="whatsapp.message_received",
                description="收到 WhatsApp 消息",
                payload_fields=[
                    PayloadField(key="from", label="发送者手机号", example="+8613800138000"),
                    PayloadField(key="text", label="消息内容", example="你好"),
                    PayloadField(key="msg_type", label="消息类型", example="text"),
                    PayloadField(key="message_id", label="消息 ID", example="wamid.xxx"),
                    PayloadField(key="sender_name", label="发送者名称", example="张三"),
                    PayloadField(key="phone_number_id", label="接收号码 ID", example="123456"),
                ],
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        if not (config.get("access_token") or "").strip():
            errors.append("access_token is required")
        if not (config.get("phone_number_id") or "").strip():
            errors.append("phone_number_id is required")
        if not (config.get("app_secret") or "").strip():
            errors.append("app_secret is required")
        return errors

    # ------------------------------------------------------------------
    # 连通性检查
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        """调用 GET /{phone_number_id} 验证凭证有效性。"""
        cfg = _extract_config(account)
        access_token = cfg["access_token"]
        phone_number_id = cfg["phone_number_id"]

        if not access_token or not phone_number_id:
            return ProbeResult(ok=False, error="access_token 和 phone_number_id 未配置")

        try:
            url = f"{WHATSAPP_API_BASE}/{WHATSAPP_API_VERSION}/{phone_number_id}"
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    url,
                    headers={"Authorization": f"Bearer {access_token}"},
                )
                data = resp.json()

            if "error" in data:
                err = data["error"]
                return ProbeResult(
                    ok=False,
                    error=err.get("message", str(err)),
                    raw=data,
                )

            display_name = data.get("verified_name") or data.get("display_phone_number", "")
            return ProbeResult(
                ok=True,
                display_name=display_name,
                bot_username=data.get("display_phone_number"),
                raw=data,
            )
        except Exception as exc:
            logger.error("[WhatsAppAdapter] probe 失败: %s", exc)
            return ProbeResult(ok=False, error=str(exc))

    async def setup_webhook(
        self,
        account: ChannelAccount,
        webhook_url: str,
    ) -> bool:
        # WhatsApp webhook 在 Meta 后台手动配置，无需 API 调用
        return True

    # ------------------------------------------------------------------
    # 入站消息解析
    # ------------------------------------------------------------------

    def parse_webhook(
        self,
        request: HttpRequest,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """解析 WhatsApp Cloud API webhook payload。

        仅处理 POST 请求（GET challenge 由 webhook view 层处理）。
        """
        body_bytes = request.body
        cfg = _extract_config(account)

        # 签名验证（强制）
        app_secret = cfg["app_secret"]
        if not app_secret:
            logger.warning(
                "[WhatsAppAdapter] app_secret 未配置，拒绝处理 webhook (account=%s)",
                account.account_id,
            )
            return None
        sig_header = request.headers.get("X-Hub-Signature-256", "")
        if not sig_header:
            logger.warning("[WhatsAppAdapter] 缺少 X-Hub-Signature-256 头")
            return None
        if not _verify_webhook_signature(app_secret, body_bytes, sig_header):
            logger.warning("[WhatsAppAdapter] webhook 签名验证失败")
            return None

        try:
            body = json.loads(body_bytes)
        except (json.JSONDecodeError, ValueError):
            logger.warning("[WhatsAppAdapter] 无效的 JSON body")
            return None

        # WhatsApp webhook payload 结构:
        # { "object": "whatsapp_business_account", "entry": [...] }
        if body.get("object") != "whatsapp_business_account":
            logger.debug("[WhatsAppAdapter] 非 WhatsApp Business 事件，忽略")
            return None

        entries = body.get("entry", [])
        if not entries:
            return None

        # 遍历 entry → changes → value.messages，取第一条有效消息
        for entry in entries:
            changes = entry.get("changes", [])
            for change in changes:
                value = change.get("value", {})
                if not value:
                    continue

                # 忽略 status 更新（delivery/read receipts）
                if value.get("statuses"):
                    logger.debug("[WhatsAppAdapter] 收到状态更新，跳过")
                    continue

                messages = value.get("messages", [])
                if not messages:
                    continue

                contacts = value.get("contacts", [])
                metadata = value.get("metadata", {})

                for msg in messages:
                    result = self._parse_single_message(
                        msg, contacts, metadata, account,
                    )
                    if result:
                        return result

        return None

    def _parse_single_message(
        self,
        msg: dict,
        contacts: list,
        wa_metadata: dict,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """解析单条 WhatsApp 消息为标准 ChannelInboundMessage。"""
        msg_id = msg.get("id", "")
        if not msg_id:
            return None

        sender_phone = msg.get("from", "")
        if not sender_phone:
            return None

        msg_type = msg.get("type", "")
        text = _extract_text(msg)
        media = _parse_media_from_message(msg)

        if not text and not media:
            return None

        # 提取联系人名称
        sender_name = ""
        for contact in contacts:
            wa_id = contact.get("wa_id", "")
            if wa_id == sender_phone:
                profile = contact.get("profile", {})
                sender_name = profile.get("name", "")
                break

        # WhatsApp 消息是一对一的，peer_id 用发送者手机号
        timestamp_str = msg.get("timestamp", "")
        try:
            timestamp = int(timestamp_str)
        except (ValueError, TypeError):
            timestamp = int(time.time())

        # context 字段包含被引用的消息 ID
        context = msg.get("context", {})
        reply_to = context.get("id") if context else None

        extra_metadata: Dict[str, Any] = {
            "msg_type": msg_type,
            "phone_number_id": wa_metadata.get("phone_number_id", ""),
        }
        if sender_name:
            extra_metadata["sender_name"] = sender_name

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind="dm",
            peer_id=sender_phone,
            sender_id=sender_phone,
            message_id=msg_id,
            reply_to=reply_to or None,
            text=text,
            media=media,
            timestamp=timestamp,
            metadata=extra_metadata,
        )

    # ------------------------------------------------------------------
    # 出站消息
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
        cfg = _extract_config(account)
        access_token = cfg["access_token"]
        phone_number_id = cfg["phone_number_id"]

        if not access_token or not phone_number_id:
            return SendResult(ok=False, error="access_token 或 phone_number_id 未配置")

        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_message_id: Optional[str] = None

        for chunk in chunks:
            payload: Dict[str, Any] = {
                "messaging_product": "whatsapp",
                "to": to,
                "type": "text",
                "text": {"body": chunk},
            }
            if reply_to and last_message_id is None:
                payload["context"] = {"message_id": reply_to}

            result = await self._call_send_api(access_token, phone_number_id, payload)
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
        cfg = _extract_config(account)
        access_token = cfg["access_token"]
        phone_number_id = cfg["phone_number_id"]

        if not access_token or not phone_number_id:
            return SendResult(ok=False, error="access_token 或 phone_number_id 未配置")

        wa_type = self._resolve_media_type(media_url, mime_type)

        media_obj: Dict[str, Any] = {"link": media_url}
        if caption:
            media_obj["caption"] = caption

        payload: Dict[str, Any] = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": wa_type,
            wa_type: media_obj,
        }
        if reply_to:
            payload["context"] = {"message_id": reply_to}

        return await self._call_send_api(access_token, phone_number_id, payload)

    # ------------------------------------------------------------------
    # 内部 API 工具方法
    # ------------------------------------------------------------------

    @staticmethod
    async def _call_send_api(
        access_token: str,
        phone_number_id: str,
        payload: Dict[str, Any],
    ) -> SendResult:
        """调用 WhatsApp Cloud API 发送消息。"""
        url = _api_url(phone_number_id, "messages")
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {access_token}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                data = resp.json()

            if "error" in data:
                err = data["error"]
                error_msg = err.get("message", str(err))
                logger.warning("[WhatsAppAdapter] 发送失败: %s", error_msg)
                return SendResult(ok=False, error=error_msg)

            messages = data.get("messages", [])
            provider_id = messages[0]["id"] if messages else None
            return SendResult(ok=True, provider_message_id=provider_id)

        except Exception as exc:
            logger.error("[WhatsAppAdapter] API 调用异常: %s", exc)
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    def _resolve_media_type(media_url: str, mime_type: Optional[str] = None) -> str:
        """根据 MIME 类型或 URL 后缀推断 WhatsApp 媒体类型。"""
        if mime_type:
            mt = mime_type.lower()
            if mt.startswith("image/"):
                return "image"
            if mt.startswith("video/"):
                return "video"
            if mt.startswith("audio/"):
                return "audio"

        lower_url = media_url.lower()
        image_exts = (".jpg", ".jpeg", ".png", ".gif", ".webp")
        video_exts = (".mp4", ".3gp", ".mov")
        audio_exts = (".mp3", ".ogg", ".opus", ".amr", ".aac")

        if any(lower_url.endswith(ext) for ext in image_exts):
            return "image"
        if any(lower_url.endswith(ext) for ext in video_exts):
            return "video"
        if any(lower_url.endswith(ext) for ext in audio_exts):
            return "audio"

        return "document"

"""WeChat personal account (iLink Bot API) channel adapter.

Uses the Tencent iLink protocol — pure HTTP/JSON with long-polling for message
retrieval. No WebSocket or third-party SDK required.

Supports:
- Long-poll message retrieval (getUpdates, 35s server hold)
- Text / image / file / video / voice inbound
- Text reply with context_token routing
- Media upload via AES-128-ECB encrypted CDN
- Typing indicator (sendTyping)
- QR-code login with token persistence
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from django.core.cache import cache

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

ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
TEXT_CHUNK_LIMIT = 2000
CONTEXT_TOKEN_CACHE_TTL = 86400  # 24h


def _get_ilink_config(account: ChannelAccount) -> tuple[str, str]:
    """Extract (base_url, bot_token) from account config."""
    config = account.config or {}
    base_url = (config.get("base_url") or ILINK_DEFAULT_BASE_URL).strip()
    token = (config.get("bot_token") or "").strip()
    if not token:
        raise ValueError("bot_token not configured")
    return base_url, token


def _cache_context_token(account_id: str, user_id: str, token: str) -> None:
    cache.set(
        f"weixin_personal:ctx:{account_id}:{user_id}",
        token,
        CONTEXT_TOKEN_CACHE_TTL,
    )


def _get_context_token(account_id: str, user_id: str) -> Optional[str]:
    return cache.get(f"weixin_personal:ctx:{account_id}:{user_id}")


class WeixinPersonalAdapter(ChannelAdapter):
    """微信个人号 (iLink Bot API) channel adapter."""

    @property
    def id(self) -> str:
        return "weixin_personal"

    @property
    def name(self) -> str:
        return "微信"

    @property
    def description(self) -> str:
        return "通过微信 ClawBot 接收和发送消息，将微信对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "wechat"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct"],
            media=True,
            supports_polling=True,
            supports_webhook=False,
        )

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="bot_token",
                label="Bot Token",
                field_type="password",
                required=False,
                help_text="通过扫码登录自动获取，无需手动填写",
            ),
            ConfigField(
                key="base_url",
                label="API Base URL",
                required=False,
                default=ILINK_DEFAULT_BASE_URL,
                help_text="iLink API 地址（通常无需修改）",
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        base_url = (config.get("base_url") or "").strip()
        if base_url and not base_url.startswith(("http://", "https://")):
            errors.append("base_url 必须以 http:// 或 https:// 开头")
        return errors

    def extract_routing_context(self, data) -> Optional[Dict[str, Any]]:
        """Persist context_token to ChannelBinding.metadata for durable routing."""
        ctx_token = (data.metadata or {}).get("context_token")
        if ctx_token:
            return {"context_token": ctx_token}
        return None

    # ------------------------------------------------------------------
    # Connectivity
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        from apps.channel_gateway.services.ilink_client import (
            get_config,
            ILinkSessionExpiredError,
        )

        try:
            base_url, token = _get_ilink_config(account)
        except ValueError as exc:
            return ProbeResult(ok=False, error=str(exc))

        try:
            result = await get_config(base_url=base_url, token=token)
            return ProbeResult(
                ok=True,
                display_name="微信 ClawBot",
                raw=result,
            )
        except ILinkSessionExpiredError:
            return ProbeResult(ok=False, error="bot_token 已过期，请重新扫码登录")
        except Exception as exc:
            return ProbeResult(ok=False, error=str(exc))

    # ------------------------------------------------------------------
    # Inbound (webhook not supported — use poll_updates via run_longpoll)
    # ------------------------------------------------------------------

    def parse_webhook(self, request, account):
        return None

    async def poll_updates(
        self,
        account: ChannelAccount,
        offset: Any = "",
        timeout: int = 25,
    ) -> tuple[List[ChannelInboundMessage], Any]:
        """Long-poll iLink getUpdates. ``offset`` is the opaque get_updates_buf cursor."""
        from apps.channel_gateway.services.ilink_client import get_updates

        base_url, token = _get_ilink_config(account)
        get_updates_buf = offset if isinstance(offset, str) else ""

        result = await get_updates(
            base_url=base_url,
            token=token,
            get_updates_buf=get_updates_buf,
            timeout_s=timeout,
        )

        new_buf = result.get("get_updates_buf", get_updates_buf)
        raw_msgs = result.get("msgs") or []
        messages: List[ChannelInboundMessage] = []

        for raw_msg in raw_msgs:
            parsed = self._parse_ilink_message(raw_msg, account)
            if parsed:
                messages.append(parsed)

        return messages, new_buf

    def _parse_ilink_message(
        self,
        raw_msg: Dict[str, Any],
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """Convert an iLink message to the canonical ChannelInboundMessage.

        NOTE on media URLs (known limitation):
        iLink CDN 返回的媒体 URL 指向 AES-128-ECB 加密的原始文件。
        - 当前行为：直接传递原始 CDN URL 到 ChannelInboundMessage.media
        - 限制：Agent 无法直接访问这些 URL（下载后需用 per-item aes_key 解密）
        - 后续计划：通过异步 Celery task 实现 下载 → AES 解密 → 上传到
          TabTin OSS，将 media.url 替换为可直接访问的 OSS URL
        """
        msg_type = raw_msg.get("message_type", 0)
        if msg_type == 2:  # Bot's own message
            return None

        from_user_id = raw_msg.get("from_user_id", "")
        if not from_user_id:
            return None

        context_token = raw_msg.get("context_token", "")
        if context_token:
            _cache_context_token(account.account_id, from_user_id, context_token)

        item_list = raw_msg.get("item_list") or []
        text_parts: List[str] = []
        media_list: List[ChannelMedia] = []

        for item in item_list:
            item_type = item.get("type", 0)

            if item_type == 1:  # TEXT
                text_item = item.get("text_item") or {}
                t = text_item.get("text", "")
                if t:
                    text_parts.append(t)

            elif item_type == 2:  # IMAGE
                image_item = item.get("image_item") or {}
                media_info = image_item.get("media") or {}
                url = media_info.get("url", "")
                if url:
                    media_list.append(ChannelMedia(kind="image", url=url))

            elif item_type == 3:  # VOICE
                voice_item = item.get("voice_item") or {}
                media_info = voice_item.get("media") or {}
                url = media_info.get("url", "")
                if url:
                    media_list.append(ChannelMedia(kind="audio", url=url))
                else:
                    text_parts.append("[语音]")

            elif item_type == 4:  # FILE
                file_item = item.get("file_item") or {}
                media_info = file_item.get("media") or {}
                url = media_info.get("url", "")
                filename = file_item.get("file_name", "")
                if url:
                    media_list.append(ChannelMedia(
                        kind="file", url=url, filename=filename or None,
                    ))
                else:
                    text_parts.append(f"[文件] {filename}")

            elif item_type == 5:  # VIDEO
                video_item = item.get("video_item") or {}
                media_info = video_item.get("media") or {}
                url = media_info.get("url", "")
                if url:
                    media_list.append(ChannelMedia(kind="video", url=url))
                else:
                    text_parts.append("[视频]")

        text = "\n".join(text_parts) if text_parts else None
        if not text and not media_list:
            return None

        message_id = str(raw_msg.get("message_id", int(time.time() * 1000)))
        create_time_ms = raw_msg.get("create_time_ms", int(time.time() * 1000))
        timestamp = create_time_ms // 1000

        peer_id = from_user_id
        peer_kind = "dm"

        group_id = raw_msg.get("group_id", "")
        if group_id:
            peer_kind = "group"
            peer_id = group_id

        metadata: Dict[str, Any] = {}
        session_id = raw_msg.get("session_id", "")
        if session_id:
            metadata["session_id"] = session_id
        if context_token:
            metadata["context_token"] = context_token

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=peer_id,
            sender_id=from_user_id,
            message_id=message_id,
            text=text,
            media=media_list if media_list else None,
            timestamp=timestamp,
            metadata=metadata,
        )

    # ------------------------------------------------------------------
    # Outbound
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
        from apps.channel_gateway.services.ilink_client import (
            send_message,
            build_text_message,
        )

        base_url, token = _get_ilink_config(account)
        context_token = _get_context_token(account.account_id, to)
        if not context_token:
            context_token = self._load_context_token_from_binding(account, to)
        if not context_token:
            return SendResult(
                ok=False,
                error="无法回复此用户——需要先收到对方的消息才能获取回复凭证",
            )

        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_result = SendResult(ok=True)

        for chunk in chunks:
            msg = build_text_message(
                to_user_id=to,
                text=chunk,
                context_token=context_token,
            )
            try:
                result = await send_message(
                    base_url=base_url,
                    token=token,
                    msg=msg,
                )
                errcode = result.get("ret", 0)
                if errcode != 0:
                    return SendResult(ok=False, error=f"sendMessage errcode={errcode}")
                last_result = SendResult(ok=True)
            except Exception as exc:
                logger.error("[WeixinPersonalAdapter] send_text error: %s", exc)
                return SendResult(ok=False, error=str(exc))

        return last_result

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
        """Send media via iLink CDN upload pipeline.

        Flow: download URL → AES-128-ECB encrypt → CDN upload → sendMessage.
        Falls back to text link if upload fails.
        """
        from apps.channel_gateway.services.ilink_client import (
            send_message,
            get_upload_url,
            encrypt_media,
            ITEM_TYPE_IMAGE, ITEM_TYPE_FILE, ITEM_TYPE_VIDEO,
            MSG_TYPE_BOT, MSG_STATE_FINISH,
        )
        import os

        base_url, token = _get_ilink_config(account)
        context_token = _get_context_token(account.account_id, to)
        if not context_token:
            context_token = self._load_context_token_from_binding(account, to)
        if not context_token:
            return SendResult(ok=False, error="无法发送媒体——缺少回复凭证")

        try:
            import httpx as _httpx
            async with _httpx.AsyncClient(timeout=60) as dl_client:
                dl_resp = await dl_client.get(media_url)
                dl_resp.raise_for_status()
                file_bytes = dl_resp.content
                content_type = dl_resp.headers.get("content-type", "application/octet-stream")
        except Exception as exc:
            logger.warning("[WeixinPersonalAdapter] media download failed, falling back to text: %s", exc)
            return await self.send_text(
                account, to, f"{caption or ''}\n{media_url}".strip(),
                reply_to=reply_to, thread_id=thread_id,
            )

        filename = media_url.rsplit("/", 1)[-1][:100] or "file"
        is_image = (mime_type or content_type or "").startswith("image/")
        is_video = (mime_type or content_type or "").startswith("video/")
        file_type = "image" if is_image else ("video" if is_video else "file")

        try:
            upload_info = await get_upload_url(
                base_url=base_url, token=token,
                file_name=filename, file_size=len(file_bytes), file_type=file_type,
            )
            upload_url = upload_info.get("upload_url", "")
            aes_key = upload_info.get("aes_key", "")
            file_id = upload_info.get("file_id", "")

            if not upload_url or not aes_key:
                raise ValueError("getUploadUrl returned empty upload_url or aes_key")

            encrypted = encrypt_media(file_bytes, aes_key)

            async with _httpx.AsyncClient(timeout=60) as up_client:
                up_resp = await up_client.post(upload_url, content=encrypted)
                up_resp.raise_for_status()
        except Exception as exc:
            logger.warning("[WeixinPersonalAdapter] CDN upload failed, falling back to text: %s", exc)
            return await self.send_text(
                account, to, f"{caption or ''}\n{media_url}".strip(),
                reply_to=reply_to, thread_id=thread_id,
            )

        item_type = ITEM_TYPE_IMAGE if is_image else (ITEM_TYPE_VIDEO if is_video else ITEM_TYPE_FILE)
        media_item: Dict[str, Any] = {"media": {"file_id": file_id, "aeskey": aes_key}}
        if item_type == ITEM_TYPE_FILE:
            media_item["file_name"] = filename

        item_key = {ITEM_TYPE_IMAGE: "image_item", ITEM_TYPE_VIDEO: "video_item"}.get(item_type, "file_item")

        items: List[Dict[str, Any]] = [{"type": item_type, item_key: media_item}]
        if caption:
            items.insert(0, {"type": 1, "text_item": {"text": caption}})

        client_id = f"tabtin:{int(time.time() * 1000)}-{os.urandom(4).hex()}"
        msg = {
            "to_user_id": to,
            "client_id": client_id,
            "message_type": MSG_TYPE_BOT,
            "message_state": MSG_STATE_FINISH,
            "context_token": context_token,
            "item_list": items,
        }

        try:
            result = await send_message(base_url=base_url, token=token, msg=msg)
            if result.get("ret", 0) != 0:
                return SendResult(ok=False, error=f"sendMessage errcode={result.get('ret')}")
            return SendResult(ok=True)
        except Exception as exc:
            logger.error("[WeixinPersonalAdapter] send_media error: %s", exc)
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    def _load_context_token_from_binding(account: ChannelAccount, peer_id: str) -> Optional[str]:
        """Fallback: read context_token from ChannelBinding.metadata when cache misses."""
        from apps.channel_gateway.models import ChannelBinding
        binding = ChannelBinding.objects.filter(
            channel="weixin_personal",
            account_id=account.account_id,
            peer_id=peer_id,
            organization_id=account.organization_id,
        ).first()
        if binding and binding.metadata:
            routing = binding.metadata.get("_routing") or {}
            ctx = routing.get("context_token", "")
            if ctx:
                _cache_context_token(account.account_id, peer_id, ctx)
                return ctx
        return None

    # ------------------------------------------------------------------
    # Typing indicator
    # ------------------------------------------------------------------

    async def send_typing(
        self,
        account: ChannelAccount,
        to: str,
        action: str = "typing",
    ) -> None:
        """Send typing indicator to the user."""
        from apps.channel_gateway.services.ilink_client import (
            get_config as ilink_get_config,
            send_typing as ilink_send_typing,
        )

        base_url, token = _get_ilink_config(account)

        cache_key = f"weixin_personal:typing_ticket:{account.account_id}"
        typing_ticket = cache.get(cache_key, "")
        if not typing_ticket:
            try:
                config_result = await ilink_get_config(base_url=base_url, token=token)
                typing_ticket = config_result.get("typing_ticket", "")
                if typing_ticket:
                    cache.set(cache_key, typing_ticket, 86400)
            except Exception as exc:
                logger.debug("[WeixinPersonalAdapter] get typing_ticket failed: %s", exc)
                return

        if not typing_ticket:
            return

        try:
            await ilink_send_typing(
                base_url=base_url,
                token=token,
                typing_ticket=typing_ticket,
                to_user_id=to,
                action=action,
            )
        except Exception as exc:
            logger.debug("[WeixinPersonalAdapter] send_typing failed: %s", exc)

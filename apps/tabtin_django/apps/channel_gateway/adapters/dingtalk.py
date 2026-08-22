"""钉钉 (DingTalk) Bot API adapter.

使用 httpx 直接调用钉钉 Open API，无需引入钉钉 SDK。

支持：
- Webhook 事件回调解析（机器人消息推送）
- 发送文本消息（sessionWebhook / OpenAPI）
- 发送媒体（Markdown 图片链接）
- HMAC-SHA256 签名验证
- 连通性 Probe
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
from django.core.cache import cache
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

DINGTALK_API_BASE = "https://api.dingtalk.com"
TOKEN_CACHE_TTL = 7000
TEXT_CHUNK_LIMIT = 20000
TIMESTAMP_TOLERANCE_MS = 300_000  # 5 minutes, aligned with DingTalk recommendation
SESSION_WEBHOOK_CACHE_TTL = 5400  # 90 min (DingTalk sessionWebhook valid ~2h)


def _extract_credentials(account: ChannelAccount) -> tuple[str, str]:
    config = account.config or {}
    app_key = (config.get("app_key") or "").strip()
    app_secret = (config.get("app_secret") or "").strip()
    if not app_key or not app_secret:
        raise ValueError("app_key and app_secret are required")
    return app_key, app_secret


def _verify_signature(timestamp: str, sign: str, sign_token: str) -> bool:
    """钉钉 HMAC-SHA256 签名校验。

    算法：hmac_sha256(sign_token, timestamp + "\\n" + sign_token) → base64
    """
    if not timestamp or not sign:
        return False

    try:
        ts_ms = int(timestamp)
    except (ValueError, TypeError):
        return False

    now_ms = int(time.time() * 1000)
    if abs(now_ms - ts_ms) > TIMESTAMP_TOLERANCE_MS:
        logger.warning("[DingTalkAdapter] timestamp expired: %s (now: %s)", timestamp, now_ms)
        return False

    string_to_sign = f"{timestamp}\n{sign_token}"
    hmac_code = hmac.new(
        sign_token.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).digest()
    computed = base64.b64encode(hmac_code).decode("utf-8")
    return hmac.compare_digest(computed, sign)


def _conv_cache_key(account_id: str, conversation_id: str) -> str:
    return f"dingtalk:conv:{account_id}:{conversation_id}"


def _cache_conversation_context(
    account_id: str,
    conversation_id: str,
    *,
    session_webhook: str,
    session_webhook_expired_time: Optional[int] = None,
    conversation_type: str = "1",
    sender_staff_id: str = "",
) -> None:
    """Cache DingTalk conversation context for outbound reply routing."""
    cache.set(
        _conv_cache_key(account_id, conversation_id),
        {
            "session_webhook": session_webhook,
            "expired_time": session_webhook_expired_time,
            "conversation_type": conversation_type,
            "sender_staff_id": sender_staff_id,
        },
        SESSION_WEBHOOK_CACHE_TTL,
    )


def _get_cached_conversation(account_id: str, conversation_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve cached conversation context for outbound routing."""
    data = cache.get(_conv_cache_key(account_id, conversation_id))
    if not data or not isinstance(data, dict):
        return None
    url = data.get("session_webhook", "")
    if not url:
        return None
    expired_time = data.get("expired_time")
    if expired_time:
        now_ms = int(time.time() * 1000)
        if now_ms > int(expired_time):
            return None
    return data


async def _get_access_token(account: ChannelAccount) -> str:
    """获取并缓存钉钉 access_token。"""
    app_key, app_secret = _extract_credentials(account)
    cache_key = f"dingtalk:token:{app_key}"
    lock_key = f"dingtalk:token_lock:{app_key}"

    token = cache.get(cache_key)
    if token:
        return token

    acquired = cache.add(lock_key, "1", timeout=10)
    if not acquired:
        import asyncio
        for _ in range(5):
            await asyncio.sleep(0.5)
            token = cache.get(cache_key)
            if token:
                return token
        # Lock holder may be slow; fall through to fetch directly
        # instead of deleting someone else's lock.

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{DINGTALK_API_BASE}/v1.0/oauth2/accessToken",
                json={"appKey": app_key, "appSecret": app_secret},
            )
            data = resp.json()

        access_token = data.get("accessToken")
        if not access_token:
            raise ValueError(f"failed to obtain access_token: {data}")

        cache.set(cache_key, access_token, TOKEN_CACHE_TTL)
        return access_token
    finally:
        if acquired:
            cache.delete(lock_key)


class DingTalkAdapter(ChannelAdapter):
    """钉钉 Bot API channel adapter."""

    @property
    def id(self) -> str:
        return "dingtalk"

    @property
    def name(self) -> str:
        return "钉钉"

    @property
    def description(self) -> str:
        return "通过钉钉 Bot API 收发消息，将钉钉对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "dingtalk"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group"],
            media=True,
            threads=False,
            supports_webhook=True,
        )

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="app_key",
                label="App Key",
                required=True,
                help_text="钉钉开发者后台的应用 AppKey",
            ),
            ConfigField(
                key="app_secret",
                label="App Secret",
                field_type="password",
                required=True,
                help_text="钉钉开发者后台的应用 AppSecret",
            ),
            ConfigField(
                key="robot_code",
                label="Robot Code",
                help_text="机器人编码（选填，通常与 AppKey 相同）",
            ),
            ConfigField(
                key="sign_token",
                label="签名校验 Token",
                field_type="password",
                required=True,
                help_text="Webhook 签名校验 Token（用于验证 HMAC-SHA256 签名）",
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        if not (config.get("app_key") or "").strip():
            errors.append("app_key is required")
        if not (config.get("app_secret") or "").strip():
            errors.append("app_secret is required")
        if not (config.get("sign_token") or "").strip():
            errors.append("sign_token is required")
        return errors

    def extract_routing_context(self, data) -> dict | None:
        meta = data.metadata or {}
        ctx: dict = {}
        conv_type = meta.get("conversation_type")
        if conv_type:
            ctx["conversation_type"] = conv_type
        ctx["sender_staff_id"] = data.sender_id
        return ctx or None

    # ------------------------------------------------------------------
    # Connectivity
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        try:
            token = await _get_access_token(account)
            return ProbeResult(
                ok=True,
                display_name="DingTalk Bot",
                raw={"access_token_prefix": token[:8] + "..."},
            )
        except Exception as exc:
            return ProbeResult(ok=False, error=str(exc))

    async def setup_webhook(
        self,
        account: ChannelAccount,
        webhook_url: str,
    ) -> bool:
        return True

    # ------------------------------------------------------------------
    # Inbound
    # ------------------------------------------------------------------

    def parse_webhook(
        self,
        request: HttpRequest,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        try:
            body = json.loads(request.body)
        except (json.JSONDecodeError, ValueError):
            logger.warning("[DingTalkAdapter] invalid JSON body")
            return None

        config = account.config or {}
        sign_token = (config.get("sign_token") or "").strip()

        if not sign_token:
            logger.warning("[DingTalkAdapter] sign_token 未配置，拒绝处理 webhook")
            return None
        timestamp = request.headers.get("timestamp", "")
        sign = request.headers.get("sign", "")
        if not _verify_signature(timestamp, sign, sign_token):
            logger.warning("[DingTalkAdapter] signature verification failed")
            return None

        msg_type = body.get("msgtype", "text")
        text: Optional[str] = None
        media: Optional[List[ChannelMedia]] = None

        if msg_type == "text":
            text_obj = body.get("text") or {}
            text = text_obj.get("content", "").strip() if isinstance(text_obj, dict) else str(text_obj)
        elif msg_type == "richText":
            text = self._extract_rich_text(body)
        elif msg_type == "picture":
            pic_url = (body.get("content", {}).get("pictureUrl", "")
                       if isinstance(body.get("content"), dict)
                       else "")
            if pic_url:
                media = [ChannelMedia(kind="image", url=pic_url)]
            text = "[图片]"
        elif msg_type == "file":
            file_url = (body.get("content", {}).get("downloadCode", "")
                        if isinstance(body.get("content"), dict)
                        else "")
            file_name = (body.get("content", {}).get("fileName", "")
                         if isinstance(body.get("content"), dict)
                         else "")
            if file_url:
                media = [ChannelMedia(kind="file", file_id=file_url, filename=file_name or None)]
            text = f"[文件] {file_name}" if file_name else "[文件]"
        else:
            text_obj = body.get("text")
            text = text_obj.get("content") if isinstance(text_obj, dict) else None

        if not text and not media:
            logger.debug("[DingTalkAdapter] no text/media content, msgtype=%s", msg_type)
            return None

        conversation_id = body.get("conversationId", "")
        if not conversation_id:
            logger.warning("[DingTalkAdapter] missing conversationId")
            return None

        conversation_type = body.get("conversationType", "1")
        peer_kind = "group" if conversation_type == "2" else "dm"

        sender_id = body.get("senderStaffId") or body.get("senderId", "unknown")
        msg_id = body.get("msgId", str(int(time.time() * 1000)))

        create_at = body.get("createAt")
        ts = int(create_at) // 1000 if create_at else int(time.time())

        metadata: Dict[str, Any] = {
            "msgtype": msg_type,
            "conversation_type": conversation_type,
        }

        session_webhook = body.get("sessionWebhook", "")
        if session_webhook:
            metadata["session_webhook"] = session_webhook
            webhook_expired = body.get("sessionWebhookExpiredTime")
            if webhook_expired:
                metadata["session_webhook_expired_time"] = webhook_expired
            # Cache sessionWebhook for outbound replies
            _cache_conversation_context(
                account.account_id, conversation_id,
                session_webhook=session_webhook,
                session_webhook_expired_time=webhook_expired,
                conversation_type=conversation_type,
                sender_staff_id=str(sender_id),
            )

        sender_nick = body.get("senderNick")
        if sender_nick:
            metadata["sender_nick"] = sender_nick

        chatbot_user_id = body.get("chatbotUserId")
        if chatbot_user_id:
            metadata["chatbot_user_id"] = chatbot_user_id

        at_users = body.get("atUsers")
        if at_users:
            metadata["at_users"] = at_users

        is_in_at_list = body.get("isInAtList")
        if is_in_at_list is not None:
            metadata["is_in_at_list"] = is_in_at_list

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=conversation_id,
            sender_id=str(sender_id),
            message_id=msg_id,
            text=text,
            media=media,
            timestamp=ts,
            metadata=metadata,
        )

    @staticmethod
    def _extract_rich_text(body: dict) -> str:
        rich_text = body.get("content", {}).get("richText", [])
        parts: list[str] = []
        for section in rich_text:
            if not isinstance(section, dict):
                continue
            text = section.get("text", "")
            if text:
                parts.append(text)
        return "\n".join(parts).strip() or "[富文本消息]"

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
        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_message_id: Optional[str] = None

        for chunk in chunks:
            result = await self._send_text_chunk(account, to, chunk)
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
        title = caption or "图片"
        md_text = f"![{title}]({media_url})"
        if caption:
            md_text += f"\n\n{caption}"

        session_webhook = self._get_session_webhook(account, to)
        if session_webhook:
            return await self._send_via_session_webhook(
                session_webhook,
                {"msgtype": "markdown", "markdown": {"title": title, "text": md_text}},
            )

        return await self._send_via_openapi(
            account, to,
            msg_key="sampleMarkdown",
            msg_param=json.dumps({"title": title, "text": md_text}),
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _send_text_chunk(
        self,
        account: ChannelAccount,
        to: str,
        text: str,
    ) -> SendResult:
        session_webhook = self._get_session_webhook(account, to)
        if session_webhook:
            return await self._send_via_session_webhook(
                session_webhook,
                {"msgtype": "text", "text": {"content": text}},
            )

        return await self._send_via_openapi(
            account, to,
            msg_key="sampleText",
            msg_param=json.dumps({"content": text}),
        )

    @staticmethod
    def _get_session_webhook(account: ChannelAccount, to: str) -> Optional[str]:
        """Retrieve a non-expired sessionWebhook URL from cache."""
        ctx = _get_cached_conversation(account.account_id, to)
        if ctx:
            return ctx.get("session_webhook")
        return None

    @staticmethod
    async def _send_via_session_webhook(
        webhook_url: str,
        payload: dict,
    ) -> SendResult:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(webhook_url, json=payload)
                data = resp.json()

            errcode = data.get("errcode", 0)
            if errcode == 0:
                return SendResult(ok=True)

            error = data.get("errmsg", f"errcode {errcode}")
            logger.warning("[DingTalkAdapter] sessionWebhook send failed: %s", error)
            return SendResult(ok=False, error=error)
        except Exception as exc:
            logger.error("[DingTalkAdapter] sessionWebhook error: %s", exc)
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    async def _send_via_openapi(
        account: ChannelAccount,
        conversation_id: str,
        *,
        msg_key: str,
        msg_param: str,
    ) -> SendResult:
        try:
            token = await _get_access_token(account)
            config = account.config or {}
            robot_code = (config.get("robot_code") or config.get("app_key") or "").strip()
            if not robot_code:
                return SendResult(ok=False, error="robot_code not configured")

            ctx = _get_cached_conversation(account.account_id, conversation_id)

            if not ctx:
                from apps.channel_gateway.services.binding_service import ChannelBindingService
                routing = ChannelBindingService.get_binding_routing(
                    "dingtalk", account.account_id, conversation_id,
                    str(account.organization_id),
                )
                if routing:
                    ctx = {
                        "conversation_type": routing.get("conversation_type", "1"),
                        "sender_staff_id": routing.get("sender_staff_id", ""),
                    }

            is_group = ctx and ctx.get("conversation_type") == "2" if ctx else False

            if is_group:
                payload = {
                    "robotCode": robot_code,
                    "openConversationId": conversation_id,
                    "msgKey": msg_key,
                    "msgParam": msg_param,
                }
                api_path = "/v1.0/robot/groupMessages/send"
            else:
                user_id = ctx.get("sender_staff_id") if ctx else None
                if not user_id:
                    return SendResult(
                        ok=False,
                        error="cannot resolve userId for 1:1 send "
                              "(sessionWebhook expired and no cached sender info)",
                    )
                payload = {
                    "robotCode": robot_code,
                    "userIds": [user_id],
                    "msgKey": msg_key,
                    "msgParam": msg_param,
                }
                api_path = "/v1.0/robot/oToMessages/batchSend"

            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{DINGTALK_API_BASE}{api_path}",
                    headers={"x-acs-dingtalk-access-token": token},
                    json=payload,
                )
                data = resp.json()

            process_query_key = data.get("processQueryKey")
            if process_query_key:
                return SendResult(ok=True, provider_message_id=process_query_key)

            if data.get("errcode") and data["errcode"] != 0:
                error = data.get("errmsg", f"errcode {data['errcode']}")
                logger.warning("[DingTalkAdapter] OpenAPI send failed: %s", error)
                return SendResult(ok=False, error=error)

            return SendResult(ok=True)
        except Exception as exc:
            logger.error("[DingTalkAdapter] OpenAPI error: %s", exc)
            return SendResult(ok=False, error=str(exc))

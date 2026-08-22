"""Google Chat Bot API adapter.

使用 httpx 直接调用 Google Chat REST API，通过 Service Account JWT 认证。

支持：
- Webhook 事件回调解析（MESSAGE 事件）
- Service Account JWT → OAuth2 access_token 交换（PyJWT RS256 签名）
- 发送文本消息（spaces.messages.create，支持 thread + 长文本分片）
- 发送媒体文件（链接文本 fallback）
- Bearer Token 验证（可选，验证 Google Chat 回调 JWT）
- 连通性 Probe（spaces.list）
"""

from __future__ import annotations

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


async def _async_sleep(seconds: float) -> None:
    import asyncio
    await asyncio.sleep(seconds)


GOOGLE_CHAT_API_BASE = "https://chat.googleapis.com/v1"
GOOGLE_OAUTH2_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot"
GOOGLE_CERTS_URL = "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com"
TOKEN_CACHE_TTL = 3500
TEXT_CHUNK_LIMIT = 4096


def _load_service_account_info(config: Dict[str, Any]) -> dict:
    raw = config.get("service_account_json", "")
    if isinstance(raw, dict):
        return raw
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("service_account_json 未配置")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"service_account_json 格式无效: {exc}") from exc


async def _get_access_token(config: Dict[str, Any]) -> str:
    """使用 Service Account JWT 签名交换 Google OAuth2 access_token，带缓存。"""
    sa_info = _load_service_account_info(config)
    client_email = sa_info.get("client_email", "")
    private_key = sa_info.get("private_key", "")

    if not client_email or not private_key:
        raise ValueError("service_account_json 缺少 client_email 或 private_key")

    cache_key = f"googlechat:token:{client_email}"
    token = cache.get(cache_key)
    if token:
        return token

    import uuid as _uuid
    lock_key = f"{cache_key}:lock"
    lock_value = str(_uuid.uuid4())
    acquired = cache.add(lock_key, lock_value, 30)
    if not acquired:
        for _ in range(32):
            await _async_sleep(0.5)
            token = cache.get(cache_key)
            if token:
                return token
        logger.warning("[GoogleChat] lock wait timed out, proceeding with direct fetch")

    try:
        token = cache.get(cache_key)
        if token:
            return token

        now = int(time.time())
        payload = {
            "iss": client_email,
            "scope": GOOGLE_CHAT_SCOPE,
            "aud": GOOGLE_OAUTH2_TOKEN_URL,
            "iat": now,
            "exp": now + 3600,
        }
        try:
            import jwt
        except ImportError:
            raise ValueError(
                "PyJWT is required for Google Chat authentication "
                "(pip install PyJWT)"
            )
        assertion = jwt.encode(payload, private_key, algorithm="RS256")

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                GOOGLE_OAUTH2_TOKEN_URL,
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": assertion,
                },
            )
        resp.raise_for_status()
        data = resp.json()
        access_token = data.get("access_token")
        if not access_token:
            raise ValueError(f"token exchange 失败: {data}")

        cache.set(cache_key, access_token, TOKEN_CACHE_TTL)
        return access_token
    finally:
        if acquired and cache.get(lock_key) == lock_value:
            cache.delete(lock_key)


GOOGLE_CERTS_CACHE_KEY = "googlechat:google_certs"
GOOGLE_CERTS_CACHE_TTL = 21600  # 6 hours
GOOGLE_CERTS_STALE_CACHE_KEY = "googlechat:google_certs:stale"
GOOGLE_CERTS_STALE_CACHE_TTL = 604800  # 7 days — fallback when fresh fetch fails
GOOGLE_CERTS_REFETCH_COOLDOWN_KEY = "googlechat:certs_refetch_ts"
GOOGLE_CERTS_REFETCH_COOLDOWN = 60


def _fetch_google_certs_sync(*, force: bool = False) -> Optional[dict]:
    """Synchronous fetch of Google public keys (fallback for webhook context).

    On network failure, falls back to stale cache (7-day TTL) so that
    transient outages don't immediately reject all GoogleChat webhooks.
    """
    if force:
        last_ts = cache.get(GOOGLE_CERTS_REFETCH_COOLDOWN_KEY)
        if last_ts and time.time() - last_ts < GOOGLE_CERTS_REFETCH_COOLDOWN:
            return cache.get(GOOGLE_CERTS_CACHE_KEY)
    try:
        resp = httpx.get(GOOGLE_CERTS_URL, timeout=10)
        resp.raise_for_status()
        certs = resp.json()
        cache.set(GOOGLE_CERTS_CACHE_KEY, certs, GOOGLE_CERTS_CACHE_TTL)
        cache.set(GOOGLE_CERTS_STALE_CACHE_KEY, certs, GOOGLE_CERTS_STALE_CACHE_TTL)
        cache.set(GOOGLE_CERTS_REFETCH_COOLDOWN_KEY, time.time(), GOOGLE_CERTS_REFETCH_COOLDOWN)
        return certs
    except Exception:
        stale = cache.get(GOOGLE_CERTS_STALE_CACHE_KEY)
        if stale:
            logger.error(
                "[GoogleChatAdapter] failed to fetch Google public keys, "
                "using stale cached certs (up to %d seconds old). "
                "Webhooks may reject if keys have rotated.",
                GOOGLE_CERTS_STALE_CACHE_TTL,
                exc_info=True,
            )
            return stale
        logger.error(
            "[GoogleChatAdapter] failed to fetch Google public keys and no "
            "stale cache available. All GoogleChat webhook verification "
            "will fail.",
            exc_info=True,
        )
        return None


async def _prefetch_google_certs() -> None:
    """Async pre-fetch Google public keys into cache (called during probe)."""
    if cache.get(GOOGLE_CERTS_CACHE_KEY):
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(GOOGLE_CERTS_URL)
            resp.raise_for_status()
            certs = resp.json()
            cache.set(GOOGLE_CERTS_CACHE_KEY, certs, GOOGLE_CERTS_CACHE_TTL)
    except Exception:
        logger.debug("[GoogleChatAdapter] async cert prefetch failed", exc_info=True)


def _verify_bearer_token(request: HttpRequest, audience: str) -> bool:
    """Verify Google Chat webhook Bearer JWT token.

    Uses cached Google public keys (pre-warmed by probe). Falls back to
    a synchronous fetch only if cache is empty.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        logger.warning("[GoogleChatAdapter] missing Bearer token")
        return False

    token = auth_header[7:]

    certs = cache.get(GOOGLE_CERTS_CACHE_KEY)
    if not certs:
        certs = _fetch_google_certs_sync()
        if not certs:
            logger.error(
                "[GoogleChatAdapter] Google public keys unavailable — cannot "
                "verify Bearer token. Rejecting webhook request."
            )
            return False

    try:
        import jwt as _jwt

        header = _jwt.get_unverified_header(token)
        kid = header.get("kid", "")
        cert_pem = certs.get(kid)
        if not cert_pem:
            certs = _fetch_google_certs_sync(force=True)
            if not certs:
                return False
            cert_pem = certs.get(kid)
            if not cert_pem:
                logger.warning("[GoogleChatAdapter] kid=%s not found in Google public keys", kid)
                return False

        _jwt.decode(
            token,
            cert_pem,
            algorithms=["RS256"],
            audience=audience,
            issuer="chat@system.gserviceaccount.com",
        )
        return True
    except ImportError:
        logger.error(
            "[GoogleChatAdapter] PyJWT not installed — all GoogleChat webhook "
            "Bearer token verification is disabled. Install with: "
            "pip install PyJWT"
        )
        return False
    except Exception as exc:
        logger.warning("[GoogleChatAdapter] Bearer token verification failed: %s", exc)
        return False


def _determine_peer_kind(space_type: str) -> str:
    if space_type.upper() == "DM":
        return "dm"
    return "group"


def _extract_media_from_attachment(attachment: dict) -> Optional[ChannelMedia]:
    content_type = attachment.get("contentType", "")
    content_name = attachment.get("contentName", "")

    if content_type.startswith("image/"):
        kind = "image"
    elif content_type.startswith("video/"):
        kind = "video"
    elif content_type.startswith("audio/"):
        kind = "audio"
    else:
        kind = "file"

    resource_name = None
    data_ref = attachment.get("attachmentDataRef")
    if data_ref:
        resource_name = data_ref.get("resourceName")

    download_uri = attachment.get("downloadUri")

    return ChannelMedia(
        kind=kind,
        url=download_uri or None,
        file_id=resource_name or attachment.get("name"),
        mime_type=content_type or None,
        filename=content_name or None,
    )


class GoogleChatAdapter(ChannelAdapter):
    """Google Chat Bot API channel adapter。"""

    @property
    def id(self) -> str:
        return "googlechat"

    @property
    def name(self) -> str:
        return "Google Chat"

    @property
    def description(self) -> str:
        return "通过 Google Chat Bot 收发消息，将 Google Chat 对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "googlechat"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group", "thread"],
            media=True,
            threads=True,
            supports_webhook=True,
        )

    # ------------------------------------------------------------------
    # 配置
    # ------------------------------------------------------------------

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="service_account_json",
                label="Service Account JSON",
                field_type="password",
                required=True,
                help_text="Google Cloud Service Account 的完整 JSON 密钥内容（从 Google Cloud Console 下载后粘贴）",
            ),
            ConfigField(
                key="audience_type",
                label="Audience Type",
                field_type="select",
                options=[
                    {"label": "App URL", "value": "app-url"},
                    {"label": "Project Number", "value": "project-number"},
                ],
                help_text="Webhook Bearer Token 验证的 audience 类型",
            ),
            ConfigField(
                key="audience",
                label="Audience",
                required=True,
                help_text="对应 audience_type 的值: app-url 模式填 App URL, project-number 模式填项目编号",
            ),
            ConfigField(
                key="webhook_path",
                label="Webhook Path",
                help_text="自定义 webhook 路径（选填）",
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        raw = config.get("service_account_json", "")

        if isinstance(raw, dict):
            sa_info = raw
        else:
            raw = (raw or "").strip()
            if not raw:
                errors.append("service_account_json is required")
                return errors
            try:
                sa_info = json.loads(raw)
            except json.JSONDecodeError:
                errors.append("service_account_json is not valid JSON")
                return errors

        if not sa_info.get("client_email"):
            errors.append("service_account_json must contain client_email")
        if not sa_info.get("private_key"):
            errors.append("service_account_json must contain private_key")

        try:
            import jwt  # noqa: F811
        except ImportError:
            errors.append("PyJWT package is required (pip install PyJWT)")

        if not (config.get("audience") or "").strip():
            errors.append("audience is required")

        return errors

    # ------------------------------------------------------------------
    # 连通性
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        try:
            config = account.config or {}
            sa_info = _load_service_account_info(config)
            token = await _get_access_token(config)

            await _prefetch_google_certs()

            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{GOOGLE_CHAT_API_BASE}/spaces",
                    params={"pageSize": "1"},
                    headers={"Authorization": f"Bearer {token}"},
                )

            if resp.status_code != 200:
                error_text = resp.text[:200] if resp.text else str(resp.status_code)
                return ProbeResult(ok=False, error=f"HTTP {resp.status_code}: {error_text}")

            return ProbeResult(
                ok=True,
                display_name=sa_info.get("client_email", "Google Chat Bot"),
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
    # 入站
    # ------------------------------------------------------------------

    def parse_webhook(
        self,
        request: HttpRequest,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        config = account.config or {}

        audience = (config.get("audience") or "").strip()
        if not audience:
            logger.warning("[GoogleChatAdapter] audience 未配置，拒绝处理 webhook")
            return None
        if not _verify_bearer_token(request, audience):
            logger.warning("[GoogleChatAdapter] Bearer token 验证失败，拒绝请求")
            return None

        try:
            body = json.loads(request.body)
        except (json.JSONDecodeError, ValueError):
            logger.warning("[GoogleChatAdapter] 无效的 JSON body")
            return None

        if (
            isinstance(body.get("commonEventObject"), dict)
            and body["commonEventObject"].get("hostApp") == "CHAT"
            and isinstance(body.get("chat"), dict)
            and isinstance(body["chat"].get("messagePayload"), dict)
        ):
            chat = body["chat"]
            payload = chat["messagePayload"]
            body = {
                "type": "MESSAGE",
                "space": payload.get("space"),
                "message": payload.get("message"),
                "user": chat.get("user"),
                "eventTime": chat.get("eventTime"),
            }

        event_type = body.get("type") or body.get("eventType")
        if event_type in ("ADDED_TO_SPACE", "REMOVED_FROM_SPACE"):
            return None
        if event_type != "MESSAGE":
            return None

        message = body.get("message")
        if not message or not isinstance(message, dict):
            return None

        space = body.get("space") or message.get("space")
        if not space or not isinstance(space, dict):
            return None

        return self._parse_message_event(message, space, body, account)

    def _parse_message_event(
        self,
        message: dict,
        space: dict,
        body: dict,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        text = (message.get("argumentText") or message.get("text") or "").strip()

        attachments = message.get("attachment") or []
        media_items: List[ChannelMedia] = []
        for att in attachments:
            if not isinstance(att, dict):
                continue
            item = _extract_media_from_attachment(att)
            if item:
                media_items.append(item)
        media = media_items if media_items else None

        if not text and not media:
            return None

        space_name = space.get("name", "")
        if not space_name:
            return None

        sender = message.get("sender") or body.get("user") or {}
        sender_id = sender.get("name", "")
        if not sender_id:
            return None

        if (sender.get("type") or "").upper() == "BOT":
            return None

        space_type = (space.get("type") or "").upper()
        peer_kind = _determine_peer_kind(space_type)

        message_name = message.get("name", "")
        thread = message.get("thread") or {}
        thread_name = thread.get("name")

        event_time = body.get("eventTime")
        if event_time:
            try:
                from datetime import datetime

                dt = datetime.fromisoformat(event_time.replace("Z", "+00:00"))
                timestamp = int(dt.timestamp())
            except (ValueError, AttributeError):
                timestamp = int(time.time())
        else:
            timestamp = int(time.time())

        metadata: Dict[str, Any] = {
            "space_type": space_type,
            "sender_display_name": sender.get("displayName", ""),
        }
        if sender.get("email"):
            metadata["sender_email"] = sender["email"]
        if space.get("displayName"):
            metadata["space_display_name"] = space["displayName"]
        if thread_name:
            metadata["thread_id"] = thread_name

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=space_name,
            sender_id=sender_id,
            message_id=message_name,
            thread_id=thread_name,
            reply_to=thread_name if thread_name and thread_name != message_name else None,
            text=text or None,
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
        config = account.config or {}
        token = await _get_access_token(config)
        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_message_name: Optional[str] = None

        effective_thread = reply_to or thread_id

        for chunk in chunks:
            payload: Dict[str, Any] = {"text": chunk}

            if effective_thread:
                payload["thread"] = {"name": effective_thread}

            params: Dict[str, str] = {}
            if effective_thread:
                params["messageReplyOption"] = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"

            result = await self._call_create_message(token, to, payload, params)

            if not result.ok:
                return result
            last_message_name = result.provider_message_id

        return SendResult(ok=True, provider_message_id=last_message_name)

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
        fallback_text = caption or media_url
        if caption and media_url:
            fallback_text = f"{caption}\n{media_url}"
        return await self.send_text(account, to, fallback_text, reply_to=reply_to)

    # ------------------------------------------------------------------
    # 内部 API 方法
    # ------------------------------------------------------------------

    @staticmethod
    async def _call_create_message(
        token: str,
        space: str,
        payload: Dict[str, Any],
        params: Optional[Dict[str, str]] = None,
    ) -> SendResult:
        space_path = space if space.startswith("spaces/") else f"spaces/{space}"
        url = f"{GOOGLE_CHAT_API_BASE}/{space_path}/messages"

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    params=params or {},
                    json=payload,
                )

            if resp.status_code == 200:
                data = resp.json()
                return SendResult(
                    ok=True,
                    provider_message_id=data.get("name", ""),
                )

            error_text = resp.text[:300] if resp.text else str(resp.status_code)
            logger.warning(
                "[GoogleChatAdapter] messages.create 失败: HTTP %s — %s",
                resp.status_code,
                error_text,
            )
            return SendResult(ok=False, error=f"HTTP {resp.status_code}: {error_text}")
        except Exception as exc:
            logger.error("[GoogleChatAdapter] messages.create 异常: %s", exc)
            return SendResult(ok=False, error=str(exc))

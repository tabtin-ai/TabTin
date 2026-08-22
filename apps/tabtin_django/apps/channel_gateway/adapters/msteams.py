"""Microsoft Teams Bot Framework adapter.

通过 Bot Framework REST API 实现 MS Teams 消息收发。
MS Teams 适配器设计说明（Python 实现）。

支持：
- Bot Framework Activity webhook 解析
- 发送文本消息（含回复）
- 发送媒体附件（Attachment）
- Bot Framework OAuth2 token 获取与缓存
- JWT JWKS 签名验证（通过 Bot Framework OpenID 配置）
"""

from __future__ import annotations

import json
import logging
import re
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

TOKEN_ENDPOINT = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token"
TOKEN_SCOPE = "https://api.botframework.com/.default"
TOKEN_CACHE_TTL = 3500
TEXT_CHUNK_LIMIT = 4096
DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/teams/"
MENTION_TAG_RE = re.compile(r"<at>[^<]*</at>\s*", re.IGNORECASE)

TRUSTED_SERVICE_URL_SUFFIXES = (
    ".botframework.com",
    ".trafficmanager.net",
)


def _validate_service_url(url: str) -> bool:
    """Reject service URLs outside Bot Framework trusted domains (SSRF prevention)."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.scheme != "https":
            return False
        host = (parsed.hostname or "").lower()
        return any(host.endswith(suffix) for suffix in TRUSTED_SERVICE_URL_SUFFIXES)
    except Exception:
        return False


def _extract_credentials(account: ChannelAccount) -> tuple[str, str]:
    config = account.config or {}
    app_id = (config.get("app_id") or "").strip()
    app_password = (config.get("app_password") or "").strip()
    if not app_id or not app_password:
        raise ValueError("app_id and app_password are required")
    return app_id, app_password


async def _get_access_token(account: ChannelAccount) -> str:
    app_id, app_password = _extract_credentials(account)
    cache_key = f"msteams:token:{app_id}"
    lock_key = f"msteams:token_lock:{app_id}"

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

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                TOKEN_ENDPOINT,
                data={
                    "grant_type": "client_credentials",
                    "client_id": app_id,
                    "client_secret": app_password,
                    "scope": TOKEN_SCOPE,
                },
            )
            data = resp.json()

        if "access_token" not in data:
            error = data.get("error_description", data.get("error", "unknown"))
            raise ValueError(f"failed to obtain Bot Framework access_token: {error}")

        token = data["access_token"]
        cache.set(cache_key, token, TOKEN_CACHE_TTL)
        return token
    finally:
        if acquired:
            cache.delete(lock_key)


def _clean_mention_tags(text: str) -> str:
    return MENTION_TAG_RE.sub("", text).strip()


SERVICE_URL_CACHE_TTL = 86400  # 24h


def _cache_service_url(account_id: str, conversation_id: str, service_url: str) -> None:
    """Cache the service_url from inbound activity for outbound routing."""
    if service_url and _validate_service_url(service_url):
        cache.set(
            f"msteams:svc_url:{account_id}:{conversation_id}",
            service_url.rstrip("/"),
            SERVICE_URL_CACHE_TTL,
        )


def _resolve_service_url(account: ChannelAccount, conversation_id: str = "") -> str:
    """Resolve service URL: cache → binding metadata → config → default."""
    if conversation_id:
        cached = cache.get(f"msteams:svc_url:{account.account_id}:{conversation_id}")
        if cached:
            return cached
        from apps.channel_gateway.services.binding_service import ChannelBindingService
        routing = ChannelBindingService.get_binding_routing(
            "msteams", account.account_id, conversation_id,
            str(account.organization_id),
        )
        if routing:
            svc_url = routing.get("service_url")
            if svc_url and _validate_service_url(svc_url):
                _cache_service_url(account.account_id, conversation_id, svc_url)
                return svc_url.rstrip("/")
    config = account.config or {}
    return (config.get("service_url") or DEFAULT_SERVICE_URL).rstrip("/")


def _parse_conversation_type(conv: Dict[str, Any]) -> str:
    conv_type = conv.get("conversationType", "")
    if conv_type == "personal":
        return "dm"
    return "group"


def _extract_media_from_attachments(attachments: List[Dict[str, Any]]) -> Optional[List[ChannelMedia]]:
    items: List[ChannelMedia] = []
    for att in attachments:
        content_type = att.get("contentType", "")
        content_url = att.get("contentUrl", "")
        name = att.get("name")

        if not content_url:
            continue

        if content_type.startswith("image/"):
            kind = "image"
        elif content_type.startswith("video/"):
            kind = "video"
        elif content_type.startswith("audio/"):
            kind = "audio"
        else:
            kind = "file"

        items.append(ChannelMedia(
            kind=kind,
            url=content_url,
            mime_type=content_type or None,
            filename=name,
        ))
    return items if items else None


BOT_FRAMEWORK_OPENID_URL = (
    "https://login.botframework.com/v1/.well-known/openidconfiguration"
)
JWKS_CACHE_KEY = "msteams:jwks"
JWKS_CACHE_TTL = 86400  # 24h
JWKS_STALE_CACHE_KEY = "msteams:jwks:stale"
JWKS_STALE_CACHE_TTL = 604800  # 7 days — fallback when fresh fetch fails
JWKS_REFETCH_COOLDOWN_KEY = "msteams:jwks_refetch_ts"
JWKS_REFETCH_COOLDOWN = 60  # min seconds between forced refetch


def _get_jwks(*, force_refresh: bool = False) -> Optional[dict]:
    """Fetch Bot Framework JWKS (cached). Returns {kid: key_data} mapping.

    On network failure, falls back to stale cache (7-day TTL) so that
    transient outages don't immediately reject all MSTeams webhooks.
    """
    cached = cache.get(JWKS_CACHE_KEY)
    if cached and not force_refresh:
        return cached

    if force_refresh:
        last_ts = cache.get(JWKS_REFETCH_COOLDOWN_KEY)
        if last_ts and time.time() - last_ts < JWKS_REFETCH_COOLDOWN:
            return cached

    try:
        openid_resp = httpx.get(BOT_FRAMEWORK_OPENID_URL, timeout=10)
        openid_resp.raise_for_status()
        openid_config = openid_resp.json()
        jwks_uri = openid_config.get("jwks_uri", "")
        if not jwks_uri:
            logger.error("[MSTeamsAdapter] no jwks_uri in OpenID config")
            return cache.get(JWKS_STALE_CACHE_KEY)

        jwks_resp = httpx.get(jwks_uri, timeout=10)
        jwks_resp.raise_for_status()
        jwks_data = jwks_resp.json()
        cache.set(JWKS_CACHE_KEY, jwks_data, JWKS_CACHE_TTL)
        cache.set(JWKS_STALE_CACHE_KEY, jwks_data, JWKS_STALE_CACHE_TTL)
        cache.set(JWKS_REFETCH_COOLDOWN_KEY, time.time(), JWKS_REFETCH_COOLDOWN)
        return jwks_data
    except Exception:
        stale = cache.get(JWKS_STALE_CACHE_KEY)
        if stale:
            logger.error(
                "[MSTeamsAdapter] JWKS fetch failed, using stale cached keys "
                "(up to %d seconds old). All MSTeams webhooks may reject if "
                "keys have rotated.",
                JWKS_STALE_CACHE_TTL,
                exc_info=True,
            )
            return stale
        logger.error(
            "[MSTeamsAdapter] JWKS fetch failed and no stale cache available. "
            "All MSTeams webhook signature verification will fail.",
            exc_info=True,
        )
        return None


_ISSUER_STS_RE = re.compile(
    r"^https://sts\.windows\.net/"
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/$",
    re.IGNORECASE,
)
_ISSUER_LOGIN_RE = re.compile(
    r"^https://login\.microsoftonline\.com/"
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/v2\.0$",
    re.IGNORECASE,
)


def _validate_issuer(iss: str, tenant_id: str = "") -> bool:
    """Validate JWT issuer against configured tenant.

    Single-tenant (specific tenant_id): exact match against that tenant only.
    Multi-tenant (no tenant_id or 'botframework.com'): validate URL pattern
    with proper UUID tenant ID component — rejects malformed or non-UUID
    tenant strings that would pass a simple prefix check.
    """
    if iss == "https://api.botframework.com":
        return True

    if tenant_id and tenant_id != "botframework.com":
        return iss in (
            f"https://sts.windows.net/{tenant_id}/",
            f"https://login.microsoftonline.com/{tenant_id}/v2.0",
        )

    if _ISSUER_STS_RE.match(iss):
        return True
    if _ISSUER_LOGIN_RE.match(iss):
        return True
    return False


def _verify_jwt(request: HttpRequest, app_id: str, tenant_id: str = "") -> bool:
    """Verify Bot Framework JWT using JWKS public keys.

    Full verification: fetch OpenID config → JWKS → verify RS256 signature,
    audience, and issuer (restricted to configured tenant or valid UUID pattern).
    """
    try:
        import jwt as _jwt
        from jwt import PyJWKClient  # noqa: F401
    except ImportError:
        logger.error(
            "[MSTeamsAdapter] PyJWT not installed — all MSTeams webhook "
            "signature verification is disabled. Install with: "
            "pip install PyJWT[crypto]"
        )
        return False

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return False

    token = auth_header[7:]

    jwks_data = _get_jwks()
    if not jwks_data:
        logger.error(
            "[MSTeamsAdapter] JWKS unavailable — cannot verify JWT signature. "
            "Rejecting webhook request."
        )
        return False

    try:
        header = _jwt.get_unverified_header(token)
        kid = header.get("kid", "")

        keys = jwks_data.get("keys", [])
        matching_key = None
        for key in keys:
            if key.get("kid") == kid:
                matching_key = key
                break

        if not matching_key:
            jwks_data = _get_jwks(force_refresh=True)
            if not jwks_data:
                return False
            keys = jwks_data.get("keys", [])
            for key in keys:
                if key.get("kid") == kid:
                    matching_key = key
                    break
            if not matching_key:
                logger.warning("[MSTeamsAdapter] kid=%s not found in JWKS", kid)
                return False

        from jwt.algorithms import RSAAlgorithm
        public_key = RSAAlgorithm.from_jwk(matching_key)

        payload = _jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience=app_id,
            options={"verify_iss": False},
        )
        iss = payload.get("iss", "")
        if not _validate_issuer(iss, tenant_id):
            logger.warning("[MSTeamsAdapter] JWT issuer not trusted: %s", iss)
            return False
        return True
    except ImportError:
        logger.error(
            "[MSTeamsAdapter] PyJWT[crypto] not installed — RSA key "
            "operations unavailable. Install with: pip install PyJWT[crypto]"
        )
        return False
    except Exception as exc:
        logger.warning("[MSTeamsAdapter] JWT verification failed: %s", exc)
        return False


class MSTeamsAdapter(ChannelAdapter):
    """Microsoft Teams Bot Framework channel adapter."""

    @property
    def id(self) -> str:
        return "msteams"

    @property
    def name(self) -> str:
        return "Microsoft Teams"

    @property
    def description(self) -> str:
        return "通过 Bot Framework 收发消息，将 Microsoft Teams 对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "msteams"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group", "thread"],
            media=True,
            threads=True,
            supports_webhook=True,
        )

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="app_id",
                label="Bot App ID",
                required=True,
                help_text="Azure Bot Framework App ID (from Azure Portal)",
            ),
            ConfigField(
                key="app_password",
                label="Bot App Password",
                field_type="password",
                required=True,
                help_text="Azure Bot Framework App Password (client secret)",
            ),
            ConfigField(
                key="tenant_id",
                label="Tenant ID",
                default="botframework.com",
                help_text="Azure AD Tenant ID (optional, defaults to botframework.com)",
            ),
            ConfigField(
                key="service_url",
                label="Service URL",
                field_type="url",
                help_text="Bot Framework service URL override (optional)",
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        if not (config.get("app_id") or "").strip():
            errors.append("app_id is required")
        if not (config.get("app_password") or "").strip():
            errors.append("app_password is required")

        try:
            import jwt  # noqa: F401
        except ImportError:
            errors.append(
                "PyJWT is not installed — MSTeams JWT verification will fail. "
                "Install with: pip install PyJWT"
            )
        else:
            try:
                from jwt.algorithms import RSAAlgorithm  # noqa: F401
            except ImportError:
                errors.append(
                    "PyJWT[crypto] extras not installed — RSA signature verification "
                    "will fail. Install with: pip install PyJWT[crypto]"
                )

        return errors

    def extract_routing_context(self, data) -> dict | None:
        meta = data.metadata or {}
        svc_url = meta.get("service_url")
        if svc_url and _validate_service_url(svc_url):
            return {"service_url": svc_url}
        return None

    # ------------------------------------------------------------------
    # Connectivity
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        try:
            token = await _get_access_token(account)
            return ProbeResult(
                ok=True,
                display_name="MS Teams Bot",
                raw={"token_acquired": True, "token_length": len(token)},
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
            logger.warning("[MSTeamsAdapter] invalid JSON body")
            return None

        config = account.config or {}
        app_id = (config.get("app_id") or "").strip()
        if not app_id:
            logger.warning("[MSTeamsAdapter] app_id missing in config, rejecting request")
            return None

        tenant_id = (config.get("tenant_id") or "").strip()
        if not _verify_jwt(request, app_id, tenant_id):
            logger.warning("[MSTeamsAdapter] JWT verification failed, rejecting request")
            return None

        activity_type = body.get("type", "")

        if activity_type in ("conversationUpdate", "installationUpdate", "contactRelationUpdate", "typing"):
            return None

        if activity_type != "message":
            return None

        conversation = body.get("conversation", {})
        from_user = body.get("from", {})
        service_url = body.get("serviceUrl", DEFAULT_SERVICE_URL)

        peer_id = conversation.get("id", "")
        if not peer_id:
            return None

        sender_id = from_user.get("id", "")
        if not sender_id:
            return None

        message_id = body.get("id", "")
        if not message_id:
            return None

        raw_text = body.get("text", "")
        text = _clean_mention_tags(raw_text) if raw_text else None

        attachments = body.get("attachments") or []
        media = _extract_media_from_attachments(attachments)

        if not text and not media:
            return None

        peer_kind = _parse_conversation_type(conversation)

        timestamp_str = body.get("timestamp", "")
        timestamp = int(time.time())
        if timestamp_str:
            try:
                from datetime import datetime, timezone
                dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
                timestamp = int(dt.timestamp())
            except (ValueError, TypeError):
                pass

        reply_to_id = body.get("replyToId")

        # Cache service_url per conversation for outbound routing
        _cache_service_url(account.account_id, peer_id, service_url)

        metadata: Dict[str, Any] = {
            "service_url": service_url,
            "from_name": from_user.get("name", ""),
            "conversation_type": conversation.get("conversationType", ""),
        }

        aad_object_id = from_user.get("aadObjectId")
        if aad_object_id:
            metadata["aad_object_id"] = aad_object_id

        tenant_id = conversation.get("tenantId")
        if tenant_id:
            metadata["tenant_id"] = tenant_id

        channel_data = body.get("channelData", {})
        if channel_data.get("teamsChannelId"):
            metadata["teams_channel_id"] = channel_data["teamsChannelId"]
        if channel_data.get("teamsTeamId"):
            metadata["teams_team_id"] = channel_data["teamsTeamId"]

        recipient = body.get("recipient", {})
        if recipient.get("id"):
            metadata["bot_id"] = recipient["id"]

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=peer_id,
            sender_id=sender_id,
            message_id=message_id,
            reply_to=reply_to_id or None,
            text=text,
            media=media,
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
        token = await _get_access_token(account)
        service_url = _resolve_service_url(account, to)
        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_message_id: Optional[str] = None

        for chunk in chunks:
            activity: Dict[str, Any] = {
                "type": "message",
                "text": chunk,
            }
            if reply_to and last_message_id is None:
                activity["replyToId"] = reply_to

            result = await self._send_activity(token, service_url, to, activity)
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
        token = await _get_access_token(account)
        service_url = _resolve_service_url(account, to)

        content_type = mime_type or "application/octet-stream"
        filename = media_url.rsplit("/", 1)[-1][:100] or "file"

        activity: Dict[str, Any] = {
            "type": "message",
            "attachments": [{
                "contentType": content_type,
                "contentUrl": media_url,
                "name": filename,
            }],
        }

        if caption:
            activity["text"] = caption

        if reply_to:
            activity["replyToId"] = reply_to

        return await self._send_activity(token, service_url, to, activity)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _send_activity(
        token: str,
        service_url: str,
        conversation_id: str,
        activity: Dict[str, Any],
    ) -> SendResult:
        url = f"{service_url}/v3/conversations/{conversation_id}/activities"
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    json=activity,
                )

            if resp.status_code in (200, 201):
                data = resp.json()
                return SendResult(
                    ok=True,
                    provider_message_id=data.get("id", ""),
                )

            error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            logger.warning("[MSTeamsAdapter] send_activity failed: %s", error)
            return SendResult(ok=False, error=error)
        except Exception as exc:
            logger.error("[MSTeamsAdapter] send_activity error: %s", exc)
            return SendResult(ok=False, error=str(exc))

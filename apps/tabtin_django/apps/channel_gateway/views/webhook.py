"""Platform webhook endpoints.

Each channel adapter registers its webhook URL pattern here.  The view
authenticates the request via the per-account ``webhook_token`` stored
in ``ChannelAccount.config``, then delegates to the adapter's
``parse_webhook`` method.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging

from django.core.cache import cache
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from apps.channel_gateway.adapters.base import WebhookChallengeResponse, WebhookRejectError
from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
from apps.channel_gateway.models import ChannelAccount
from apps.channel_gateway.services.inbound_service import ChannelInboundService

logger = logging.getLogger(__name__)

WEBHOOK_RATE_LIMIT = 60   # max requests per window per IP
WEBHOOK_RATE_WINDOW = 60   # window in seconds


def _get_client_ip(request: HttpRequest) -> str:
    from apps.users.auth.utils import get_client_ip
    return get_client_ip(request) or "unknown"


def _is_rate_limited(request: HttpRequest) -> bool:
    """Return True if the caller exceeded the per-IP webhook rate limit."""
    ip = _get_client_ip(request)
    key = f"cg:wh_rl:{ip}"
    try:
        current = cache.incr(key)
    except ValueError:
        cache.set(key, 1, WEBHOOK_RATE_WINDOW)
        return False
    return current > WEBHOOK_RATE_LIMIT


@csrf_exempt
def channel_webhook(request: HttpRequest, channel_id: str, webhook_token: str) -> HttpResponse:
    """``POST|GET /channel-gateway/webhook/<channel_id>/<webhook_token>/``

    Generic entry point for all channel webhooks.  The *channel_id* selects
    the adapter and the *webhook_token* authenticates the caller.

    All challenge responses (GET and POST) require successful webhook_token
    authentication first, then go through the adapter's ``parse_webhook``
    for platform-specific signature verification.
    """
    if _is_rate_limited(request):
        return JsonResponse({"ok": False, "error": "rate limited"}, status=429)

    if request.method == "GET":
        return _handle_get_challenge(request, channel_id, webhook_token)

    if request.method != "POST":
        return JsonResponse({"ok": False, "error": "method not allowed"}, status=405)

    account = _resolve_account_by_webhook_token(channel_id, webhook_token)
    if account is None:
        return JsonResponse({"ok": False, "error": "invalid token"}, status=403)

    adapter = ChannelAdapterRegistry.get(channel_id)
    if adapter is None:
        logger.warning("[webhook] unknown channel_id: %s", channel_id)
        return JsonResponse({"ok": False, "error": "not found"}, status=404)

    try:
        inbound = adapter.parse_webhook(request, account)
    except WebhookChallengeResponse as challenge:
        if challenge.raw_json:
            return HttpResponse(
                challenge.challenge,
                content_type="application/json",
            )
        return JsonResponse({"challenge": challenge.challenge})
    except WebhookRejectError as exc:
        logger.warning("[webhook] %s rejected: %s", channel_id, exc)
        return JsonResponse({"ok": False, "error": str(exc)}, status=400)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("[webhook] %s bad request: %s", channel_id, exc)
        return JsonResponse({"ok": False, "error": "bad request"}, status=400)
    except Exception:
        logger.exception("[webhook] %s parse_webhook failed", channel_id)
        return JsonResponse({"ok": False, "error": "internal error"}, status=500)

    if inbound is None:
        return JsonResponse({"ok": True})

    try:
        from apps.channel_gateway.tasks import process_inbound_message
        process_inbound_message.delay(inbound.model_dump())
    except Exception:
        logger.exception("[webhook] dispatch inbound failed for %s", inbound.message_id)

    return JsonResponse({"ok": True})


def _handle_get_challenge(
    request: HttpRequest,
    channel_id: str,
    webhook_token: str,
) -> HttpResponse:
    """Handle GET-based URL verification challenges.

    Supports:
    - WhatsApp: ``hub.mode=subscribe``, ``hub.verify_token``, ``hub.challenge``
      → returns plain text challenge (required by Meta)
    - Generic: ``?challenge=xxx`` → returns JSON ``{"challenge": "xxx"}``
    """
    hub_mode = request.GET.get("hub.mode")
    hub_challenge = request.GET.get("hub.challenge")

    if hub_mode == "subscribe" and hub_challenge:
        account = _resolve_account_by_webhook_token(channel_id, webhook_token)
        if account is None:
            return HttpResponse("Forbidden", status=403)
        hub_verify_token = request.GET.get("hub.verify_token", "")
        stored = (account.config or {}).get("verify_token", "")
        if not stored:
            logger.warning("[webhook] WhatsApp verify_token not configured for channel=%s", channel_id)
            return HttpResponse("Forbidden", status=403)
        if not hmac.compare_digest(stored, hub_verify_token):
            return HttpResponse("Forbidden", status=403)
        return HttpResponse(hub_challenge, content_type="text/plain")

    # WeChat Work URL verification: decrypt echostr and return plaintext
    echostr = request.GET.get("echostr")
    msg_signature = request.GET.get("msg_signature")
    if echostr and msg_signature:
        account = _resolve_account_by_webhook_token(channel_id, webhook_token)
        if account is None:
            return HttpResponse("Forbidden", status=403)
        config = account.config or {}
        encoding_aes_key = (config.get("encoding_aes_key") or "").strip()
        cb_token = (config.get("token") or "").strip()
        if not encoding_aes_key or not cb_token:
            return HttpResponse("Forbidden", status=403)
        try:
            from apps.channel_gateway.adapters.wechat_work import decrypt_echostr

            timestamp = request.GET.get("timestamp", "")
            nonce = request.GET.get("nonce", "")
            decrypted = decrypt_echostr(
                encoding_aes_key, cb_token, msg_signature, timestamp, nonce, echostr,
            )
            return HttpResponse(decrypted, content_type="text/plain")
        except Exception as exc:
            logger.warning("[webhook] wechat_work URL verification failed: %s", exc)
            return HttpResponse("Forbidden", status=403)

    challenge = request.GET.get("challenge")
    if challenge:
        account = _resolve_account_by_webhook_token(channel_id, webhook_token)
        if account is None:
            return HttpResponse("Forbidden", status=403)
        return JsonResponse({"challenge": challenge})
    return JsonResponse({"ok": True})


def _handle_post_challenge(request: HttpRequest) -> JsonResponse | None:
    """Handle POST-based URL verification challenges (Feishu sends these).

    Returns a JsonResponse if this is a challenge request, None otherwise
    so normal webhook processing continues.
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return None

    # Feishu v2.0 URL 验证: POST with {"challenge": "xxx", "token": "xxx", "type": "url_verification"}
    if body.get("type") == "url_verification" and "challenge" in body:
        return JsonResponse({"challenge": body["challenge"]})

    # Feishu encrypted challenge
    if "encrypt" in body and not body.get("header"):
        # Might be an encrypted challenge — let it pass through to the adapter
        return None

    # Direct challenge field (rare but supported)
    if isinstance(body.get("challenge"), str) and len(body) <= 3:
        return JsonResponse({"challenge": body["challenge"]})

    return None


_WEBHOOK_TOKEN_CACHE_TTL = 3600  # 1 hour


def _resolve_account_by_webhook_token(
    channel: str,
    webhook_token: str,
) -> ChannelAccount | None:
    """Find the ChannelAccount whose ``config.webhook_token`` matches.

    Uses a Redis cache (token_hash → account_id) to avoid loading all
    accounts for the channel on every request.  Falls back to a full
    scan on cache miss and auto-populates the cache.
    """
    if not webhook_token or len(webhook_token) < 16:
        return None

    token_hash = hashlib.sha256(webhook_token.encode()).hexdigest()
    cache_key = f"cg:wh_tok:{channel}:{token_hash}"

    cached_account_id = cache.get(cache_key)
    if cached_account_id:
        account = ChannelAccount.objects.filter(id=cached_account_id, enabled=True).first()
        if account:
            stored = ((account.config or {}).get("webhook_token") or "").strip()
            if stored and hmac.compare_digest(stored, webhook_token):
                return account
        cache.delete(cache_key)

    for account in ChannelAccount.objects.filter(channel=channel, enabled=True).iterator():
        stored = ((account.config or {}).get("webhook_token") or "").strip()
        if stored and hmac.compare_digest(stored, webhook_token):
            cache.set(cache_key, str(account.id), _WEBHOOK_TOKEN_CACHE_TTL)
            return account

    return None

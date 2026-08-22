"""Invite-code access gate for authenticated API requests."""

from __future__ import annotations

import logging
from typing import Iterable

from django.conf import settings
from django.core.cache import cache
from django.http import JsonResponse

from .models import RegistrationInviteRedemption
from .permissions import authenticate_django_bearer_request
from .services.invite_code_service import is_invite_gate_enabled

logger = logging.getLogger(__name__)

INVITE_GATE_REQUIRED_CODE = "INVITE_CODE_REQUIRED"
INVITE_GATE_CACHE_TTL_SECONDS = 60
INVITE_GATE_CACHE_PREFIX = "invite_gate:redeemed"

_API_PREFIX = "/api/"
_DEFAULT_ALLOWLIST_PREFIXES: tuple[str, ...] = (
    "/api/auth/login",
    "/api/auth/login/verification-code",
    "/api/auth/register",
    "/api/auth/send-verification-code",
    "/api/auth/refresh-token",
    "/api/auth/logout",
    "/api/auth/profile",
    "/api/auth/invite-code/redeem",
    # StaffAuth still protects this bootstrap path; the gate must not block admins
    # from creating the first usable invite code.
    "/api/auth/admin/invite-codes",
    "/api/auth/health",
    "/api/health",
    "/api/docs",
    "/api/openapi",
    "/api/schema",
    "/api/shared/",
    # TabDoc / TabData 公开分享链（含 collab-token、评论）；与 /api/shared/ 同属外链场景，
    # 已登录但未兑邀请码的用户也应能打开分享页并订阅 share.events。
    "/api/tabdoc/shared/",
    "/api/tabdata/shared/",
    "/api/forms/",
)
_NON_API_ALLOWLIST_PREFIXES: tuple[str, ...] = (
    "/health",
    "/ping",
    "/admin",
    "/static/",
    "/media/",
)


def _iter_allowlist_prefixes() -> Iterable[str]:
    yield from _DEFAULT_ALLOWLIST_PREFIXES
    extra = getattr(settings, "INVITE_GATE_ALLOWLIST_PREFIXES", ())
    if isinstance(extra, str):
        extra = [item.strip() for item in extra.split(",") if item.strip()]
    yield from extra


def _path_matches_prefix(path: str, prefix: str) -> bool:
    normalized_prefix = prefix.rstrip("/")
    if not normalized_prefix:
        return False
    return path == normalized_prefix or path.startswith(f"{normalized_prefix}/")


def _is_allowlisted_request(path: str, method: str) -> bool:
    if method == "OPTIONS":
        return True
    if not path.startswith(_API_PREFIX):
        return any(_path_matches_prefix(path, prefix) for prefix in _NON_API_ALLOWLIST_PREFIXES)
    return any(_path_matches_prefix(path, prefix) for prefix in _iter_allowlist_prefixes())


def clear_invite_gate_cache(user_id) -> None:
    cache.delete(f"{INVITE_GATE_CACHE_PREFIX}:{user_id}")


def _has_redeemed_invite(user) -> bool:
    cache_key = f"{INVITE_GATE_CACHE_PREFIX}:{user.id}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached == "1"
    redeemed = RegistrationInviteRedemption.objects.filter(user=user).exists()
    cache.set(cache_key, "1" if redeemed else "0", INVITE_GATE_CACHE_TTL_SECONDS)
    return redeemed


class InviteGateMiddleware:
    """Block authenticated core API access until invite code redemption completes."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if self._should_block(request):
            return JsonResponse(
                {
                    "success": False,
                    "message": "请先完成邀请码验证",
                    "data": None,
                    "code": INVITE_GATE_REQUIRED_CODE,
                },
                status=403,
            )
        return self.get_response(request)

    def _should_block(self, request) -> bool:
        if not is_invite_gate_enabled():
            return False
        path = request.path_info or request.path
        if _is_allowlisted_request(path, request.method):
            return False
        if not path.startswith(_API_PREFIX):
            return False

        user = authenticate_django_bearer_request(request)
        if user is None:
            return False
        if getattr(request, "api_key", None) is not None:
            return False
        if _has_redeemed_invite(user):
            return False

        logger.info(
            "[InviteGate] blocked pending user",
            extra={"user_id": str(user.id), "path": path, "method": request.method},
        )
        return True

"""
统一认证类。

InternalServiceAuth — collab-live 等内部服务的认证，
替代 auth=None + 手动 _is_live_request() 的模式。
"""

import hmac
import logging

from ninja.errors import HttpError
from ninja.security import APIKeyHeader

from apps.services.common.live_api import (
    _get_live_secret,
    _DEFAULT_DEV_SECRET,
)

logger = logging.getLogger("services.common.auth")

_cached_is_debug: bool | None = None


def _get_debug() -> bool:
    global _cached_is_debug
    if _cached_is_debug is None:
        from django.conf import settings
        _cached_is_debug = bool(settings.DEBUG)
    return _cached_is_debug


class InternalServiceAuth(APIKeyHeader):
    """collab-live 等内部服务的 X-Live-Secret HMAC 认证。

    认证通过后 request.auth = "collab-live-service"。
    认证失败抛出 403（与原 _is_live_request 行为一致），
    而非 Ninja 默认的 401，确保 collab-live 重试逻辑正确跳过。
    """

    param_name = "X-Live-Secret"

    def authenticate(self, request, key):
        secret = _get_live_secret()

        if not secret:
            logger.warning(
                "COLLAB_LIVE_SECRET 未配置，拒绝所有内部服务请求。"
                "请在环境变量中设置 COLLAB_LIVE_SECRET。"
            )
            raise HttpError(403, "Unauthorized: live secret not configured")

        if not key:
            raise HttpError(403, "Unauthorized: missing X-Live-Secret header")

        if secret == _DEFAULT_DEV_SECRET and not _get_debug():
            logger.warning(
                "COLLAB_LIVE_SECRET 仍为默认开发密钥且当前非 DEBUG 模式，"
                "拒绝请求。请设置安全的随机密钥。"
            )
            raise HttpError(403, "Unauthorized: default dev secret rejected in production")

        if hmac.compare_digest(key.encode("utf-8"), secret.encode("utf-8")):
            return "collab-live-service"

        logger.warning("X-Live-Secret 校验失败，来源 IP: %s", request.META.get("REMOTE_ADDR", "unknown"))
        raise HttpError(403, "Unauthorized: invalid X-Live-Secret")

"""
Collab 统一装饰器

注意: collab-live 认证已内联到 api.py 的 _is_live_request() 中。
此文件保留供外部模块在过渡期使用 @check_live_secret 装饰器。
"""
import functools
import logging

from django.http import JsonResponse

from apps.i18n import get_text as _

logger = logging.getLogger("collab.decorators")


def check_live_secret(func):
    """
    验证 X-Live-Secret 头，确保请求来自 collab-live 服务。

    延迟读取 settings 避免模块加载时 Django 未就绪。
    """

    _DEFAULT_DEV_SECRET = "collab-live-dev-secret"

    @functools.wraps(func)
    def wrapper(request, *args, **kwargs):
        import hmac
        from django.conf import settings

        live_secret = getattr(settings, "COLLAB_LIVE_SECRET", "") or ""
        header = request.headers.get("X-Live-Secret", "")
        if not live_secret or not header:
            logger.warning("Missing live secret from %s", request.META.get("REMOTE_ADDR"))
            return JsonResponse(
                {"status": "error", "message": _("auth.unauthorized")},
                status=403,
            )
        if live_secret == _DEFAULT_DEV_SECRET and not settings.DEBUG:
            logger.warning(
                "Production request with default dev secret from %s",
                request.META.get("REMOTE_ADDR"),
            )
            return JsonResponse(
                {"status": "error", "message": _("auth.unauthorized")},
                status=403,
            )
        if not hmac.compare_digest(header.encode("utf-8"), live_secret.encode("utf-8")):
            logger.warning("Invalid live secret from %s", request.META.get("REMOTE_ADDR"))
            return JsonResponse(
                {"status": "error", "message": _("auth.unauthorized")},
                status=403,
            )
        return func(request, *args, **kwargs)

    return wrapper

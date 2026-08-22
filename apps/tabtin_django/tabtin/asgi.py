"""
ASGI config for tabtin project.
"""

import os
import sys
import signal
import faulthandler

from apps.services.startup_jobs import configure_utf8_standard_streams

configure_utf8_standard_streams()

faulthandler.enable()
if hasattr(faulthandler, "register") and hasattr(signal, "SIGUSR2"):
    faulthandler.register(signal.SIGUSR2, file=sys.stderr, all_threads=True)

from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')

# R5-03 修复：OTel SDK 启动必须在 get_asgi_application() 之前
# Django 业务模块 import 时会缓存 tracer 实例，过早调 setup 没用
from tabtin.otel_init import setup_otel  # noqa: E402
setup_otel()

# Sentry 错误监控：SENTRY_DSN 未配置时 no-op
from tabtin.sentry import init_sentry  # noqa: E402
init_sentry()

django_asgi_app = get_asgi_application()
configure_utf8_standard_streams()

from tabtin.urls_deferred import register_deferred_routers  # noqa: E402
from tabtin.middleware import DeferredRouterMiddleware  # noqa: E402

register_deferred_routers()
configure_utf8_standard_streams()
DeferredRouterMiddleware._registered = True

from tabtin.log_async import patch_handlers_to_async  # noqa: E402
patch_handlers_to_async()

from tabtin.routing import websocket_urlpatterns  # noqa: E402

application = ProtocolTypeRouter(
    {
        'http': django_asgi_app,
        'websocket': AuthMiddlewareStack(
            URLRouter(websocket_urlpatterns)
        ),
    }
)

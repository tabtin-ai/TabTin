"""
WSGI config for tabtin project.

It exposes the WSGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/4.2/howto/deployment/wsgi/
"""

import os

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
import apps.services.startup_timing  # noqa: E402,F401  — 在 django.setup() 前设置 _start_time

# R5-03 修复：OTel SDK 启动必须在 Django 业务模块 import 前
# 否则业务模块拿到的 tracer 还是 NoOp（已 cache 了 _tracer 实例）
from tabtin.otel_init import setup_otel  # noqa: E402
setup_otel()

# Sentry 错误监控：SENTRY_DSN 未配置时 no-op
from tabtin.sentry import init_sentry  # noqa: E402
init_sentry()

from django.core.wsgi import get_wsgi_application  # noqa: E402

application = get_wsgi_application()

from apps.services.startup_timing import log_startup_timing  # noqa: E402
log_startup_timing()

from tabtin.log_async import patch_handlers_to_async  # noqa: E402
patch_handlers_to_async()

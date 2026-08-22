"""
RB-014 / RB-015 回归测试

RB-014: JWT 重验间隔从 300s 降低到 60s，且可通过 settings 覆盖
RB-015: (collab-live 侧测试，见 permission-guard.test.ts)
"""
import os
import sys
from unittest.mock import patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


class TestJwtRecheckIntervalDefault:
    """RB-014: JWT_RECHECK_INTERVAL_SECONDS 默认值从 300 降至 60。"""

    def test_default_interval_is_60(self):
        """默认重验间隔应为 60 秒（而非旧的 300 秒）。"""
        from apps.services.common.ws import gateway
        assert gateway.JWT_RECHECK_INTERVAL_SECONDS == 60

    def test_interval_not_300(self):
        """确保旧的 5 分钟默认值已被替换。"""
        from apps.services.common.ws import gateway
        assert gateway.JWT_RECHECK_INTERVAL_SECONDS != 300

    def test_interval_used_in_heartbeat_check(self):
        """心跳方法引用 JWT_RECHECK_INTERVAL_SECONDS 常量。"""
        import inspect
        from apps.services.common.ws.gateway import GatewayConsumer
        source = inspect.getsource(GatewayConsumer._send_heartbeat)
        assert "JWT_RECHECK_INTERVAL_SECONDS" in source

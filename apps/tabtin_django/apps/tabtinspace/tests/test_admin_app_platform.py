"""Wave E — Admin App Platform API 测试。

测试 DeviceAppInstallSnapshot 模型 + CLI 审计查询 + Connect 管理查询。
使用 settings_app_platform_test（sqlite 独立环境，不依赖 tabtinspace AppConfig）。

由于 tabtinspace 的 ready() 依赖链很深（tabdata→oss 等），本测试直接测试
可以独立运行的子集（CliAuditEvent / Connect / ConnectAudit），以及 API 函数
的纯逻辑部分。DeviceAppInstallSnapshot 模型测试在主 settings 下通过 manage.py test 运行。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from django.test import TestCase


def _staff_request():
    return SimpleNamespace(
        auth=SimpleNamespace(
            id=uuid.uuid4(),
            is_staff=True,
            is_superuser=True,
        ),
        GET={},
    )


class CliAuditEventQueryTests(TestCase):
    """测试 CliAuditEvent 模型查询能力（使用 A2 已建立的模型）。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.services.agent_engine.cli.models import CliAuditEvent

        self.wt_id = uuid.uuid4()
        self.user_id = uuid.uuid4()

        CliAuditEvent.objects.create(
            organization_id=self.wt_id,
            user_id=self.user_id,
            binary="tabtin",
            inner_binary="demo-cli",
            domain="im",
            verb="send",
            risk_level="review",
            rule_decision="allow",
            hitl_required=True,
            hitl_user_decision="allow",
        )
        CliAuditEvent.objects.create(
            organization_id=self.wt_id,
            user_id=self.user_id,
            binary="tabtin",
            inner_binary=None,
            domain="table",
            verb="query",
            risk_level="safe",
            rule_decision="allow",
            hitl_required=False,
        )
        CliAuditEvent.objects.create(
            organization_id=self.wt_id,
            user_id=uuid.uuid4(),
            binary="some-third-party-cli",
            inner_binary=None,
            domain="im",
            verb="list",
            risk_level="safe",
            rule_decision="allow",
            hitl_required=False,
            bypass=True,
        )

    def test_filter_by_binary(self):
        from apps.services.agent_engine.cli.models import CliAuditEvent
        qs = CliAuditEvent.objects.filter(binary="tabtin")
        self.assertEqual(qs.count(), 2)

    def test_filter_by_risk_level(self):
        from apps.services.agent_engine.cli.models import CliAuditEvent
        qs = CliAuditEvent.objects.filter(risk_level="review")
        self.assertEqual(qs.count(), 1)
        self.assertEqual(qs.first().verb, "send")

    def test_filter_by_hitl_decision(self):
        from apps.services.agent_engine.cli.models import CliAuditEvent
        qs = CliAuditEvent.objects.filter(hitl_user_decision="allow")
        self.assertEqual(qs.count(), 1)

    def test_filter_by_domain(self):
        from apps.services.agent_engine.cli.models import CliAuditEvent
        qs = CliAuditEvent.objects.filter(domain="im")
        self.assertEqual(qs.count(), 2)

    def test_bypass_filter(self):
        from apps.services.agent_engine.cli.models import CliAuditEvent
        qs = CliAuditEvent.objects.filter(bypass=True)
        self.assertEqual(qs.count(), 1)
        self.assertEqual(qs.first().binary, "some-third-party-cli")

    def test_ordering_by_created_at(self):
        from apps.services.agent_engine.cli.models import CliAuditEvent
        events = list(CliAuditEvent.objects.order_by("-created_at"))
        self.assertEqual(len(events), 3)
        for i in range(len(events) - 1):
            self.assertGreaterEqual(events[i].created_at, events[i + 1].created_at)


# v3.1（2026-04-19）：ConnectQueryTests 整块删除
# 理由：Connect 模型整体作废（方向锚 H2）；AdminDash Connect 管理 API 已从
# admin_app_platform_api.py 删除。


class PaginationHelperTests(TestCase):
    """测试 admin_app_platform_api 中的 _build_pagination 辅助函数。"""

    def test_basic_pagination(self):
        from apps.tabtinspace.admin_app_platform_api import _build_pagination
        result = _build_pagination(total=100, page=1, page_size=20)
        self.assertEqual(result["total"], 100)
        self.assertEqual(result["page"], 1)
        self.assertEqual(result["total_pages"], 5)
        self.assertEqual(result["offset"], 0)

    def test_last_page(self):
        from apps.tabtinspace.admin_app_platform_api import _build_pagination
        result = _build_pagination(total=100, page=5, page_size=20)
        self.assertEqual(result["page"], 5)
        self.assertEqual(result["offset"], 80)

    def test_beyond_last_page(self):
        from apps.tabtinspace.admin_app_platform_api import _build_pagination
        result = _build_pagination(total=100, page=10, page_size=20)
        self.assertEqual(result["page"], 5)

    def test_empty(self):
        from apps.tabtinspace.admin_app_platform_api import _build_pagination
        result = _build_pagination(total=0, page=1, page_size=20)
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["total_pages"], 0)
        self.assertEqual(result["offset"], 0)

    def test_partial_last_page(self):
        from apps.tabtinspace.admin_app_platform_api import _build_pagination
        result = _build_pagination(total=25, page=2, page_size=20)
        self.assertEqual(result["total_pages"], 2)
        self.assertEqual(result["offset"], 20)


class UuidParserTests(TestCase):
    """测试 _try_parse_uuid 辅助函数。"""

    def test_valid_uuid(self):
        from apps.tabtinspace.admin_app_platform_api import _try_parse_uuid
        uid = uuid.uuid4()
        result = _try_parse_uuid(str(uid))
        self.assertEqual(result, uid)

    def test_empty_string(self):
        from apps.tabtinspace.admin_app_platform_api import _try_parse_uuid
        self.assertIsNone(_try_parse_uuid(""))

    def test_invalid_string(self):
        from apps.tabtinspace.admin_app_platform_api import _try_parse_uuid
        self.assertIsNone(_try_parse_uuid("not-a-uuid"))

    def test_whitespace(self):
        from apps.tabtinspace.admin_app_platform_api import _try_parse_uuid
        self.assertIsNone(_try_parse_uuid("  "))

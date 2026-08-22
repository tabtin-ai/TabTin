"""暂停 / 只读 / 禁资源写入时，TabData 创建表格应被组织强控拦截。"""
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata.services.table_service import TableService
from apps.tabtinspace.models import (
    Agent,
    Organization,
    OrganizationControlPolicy,
    OrganizationMember,
    Space,
    SpaceMembership,
)
from apps.tabtinspace.services.organization_control_guard import (
    ORGANIZATION_SUSPENDED,
    OrganizationControlBlockedError,
)

User = get_user_model()

_QUOTA_PATCH = patch(
    "apps.tabdata.services.table_service.QuotaService",
    MagicMock(return_value=MagicMock(check_quota=MagicMock())),
)
_NATIVE_ENSURE_TABLE_PATCH = patch(
    "apps.tabdata.services.table_service.TableService._native_ensure_table",
    return_value=None,
)


class OrganizationControlCreateTableTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        for p in (_QUOTA_PATCH, _NATIVE_ENSURE_TABLE_PATCH):
            p.start()
            self.addCleanup(p.stop)

        self.user = User.objects.create_user(
            username="org-control-table-user",
            email="org-control-table@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="强控测试组织",
            owner_id=str(self.user.id),
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.user.id),
            role="owner",
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="强控测试 Space",
        )
        self.agent, _ = Agent.objects.get_or_create(
            organization=self.organization,
            user=self.user,
            defaults={
                "name": "强控测试 Agent",
                "type": "human",
                "is_active": True,
            },
        )
        SpaceMembership.objects.update_or_create(
            workspace=self.space,
            agent=self.agent,
            defaults={"role": "owner", "is_active": True},
        )
        self.table_svc = TableService(user=self.user)

    def test_create_table_blocked_when_organization_suspended(self):
        OrganizationControlPolicy.objects.create(
            organization=self.organization,
            is_suspended=True,
        )

        with self.assertRaises(OrganizationControlBlockedError) as ctx:
            self.table_svc.create_table(
                space_id=self.space.id,
                name="不应创建成功",
                use_default_fields=False,
            )

        self.assertEqual(ctx.exception.code, ORGANIZATION_SUSPENDED)

    def test_create_table_allowed_without_control_policy(self):
        table = self.table_svc.create_table(
            space_id=self.space.id,
            name="可正常创建",
            use_default_fields=False,
        )
        self.assertIsNotNone(table)
        self.assertEqual(table.name, "可正常创建")

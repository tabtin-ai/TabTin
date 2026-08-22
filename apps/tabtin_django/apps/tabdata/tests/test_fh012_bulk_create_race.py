"""
FH-012 回归测试：bulk_create_fields 字段名重复校验竞态修复

验证 bulk_create_fields 在查询现有字段名之前锁定 Table 行（select_for_update），
防止并发请求绕过应用层字段名重复校验。
"""

import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField
from apps.tabdata.services.table_service import TableService
from apps.tabdata.tests.test_permissions import _ensure_free_tier
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


def _setup_membership(organization, space, user, role="owner"):
    agent, _ = Agent.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"name": user.get_display_name(), "type": "human", "is_active": True},
    )
    SpaceMembership.objects.update_or_create(
        workspace=space,
        agent=agent,
        defaults={"role": role, "is_active": True},
    )


class FH012BulkCreateFieldsRaceTests(TestCase):
    """FH-012: bulk_create_fields 字段名重复校验必须在 Table 行锁内执行。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        _ensure_free_tier()
        self.user = User.objects.create_user(
            username=f"fh012_{uuid.uuid4().hex[:6]}",
            email=f"fh012_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(name="fh012-ws", owner=self.user)
        self.space = Space.objects.create(organization=self.organization, name="fh012-space")
        _setup_membership(self.organization, self.space, self.user, "owner")
        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="fh012-table",
            owner=self.user,
        )

    def _make_service(self):
        return TableService(user=self.user)

    @patch.object(TableService, "_native_add_column")
    @patch.object(TableService, "_publish_field_event")
    def test_sequential_calls_reject_duplicate_names(self, _pub, _nat):
        """两次连续调用 bulk_create_fields 不应创建同名字段。

        ：同名同类型的重试是幂等 skip（不再报错），
        但不得重复创建字段。
        """
        svc = self._make_service()
        fields_data = [{"name": "字段A", "field_type": "text"}]

        created1, errors1, skipped1 = svc.bulk_create_fields(self.table.id, fields_data)
        self.assertEqual(len(created1), 1)
        self.assertEqual(len(errors1), 0)
        self.assertEqual(len(skipped1), 0)

        created2, errors2, skipped2 = svc.bulk_create_fields(self.table.id, fields_data)
        self.assertEqual(len(created2), 0)
        self.assertEqual(len(errors2), 0)
        self.assertEqual(skipped2, [{"name": "字段A", "field_type": "text"}])
        self.assertEqual(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=self.table.id, name="字段A", is_deleted=False,
            ).count(),
            1,
        )

    @patch.object(TableService, "_native_add_column")
    @patch.object(TableService, "_publish_field_event")
    def test_same_name_different_type_still_errors(self, _pub, _nat):
        """：同名不同类型不允许幂等 skip——调用方会误信字段类型。"""
        svc = self._make_service()
        created1, errors1, _sk1 = svc.bulk_create_fields(
            self.table.id, [{"name": "字段B", "field_type": "text"}]
        )
        self.assertEqual(len(created1), 1)

        created2, errors2, skipped2 = svc.bulk_create_fields(
            self.table.id, [{"name": "字段B", "field_type": "url"}]
        )
        self.assertEqual(len(created2), 0)
        self.assertEqual(len(skipped2), 0)
        self.assertTrue(any("类型不同" in e for e in errors2))

    @patch.object(TableService, "_native_add_column")
    @patch.object(TableService, "_publish_field_event")
    def test_nonexistent_table_returns_not_found_error(self, _pub, _nat):
        """Table 不存在时，bulk_create_fields 应返回 '表格不存在' 错误。"""
        svc = self._make_service()
        fake_id = uuid.uuid4()
        with patch.object(svc, "check_table_permission", return_value=True):
            created, errors, _skipped = svc.bulk_create_fields(
                fake_id, [{"name": "X", "field_type": "text"}]
            )
        self.assertEqual(len(created), 0)
        self.assertTrue(any("不存在" in e for e in errors))

    @patch.object(TableService, "_native_add_column")
    @patch.object(TableService, "_publish_field_event")
    def test_preexisting_field_rejected_at_app_layer(self, _pub, _nat):
        """已有字段名在应用层就被拒绝，不依赖 DB 唯一约束。"""
        TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, name="已有字段", field_type="text", order=0,
        )
        svc = self._make_service()
        created, errors, _skipped = svc.bulk_create_fields(
            self.table.id, [{"name": "已有字段", "field_type": "number"}]
        )
        self.assertEqual(len(created), 0)
        self.assertTrue(any("已存在" in e for e in errors))

    @patch.object(TableService, "_native_add_column")
    @patch.object(TableService, "_publish_field_event")
    def test_select_for_update_is_called(self, _pub, _nat):
        """验证 bulk_create_fields 在查询字段名之前确实调用了 select_for_update。

        通过 mock Table.objects 的 QuerySet 链来检测 select_for_update 被调用。
        """
        svc = self._make_service()
        call_order = []
        original_get = Table.objects.using(TABDATA_DB_ALIAS).select_for_update().__class__.get

        from django.db.models import QuerySet

        _original_select_for_update = QuerySet.select_for_update
        _original_filter = QuerySet.filter

        def tracking_select_for_update(self_qs, *args, **kwargs):
            if self_qs.model is Table:
                call_order.append("select_for_update")
            return _original_select_for_update(self_qs, *args, **kwargs)

        def tracking_filter(self_qs, *args, **kwargs):
            if self_qs.model is TableField and kwargs.get("is_deleted") is False:
                call_order.append("field_query")
            return _original_filter(self_qs, *args, **kwargs)

        with patch.object(QuerySet, "select_for_update", tracking_select_for_update):
            with patch.object(QuerySet, "filter", tracking_filter):
                svc.bulk_create_fields(
                    self.table.id,
                    [{"name": "追踪字段", "field_type": "text"}],
                )

        sfu_idx = next(
            (i for i, v in enumerate(call_order) if v == "select_for_update"), None
        )
        field_idx = next(
            (i for i, v in enumerate(call_order) if v == "field_query"), None
        )
        self.assertIsNotNone(sfu_idx, "select_for_update 应被调用")
        self.assertIsNotNone(field_idx, "字段查询应被调用")
        self.assertLess(
            sfu_idx, field_idx,
            "select_for_update 必须在字段名查询之前调用",
        )

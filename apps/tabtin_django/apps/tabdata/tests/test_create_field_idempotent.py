"""create_field 同名同类型幂等。

超时后客户端重试不应再报「字段已存在」；同名不同类型仍拒绝。
"""

from __future__ import annotations

import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField
from apps.tabdata.services.table_service import TableService
from apps.tabdata.tests.test_permissions import (
    _create_workspace,
    _ensure_free_tier,
    _ensure_project_membership,
)
from apps.tabtinspace.models import Organization
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class CreateFieldIdempotentTests(TestCase):
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
            username=f"cf6754_{uuid.uuid4().hex[:6]}",
            email=f"cf6754_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(name="cf6754-ws", owner=self.user)
        self.space = _create_workspace(self.organization, self.user, "cf6754-space")
        _ensure_project_membership(self.organization, self.space, self.user, "owner")
        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="cf6754-table",
            owner=self.user,
        )

    def _svc(self) -> TableService:
        return TableService(user=self.user)

    @patch.object(TableService, "_native_add_column")
    @patch.object(TableService, "_publish_field_event")
    @patch.object(TableService, "_trigger_field_version_history")
    def test_same_name_same_type_retry_returns_existing(self, _hist, _pub, _nat):
        svc = self._svc()
        first = svc.create_field(self.table.id, "状态", "text")
        self.assertIsNotNone(first)

        second = svc.create_field(self.table.id, "状态", "text")
        self.assertIsNotNone(second)
        self.assertEqual(first.id, second.id)
        self.assertEqual(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=self.table.id, name="状态", is_deleted=False,
            ).count(),
            1,
        )

    @patch.object(TableService, "_native_add_column")
    @patch.object(TableService, "_publish_field_event")
    @patch.object(TableService, "_trigger_field_version_history")
    def test_same_name_different_type_still_errors(self, _hist, _pub, _nat):
        svc = self._svc()
        first = svc.create_field(self.table.id, "状态", "text")
        self.assertIsNotNone(first)

        with self.assertRaises(ValueError) as ctx:
            svc.create_field(self.table.id, "状态", "number")
        self.assertIn("已存在", str(ctx.exception))

    @patch.object(TableService, "_native_add_column")
    @patch.object(TableService, "_publish_field_event")
    @patch.object(TableService, "_trigger_field_version_history")
    def test_idempotent_reuse_ignores_requested_field_id(self, _hist, _pub, _nat):
        """collab persist 带不同 field_id 时，同名同类型应复用已有行。"""
        svc = self._svc()
        first = svc.create_field(self.table.id, "data", "text")
        self.assertIsNotNone(first)

        other_id = uuid.uuid4()
        reused = svc.create_field(
            self.table.id,
            "data",
            "text",
            field_id=other_id,
            skip_permission_check=True,
        )
        self.assertEqual(reused.id, first.id)
        self.assertNotEqual(reused.id, other_id)

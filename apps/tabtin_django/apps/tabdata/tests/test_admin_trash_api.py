from types import SimpleNamespace
import uuid
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata import admin_api
from apps.tabdata.admin_schemas import AdminTableBatchMutationRequestSchema
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table


class AdminTableTrashApiTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        User = get_user_model()
        self.staff_user = User.objects.create_user(
            username="table_trash_admin",
            email="table_trash_admin@test.com",
            password="pass123",
            is_staff=True,
        )
        self.organization_id = uuid.uuid4()
        self.space_id = uuid.uuid4()
        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            name="待逻辑删除表",
            organization_id=self.organization_id,
            space_id=self.space_id,
            owner=self.staff_user,
            visibility="normal",
            is_archived=False,
        )
        self.request = SimpleNamespace(auth=self.staff_user, META={}, headers={})

    def _payload(self, table_id=None):
        return AdminTableBatchMutationRequestSchema(
            table_ids=[str(table_id or self.table.id)],
            dry_run=False,
            reason="admin table trash test",
        )

    @patch("apps.tabdata.admin_api.TableService")
    @patch("apps.tabdata.admin_api.ResourceBridge")
    @patch("apps.tabdata.admin_api.bump_table_schema_version_token")
    @patch("apps.tabdata.admin_api.QuotaService")
    def test_batch_trash_and_untrash_table(
        self,
        quota_service_cls,
        bump_token,
        bridge,
        table_service_cls,
    ):
        table_service_cls.return_value._native_ensure_table = MagicMock()
        quota_service_cls.return_value.check_quota = MagicMock()

        trash_response = admin_api.batch_trash_tables(self.request, self._payload())

        self.assertEqual(trash_response.updated_count, 1)
        self.table.refresh_from_db()
        self.assertIsNotNone(self.table.trashed_at)
        bridge.on_trash.assert_called()
        bump_token.assert_called()

        untrash_response = admin_api.batch_untrash_tables(self.request, self._payload())

        self.assertEqual(untrash_response.updated_count, 1)
        self.table.refresh_from_db()
        self.assertIsNone(self.table.trashed_at)
        bridge.on_restore.assert_called()
        table_service_cls.return_value._native_ensure_table.assert_called()

    @patch("apps.tabdata.admin_api.ResourceBridge")
    @patch("apps.tabdata.admin_api.bump_table_schema_version_token")
    def test_archive_restore_skips_trashed_table(self, bump_token, bridge):
        admin_api.batch_trash_tables(self.request, self._payload())

        response = admin_api.batch_restore_tables(self.request, self._payload())

        self.assertEqual(response.updated_count, 0)
        self.assertEqual(response.skipped[0].reason, "表格在回收站中，请先使用回收站恢复")
        self.table.refresh_from_db()
        self.assertIsNotNone(self.table.trashed_at)
        bridge.on_restore.assert_not_called()

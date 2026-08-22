"""#5897：增量导入行序沉顶 + CSV→JSON 后再删撞乐观锁。

覆盖：
1. upsert 推送附带 after_record_id（锚点=既有末行），collab 走 order.after
2. 增量 update 同步 native __version，避免 bulk-delete 撞锁

运行：
    cd apps/tabtin_django
    USE_SQLITE_FOR_TESTS=0 DJANGO_SETTINGS_MODULE=tabtin.settings \\
      python -m pytest apps/tabdata/tests/test_5897_incremental_import_order_delete.py -v
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.collab_service import CollabService
from apps.tabdata.services.import_service import ImportService
from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc
from apps.tabtinspace.models import Organization, OrganizationMember, Project

User = get_user_model()


class IncrementalImportOrderDeleteTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="u5897",
            email="u5897@example.com",
            password="pw123456",
        )
        self.organization = Organization.objects.create(name="Org5897", owner=self.user)
        OrganizationMember.objects.create(
            organization=self.organization, user=self.user, role="owner",
        )
        # ：Space 表已 DROP；Table.space_id 挂 Project.id
        self.project = Project.objects.create(
            name="SP5897",
            organization=self.organization,
        )
        self.table = Table.objects.create(
            space_id=self.project.id,
            organization_id=self.organization.id,
            name="T5897",
            owner=self.user,
        )
        self.field = TableField.objects.create(
            table=self.table,
            name="任务",
            field_type="text",
            is_primary=True,
            order=0,
        )

    def test_upsert_after_existing_tail_uses_order_after(self):
        existing = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={str(self.field.id): "旧行"},
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            version=1,
            order=1024.0,
        )
        imported = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={str(self.field.id): "示例文本1"},
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            version=2,
            order=1025.0,
        )

        captured = {}

        def _capture(**kwargs):
            captured["changes"] = kwargs.get("changes")

        with patch(
            "apps.tabdata.services.collab_service.CollabService.push_cells",
            side_effect=_capture,
        ):
            with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=True):
                sync_records_to_ydoc(
                    self.table.id,
                    [imported],
                    None,
                    upsert_record_ids=[str(imported.id)],
                    source="import_service",
                )

        changes = captured.get("changes")
        self.assertIsNotNone(changes)
        upsert = changes[0]
        self.assertEqual(upsert["type"], "upsert_record")
        self.assertEqual(upsert["after_record_id"], str(existing.id))

        ops = CollabService.table_changes_to_apply_ops(changes)
        order_ops = [op for op in ops if op["op"].startswith("order.")]
        self.assertEqual(len(order_ops), 1)
        self.assertEqual(order_ops[0]["op"], "order.after")
        self.assertEqual(order_ops[0]["after_key"], str(existing.id))

    def test_import_update_syncs_native_version(self):
        rec = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={str(self.field.id): "示例文本1"},
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            version=3,
            order=1.0,
        )
        mock_io = MagicMock()
        with (
            patch(
                "apps.tabdata.native.record_io.NativeRecordIO",
                return_value=mock_io,
            ),
            patch(
                "apps.tabdata.native.ddl_manager.resolve_schema_partition_id",
                return_value=self.project.id,
            ),
        ):
            ImportService._sync_import_to_native(
                self.table.id,
                {"任务": self.field},
                records_to_create=[],
                records_to_update=[rec],
            )

        mock_io.bulk_update_records.assert_called_once()
        rows = mock_io.bulk_update_records.call_args[0][0]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["__id"], rec.id)
        self.assertEqual(rows[0]["__version"], 3)
        self.assertEqual(rows[0][self.field.id.hex], "示例文本1")

    def test_csv_then_json_incremental_bumps_orm_version(self):
        """CSV 建行 → 同主键 JSON 增量更新应 bump ORM version（供 native 对齐）。"""
        service = ImportService(user=self.user)
        csv_content = "任务\n示例文本1\n示例文本2\n"
        created, updated, errors = service.import_from_csv(
            table_id=self.table.id,
            file_content=csv_content,
            skip_errors=False,
        )
        self.assertEqual(errors, [])
        self.assertEqual(created, 2)
        self.assertEqual(updated, 0)

        before = {
            str(r.id): r.version
            for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table=self.table, is_deleted=False,
            )
        }
        self.assertEqual(len(before), 2)

        json_content = (
            '[{"任务":"示例文本1"},{"任务":"示例文本2"}]'
        )
        created, updated, errors = service.import_from_json(
            table_id=self.table.id,
            json_content=json_content,
            skip_errors=False,
            update_existing=True,
            primary_key_field="任务",
        )
        self.assertEqual(errors, [])
        self.assertEqual(created, 0)
        self.assertEqual(updated, 2)

        after = {
            str(r.id): r.version
            for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table=self.table, is_deleted=False,
            )
        }
        for rid, old_ver in before.items():
            self.assertGreater(after[rid], old_ver, msg=f"record {rid} version not bumped")

"""
MB-01 迁移命令测试：TableNamedVersion → VersionHistory

测试覆盖:
1. 基本迁移：TableNamedVersion 正确映射到 VersionHistory 字段
2. 幂等性：重复运行不创建重复记录
3. dry-run 模式：不写入数据
4. 异常处理：单条失败不中断整体
5. 空表场景：无记录时正常完成
6. deprecated API 端点：_vh_to_named_version_dict 转换逻辑

注意：使用 mock 避免 django_db，因为 billing app 的 migration 存在
pre-existing schema 问题（BillingAnomalyAlert.workspace_id 缺失）。
"""
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import uuid  # noqa: E402
from datetime import datetime  # noqa: E402
from unittest import TestCase  # noqa: E402
from unittest.mock import MagicMock, call, patch  # noqa: E402

from django.utils import timezone  # noqa: E402


DB = "postgresql"
CMD_MODULE = "apps.tabdata.management.commands.migrate_named_versions"
TNV_MODEL = "apps.tabdata.models.TableNamedVersion"
VH_MODEL = "apps.collab.models.VersionHistory"


def _fake_nv(*, table_id=None, organization_id=None, name="v1", history_id=None,
             created_by_id=None, snapshot_at=None, created_at=None):
    nv = MagicMock()
    nv.id = uuid.uuid4()
    nv.table_id = table_id or uuid.uuid4()
    nv.organization_id = organization_id or uuid.uuid4()
    nv.history_id = history_id or uuid.uuid4()
    nv.name = name
    nv.created_by_id = created_by_id
    nv.snapshot_at = snapshot_at or timezone.now()
    nv.created_at = created_at or timezone.now()
    return nv


# ── Test: 基本迁移 ──────────────────────────────────


class TestMigrateNamedVersionsBasic(TestCase):

    @patch(f"{CMD_MODULE}._build_table_blob", return_value=b"fake_blob")
    @patch(VH_MODEL)
    @patch(TNV_MODEL)
    def test_migrate_creates_vh_record(self, mock_tnv_cls, mock_vh_cls, mock_blob):
        """每条 TableNamedVersion 应生成对应的 VersionHistory。"""
        table_id = uuid.uuid4()
        organization_id = uuid.uuid4()
        nv = _fake_nv(table_id=table_id, organization_id=organization_id, name="测试版本")

        mock_qs = MagicMock()
        mock_qs.select_related.return_value = mock_qs
        mock_qs.order_by.return_value = mock_qs
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([nv])
        mock_tnv_cls.objects.using.return_value = mock_qs

        mock_vh_qs = MagicMock()
        mock_vh_qs.filter.return_value = mock_vh_qs
        mock_vh_qs.exists.return_value = False
        mock_vh_cls.objects.using.return_value = mock_vh_qs

        mock_created_vh = MagicMock()
        mock_created_vh.id = uuid.uuid4()
        mock_vh_qs.create.return_value = mock_created_vh

        from apps.tabdata.management.commands.migrate_named_versions import (
            migrate_named_versions,
        )

        result = migrate_named_versions(dry_run=False, batch_size=100)

        self.assertEqual(result["migrated"], 1)
        self.assertEqual(result["failed"], 0)

        create_kwargs = mock_vh_qs.create.call_args[1]
        self.assertEqual(create_kwargs["resource_type"], "table")
        self.assertEqual(create_kwargs["resource_id"], table_id)
        self.assertEqual(create_kwargs["organization_id"], organization_id)
        self.assertTrue(create_kwargs["is_named"])
        self.assertEqual(create_kwargs["name"], "测试版本")
        self.assertTrue(create_kwargs["is_snapshot"])
        self.assertIsNone(create_kwargs["expired_at"])
        self.assertEqual(create_kwargs["blob"], b"fake_blob")
        self.assertEqual(create_kwargs["metadata"]["legacy_id"], str(nv.id))
        self.assertEqual(create_kwargs["metadata"]["legacy_model"], "TableNamedVersion")

    @patch(f"{CMD_MODULE}._build_table_blob", return_value=b"blob")
    @patch(VH_MODEL)
    @patch(TNV_MODEL)
    def test_migrate_idempotent(self, mock_tnv_cls, mock_vh_cls, mock_blob):
        """已存在的记录应被跳过（幂等）。"""
        nv = _fake_nv(name="幂等测试")

        mock_qs = MagicMock()
        mock_qs.select_related.return_value = mock_qs
        mock_qs.order_by.return_value = mock_qs
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([nv])
        mock_tnv_cls.objects.using.return_value = mock_qs

        mock_vh_qs = MagicMock()
        mock_vh_qs.filter.return_value = mock_vh_qs
        mock_vh_qs.exists.return_value = True
        mock_vh_cls.objects.using.return_value = mock_vh_qs

        from apps.tabdata.management.commands.migrate_named_versions import (
            migrate_named_versions,
        )

        result = migrate_named_versions(dry_run=False, batch_size=100)

        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["migrated"], 0)
        mock_vh_qs.create.assert_not_called()

    @patch(VH_MODEL)
    @patch(TNV_MODEL)
    def test_dry_run_no_writes(self, mock_tnv_cls, mock_vh_cls):
        """dry-run 模式不写入数据。"""
        nv = _fake_nv(name="dry-run 测试")

        mock_qs = MagicMock()
        mock_qs.select_related.return_value = mock_qs
        mock_qs.order_by.return_value = mock_qs
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([nv])
        mock_tnv_cls.objects.using.return_value = mock_qs

        mock_vh_qs = MagicMock()
        mock_vh_qs.filter.return_value = mock_vh_qs
        mock_vh_qs.exists.return_value = False
        mock_vh_cls.objects.using.return_value = mock_vh_qs

        from apps.tabdata.management.commands.migrate_named_versions import (
            migrate_named_versions,
        )

        result = migrate_named_versions(dry_run=True, batch_size=100)

        self.assertEqual(result["migrated"], 1)
        mock_vh_qs.create.assert_not_called()


# ── Test: 边界情况 ──────────────────────────────────


class TestMigrateNamedVersionsEdgeCases(TestCase):

    @patch(VH_MODEL)
    @patch(TNV_MODEL)
    def test_empty_table(self, mock_tnv_cls, mock_vh_cls):
        """无 TableNamedVersion 记录时正常完成。"""
        mock_qs = MagicMock()
        mock_qs.select_related.return_value = mock_qs
        mock_qs.order_by.return_value = mock_qs
        mock_qs.count.return_value = 0
        mock_qs.iterator.return_value = iter([])
        mock_tnv_cls.objects.using.return_value = mock_qs

        from apps.tabdata.management.commands.migrate_named_versions import (
            migrate_named_versions,
        )

        result = migrate_named_versions(dry_run=True, batch_size=100)
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["failed"], 0)

    @patch(f"{CMD_MODULE}._build_table_blob", return_value=b"")
    @patch(VH_MODEL)
    @patch(TNV_MODEL)
    def test_blob_build_failure_handled(self, mock_tnv_cls, mock_vh_cls, mock_blob):
        """blob 构建失败时（空 bytes）仍创建 VH 记录，blob_size 为 0。"""
        nv = _fake_nv(name="blob 失败测试")

        mock_qs = MagicMock()
        mock_qs.select_related.return_value = mock_qs
        mock_qs.order_by.return_value = mock_qs
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([nv])
        mock_tnv_cls.objects.using.return_value = mock_qs

        mock_vh_qs = MagicMock()
        mock_vh_qs.filter.return_value = mock_vh_qs
        mock_vh_qs.exists.return_value = False
        mock_vh_cls.objects.using.return_value = mock_vh_qs

        mock_created_vh = MagicMock()
        mock_created_vh.id = uuid.uuid4()
        mock_vh_qs.create.return_value = mock_created_vh

        from apps.tabdata.management.commands.migrate_named_versions import (
            migrate_named_versions,
        )

        result = migrate_named_versions(dry_run=False, batch_size=100)

        self.assertEqual(result["migrated"], 1)
        create_kwargs = mock_vh_qs.create.call_args[1]
        self.assertEqual(create_kwargs["blob"], b"")
        self.assertEqual(create_kwargs["blob_size"], 0)

    @patch(f"{CMD_MODULE}._build_table_blob", return_value=b"data")
    @patch(VH_MODEL)
    @patch(TNV_MODEL)
    def test_metadata_fields_preserved(self, mock_tnv_cls, mock_vh_cls, mock_blob):
        """snapshot_at 和 legacy_history_id 正确写入 metadata。"""
        history_id = uuid.uuid4()
        nv = _fake_nv(name="元数据测试", history_id=history_id)

        mock_qs = MagicMock()
        mock_qs.select_related.return_value = mock_qs
        mock_qs.order_by.return_value = mock_qs
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([nv])
        mock_tnv_cls.objects.using.return_value = mock_qs

        mock_vh_qs = MagicMock()
        mock_vh_qs.filter.return_value = mock_vh_qs
        mock_vh_qs.exists.return_value = False
        mock_vh_cls.objects.using.return_value = mock_vh_qs

        mock_created_vh = MagicMock()
        mock_created_vh.id = uuid.uuid4()
        mock_vh_qs.create.return_value = mock_created_vh

        from apps.tabdata.management.commands.migrate_named_versions import (
            migrate_named_versions,
        )

        migrate_named_versions(dry_run=False, batch_size=100)

        create_kwargs = mock_vh_qs.create.call_args[1]
        self.assertEqual(create_kwargs["metadata"]["legacy_history_id"], str(history_id))
        self.assertIsNotNone(create_kwargs["metadata"]["snapshot_at"])

    @patch(f"{CMD_MODULE}._build_table_blob", side_effect=Exception("DB error"))
    @patch(VH_MODEL)
    @patch(TNV_MODEL)
    def test_single_failure_doesnt_break_batch(self, mock_tnv_cls, mock_vh_cls, mock_blob):
        """单条失败不中断整体迁移。"""
        nv = _fake_nv(name="异常测试")

        mock_qs = MagicMock()
        mock_qs.select_related.return_value = mock_qs
        mock_qs.order_by.return_value = mock_qs
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([nv])
        mock_tnv_cls.objects.using.return_value = mock_qs

        mock_vh_qs = MagicMock()
        mock_vh_qs.filter.return_value = mock_vh_qs
        mock_vh_qs.exists.return_value = False
        mock_vh_cls.objects.using.return_value = mock_vh_qs

        from apps.tabdata.management.commands.migrate_named_versions import (
            migrate_named_versions,
        )

        result = migrate_named_versions(dry_run=False, batch_size=100)

        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["migrated"], 0)


# ── Test: Deprecated API 端点 ──────────────────────────────


class TestDeprecatedNamedVersionAPI(TestCase):

    def test_vh_to_named_version_dict_from_orm(self):
        """_vh_to_named_version_dict 能正确转换 VH ORM 对象。"""
        from apps.tabdata.api_undo_redo import _vh_to_named_version_dict

        table_id = uuid.uuid4()
        vh = MagicMock()
        vh.id = uuid.uuid4()
        vh.resource_id = table_id
        vh.blob = b"data"
        vh.blob_size = 4
        vh.name = "API 测试版本"
        vh.editor_id = "user-123"
        vh.created_at = timezone.now()
        vh.metadata = {
            "legacy_history_id": "hist-456",
            "snapshot_at": "2026-03-20T12:00:00Z",
        }

        result = _vh_to_named_version_dict(vh)
        self.assertEqual(result["id"], str(vh.id))
        self.assertEqual(result["table_id"], str(table_id))
        self.assertEqual(result["name"], "API 测试版本")
        self.assertEqual(result["history_id"], "hist-456")
        self.assertEqual(result["snapshot_at"], "2026-03-20T12:00:00Z")
        self.assertEqual(result["created_by"], "user-123")
        self.assertTrue(result["history_valid"])

    def test_vh_to_named_version_dict_from_dict(self):
        """_vh_to_named_version_dict 能处理 dict 输入。"""
        from apps.tabdata.api_undo_redo import _vh_to_named_version_dict

        result = _vh_to_named_version_dict({
            "id": "abc-123",
            "name": "Dict 版本",
            "created_at": "2026-03-20T12:00:00Z",
            "editor_id": "u-1",
        })
        self.assertEqual(result["id"], "abc-123")
        self.assertEqual(result["name"], "Dict 版本")
        self.assertEqual(result["created_by"], "u-1")

    def test_vh_to_named_version_dict_no_legacy(self):
        """无 legacy_history_id 的新建 VH 命名版本，history_valid 始终为 True。"""
        from apps.tabdata.api_undo_redo import _vh_to_named_version_dict

        vh = MagicMock()
        vh.id = uuid.uuid4()
        vh.resource_id = uuid.uuid4()
        vh.blob = b""
        vh.blob_size = 0
        vh.name = "新版本"
        vh.editor_id = "user-1"
        vh.created_at = timezone.now()
        vh.metadata = {}

        result = _vh_to_named_version_dict(vh)
        self.assertTrue(result["history_valid"])
        self.assertIsNone(result["history_id"])

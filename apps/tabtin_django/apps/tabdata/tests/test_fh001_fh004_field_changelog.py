"""
FH-001 / FH-004 回归测试

FH-004: collab/constants.py 应包含字段级 change_type 枚举
FH-001: 字段 CRUD 应触发 VersionHistory + ChangeLog 写入
"""
import os
import uuid
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ══════════════════════════════════════════════════════════
# FH-004: 字段级 change_type 常量
# ══════════════════════════════════════════════════════════

class TestFieldChangeTypeConstants:
    """验证 collab/constants.py 中包含字段级 change_type 枚举。"""

    def test_field_change_types_exist(self):
        from apps.collab.constants import (
            CHANGE_TYPE_CREATE_FIELD,
            CHANGE_TYPE_UPDATE_FIELD,
            CHANGE_TYPE_DELETE_FIELD,
            CHANGE_TYPE_CONVERT_FIELD,
            CHANGE_TYPE_REORDER_FIELDS,
        )
        assert CHANGE_TYPE_CREATE_FIELD == "create_field"
        assert CHANGE_TYPE_UPDATE_FIELD == "update_field"
        assert CHANGE_TYPE_DELETE_FIELD == "delete_field"
        assert CHANGE_TYPE_CONVERT_FIELD == "convert_field"
        assert CHANGE_TYPE_REORDER_FIELDS == "reorder_fields"

    def test_field_change_types_fit_model_max_length(self):
        """所有字段级 change_type 值不超过 ChangeLog.change_type 的 max_length=20。"""
        from apps.collab.constants import (
            CHANGE_TYPE_CREATE_FIELD,
            CHANGE_TYPE_UPDATE_FIELD,
            CHANGE_TYPE_DELETE_FIELD,
            CHANGE_TYPE_CONVERT_FIELD,
            CHANGE_TYPE_REORDER_FIELDS,
        )
        max_len = 20
        for ct in [
            CHANGE_TYPE_CREATE_FIELD,
            CHANGE_TYPE_UPDATE_FIELD,
            CHANGE_TYPE_DELETE_FIELD,
            CHANGE_TYPE_CONVERT_FIELD,
            CHANGE_TYPE_REORDER_FIELDS,
        ]:
            assert len(ct) <= max_len, f"{ct!r} exceeds max_length={max_len}"

    def test_field_change_types_distinct_from_generic(self):
        """字段级类型不应与通用 create/update/delete/restore 冲突。"""
        from apps.collab.constants import (
            CHANGE_TYPE_CREATE, CHANGE_TYPE_UPDATE,
            CHANGE_TYPE_DELETE, CHANGE_TYPE_RESTORE,
            CHANGE_TYPE_CREATE_FIELD, CHANGE_TYPE_UPDATE_FIELD,
            CHANGE_TYPE_DELETE_FIELD, CHANGE_TYPE_CONVERT_FIELD,
            CHANGE_TYPE_REORDER_FIELDS,
        )
        generic = {CHANGE_TYPE_CREATE, CHANGE_TYPE_UPDATE, CHANGE_TYPE_DELETE, CHANGE_TYPE_RESTORE}
        field_level = {
            CHANGE_TYPE_CREATE_FIELD, CHANGE_TYPE_UPDATE_FIELD,
            CHANGE_TYPE_DELETE_FIELD, CHANGE_TYPE_CONVERT_FIELD,
            CHANGE_TYPE_REORDER_FIELDS,
        }
        assert generic.isdisjoint(field_level)


# ══════════════════════════════════════════════════════════
# FH-001: _trigger_field_version_history 同时写入 ChangeLog
# ══════════════════════════════════════════════════════════

class TestFieldHistoryWritesChangeLog:
    """验证 _trigger_field_version_history 在写入 VersionHistory 的同时创建 ChangeLog。"""

    def _make_service(self):
        from apps.tabdata.services.table_service import TableService
        svc = TableService.__new__(TableService)
        svc.user = MagicMock(id=uuid.uuid4())
        return svc

    def _make_adapter_and_svc(self, table_id):
        mock_adapter = MagicMock()
        mock_resource = MagicMock()
        mock_resource.id = table_id
        mock_resource.organization_id = uuid.uuid4()
        mock_adapter.get_resource.return_value = mock_resource
        mock_adapter.get_version_data.return_value = {"fields": [], "records": {}}

        mock_vh_svc = MagicMock()
        mock_vh = MagicMock()
        mock_vh_svc.create_history.return_value = mock_vh
        return mock_adapter, mock_vh_svc, mock_vh

    def test_changelog_created_with_field_change_type(self):
        """ChangeLog 应使用字段级 change_type（如 create_field）而非通用 update。"""
        from apps.collab.constants import CHANGE_TYPE_CREATE_FIELD

        svc = self._make_service()
        table_id = uuid.uuid4()
        mock_adapter, mock_vh_svc, mock_vh = self._make_adapter_and_svc(table_id)

        mock_cl_using = MagicMock()
        mock_cl_manager = MagicMock()
        mock_cl_using.return_value = mock_cl_manager

        with patch(
            "apps.tabdata.services.record_service._run_after_tabdata_commit",
            side_effect=lambda fn: fn(),
        ), \
             patch("apps.collab.registry.get_adapter", return_value=mock_adapter), \
             patch("apps.collab.service.VersionHistoryService", return_value=mock_vh_svc), \
             patch("apps.collab.models.ChangeLog") as MockChangeLog, \
             patch("django.db.transaction.atomic"):

            MockChangeLog.objects.using.return_value = mock_cl_manager

            svc._trigger_field_version_history(
                table_id, "create_field",
                change_type=CHANGE_TYPE_CREATE_FIELD,
                summary="创建字段 'name' (text)",
                field_details=[{"id": "abc", "name": "name", "field_type": "text"}],
            )

        mock_cl_manager.create.assert_called_once()
        cl_kwargs = mock_cl_manager.create.call_args.kwargs
        assert cl_kwargs["change_type"] == "create_field"
        assert cl_kwargs["resource_type"] == "table"
        assert "创建字段" in cl_kwargs["summary"]
        assert cl_kwargs["changes"]["fields"][0]["name"] == "name"

    def test_changelog_linked_to_version_history(self):
        """ChangeLog 的 version_history FK 应指向同次创建的 VersionHistory。"""
        svc = self._make_service()
        table_id = uuid.uuid4()
        mock_adapter, mock_vh_svc, mock_vh = self._make_adapter_and_svc(table_id)

        mock_cl_manager = MagicMock()

        with patch(
            "apps.tabdata.services.record_service._run_after_tabdata_commit",
            side_effect=lambda fn: fn(),
        ), \
             patch("apps.collab.registry.get_adapter", return_value=mock_adapter), \
             patch("apps.collab.service.VersionHistoryService", return_value=mock_vh_svc), \
             patch("apps.collab.models.ChangeLog") as MockChangeLog, \
             patch("django.db.transaction.atomic"):

            MockChangeLog.objects.using.return_value = mock_cl_manager

            svc._trigger_field_version_history(
                table_id, "update_field",
                change_type="update_field",
                summary="更新字段 'age'",
                field_details=[{"id": "def", "name": "age"}],
            )

        cl_kwargs = mock_cl_manager.create.call_args.kwargs
        assert cl_kwargs["version_history"] is mock_vh

    def test_delete_field_passes_correct_change_type(self):
        """delete_field 应传递 CHANGE_TYPE_DELETE_FIELD 给 _trigger_field_version_history。"""
        from apps.tabdata.services.table_service import TableService
        from apps.collab.constants import CHANGE_TYPE_DELETE_FIELD

        field_id = uuid.uuid4()
        table_id = uuid.uuid4()

        mock_field = MagicMock()
        mock_field.id = field_id
        mock_field.table_id = table_id
        mock_field.is_primary = False
        mock_field.field_type = "text"
        mock_field.name = "test_field"
        mock_field.is_deleted = False

        mock_table = MagicMock()
        mock_table.is_system_table = False

        mock_op = MagicMock()
        mock_op.serialize_field.return_value = {}

        with patch("apps.tabdata.services.table_service.TableField") as MockTF, \
             patch("apps.tabdata.services.table_service.Table") as MockT, \
             patch("apps.tabdata.services.table_service.get_current_window_id", return_value="w1"), \
             patch("apps.tabdata.services.table_service.is_system_field", return_value=False), \
             patch("django.db.transaction.atomic"), \
             patch.object(TableService, "check_table_permission", return_value=True), \
             patch.object(TableService, "_get_operation_service", return_value=mock_op), \
             patch.object(TableService, "_native_drop_column"), \
             patch.object(TableService, "_refresh_field_count"), \
             patch.object(TableService, "_increment_schema_version"), \
             patch.object(TableService, "_sync_table_records_to_ydoc"), \
             patch.object(TableService, "_remove_field_from_views"), \
             patch.object(TableService, "_publish_field_event"), \
             patch.object(TableService, "_trigger_field_version_history") as mock_vh_trigger:

            MockTF.objects.using.return_value.get.return_value = mock_field
            MockT.objects.using.return_value.get.return_value = mock_table

            svc = TableService.__new__(TableService)
            svc.user = MagicMock(id=uuid.uuid4())
            svc.delete_field(field_id)

        mock_vh_trigger.assert_called_once()
        kwargs = mock_vh_trigger.call_args.kwargs
        assert kwargs["change_type"] == CHANGE_TYPE_DELETE_FIELD
        assert "删除字段" in kwargs["summary"]
        assert kwargs["field_details"][0]["id"] == str(field_id)

    def test_create_field_passes_correct_change_type(self):
        """create_field 应传递 CHANGE_TYPE_CREATE_FIELD 给 _trigger_field_version_history。"""
        from apps.tabdata.services.table_service import TableService
        from apps.collab.constants import CHANGE_TYPE_CREATE_FIELD

        table_id = uuid.uuid4()
        field_id = uuid.uuid4()

        mock_field = MagicMock()
        mock_field.id = field_id
        mock_field.name = "new_col"
        mock_field.field_type = "text"
        mock_field.table_id = table_id

        mock_table = MagicMock()
        mock_table.is_system_table = False

        mock_op = MagicMock()
        mock_op.serialize_field.return_value = {}

        with patch("apps.tabdata.services.table_service.TableField") as MockTF, \
             patch("apps.tabdata.services.table_service.Table") as MockT, \
             patch("apps.tabdata.services.table_service.get_current_window_id", return_value="w1"), \
             patch("apps.tabdata.services.table_service.is_system_field", return_value=False), \
             patch("apps.tabdata.services.table_service.resolve_field_type_alias", return_value="text"), \
             patch("django.db.transaction.atomic"), \
             patch.object(TableService, "check_table_permission", return_value=True), \
             patch.object(TableService, "_get_operation_service", return_value=mock_op), \
             patch.object(TableService, "_normalize_field_options", return_value={}), \
             patch.object(TableService, "_native_add_column"), \
             patch.object(TableService, "_refresh_field_count"), \
             patch.object(TableService, "_increment_schema_version"), \
             patch.object(TableService, "_auto_add_field_to_views"), \
             patch.object(TableService, "_publish_field_event"), \
             patch.object(TableService, "_trigger_field_version_history") as mock_vh_trigger:

            MockTF.FIELD_TYPE_CHOICES = [("text", "Text")]
            MockTF.objects.using.return_value.filter.return_value.count.return_value = 0
            MockTF.objects.using.return_value.create.return_value = mock_field
            MockT.objects.using.return_value.get.return_value = mock_table

            svc = TableService.__new__(TableService)
            svc.user = MagicMock(id=uuid.uuid4())
            result = svc.create_field(table_id, "new_col", "text")

        assert result is mock_field
        mock_vh_trigger.assert_called_once()
        kwargs = mock_vh_trigger.call_args.kwargs
        assert kwargs["change_type"] == CHANGE_TYPE_CREATE_FIELD
        assert "创建字段" in kwargs["summary"]

    def test_version_history_failure_does_not_propagate(self):
        """_trigger_field_version_history 内部异常不应传播到调用方。"""
        svc = self._make_service()
        table_id = uuid.uuid4()

        with patch(
            "apps.tabdata.services.record_service._run_after_tabdata_commit",
            side_effect=lambda fn: fn(),
        ), \
             patch("apps.collab.registry.get_adapter", side_effect=RuntimeError("boom")):

            svc._trigger_field_version_history(
                table_id, "test",
                change_type="create_field",
                summary="test",
                field_details=[],
            )


# ══════════════════════════════════════════════════════════
# FH-001: reorder_fields / convert_field_type 现在触发历史
# ══════════════════════════════════════════════════════════

class TestNewFieldHistoryCallSites:
    """验证 reorder_fields 和 convert_field_type 现在也触发历史写入。"""

    def test_reorder_fields_triggers_version_history(self):
        """reorder_fields 应触发 _trigger_field_version_history。"""
        from apps.tabdata.services.table_service import TableService
        from apps.collab.constants import CHANGE_TYPE_REORDER_FIELDS

        table_id = uuid.uuid4()
        field_id_1 = uuid.uuid4()
        field_id_2 = uuid.uuid4()

        mock_field_1 = MagicMock()
        mock_field_1.id = field_id_1
        mock_field_1.name = "col_a"
        mock_field_1.order = 1

        mock_field_2 = MagicMock()
        mock_field_2.id = field_id_2
        mock_field_2.name = "col_b"
        mock_field_2.order = 0

        mock_op = MagicMock()
        mock_op.serialize_field.return_value = {}

        with patch("apps.tabdata.services.table_service.TableField") as MockTF, \
             patch("apps.tabdata.services.table_service.get_current_window_id", return_value="w1"), \
             patch("django.db.transaction.atomic"), \
             patch.object(TableService, "check_table_permission", return_value=True), \
             patch.object(TableService, "_get_operation_service", return_value=mock_op), \
             patch.object(TableService, "_increment_schema_version"), \
             patch.object(TableService, "_publish_field_event"), \
             patch.object(TableService, "_trigger_field_version_history") as mock_vh_trigger:

            locked_fields = [mock_field_1, mock_field_2]
            MockTF.objects.using.return_value.select_for_update.return_value.filter.return_value = locked_fields
            MockTF.objects.using.return_value.bulk_update = MagicMock()
            MockTF.objects.using.return_value.filter.return_value = locked_fields
            MockTF.DoesNotExist = Exception

            svc = TableService.__new__(TableService)
            svc.user = MagicMock(id=uuid.uuid4())

            result = svc.reorder_fields(
                table_id,
                [
                    {"field_id": str(field_id_1), "sort_order": 1},
                    {"field_id": str(field_id_2), "sort_order": 0},
                ],
            )

        assert result is True
        mock_vh_trigger.assert_called_once()
        kwargs = mock_vh_trigger.call_args.kwargs
        assert kwargs["change_type"] == CHANGE_TYPE_REORDER_FIELDS

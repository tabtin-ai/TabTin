"""
FH-007 / FH-008 回归测试

FH-007（ 修订）: delete_field 软删除后**不再**即时 DROP native 列——
    DROP COLUMN 会销毁单元格数据，破坏 Ctrl+Z 追悔与回收站语义；物理 drop
    延到 field_recycle_cleanup（TTL）。_native_drop_column 方法本身仍保留，
    由回收站任务与版本还原路径使用。
FH-008: 字段 CRUD 后应联动触发 VersionHistory 写入
"""
import os
import uuid
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ══════════════════════════════════════════════════════════
# FH-007: delete_field 触发 _native_drop_column
# ══════════════════════════════════════════════════════════

class TestDeleteFieldNativeColumnCleanup:
    """验证 delete_field 在软删除后调用 _native_drop_column 清理 native 列。"""

    @patch("apps.tabdata.services.table_service.TableService._trigger_field_version_history")
    @patch("apps.tabdata.services.table_service.TableService._publish_field_event")
    @patch("apps.tabdata.services.table_service.TableService._remove_field_from_views")
    @patch("apps.tabdata.services.table_service.TableService._sync_table_records_to_ydoc")
    @patch("apps.tabdata.services.table_service.TableService._refresh_field_count")
    @patch("apps.tabdata.services.table_service.TableService._increment_schema_version")
    @patch("apps.tabdata.services.table_service.TableService._native_drop_column")
    @patch("apps.tabdata.services.table_service.TableService._get_operation_service")
    @patch("apps.tabdata.services.table_service.TableService.check_table_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.is_system_field", return_value=False)
    def test_delete_field_does_not_drop_native_column(
        self,
        mock_is_system,
        mock_check_perm,
        mock_op_svc,
        mock_native_drop,
        mock_inc_schema,
        mock_refresh,
        mock_ydoc_sync,
        mock_remove_views,
        mock_publish,
        mock_vh,
    ):
        """#3227：delete_field 软删除后**不再**即时 DROP native 列。

        DROP COLUMN 会不可逆销毁单元格数据，与「删字段可 Ctrl+Z 追悔」及
        回收站 field_recycle_cleanup（TTL 后才物理 drop）冲突。列 + 数据保留
        至 TTL 清理，撤销时 restore_field 幂等复用原列，数据原样回来。
        """
        from apps.tabdata.services.table_service import TableService

        field_id = uuid.uuid4()
        table_id = uuid.uuid4()

        mock_field = MagicMock()
        mock_field.id = field_id
        mock_field.table_id = table_id
        mock_field.is_primary = False
        mock_field.field_type = "text"
        mock_field.is_deleted = False

        mock_table = MagicMock()
        mock_table.is_system_table = False

        mock_op = MagicMock()
        mock_op.serialize_field.return_value = {"id": str(field_id)}
        mock_op_svc.return_value = mock_op

        with patch("apps.tabdata.services.table_service.TableField") as MockTableField, \
             patch("apps.tabdata.services.table_service.Table") as MockTable, \
             patch("apps.tabdata.services.table_service.get_current_window_id", return_value="w1"):

            MockTableField.objects.using.return_value.get.return_value = mock_field
            MockTable.objects.using.return_value.get.return_value = mock_table

            svc = TableService.__new__(TableService)
            svc.user = MagicMock(id=uuid.uuid4())

            with patch("django.db.transaction.atomic"):
                result = svc.delete_field(field_id)

        assert result is True
        mock_native_drop.assert_not_called()

    @patch("apps.tabdata.services.table_service.TableService._trigger_field_version_history")
    @patch("apps.tabdata.services.table_service.TableService._publish_field_event")
    @patch("apps.tabdata.services.table_service.TableService._remove_field_from_views")
    @patch("apps.tabdata.services.table_service.TableService._refresh_field_count")
    @patch("apps.tabdata.services.table_service.TableService._increment_schema_version")
    @patch("apps.tabdata.services.table_service.TableService._native_drop_column")
    @patch("apps.tabdata.services.table_service.TableService._get_operation_service")
    @patch("apps.tabdata.services.table_service.TableService.check_table_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.is_system_field", return_value=True)
    def test_delete_field_skips_native_drop_for_system_field(
        self,
        mock_is_system,
        mock_check_perm,
        mock_op_svc,
        mock_native_drop,
        mock_inc_schema,
        mock_refresh,
        mock_remove_views,
        mock_publish,
        mock_vh,
    ):
        """系统字段（如 created_time）删除时不应调用 _native_drop_column。"""
        from apps.tabdata.services.table_service import TableService

        field_id = uuid.uuid4()
        table_id = uuid.uuid4()

        mock_field = MagicMock()
        mock_field.id = field_id
        mock_field.table_id = table_id
        mock_field.is_primary = False
        mock_field.field_type = "created_time"
        mock_field.is_deleted = False

        mock_table = MagicMock()
        mock_table.is_system_table = False

        mock_op = MagicMock()
        mock_op.serialize_field.return_value = {"id": str(field_id)}
        mock_op_svc.return_value = mock_op

        with patch("apps.tabdata.services.table_service.TableField") as MockTableField, \
             patch("apps.tabdata.services.table_service.Table") as MockTable, \
             patch("apps.tabdata.services.table_service.get_current_window_id", return_value="w1"):

            MockTableField.objects.using.return_value.get.return_value = mock_field
            MockTable.objects.using.return_value.get.return_value = mock_table

            svc = TableService.__new__(TableService)
            svc.user = MagicMock(id=uuid.uuid4())

            with patch("django.db.transaction.atomic"):
                result = svc.delete_field(field_id)

        assert result is True
        mock_native_drop.assert_not_called()


# ══════════════════════════════════════════════════════════
# FH-007: _native_drop_column 正确调用 DDLManager.drop_column
# ══════════════════════════════════════════════════════════

class TestNativeDropColumn:
    """验证 _native_drop_column 方法正确委托 DDLManager.drop_column。"""

    @patch("apps.tabdata.services.table_service.DDLManager")
    @patch("apps.tabdata.models.Table")
    def test_native_drop_column_delegates_to_ddl_manager(self, MockTable, MockDDL):
        from apps.tabdata.services.table_service import TableService

        table_id = uuid.uuid4()
        field_id = uuid.uuid4()
        space_id = uuid.uuid4()

        mock_table = MagicMock()
        mock_table.space_id = space_id

        mock_ddl = MagicMock()
        MockDDL.return_value = mock_ddl
        MockTable.objects.using.return_value.get.return_value = mock_table

        svc = TableService.__new__(TableService)
        svc.user = None
        svc._native_drop_column(table_id, field_id)

        mock_ddl.drop_column.assert_called_once_with(space_id, table_id, field_id)

    @patch("apps.tabdata.services.table_service.DDLManager")
    @patch("apps.tabdata.models.Table")
    def test_native_drop_column_failsafe_on_exception(self, MockTable, MockDDL):
        """_native_drop_column 失败时仅 warn，不阻断主流程。"""
        from apps.tabdata.services.table_service import TableService

        mock_ddl = MagicMock()
        mock_ddl.drop_column.side_effect = RuntimeError("DDL error")
        MockDDL.return_value = mock_ddl
        MockTable.objects.using.return_value.get.return_value = MagicMock(space_id=uuid.uuid4())

        svc = TableService.__new__(TableService)
        svc.user = None
        svc._native_drop_column(uuid.uuid4(), uuid.uuid4())


# ══════════════════════════════════════════════════════════
# FH-008: 字段 CRUD 触发 VersionHistory 写入
# ══════════════════════════════════════════════════════════

class TestFieldVersionHistoryTrigger:
    """验证 _trigger_field_version_history 在事务提交后触发 VersionHistory 写入。"""

    @patch("apps.tabdata.services.table_service.TableService._trigger_field_version_history")
    @patch("apps.tabdata.services.table_service.TableService._publish_field_event")
    @patch("apps.tabdata.services.table_service.TableService._native_drop_column")
    @patch("apps.tabdata.services.table_service.TableService._remove_field_from_views")
    @patch("apps.tabdata.services.table_service.TableService._refresh_field_count")
    @patch("apps.tabdata.services.table_service.TableService._increment_schema_version")
    @patch("apps.tabdata.services.table_service.TableService._get_operation_service")
    @patch("apps.tabdata.services.table_service.TableService.check_table_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.is_system_field", return_value=False)
    def test_delete_field_triggers_version_history(
        self,
        mock_is_system,
        mock_check_perm,
        mock_op_svc,
        mock_inc_schema,
        mock_refresh,
        mock_remove_views,
        mock_native_drop,
        mock_publish,
        mock_vh_trigger,
    ):
        """delete_field 应在操作完成后触发 VersionHistory 写入。"""
        from apps.tabdata.services.table_service import TableService

        field_id = uuid.uuid4()
        table_id = uuid.uuid4()

        mock_field = MagicMock()
        mock_field.id = field_id
        mock_field.table_id = table_id
        mock_field.is_primary = False
        mock_field.field_type = "text"

        mock_table = MagicMock()
        mock_table.is_system_table = False

        mock_op = MagicMock()
        mock_op.serialize_field.return_value = {}
        mock_op_svc.return_value = mock_op

        with patch("apps.tabdata.services.table_service.TableField") as MockTF, \
             patch("apps.tabdata.services.table_service.Table") as MockT, \
             patch("apps.tabdata.services.table_service.get_current_window_id", return_value="w1"), \
             patch("django.db.transaction.atomic"):

            MockTF.objects.using.return_value.get.return_value = mock_field
            MockT.objects.using.return_value.get.return_value = mock_table

            svc = TableService.__new__(TableService)
            svc.user = MagicMock(id=uuid.uuid4())
            svc.delete_field(field_id)

        assert mock_vh_trigger.call_count == 1
        call_args = mock_vh_trigger.call_args
        assert call_args[0][0] == table_id
        assert call_args[0][1] == "delete_field"

    def test_trigger_field_version_history_calls_create_history(self):
        """_trigger_field_version_history 应调用 VersionHistoryService.create_history。"""
        from apps.tabdata.services.table_service import TableService

        table_id = uuid.uuid4()

        mock_adapter = MagicMock()
        mock_resource = MagicMock()
        mock_resource.id = table_id
        mock_resource.organization_id = uuid.uuid4()
        mock_adapter.get_resource.return_value = mock_resource
        mock_adapter.get_version_data.return_value = {"fields": [], "records": {}}

        mock_svc = MagicMock()

        svc = TableService.__new__(TableService)
        svc.user = MagicMock(id=uuid.uuid4())

        with patch(
            "apps.tabdata.services.record_service._run_after_tabdata_commit",
            side_effect=lambda fn: fn(),
        ), \
             patch("apps.collab.registry.get_adapter", return_value=mock_adapter), \
             patch("apps.collab.service.VersionHistoryService", return_value=mock_svc):

            svc._trigger_field_version_history(table_id, "create_field")

        mock_svc.create_history.assert_called_once()
        call_kwargs = mock_svc.create_history.call_args
        assert call_kwargs.kwargs.get("force_snapshot") is True

    def test_trigger_field_version_history_no_adapter_silent(self):
        """adapter 未注册时不抛异常。"""
        from apps.tabdata.services.table_service import TableService

        svc = TableService.__new__(TableService)
        svc.user = None

        with patch(
            "apps.tabdata.services.record_service._run_after_tabdata_commit",
            side_effect=lambda fn: fn(),
        ), \
             patch("apps.collab.registry.get_adapter", return_value=None):

            svc._trigger_field_version_history(uuid.uuid4(), "test_action")

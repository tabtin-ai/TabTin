"""
DV-005 / DV-017 回归测试

DV-005: restore_to_version 后 Redis Undo 栈必须被清空
DV-017: restore_table_to_history 推入新条目前必须先清空旧 Undo 栈
"""
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402
from uuid import uuid4  # noqa: E402

from apps.tabdata.services.undo_redo_stack_service import UndoRedoStackService  # noqa: E402


# ================================================================
# UndoRedoStackService.clear_table_stacks 单元测试
# ================================================================

@pytest.fixture
def stack_svc():
    svc = UndoRedoStackService()
    svc.enabled = True
    return svc


@pytest.fixture
def ids():
    return {
        "user": str(uuid4()),
        "table": str(uuid4()),
        "window": "win-1",
    }


class TestClearTableStacks:
    """UndoRedoStackService.clear_table_stacks 单元测试"""

    def test_clear_specific_window(self, stack_svc, ids):
        """clear_table_stacks 应清空指定 user+table+window 的 undo 和 redo 栈"""
        stack_svc.push_undo_operation(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window"],
            operation={"id": "op1", "history_id": "h1"}, clear_redo=False,
        )
        stack_svc.push_redo_operations(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window"],
            operations=[{"id": "op2", "history_id": "h2"}],
        )

        _, undo_total = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window"], limit=10,
        )
        _, redo_total = stack_svc.get_redo_stack(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window"], limit=10,
        )
        assert undo_total == 1
        assert redo_total == 1

        stack_svc.clear_table_stacks(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window"],
        )

        _, undo_total = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window"], limit=10,
        )
        _, redo_total = stack_svc.get_redo_stack(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window"], limit=10,
        )
        assert undo_total == 0
        assert redo_total == 0

    def test_clear_global_window(self, stack_svc, ids):
        """clear_table_stacks 无 window_id 时清空 __global__ 窗口栈"""
        stack_svc.push_undo_operation(
            user_id=ids["user"], table_id=ids["table"], window_id=None,
            operation={"id": "op1", "history_id": "h1"}, clear_redo=False,
        )

        stack_svc.clear_table_stacks(
            user_id=ids["user"], table_id=ids["table"], window_id=None,
        )

        _, total = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"], window_id=None, limit=10,
        )
        assert total == 0

    def test_clear_does_not_affect_other_tables(self, stack_svc):
        """clear_table_stacks 不影响其他表的栈"""
        user_id = str(uuid4())
        table_a = str(uuid4())
        table_b = str(uuid4())

        stack_svc.push_undo_operation(
            user_id=user_id, table_id=table_a, window_id=None,
            operation={"id": "a1", "history_id": "ha"}, clear_redo=False,
        )
        stack_svc.push_undo_operation(
            user_id=user_id, table_id=table_b, window_id=None,
            operation={"id": "b1", "history_id": "hb"}, clear_redo=False,
        )

        stack_svc.clear_table_stacks(user_id=user_id, table_id=table_a, window_id=None)

        _, total_a = stack_svc.get_undo_stack(
            user_id=user_id, table_id=table_a, window_id=None, limit=10,
        )
        _, total_b = stack_svc.get_undo_stack(
            user_id=user_id, table_id=table_b, window_id=None, limit=10,
        )
        assert total_a == 0, "表 A 的栈应已被清空"
        assert total_b == 1, "表 B 的栈不应受影响"

    def test_clear_disabled_is_noop(self, stack_svc):
        """栈禁用时 clear_table_stacks 不报错"""
        stack_svc.enabled = False
        stack_svc.clear_table_stacks(
            user_id="u1", table_id="t1", window_id=None,
        )

    def test_clear_all_windows_fallback(self, stack_svc, ids):
        """all_windows=True 在无 delete_pattern 时至少清空 global 窗口"""
        stack_svc.push_undo_operation(
            user_id=ids["user"], table_id=ids["table"], window_id=None,
            operation={"id": "op1", "history_id": "h1"}, clear_redo=False,
        )

        stack_svc.clear_table_stacks(
            user_id=ids["user"], table_id=ids["table"], all_windows=True,
        )

        _, total = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"], window_id=None, limit=10,
        )
        assert total == 0


# ================================================================
# DV-017: restore_table_to_history 先清空旧栈再推入新条目
# ================================================================

class TestDV017RestoreTableClearsOldStack:
    """DV-017: restore_table_to_history 在 push 新条目前先清空旧栈"""

    def test_old_undo_stack_cleared_before_push(self, stack_svc):
        """模拟 restore_table_to_history 的栈操作序列，验证旧条目被清空"""
        user_id = str(uuid4())
        table_id = str(uuid4())
        window_id = "win-test"

        stack_svc.push_undo_operation(
            user_id=user_id, table_id=table_id, window_id=window_id,
            operation={"id": "old-op-1", "history_id": "old-h1"},
            clear_redo=False,
        )
        stack_svc.push_undo_operation(
            user_id=user_id, table_id=table_id, window_id=window_id,
            operation={"id": "old-op-2", "history_id": "old-h2"},
            clear_redo=False,
        )
        stack_svc.push_redo_operations(
            user_id=user_id, table_id=table_id, window_id=window_id,
            operations=[{"id": "old-redo-1", "history_id": "old-rh1"}],
        )

        _, undo_total_before = stack_svc.get_undo_stack(
            user_id=user_id, table_id=table_id, window_id=window_id, limit=10,
        )
        assert undo_total_before == 2

        # --- 模拟 DV-017 修复后的逻辑：先清空，再 push ---
        stack_svc.clear_table_stacks(
            user_id=user_id, table_id=table_id, window_id=window_id,
        )

        _, undo_cleared = stack_svc.get_undo_stack(
            user_id=user_id, table_id=table_id, window_id=window_id, limit=10,
        )
        _, redo_cleared = stack_svc.get_redo_stack(
            user_id=user_id, table_id=table_id, window_id=window_id, limit=10,
        )
        assert undo_cleared == 0, "旧 undo 栈应被清空"
        assert redo_cleared == 0, "旧 redo 栈应被清空"

        new_ops = [
            {"id": "new-restore-1", "history_id": "new-rh1"},
            {"id": "new-restore-2", "history_id": "new-rh2"},
        ]
        stack_svc.push_undo_operations(
            user_id=user_id, table_id=table_id, window_id=window_id,
            operations=new_ops, clear_redo=False,
        )

        undo_ops, undo_total_final = stack_svc.get_undo_stack(
            user_id=user_id, table_id=table_id, window_id=window_id, limit=10,
        )
        assert undo_total_final == 2, "只应有 restore 产生的新条目"

        op_ids = {op["id"] for op in undo_ops}
        assert "old-op-1" not in op_ids, "旧条目不应存在"
        assert "old-op-2" not in op_ids, "旧条目不应存在"
        assert "new-restore-1" in op_ids
        assert "new-restore-2" in op_ids


# ================================================================
# DV-005: collab restore_version 后 tabdata Undo/Redo 栈必须被清空
# ================================================================

class TestDV005RestoreVersionClearsStack:
    """DV-005: collab restore_version 后 tabdata Undo/Redo 栈必须被清空"""

    def test_clear_tabdata_stacks_called_for_table_restore(self, stack_svc):
        """_clear_tabdata_undo_redo_stacks 应正确清空缓存栈"""
        from apps.collab.api import _clear_tabdata_undo_redo_stacks

        user_id = str(uuid4())
        table_id = str(uuid4())

        stack_svc.push_undo_operation(
            user_id=user_id, table_id=table_id, window_id=None,
            operation={"id": "pre-restore-op", "history_id": "pre-h1"},
            clear_redo=False,
        )

        _, total_before = stack_svc.get_undo_stack(
            user_id=user_id, table_id=table_id, window_id=None, limit=10,
        )
        assert total_before == 1

        _clear_tabdata_undo_redo_stacks(user_id, table_id)

        _, total_after = stack_svc.get_undo_stack(
            user_id=user_id, table_id=table_id, window_id=None, limit=10,
        )
        assert total_after == 0, "restore 后 undo 栈应被清空"

    @patch("apps.collab.api._clear_tabdata_undo_redo_stacks")
    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api._validate_resource_type", return_value=None)
    def test_restore_version_endpoint_calls_clear_for_table(
        self, mock_validate, mock_get_adapter, mock_vh_cls,
        mock_force_close, mock_clear_stacks,
    ):
        """restore_version 端点在 table restore 成功后应触发栈清空"""
        mock_adapter = MagicMock()
        mock_adapter.get_resource.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_get_adapter.return_value = mock_adapter

        mock_vh = MagicMock()
        mock_vh.id = uuid4()
        mock_vh_svc = MagicMock()
        mock_vh_svc.restore_to_version.return_value = mock_vh
        mock_vh_cls.return_value = mock_vh_svc

        mock_force_close.return_value = {
            "success": True, "loaded": True, "connections_closed": 0,
        }

        from apps.collab.api import restore_version
        from apps.collab.schemas import RestoreVersionRequest

        mock_request = MagicMock()
        mock_request.auth = MagicMock()
        mock_request.auth.id = uuid4()
        mock_request.auth.nickname = "test_user"

        body = RestoreVersionRequest(version_id=uuid4())
        resource_id = uuid4()

        restore_version(mock_request, "table", resource_id, body)

        mock_clear_stacks.assert_called_once_with(
            str(mock_request.auth.id), str(resource_id),
        )

    @patch("apps.collab.api._clear_tabdata_undo_redo_stacks")
    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api._validate_resource_type", return_value=None)
    def test_restore_version_endpoint_skips_clear_for_non_table(
        self, mock_validate, mock_get_adapter, mock_vh_cls,
        mock_force_close, mock_clear_stacks,
    ):
        """restore_version 端点对非 table 资源不调用 tabdata 栈清空"""
        mock_adapter = MagicMock()
        mock_adapter.get_resource.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_get_adapter.return_value = mock_adapter

        mock_vh = MagicMock()
        mock_vh.id = uuid4()
        mock_vh_svc = MagicMock()
        mock_vh_svc.restore_to_version.return_value = mock_vh
        mock_vh_cls.return_value = mock_vh_svc

        mock_force_close.return_value = {
            "success": True, "loaded": True, "connections_closed": 0,
        }

        from apps.collab.api import restore_version
        from apps.collab.schemas import RestoreVersionRequest

        mock_request = MagicMock()
        mock_request.auth = MagicMock()
        mock_request.auth.id = uuid4()

        body = RestoreVersionRequest(version_id=uuid4())

        restore_version(mock_request, "docs", uuid4(), body)
        mock_clear_stacks.assert_not_called()


# ================================================================
# DV-005 扩展：rollback_agent_run 恢复 table 后清栈
# ================================================================

class TestDV005RollbackExecutionRunClearsStack:
    """DV-005: rollback_agent_run 恢复 table 资源后必须清空 Undo/Redo 栈"""

    @patch("apps.collab.api._clear_tabdata_undo_redo_stacks")
    @patch("apps.collab.api._force_close_collab_document",
           return_value={"success": True, "loaded": True, "connections_closed": 0})
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.models.VersionHistory")
    @patch("apps.collab.models.ChangeLog")
    @patch("django.db.transaction.atomic")
    def test_rollback_clears_stack_for_table_resource(
        self, mock_atomic, MockCL, MockVH,
        mock_get_adapter, mock_vh_cls, mock_force_close, mock_clear_stacks,
    ):
        """rollback_agent_run 恢复 table 资源后应触发栈清空"""
        table_id = uuid4()
        mock_cl = MagicMock()
        mock_cl.resource_type = "table"
        mock_cl.resource_id = table_id
        mock_cl.created_at = MagicMock()

        MockCL.objects.using.return_value.filter.return_value.order_by.return_value = [mock_cl]

        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_get_adapter.return_value = mock_adapter

        mock_pre_vh = MagicMock()
        mock_pre_vh.id = uuid4()
        MockVH.objects.using.return_value.filter.return_value.order_by.return_value.first.return_value = mock_pre_vh

        mock_restored = MagicMock()
        mock_restored.id = uuid4()
        mock_vh_svc = MagicMock()
        mock_vh_svc.restore_to_version.return_value = mock_restored
        mock_vh_cls.return_value = mock_vh_svc

        mock_request = MagicMock()
        mock_request.auth.id = uuid4()
        mock_request.auth.nickname = "tester"

        from apps.collab.api import rollback_agent_run
        rollback_agent_run(mock_request, "test-agent-run-123")

        mock_clear_stacks.assert_called_once_with(
            str(mock_request.auth.id), str(table_id),
        )

    @patch("apps.collab.api._clear_tabdata_undo_redo_stacks")
    @patch("apps.collab.api._force_close_collab_document",
           return_value={"success": True, "loaded": True, "connections_closed": 0})
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.models.VersionHistory")
    @patch("apps.collab.models.ChangeLog")
    @patch("django.db.transaction.atomic")
    def test_rollback_skips_clear_for_non_table_resource(
        self, mock_atomic, MockCL, MockVH,
        mock_get_adapter, mock_vh_cls, mock_force_close, mock_clear_stacks,
    ):
        """rollback_agent_run 对非 table 资源不调用 tabdata 栈清空"""
        doc_id = uuid4()
        mock_cl = MagicMock()
        mock_cl.resource_type = "docs"
        mock_cl.resource_id = doc_id
        mock_cl.created_at = MagicMock()

        MockCL.objects.using.return_value.filter.return_value.order_by.return_value = [mock_cl]

        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_get_adapter.return_value = mock_adapter

        mock_pre_vh = MagicMock()
        mock_pre_vh.id = uuid4()
        MockVH.objects.using.return_value.filter.return_value.order_by.return_value.first.return_value = mock_pre_vh

        mock_restored = MagicMock()
        mock_restored.id = uuid4()
        mock_vh_svc = MagicMock()
        mock_vh_svc.restore_to_version.return_value = mock_restored
        mock_vh_cls.return_value = mock_vh_svc

        mock_request = MagicMock()
        mock_request.auth.id = uuid4()
        mock_request.auth.nickname = "tester"

        from apps.collab.api import rollback_agent_run
        rollback_agent_run(mock_request, "test-agent-run-456")

        mock_clear_stacks.assert_not_called()

    @patch("apps.collab.api._clear_tabdata_undo_redo_stacks")
    @patch("apps.collab.api._force_close_collab_document",
           return_value={"success": True, "loaded": True, "connections_closed": 0})
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.models.VersionHistory")
    @patch("apps.collab.models.ChangeLog")
    @patch("django.db.transaction.atomic")
    def test_rollback_clears_stack_for_each_table_in_mixed_batch(
        self, mock_atomic, MockCL, MockVH,
        mock_get_adapter, mock_vh_cls, mock_force_close, mock_clear_stacks,
    ):
        """rollback 混合资源时只对 table 类型调用栈清空"""
        table_id = uuid4()
        doc_id = uuid4()

        mock_cl_table = MagicMock()
        mock_cl_table.resource_type = "table"
        mock_cl_table.resource_id = table_id
        mock_cl_table.created_at = MagicMock()

        mock_cl_doc = MagicMock()
        mock_cl_doc.resource_type = "docs"
        mock_cl_doc.resource_id = doc_id
        mock_cl_doc.created_at = MagicMock()

        MockCL.objects.using.return_value.filter.return_value.order_by.return_value = [
            mock_cl_table, mock_cl_doc,
        ]

        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_get_adapter.return_value = mock_adapter

        mock_pre_vh = MagicMock()
        mock_pre_vh.id = uuid4()
        MockVH.objects.using.return_value.filter.return_value.order_by.return_value.first.return_value = mock_pre_vh

        mock_restored = MagicMock()
        mock_restored.id = uuid4()
        mock_vh_svc = MagicMock()
        mock_vh_svc.restore_to_version.return_value = mock_restored
        mock_vh_cls.return_value = mock_vh_svc

        mock_request = MagicMock()
        mock_request.auth.id = uuid4()
        mock_request.auth.nickname = "tester"

        from apps.collab.api import rollback_agent_run
        rollback_agent_run(mock_request, "test-mixed-run")

        mock_clear_stacks.assert_called_once_with(
            str(mock_request.auth.id), str(table_id),
        )


# ================================================================
# DV-005 扩展：restore_space_checkpoint 恢复 table 后清栈
# ================================================================

class TestDV005RestoreCheckpointClearsStack:
    """DV-005: restore_space_checkpoint 恢复 table 资源后必须清空 Undo/Redo 栈"""

    @patch("apps.collab.api._clear_tabdata_undo_redo_stacks")
    @patch("apps.collab.api._force_close_collab_document",
           return_value={"success": True, "loaded": True, "connections_closed": 0})
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.models.SpaceCheckpoint")
    @patch("apps.collab.models.VersionHistory")
    @patch("apps.tabtinspace.services.base.BaseService")
    @patch("django.db.transaction.atomic")
    def test_checkpoint_restore_clears_stack_for_table(
        self, mock_atomic, MockBaseService, MockVH, MockCP,
        mock_get_adapter, mock_vh_cls, mock_force_close, mock_clear_stacks,
    ):
        """restore_space_checkpoint 恢复 table 资源后应触发栈清空"""
        checkpoint_id = uuid4()
        table_id = uuid4()
        vh_id = uuid4()

        mock_cp = MagicMock()
        mock_cp.space_id = uuid4()
        mock_cp.name = "test-cp"
        mock_cp.version_refs = {f"table:{table_id}": str(vh_id)}
        mock_cp.file_checkpoint_hash = ""
        MockCP.objects.using.return_value.filter.return_value.first.return_value = mock_cp

        mock_perm_svc = MagicMock()
        mock_perm_svc.check_space_permission.return_value = True
        MockBaseService.return_value = mock_perm_svc

        mock_target_vh = MagicMock()
        mock_target_vh.id = vh_id
        MockVH.objects.using.return_value.filter.return_value = [mock_target_vh]

        mock_adapter = MagicMock()
        mock_adapter.get_resource.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_get_adapter.return_value = mock_adapter

        mock_restored = MagicMock()
        mock_restored.id = uuid4()
        mock_vh_svc = MagicMock()
        mock_vh_svc.restore_to_version.return_value = mock_restored
        mock_vh_cls.return_value = mock_vh_svc

        mock_request = MagicMock()
        mock_request.auth.id = uuid4()
        mock_request.auth.nickname = "tester"

        from apps.collab.api import restore_space_checkpoint
        restore_space_checkpoint(mock_request, checkpoint_id)

        mock_clear_stacks.assert_called_once_with(
            str(mock_request.auth.id), str(table_id),
        )

    @patch("apps.collab.api._clear_tabdata_undo_redo_stacks")
    @patch("apps.collab.api._force_close_collab_document",
           return_value={"success": True, "loaded": True, "connections_closed": 0})
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.models.SpaceCheckpoint")
    @patch("apps.collab.models.VersionHistory")
    @patch("apps.tabtinspace.services.base.BaseService")
    @patch("django.db.transaction.atomic")
    def test_checkpoint_restore_skips_clear_for_non_table(
        self, mock_atomic, MockBaseService, MockVH, MockCP,
        mock_get_adapter, mock_vh_cls, mock_force_close, mock_clear_stacks,
    ):
        """restore_space_checkpoint 对非 table 资源不调用 tabdata 栈清空"""
        checkpoint_id = uuid4()
        doc_id = uuid4()
        vh_id = uuid4()

        mock_cp = MagicMock()
        mock_cp.space_id = uuid4()
        mock_cp.name = "test-cp"
        mock_cp.version_refs = {f"docs:{doc_id}": str(vh_id)}
        mock_cp.file_checkpoint_hash = ""
        MockCP.objects.using.return_value.filter.return_value.first.return_value = mock_cp

        mock_perm_svc = MagicMock()
        mock_perm_svc.check_space_permission.return_value = True
        MockBaseService.return_value = mock_perm_svc

        mock_target_vh = MagicMock()
        mock_target_vh.id = vh_id
        MockVH.objects.using.return_value.filter.return_value = [mock_target_vh]

        mock_adapter = MagicMock()
        mock_adapter.get_resource.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_get_adapter.return_value = mock_adapter

        mock_restored = MagicMock()
        mock_restored.id = uuid4()
        mock_vh_svc = MagicMock()
        mock_vh_svc.restore_to_version.return_value = mock_restored
        mock_vh_cls.return_value = mock_vh_svc

        mock_request = MagicMock()
        mock_request.auth.id = uuid4()
        mock_request.auth.nickname = "tester"

        from apps.collab.api import restore_space_checkpoint
        restore_space_checkpoint(mock_request, checkpoint_id)

        mock_clear_stacks.assert_not_called()

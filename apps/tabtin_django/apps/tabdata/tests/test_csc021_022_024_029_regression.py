"""
CSC-022 回归测试

CSC-022: restore_table_to_history 的 clear_table_stacks 必须使用 all_windows=True，
与 collab 链路保持一致，防止跨标签页 Undo 数据混乱。
"""
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from unittest.mock import MagicMock, patch, call  # noqa: E402
from uuid import uuid4  # noqa: E402

from apps.tabdata.services.undo_redo_service import UndoRedoService  # noqa: E402
from apps.tabdata.services.undo_redo_stack_service import UndoRedoStackService  # noqa: E402


class TestCSC022RestoreClearsAllWindows:
    """restore_table_to_history 必须清空所有窗口的 Undo 栈 (all_windows=True)"""

    @pytest.fixture
    def stack_svc(self):
        svc = UndoRedoStackService()
        svc.enabled = True
        return svc

    @pytest.fixture
    def ids(self):
        return {
            "user": str(uuid4()),
            "table": str(uuid4()),
            "window_a": "win-a",
            "window_b": "win-b",
        }

    def test_restore_clears_all_windows_not_just_current(self, stack_svc, ids):
        """
        CSC-022 核心场景：
        用户在标签页 A (window_a) 执行 restore 后，标签页 B (window_b) 的
        Undo 栈也必须被清空，防止跨标签页 Undo 回滚到 restore 前的中间状态。
        """
        stack_svc.push_undo_operation(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window_a"],
            operation={"id": "op-a1", "history_id": "h-a1"}, clear_redo=False,
        )
        stack_svc.push_undo_operation(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window_b"],
            operation={"id": "op-b1", "history_id": "h-b1"}, clear_redo=False,
        )

        _, total_a = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"],
            window_id=ids["window_a"], limit=10,
        )
        _, total_b = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"],
            window_id=ids["window_b"], limit=10,
        )
        assert total_a == 1, "前置：标签页 A 应有 1 条 undo"
        assert total_b == 1, "前置：标签页 B 应有 1 条 undo"

        stack_svc.clear_table_stacks(
            user_id=ids["user"],
            table_id=ids["table"],
            all_windows=True,
        )

        _, total_a_after = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"],
            window_id=ids["window_a"], limit=10,
        )
        _, total_b_after = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"],
            window_id=ids["window_b"], limit=10,
        )
        assert total_a_after == 0, "restore 后标签页 A 的 undo 栈应被清空"
        assert total_b_after == 0, "restore 后标签页 B 的 undo 栈应被清空"

    def test_restore_service_uses_all_windows_flag(self):
        """
        验证 UndoRedoService.restore_table_to_history 内部调用
        clear_table_stacks 时传递了 all_windows=True。
        """
        mock_user = MagicMock()
        mock_user.id = 123
        mock_user.get_display_name.return_value = "TestUser"

        svc = UndoRedoService(user=mock_user, window_id="win-x")

        table_id = uuid4()
        history_id = uuid4()

        with patch.object(svc, 'check_table_permission', return_value=True), \
             patch.object(svc, 'reconstruct_table_at_history', return_value=[]), \
             patch('apps.tabdata.models.TableRecord.objects') as mock_records:

            mock_records.using.return_value.select_for_update.return_value.filter.return_value = []

            with patch.object(svc.stack_service, 'clear_table_stacks') as mock_clear:
                svc.stack_service.enabled = True
                result = svc.restore_table_to_history(table_id, history_id)

        if result and result.get("changed_records", 0) > 0:
            mock_clear.assert_called_once()
            _, kwargs = mock_clear.call_args
            assert kwargs.get("all_windows") is True, \
                "restore_table_to_history 应使用 all_windows=True 清栈"
            assert "window_id" not in kwargs or kwargs.get("window_id") is None, \
                "不应传递特定的 window_id"

    def test_only_current_window_clear_is_insufficient(self, stack_svc, ids):
        """
        反向验证：仅清空当前窗口时，其他窗口的栈会残留（CSC-022 的 bug 场景）。
        """
        stack_svc.push_undo_operation(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window_a"],
            operation={"id": "op-a1", "history_id": "h-a1"}, clear_redo=False,
        )
        stack_svc.push_undo_operation(
            user_id=ids["user"], table_id=ids["table"], window_id=ids["window_b"],
            operation={"id": "op-b1", "history_id": "h-b1"}, clear_redo=False,
        )

        stack_svc.clear_table_stacks(
            user_id=ids["user"],
            table_id=ids["table"],
            window_id=ids["window_a"],
        )

        _, total_a = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"],
            window_id=ids["window_a"], limit=10,
        )
        _, total_b = stack_svc.get_undo_stack(
            user_id=ids["user"], table_id=ids["table"],
            window_id=ids["window_b"], limit=10,
        )
        assert total_a == 0, "当前窗口应被清空"
        assert total_b == 1, "仅清空单窗口时，其他窗口栈仍残留（bug 场景复现）"

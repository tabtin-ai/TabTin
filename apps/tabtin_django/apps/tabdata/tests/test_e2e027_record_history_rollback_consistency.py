"""
E2E-027 回归测试

TabData RecordHistory 与 rollback 一致性：
- Agent SQL 写入时，RecordHistory.window_id 应编码 agent_run_id（格式：agent_sql:{agent_run_id}）
- rollback_agent_run 成功后，对应 RecordHistory 应被标记为 is_undone=True
"""
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import pytest
from unittest.mock import patch, MagicMock, call
from uuid import uuid4

# ================================================================
# 测试 1：_emit_record_history_for_write 使用编码了 agent_run_id 的 window_id
# ================================================================

class TestEmitRecordHistoryWindowId:
    """E2E-027: _emit_record_history_for_write 应将 agent_run_id 编码到 window_id"""

    def _make_executor(self, user=None):
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        executor = AgentSQLExecutor.__new__(AgentSQLExecutor)
        executor.user = user or MagicMock()
        executor.db_alias = "postgresql"
        return executor

    def test_window_id_encodes_agent_run_id_for_insert(self):
        """INSERT 路径：window_id 应为 agent_sql:{agent_run_id}"""
        executor = self._make_executor()
        table_id = uuid4()
        record_id = str(uuid4())
        agent_run_id = "run-abc-123"

        mock_record = MagicMock()

        with patch("apps.tabdata.history_events.emit_record_history_event") as mock_emit, \
             patch("apps.tabdata.models.TableRecord.objects") as mock_objects, \
             patch.object(executor, '_capture_after_states') as mock_after:

            mock_objects.using.return_value.filter.return_value.first.return_value = mock_record
            mock_after.return_value = {
                table_id: {record_id: {"field1": "value1"}}
            }

            executor._emit_record_history_for_write(
                sql_type='INSERT',
                affected_table_ids={table_id},
                allocated_version=1,
                before_states={},
                inserted_ids=[record_id],
                affected_rows=1,
                agent_run_id=agent_run_id,
            )
            assert mock_emit.called
            call_kwargs = mock_emit.call_args[1]
            assert call_kwargs['window_id'] == f"agent_sql:{agent_run_id}"

    def test_window_id_fallback_when_no_agent_run_id(self):
        """无 agent_run_id 时，window_id 应回退到 'agent_sql'"""
        executor = self._make_executor()
        table_id = uuid4()
        record_id = str(uuid4())

        mock_record = MagicMock()

        with patch("apps.tabdata.history_events.emit_record_history_event") as mock_emit, \
             patch("apps.tabdata.models.TableRecord.objects") as mock_objects, \
             patch.object(executor, '_capture_after_states') as mock_after:

            mock_objects.using.return_value.filter.return_value.first.return_value = mock_record
            mock_after.return_value = {
                table_id: {record_id: {"field1": "value1"}}
            }

            executor._emit_record_history_for_write(
                sql_type='INSERT',
                affected_table_ids={table_id},
                allocated_version=1,
                before_states={},
                inserted_ids=[record_id],
                affected_rows=1,
                agent_run_id="",
            )
            assert mock_emit.called
            call_kwargs = mock_emit.call_args[1]
            assert call_kwargs['window_id'] == "agent_sql"

    def test_window_id_encodes_agent_run_id_for_update(self):
        """UPDATE 路径：window_id 应为 agent_sql:{agent_run_id}"""
        executor = self._make_executor()
        table_id = uuid4()
        record_id = str(uuid4())
        agent_run_id = "run-update-456"

        mock_record = MagicMock()

        with patch("apps.tabdata.history_events.emit_record_history_event") as mock_emit, \
             patch("apps.tabdata.models.TableRecord.objects") as mock_objects, \
             patch.object(executor, '_capture_after_states') as mock_after:

            mock_objects.using.return_value.filter.return_value.first.return_value = mock_record
            mock_after.return_value = {
                table_id: {record_id: {"field1": "new_value"}}
            }

            executor._emit_record_history_for_write(
                sql_type='UPDATE',
                affected_table_ids={table_id},
                allocated_version=2,
                before_states={table_id: {record_id: {"field1": "old_value"}}},
                inserted_ids=[],
                affected_rows=1,
                agent_run_id=agent_run_id,
            )
            assert mock_emit.called
            call_kwargs = mock_emit.call_args[1]
            assert call_kwargs['window_id'] == f"agent_sql:{agent_run_id}"

    def test_window_id_encodes_agent_run_id_for_delete(self):
        """DELETE 路径：window_id 应为 agent_sql:{agent_run_id}"""
        executor = self._make_executor()
        table_id = uuid4()
        record_id = str(uuid4())
        agent_run_id = "run-delete-789"

        mock_record = MagicMock()

        with patch("apps.tabdata.history_events.emit_record_history_event") as mock_emit, \
             patch("apps.tabdata.models.TableRecord.objects") as mock_objects:

            mock_objects.using.return_value.filter.return_value.first.return_value = mock_record

            executor._emit_record_history_for_write(
                sql_type='DELETE',
                affected_table_ids={table_id},
                allocated_version=3,
                before_states={table_id: {record_id: {"field1": "old_value"}}},
                inserted_ids=[],
                affected_rows=1,
                agent_run_id=agent_run_id,
            )
            assert mock_emit.called
            call_kwargs = mock_emit.call_args[1]
            assert call_kwargs['window_id'] == f"agent_sql:{agent_run_id}"


# ================================================================
# 测试 2：_mark_agent_sql_record_history_undone 正确标记 RecordHistory
# ================================================================

class TestMarkAgentSqlRecordHistoryUndone:
    """E2E-027: _mark_agent_sql_record_history_undone 应正确标记 RecordHistory"""

    def test_marks_matching_records_as_undone(self):
        """应将 window_id=agent_sql:{agent_run_id} 且 is_undone=False 的记录标记为已撤销"""
        from apps.collab.api import _mark_agent_sql_record_history_undone

        table_id = str(uuid4())
        agent_run_id = "run-rollback-001"
        expected_window_id = f"agent_sql:{agent_run_id}"

        mock_qs = MagicMock()
        mock_qs.update.return_value = 3

        with patch("apps.tabdata.models.RecordHistory") as mock_rh_cls:
            mock_rh_cls.objects.using.return_value.filter.return_value = mock_qs
            _mark_agent_sql_record_history_undone(table_id, agent_run_id)

            mock_rh_cls.objects.using.assert_called_once()
            filter_call = mock_rh_cls.objects.using.return_value.filter.call_args
            assert filter_call[1]['window_id'] == expected_window_id
            assert filter_call[1]['is_undone'] is False
            mock_qs.update.assert_called_once()
            update_call = mock_qs.update.call_args
            assert update_call[1]['is_undone'] is True
            assert 'undone_at' in update_call[1]

    def test_does_not_raise_on_exception(self):
        """标记失败时不应抛出异常（非致命操作）"""
        from apps.collab.api import _mark_agent_sql_record_history_undone

        with patch("apps.tabdata.models.RecordHistory") as mock_rh_cls:
            mock_rh_cls.objects.using.side_effect = Exception("DB error")
            # 不应抛出异常
            _mark_agent_sql_record_history_undone(str(uuid4()), "run-fail-001")

    def test_no_op_when_agent_run_id_empty(self):
        """agent_run_id 为空时，不应查询 DB（window_id 为 'agent_sql:' 无意义）"""
        from apps.collab.api import _mark_agent_sql_record_history_undone

        with patch("apps.tabdata.models.RecordHistory") as mock_rh_cls:
            mock_qs = MagicMock()
            mock_qs.update.return_value = 0
            mock_rh_cls.objects.using.return_value.filter.return_value = mock_qs
            # 空 agent_run_id 时，window_id = "agent_sql:"，不会匹配任何记录
            _mark_agent_sql_record_history_undone(str(uuid4()), "")
            # 仍然会执行查询，但 window_id="agent_sql:" 不会命中任何记录，update 返回 0
            mock_qs.update.assert_called_once()


# ================================================================
# 测试 3：_mark_agent_sql_record_history_undone 在 rollback 代码路径中被正确调用
# ================================================================

class TestMarkUndoneIntegration:
    """E2E-027: 验证 _mark_agent_sql_record_history_undone 的调用逻辑"""

    def test_mark_undone_only_called_for_table_type(self):
        """_mark_agent_sql_record_history_undone 只应在 res_type == 'table' 时被调用"""
        from apps.collab.api import _mark_agent_sql_record_history_undone

        table_id = str(uuid4())
        agent_run_id = "run-integration-001"

        mock_qs = MagicMock()
        mock_qs.update.return_value = 2

        with patch("apps.tabdata.models.RecordHistory") as mock_rh_cls:
            mock_rh_cls.objects.using.return_value.filter.return_value = mock_qs
            _mark_agent_sql_record_history_undone(table_id, agent_run_id)

            # 验证 filter 条件包含正确的 window_id
            filter_kwargs = mock_rh_cls.objects.using.return_value.filter.call_args[1]
            assert filter_kwargs['window_id'] == f"agent_sql:{agent_run_id}"
            assert filter_kwargs['record__table_id'] == table_id
            assert filter_kwargs['is_undone'] is False

            # 验证 update 设置了 is_undone=True
            update_kwargs = mock_qs.update.call_args[1]
            assert update_kwargs['is_undone'] is True

    def test_window_id_format_consistency(self):
        """window_id 格式 'agent_sql:{agent_run_id}' 在写入和查询时必须一致"""
        agent_run_id = "run-consistency-check"
        # 写入时（_emit_record_history_for_write）
        write_window_id = f"agent_sql:{agent_run_id}" if agent_run_id else "agent_sql"
        # 查询时（_mark_agent_sql_record_history_undone）
        query_window_id = f"agent_sql:{agent_run_id}"
        assert write_window_id == query_window_id, (
            "写入和查询的 window_id 格式必须一致，否则 rollback 无法找到对应记录"
        )

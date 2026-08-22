"""
DV-002 / DV-003 / DV-012 / DV-016 / DV-032 回归测试（纯单元测试，不依赖数据库）

DV-002: Agent SQL INSERT 路径使用标准 {field: {old: None, new: value}} 格式
DV-003: execute_write 调用 _write_change_log_for_write 写入 VersionHistory + ChangeLog
DV-012: 主 SQL 与 _sync_django_model_version 在同一事务中
DV-016: agent_run_id 从 SQLExecuteTool 传递到 ChangeLog
DV-032: execute_write 主 SQL 在 transaction.atomic 保护内
"""

import inspect
import os
import uuid
from unittest import TestCase
from unittest.mock import patch, MagicMock, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()


def _make_executor(space_id=None, user=None):
    """构建带 Mock 的 AgentSQLExecutor。"""
    with patch('apps.tabdata.native.agent_sql.get_resolver') as mock_get_resolver:
        mock_resolver = MagicMock()
        mock_get_resolver.return_value = mock_resolver
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        sid = space_id or uuid.uuid4()
        u = user or MagicMock()
        u.id = uuid.uuid4()
        executor = AgentSQLExecutor(sid, u)
    return executor, sid, mock_resolver


# ══════════════════════════════════════
# DV-002: INSERT field_changes 标准格式
# ══════════════════════════════════════

class TestDV002InsertFieldChangesFormat(TestCase):
    """DV-002: _emit_record_history_for_write INSERT 路径使用标准 {field: {old, new}} 格式。"""

    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.models.TableRecord.objects')
    @patch('apps.tabdata.history_events.emit_record_history_event')
    def test_insert_uses_standard_format(self, mock_emit, mock_tr_objects, mock_conns):
        """INSERT 路径 field_changes 应为 {field: {'old': None, 'new': value}} 格式，
        而非旧的 {'data': {...}} 格式。"""
        executor, space_id, _ = _make_executor()
        table_id = uuid.uuid4()

        mock_cursor = MagicMock()
        mock_cursor.description = [('__id',), ('__version',), ('f1',), ('f2',)]
        row_id = uuid.uuid4()
        mock_cursor.fetchall.return_value = [
            (row_id, 100, 'hello', 42),
        ]
        mock_conns.__getitem__.return_value.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conns.__getitem__.return_value.cursor.return_value.__exit__ = MagicMock(return_value=False)

        mock_record = MagicMock()
        mock_record.id = row_id
        mock_record.data = {}
        mock_tr_objects.using.return_value.filter.return_value.first.return_value = mock_record

        executor._emit_record_history_for_write(
            sql_type='INSERT',
            affected_table_ids={table_id},
            allocated_version=100,
            before_states={},
            inserted_ids=[str(row_id)],
            affected_rows=1,
            operation_group_id=uuid.uuid4(),
        )

        mock_emit.assert_called_once()
        fc = mock_emit.call_args.kwargs['field_changes']

        self.assertNotIn('data', fc, "INSERT 不应使用旧的 {'data': ...} 格式")
        self.assertIn('f1', fc)
        self.assertIn('f2', fc)
        self.assertEqual(fc['f1'], {'old': None, 'new': 'hello'})
        self.assertEqual(fc['f2'], {'old': None, 'new': 42})
        self.assertEqual(mock_emit.call_args.kwargs['action'], 'create')

    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.models.TableRecord.objects')
    @patch('apps.tabdata.history_events.emit_record_history_event')
    def test_insert_excludes_system_columns(self, mock_emit, mock_tr_objects, mock_conns):
        """INSERT 路径的 field_changes 应排除 __ 开头的系统列。"""
        executor, space_id, _ = _make_executor()
        table_id = uuid.uuid4()

        mock_cursor = MagicMock()
        mock_cursor.description = [
            ('__id',), ('__version',), ('__created_at',), ('__updated_at',), ('title',),
        ]
        row_id = uuid.uuid4()
        mock_cursor.fetchall.return_value = [
            (row_id, 100, '2026-01-01', '2026-01-01', 'test'),
        ]
        mock_conns.__getitem__.return_value.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conns.__getitem__.return_value.cursor.return_value.__exit__ = MagicMock(return_value=False)

        mock_record = MagicMock()
        mock_record.id = row_id
        mock_tr_objects.using.return_value.filter.return_value.first.return_value = mock_record

        executor._emit_record_history_for_write(
            sql_type='INSERT',
            affected_table_ids={table_id},
            allocated_version=100,
            before_states={},
            inserted_ids=[str(row_id)],
            affected_rows=1,
        )

        mock_emit.assert_called_once()
        fc = mock_emit.call_args.kwargs['field_changes']
        for k in fc:
            self.assertFalse(
                str(k).startswith('__'),
                f"field_changes 不应包含系统列: {k}",
            )


class TestDV002UpdateUsesNativeData(TestCase):
    """DV-002: _emit_record_history_for_write UPDATE 路径使用原生表数据而非 record.data。"""

    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.models.TableRecord.objects')
    @patch('apps.tabdata.history_events.emit_record_history_event')
    def test_update_uses_native_after_state(self, mock_emit, mock_tr_objects, mock_conns):
        """UPDATE 路径应从原生表回查 after state，不依赖 record.data。"""
        executor, space_id, _ = _make_executor()
        table_id = uuid.uuid4()
        row_id = uuid.uuid4()

        mock_cursor = MagicMock()
        mock_cursor.description = [('__id',), ('__version',), ('f1',)]
        mock_cursor.fetchall.return_value = [(row_id, 100, 'new_value')]
        mock_conns.__getitem__.return_value.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conns.__getitem__.return_value.cursor.return_value.__exit__ = MagicMock(return_value=False)

        mock_record = MagicMock()
        mock_record.id = row_id
        mock_record.data = {'f1': 'stale_orm_value'}
        mock_tr_objects.using.return_value.filter.return_value.first.return_value = mock_record

        before_states = {
            table_id: {
                str(row_id): {'__id': row_id, '__version': 99, 'f1': 'old_value'},
            },
        }

        executor._emit_record_history_for_write(
            sql_type='UPDATE',
            affected_table_ids={table_id},
            allocated_version=100,
            before_states=before_states,
            inserted_ids=[],
            affected_rows=1,
        )

        mock_emit.assert_called_once()
        fc = mock_emit.call_args.kwargs['field_changes']
        self.assertIn('f1', fc)
        self.assertEqual(fc['f1']['old'], 'old_value')
        self.assertEqual(fc['f1']['new'], 'new_value',
                         "after value 应来自原生表而非 record.data")


# ══════════════════════════════════════
# DV-003: VersionHistory + ChangeLog 写入
# ══════════════════════════════════════

class TestDV003WriteChangeLogForWrite(TestCase):
    """DV-003: execute_write 调用 _write_change_log_for_write 写入 VH + CL。"""

    def test_write_change_log_method_exists(self):
        """_write_change_log_for_write 方法存在。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        self.assertTrue(
            hasattr(AgentSQLExecutor, '_write_change_log_for_write'),
            "AgentSQLExecutor 应包含 _write_change_log_for_write 方法",
        )

    def test_write_change_log_imports_version_history_service(self):
        """_write_change_log_for_write 内部应调用 VersionHistoryService.create_history。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor._write_change_log_for_write)
        self.assertIn('VersionHistoryService', source)
        self.assertIn('create_history', source)
        self.assertIn('ChangeLog', source)

    def test_execute_write_calls_write_change_log(self):
        """execute_write 流程末尾应调用 _write_change_log_for_write。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)
        self.assertIn('_write_change_log_for_write', source)


# ══════════════════════════════════════
# DV-012: 事务一致性
# ══════════════════════════════════════

class TestDV012TransactionConsistency(TestCase):
    """DV-012: 主 SQL + _sync_django_model_version 在同一 transaction.atomic 内。"""

    def test_sync_inside_atomic(self):
        """_sync_django_model_version 调用在 transaction.atomic 块内（通过源码分析验证）。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)

        atomic_start = source.find('transaction.atomic(using=self.db_alias)')
        self.assertGreater(atomic_start, -1, "应有 transaction.atomic")

        sync_call = source.find('_sync_django_model_version')
        self.assertGreater(sync_call, -1, "应有 _sync_django_model_version")

        lines = source.split('\n')
        atomic_line = None
        sync_line = None
        for i, line in enumerate(lines):
            if 'transaction.atomic(using=self.db_alias)' in line and 'with ' in line:
                atomic_line = i
            if '_sync_django_model_version' in line and atomic_line is not None:
                sync_line = i
                break

        self.assertIsNotNone(atomic_line, "应找到 with transaction.atomic 行")
        self.assertIsNotNone(sync_line, "应找到 _sync_django_model_version 行")
        self.assertGreater(
            sync_line, atomic_line,
            "_sync_django_model_version 应在 transaction.atomic 块内（行号在 with 之后）",
        )


# ══════════════════════════════════════
# DV-016: agent_run_id 传递链
# ══════════════════════════════════════

class TestDV016ExecutionRunIdPropagation(TestCase):
    """DV-016: agent_run_id 从 SQLExecuteTool → execute_write → _write_change_log_for_write → ChangeLog。"""

    # DV-016a：SQLExecuteInput.agent_run_id 字段断言已移除——
    # Wave 4a 按 D4 全删 FC 把 SQLExecuteTool / SQLExecuteInput BaseTool 包装层删除，
    # Agent 走 `tabtin table execute` CLI；agent_run_id 仍由
    # AgentSQLExecutor.execute_write(agent_run_id=...) 透传到 ChangeLog
    # （由下面 test_execute_write_accepts_agent_run_id / passes_agent_run_id_to_changelog 覆盖）。

    def test_execute_write_accepts_agent_run_id(self):
        """execute_write 签名应包含 agent_run_id 参数。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        sig = inspect.signature(AgentSQLExecutor.execute_write)
        self.assertIn('agent_run_id', sig.parameters,
                       "execute_write 应接受 agent_run_id 参数")

    def test_write_change_log_receives_agent_run_id(self):
        """_write_change_log_for_write 签名应包含 agent_run_id 参数。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        sig = inspect.signature(AgentSQLExecutor._write_change_log_for_write)
        self.assertIn('agent_run_id', sig.parameters,
                       "_write_change_log_for_write 应接受 agent_run_id 参数")

    def test_execute_write_passes_agent_run_id_to_changelog(self):
        """execute_write 中 _write_change_log_for_write 调用应传递 agent_run_id。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)
        self.assertIn('agent_run_id=agent_run_id', source,
                       "execute_write 应将 agent_run_id 传递给 _write_change_log_for_write")

    # SQLExecuteTool.run 透传 agent_run_id 测试已删除：Wave 4a 删除 BaseTool
    # 包装层后这条路径不存在；agent_run_id 由 api_agent_sql.sql_execute →
    # AgentSQLExecutor.execute_write 直接传递（Open API 路径）。


# ══════════════════════════════════════
# DV-032: execute_write 事务保护
# ══════════════════════════════════════

class TestDV032ExecuteWriteTransactionProtection(TestCase):
    """DV-032: execute_write 使用 transaction.atomic 保护主 SQL 执行。"""

    def test_execute_write_has_transaction_atomic(self):
        """execute_write 源码中应包含 transaction.atomic。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)
        self.assertIn('transaction.atomic', source,
                       "execute_write 应使用 transaction.atomic 保护")

    def test_cursor_execute_inside_atomic(self):
        """cursor.execute 应在 transaction.atomic 块内执行。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)

        lines = source.split('\n')
        atomic_indent = None
        cursor_found_inside = False

        for line in lines:
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            if 'with transaction.atomic(using=self.db_alias)' in line:
                atomic_indent = indent
            if atomic_indent is not None and 'cursor.execute(' in line:
                if indent > atomic_indent:
                    cursor_found_inside = True
                    break

        self.assertTrue(
            cursor_found_inside,
            "cursor.execute 应在 transaction.atomic with 块的缩进内",
        )


# ══════════════════════════════════════
# DV-002: _capture_after_states 方法
# ══════════════════════════════════════

class TestDV002CaptureAfterStates(TestCase):
    """DV-002: _capture_after_states 从原生表回查写入后数据。"""

    def test_capture_after_states_exists(self):
        """AgentSQLExecutor 应包含 _capture_after_states 方法。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        self.assertTrue(
            hasattr(AgentSQLExecutor, '_capture_after_states'),
            "AgentSQLExecutor 应包含 _capture_after_states 方法",
        )

    @patch('apps.tabdata.native.agent_sql.DDLManager')
    @patch('apps.tabdata.native.agent_sql.connections')
    def test_capture_after_states_returns_data(self, mock_conns, mock_ddl):
        """_capture_after_states 应从原生表回查并返回正确结构。"""
        executor, space_id, _ = _make_executor()
        table_id = uuid.uuid4()
        row_id = uuid.uuid4()

        mock_ddl.qualified_table_name.return_value = f'"as_{space_id.hex}"."tbl_{table_id.hex}"'

        mock_cursor = MagicMock()
        mock_cursor.description = [('__id',), ('__version',), ('f1',)]
        mock_cursor.fetchall.return_value = [(row_id, 100, 'val')]
        mock_conns.__getitem__.return_value.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conns.__getitem__.return_value.cursor.return_value.__exit__ = MagicMock(return_value=False)

        result = executor._capture_after_states({table_id}, 100)

        self.assertIn(table_id, result)
        self.assertIn(str(row_id), result[table_id])
        row_data = result[table_id][str(row_id)]
        self.assertEqual(row_data['f1'], 'val')

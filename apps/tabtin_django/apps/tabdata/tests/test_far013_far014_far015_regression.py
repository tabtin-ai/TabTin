"""
FAR-013 / FAR-014 / FAR-015 回归测试（纯单元测试，不依赖数据库）

FAR-013: MAX_WRITE_ROWS 执行前预检——_estimate_affected_rows 超限时拒绝执行
FAR-014: _RE_TRIVIAL_WHERE 覆盖 "__id" IS NOT NULL 恒真条件；
         SQLExecuteTool.description 不再引导全表更新
FAR-015: DELETE 后 _sync_django_model_delete 将 tabdata_record.is_deleted 置 True
"""

import os
import re
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
# FAR-013: _estimate_affected_rows 预检
# ══════════════════════════════════════

class TestFAR013EstimateAffectedRows(TestCase):
    """FAR-013: _estimate_affected_rows 超出 MAX_WRITE_ROWS 时抛出 WriteUnsafeError。"""

    def test_estimate_raises_when_exceeds_limit(self):
        """COUNT(*) 返回超过 MAX_WRITE_ROWS 时应抛出 WriteUnsafeError。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor, WriteUnsafeError
        from apps.tabdata.native.ddl_manager import DDLManager

        executor, space_id, _ = _make_executor()
        table_id = uuid.uuid4()

        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = (AgentSQLExecutor.MAX_WRITE_ROWS + 1,)
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)

        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch('apps.tabdata.native.agent_sql.connections') as mock_conns, \
             patch.object(DDLManager, 'qualified_table_name', return_value='"as_abc"."tbl_xyz"'):
            mock_conns.__getitem__.return_value = mock_conn

            with self.assertRaises(WriteUnsafeError) as ctx:
                executor._estimate_affected_rows(
                    resolved_sql='UPDATE "as_abc"."tbl_xyz" SET "f" = %s WHERE "status" = %s',
                    exec_params=['done', 'active'],
                    sql_type='UPDATE',
                    affected_table_ids={table_id},
                )
            self.assertIn('exceeding the safety limit', str(ctx.exception))

    def test_estimate_passes_when_within_limit(self):
        """COUNT(*) 返回不超过 MAX_WRITE_ROWS 时不应抛出异常。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        from apps.tabdata.native.ddl_manager import DDLManager

        executor, space_id, _ = _make_executor()
        table_id = uuid.uuid4()

        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = (10,)
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)

        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch('apps.tabdata.native.agent_sql.connections') as mock_conns, \
             patch.object(DDLManager, 'qualified_table_name', return_value='"as_abc"."tbl_xyz"'):
            mock_conns.__getitem__.return_value = mock_conn

            result = executor._estimate_affected_rows(
                resolved_sql='UPDATE "as_abc"."tbl_xyz" SET "f" = %s WHERE "__id" = %s',
                exec_params=['done', str(uuid.uuid4())],
                sql_type='UPDATE',
                affected_table_ids={table_id},
            )
        self.assertEqual(result, 10)

    def test_estimate_skips_insert(self):
        """INSERT 不需要预检，直接返回 0。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        executor, _, _ = _make_executor()
        result = executor._estimate_affected_rows(
            resolved_sql='INSERT INTO "as_abc"."tbl_xyz" ("f") VALUES (%s)',
            exec_params=['val'],
            sql_type='INSERT',
            affected_table_ids={uuid.uuid4()},
        )
        self.assertEqual(result, 0)


# ══════════════════════════════════════
# FAR-014: _RE_TRIVIAL_WHERE 覆盖 __id IS NOT NULL
# ══════════════════════════════════════

class TestFAR014TrivialWhereRegex(TestCase):
    """FAR-014: _RE_TRIVIAL_WHERE 应拦截 WHERE "__id" IS NOT NULL 等恒真条件。"""

    def setUp(self):
        from apps.tabdata.native.agent_sql import _RE_TRIVIAL_WHERE
        self.regex = _RE_TRIVIAL_WHERE

    def test_rejects_id_is_not_null(self):
        """WHERE "__id" IS NOT NULL 应被拦截。"""
        sql = 'UPDATE "as_abc"."tbl_xyz" SET "f" = %s WHERE "__id" IS NOT NULL'
        self.assertIsNotNone(self.regex.search(sql))

    def test_rejects_id_is_not_null_with_semicolon(self):
        """WHERE "__id" IS NOT NULL; 应被拦截。"""
        sql = 'UPDATE "as_abc"."tbl_xyz" SET "f" = %s WHERE "__id" IS NOT NULL;'
        self.assertIsNotNone(self.regex.search(sql))

    def test_rejects_1_equals_1(self):
        """WHERE 1=1 应被拦截（原有功能保持）。"""
        sql = 'UPDATE "as_abc"."tbl_xyz" SET "f" = %s WHERE 1=1'
        self.assertIsNotNone(self.regex.search(sql))

    def test_rejects_true(self):
        """WHERE TRUE 应被拦截（原有功能保持）。"""
        sql = 'UPDATE "as_abc"."tbl_xyz" SET "f" = %s WHERE TRUE'
        self.assertIsNotNone(self.regex.search(sql))

    def test_allows_specific_where(self):
        """WHERE "__id" = %s 不应被拦截。"""
        sql = 'UPDATE "as_abc"."tbl_xyz" SET "f" = %s WHERE "__id" = %s'
        self.assertIsNone(self.regex.search(sql))

    def test_allows_status_where(self):
        """WHERE "status" = %s 不应被拦截。"""
        sql = 'UPDATE "as_abc"."tbl_xyz" SET "f" = %s WHERE "status" = %s'
        self.assertIsNone(self.regex.search(sql))

    def test_validate_write_safety_rejects_id_is_not_null(self):
        """_validate_write_safety 应对 WHERE "__id" IS NOT NULL 抛出 WriteUnsafeError。"""
        from apps.tabdata.native.agent_sql import WriteUnsafeError

        executor, _, _ = _make_executor()
        sql = 'UPDATE "as_abc"."tbl_xyz" SET "f" = %s WHERE "__id" IS NOT NULL'
        with self.assertRaises(WriteUnsafeError):
            executor._validate_write_safety('UPDATE', sql)


# FAR-014（SQLExecuteTool description 不引导全表更新）测试已删除：Wave 4a 按
# D4 全删 FC 把 SQLExecuteTool BaseTool 包装层删掉，Agent 走 `tabtin table
# execute` CLI；底层 _RE_TRIVIAL_WHERE 守门由上面 TestFAR014TrivialConditions
# 类覆盖（直测 `_validate_write_safety`），description 测试不再适用。


# ══════════════════════════════════════
# FAR-015: _sync_django_model_delete
# ══════════════════════════════════════

class TestFAR015SyncDjangoModelDelete(TestCase):
    """FAR-015: DELETE 后 _sync_django_model_delete 将 tabdata_record.is_deleted 置 True。"""

    def test_sync_delete_updates_is_deleted(self):
        """_sync_django_model_delete 应对 before_states 中的记录执行 is_deleted=TRUE 更新。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        executor, space_id, _ = _make_executor()
        table_id = uuid.uuid4()
        record_id_1 = str(uuid.uuid4())
        record_id_2 = str(uuid.uuid4())

        before_states = {
            table_id: {
                record_id_1: {'__id': record_id_1, 'f': 'val1'},
                record_id_2: {'__id': record_id_2, 'f': 'val2'},
            }
        }

        mock_cursor = MagicMock()
        mock_cursor.rowcount = 2
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)

        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch('apps.tabdata.native.agent_sql.connections') as mock_conns:
            mock_conns.__getitem__.return_value = mock_conn

            executor._sync_django_model_delete(
                affected_table_ids={table_id},
                before_states=before_states,
            )

        mock_cursor.execute.assert_called_once()
        call_args = mock_cursor.execute.call_args
        sql_executed = call_args[0][0]
        params_executed = call_args[0][1]

        self.assertIn('is_deleted = TRUE', sql_executed)
        self.assertIn('tabdata_record', sql_executed)
        self.assertIn(str(table_id), params_executed)
        self.assertIn(record_id_1, params_executed)
        self.assertIn(record_id_2, params_executed)

    def test_sync_delete_skips_empty_before_states(self):
        """before_states 为空时不应执行任何 SQL。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        executor, _, _ = _make_executor()
        table_id = uuid.uuid4()

        mock_cursor = MagicMock()
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)

        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch('apps.tabdata.native.agent_sql.connections') as mock_conns:
            mock_conns.__getitem__.return_value = mock_conn

            executor._sync_django_model_delete(
                affected_table_ids={table_id},
                before_states={},
            )

        mock_cursor.execute.assert_not_called()

    def test_execute_write_source_calls_sync_delete_on_delete(self):
        """execute_write 源码中 DELETE 路径应调用 _sync_django_model_delete。"""
        import inspect
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        src = inspect.getsource(AgentSQLExecutor.execute_write)
        # 确认 DELETE 分支中调用了 _sync_django_model_delete
        self.assertIn('_sync_django_model_delete', src,
                      "execute_write 应在 DELETE 路径调用 _sync_django_model_delete")
        # 确认调用在 sql_type == 'DELETE' 条件下
        self.assertIn("sql_type == 'DELETE'", src,
                      "execute_write 应有 sql_type == 'DELETE' 条件分支")

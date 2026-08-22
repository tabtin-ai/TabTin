"""
Phase 4 Agent SQL 测试

验证 Agent SQL 层的完整功能链：
- NameResolver: 中文名 → 内部名解析
- AgentSQLExecutor: 安全层 + 执行
- API 端点基本行为
- Agent 工具包装

使用 Mock 方式测试，避免依赖真实 PostgreSQL 连接。
"""

import json
import uuid
from unittest.mock import patch, MagicMock, PropertyMock
from django.test import TestCase, SimpleTestCase


# ══════════════════════════════════════
# 辅助函数
# ══════════════════════════════════════

def _make_table(table_id=None, name="任务规划", project_id=None):
    """创建 Mock Table 对象。"""
    t = MagicMock()
    t.id = table_id or uuid.uuid4()
    t.name = name
    t.project_id = project_id or uuid.uuid4()
    t.is_archived = False
    return t


def _make_field(field_id=None, name="标题", field_type="text", table_id=None):
    """创建 Mock TableField 对象。"""
    f = MagicMock()
    f.id = field_id or uuid.uuid4()
    f.name = name
    f.field_type = field_type
    f.table_id = table_id or uuid.uuid4()
    f.is_deleted = False
    return f


# ══════════════════════════════════════
# NameResolver 测试
# ══════════════════════════════════════

class TestNameResolver(TestCase):
    """名称解析器测试"""

    def _build_resolver(self, tables=None, fields=None):
        """构建带 Mock 元数据的 NameResolver。"""
        project_id = uuid.uuid4()

        table_data = tables or [
            (uuid.uuid4(), "任务规划"),
            (uuid.uuid4(), "bug追踪"),
        ]
        field_data = fields or []

        # 自动为每个表生成默认字段
        if not fields:
            for tid, tname in table_data:
                field_data.append((uuid.uuid4(), tid, "标题", "text"))
                field_data.append((uuid.uuid4(), tid, "状态", "select"))
                if tname == "任务规划":
                    field_data.append((uuid.uuid4(), tid, "阶段", "number"))

        with patch('apps.tabdata.models.Table') as MockTable, \
             patch('apps.tabdata.models.TableField') as MockField:

            # Mock Table.objects.filter().values_list()
            MockTable.objects.filter.return_value.values_list.return_value = table_data

            # Mock TableField.objects.filter().values_list()
            MockField.objects.filter.return_value.values_list.return_value = field_data

            from apps.tabdata.native.name_resolver import NameResolver
            resolver = NameResolver(project_id)

        return resolver, project_id, table_data, field_data

    def test_resolve_table_found(self):
        """已知表名解析为 schema-qualified 名称"""
        resolver, project_id, tables, _ = self._build_resolver()
        result = resolver.resolve_table("任务规划")
        self.assertIn("as_", result)
        self.assertIn("tbl_", result)
        self.assertTrue(result.startswith('"'))

    def test_resolve_table_not_found(self):
        """未知表名抛出 TableNotFoundError"""
        from apps.tabdata.native.name_resolver import TableNotFoundError
        resolver, _, _, _ = self._build_resolver()
        with self.assertRaises(TableNotFoundError):
            resolver.resolve_table("不存在的表")

    def test_resolve_field_found(self):
        """已知字段名解析为列名"""
        resolver, _, _, _ = self._build_resolver()
        result = resolver.resolve_field("任务规划", "标题")
        self.assertTrue(result.startswith('"'))
        self.assertTrue(result.endswith('"'))
        # 列名应是 32 位 hex
        col_name = result.strip('"')
        self.assertEqual(len(col_name), 32)

    def test_resolve_field_not_found(self):
        """未知字段名抛出 FieldNotFoundError"""
        from apps.tabdata.native.name_resolver import FieldNotFoundError
        resolver, _, _, _ = self._build_resolver()
        with self.assertRaises(FieldNotFoundError):
            resolver.resolve_field("任务规划", "不存在的字段")

    def test_resolve_field_system_alias(self):
        """系统字段中文别名解析"""
        resolver, _, _, _ = self._build_resolver()
        result = resolver.resolve_field("任务规划", "创建时间")
        self.assertEqual(result, '"__created_at"')

        result = resolver.resolve_field("任务规划", "ID")
        self.assertEqual(result, '"__id"')

    def test_resolve_sql_select(self):
        """完整 SELECT SQL 中表名和字段名替换"""
        resolver, _, _, _ = self._build_resolver()
        sql = 'SELECT "标题", "状态" FROM "任务规划" WHERE "阶段" > %s'
        resolved, mapping = resolver.resolve_sql(sql)

        # 原始中文名不应出现在解析后的 SQL 中
        self.assertNotIn("标题", resolved)
        self.assertNotIn("任务规划", resolved)
        # 内部名应出现
        self.assertIn("as_", resolved)
        self.assertIn("tbl_", resolved)
        # mapping 应包含解析的名称
        self.assertIn("任务规划", mapping)
        self.assertIn("标题", mapping)

    def test_resolve_sql_backtick(self):
        """反引号语法支持"""
        resolver, _, _, _ = self._build_resolver()
        sql = 'SELECT `标题` FROM `任务规划`'
        resolved, mapping = resolver.resolve_sql(sql)
        self.assertIn("任务规划", mapping)
        self.assertIn("标题", mapping)

    def test_resolve_sql_dot_qualified(self):
        """点号限定 "表名"."字段名" 语法"""
        resolver, _, _, _ = self._build_resolver()
        sql = 'SELECT "任务规划"."标题" FROM "任务规划"'
        resolved, mapping = resolver.resolve_sql(sql)
        self.assertIn("标题", mapping)
        self.assertIn("任务规划", mapping)

    def test_ambiguous_field_detection(self):
        """多表同名字段的歧义检测"""
        from apps.tabdata.native.name_resolver import AmbiguousFieldError

        project_id = uuid.uuid4()
        tid1 = uuid.uuid4()
        tid2 = uuid.uuid4()

        tables = [(tid1, "任务规划"), (tid2, "bug追踪")]
        # 两张表都有"状态"字段
        fields = [
            (uuid.uuid4(), tid1, "状态", "select"),
            (uuid.uuid4(), tid2, "状态", "select"),
        ]

        resolver, _, _, _ = self._build_resolver(tables=tables, fields=fields)
        # 同时引用两张表，使用歧义字段
        sql = 'SELECT "状态" FROM "任务规划", "bug追踪"'
        with self.assertRaises(AmbiguousFieldError):
            resolver.resolve_sql(sql)

    def test_build_catalog(self):
        """目录构建完整性"""
        resolver, project_id, _, _ = self._build_resolver()
        catalog = resolver.build_catalog(project_id, compact=False)

        self.assertIn("project_id", catalog)
        self.assertIn("tables", catalog)
        self.assertTrue(len(catalog["tables"]) >= 2)

        table_names = [t["name"] for t in catalog["tables"]]
        self.assertIn("任务规划", table_names)
        self.assertIn("bug追踪", table_names)

        for table in catalog["tables"]:
            self.assertIn("fields", table)
            self.assertIn("system_fields", table)
            self.assertIn("internal_name", table)

    def test_get_table_ids_from_sql(self):
        """从解析后 SQL 中提取表 ID"""
        resolver, _, tables, _ = self._build_resolver()
        table_id = tables[0][0]
        hex_str = table_id.hex

        sql = f'SELECT * FROM "as_xxx"."tbl_{hex_str}"'
        ids = resolver.get_table_ids_from_sql(sql)
        self.assertIn(table_id, ids)


# ══════════════════════════════════════
# SQL 分类测试
# ══════════════════════════════════════

class TestSQLClassification(TestCase):
    """SQL 语句分类测试"""

    def _make_executor(self):
        """创建带 Mock 的 AgentSQLExecutor。"""
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(uuid.uuid4(), MagicMock())
        return executor

    def test_classify_select(self):
        """SELECT 正确分类"""
        executor = self._make_executor()
        self.assertEqual(executor.classify_sql("SELECT * FROM t"), "SELECT")

    def test_classify_insert(self):
        """INSERT 正确分类"""
        executor = self._make_executor()
        self.assertEqual(
            executor.classify_sql("INSERT INTO t (a) VALUES (1)"), "INSERT"
        )

    def test_classify_update(self):
        """UPDATE 正确分类"""
        executor = self._make_executor()
        self.assertEqual(
            executor.classify_sql("UPDATE t SET a = 1 WHERE b = 2"), "UPDATE"
        )

    def test_classify_delete(self):
        """DELETE 正确分类"""
        executor = self._make_executor()
        self.assertEqual(
            executor.classify_sql("DELETE FROM t WHERE a = 1"), "DELETE"
        )

    def test_reject_create(self):
        """CREATE TABLE 被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql("CREATE TABLE t (id INT)")

    def test_reject_drop(self):
        """DROP TABLE 被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql("DROP TABLE t")

    def test_reject_alter(self):
        """ALTER TABLE 被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql("ALTER TABLE t ADD COLUMN x INT")

    def test_reject_grant(self):
        """GRANT 被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql("GRANT ALL ON t TO user1")

    def test_reject_multi_statement(self):
        """多语句 SQL 被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql("SELECT 1; DROP TABLE t")

    def test_reject_empty(self):
        """空 SQL 被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql("")

    def test_strip_comments(self):
        """注释被剥离后正确分类"""
        executor = self._make_executor()
        sql = "/* comment */ SELECT * FROM t"
        self.assertEqual(executor.classify_sql(sql), "SELECT")


# ══════════════════════════════════════
# Schema 限制测试
# ══════════════════════════════════════

class TestSchemaRestriction(TestCase):
    """Schema 限制验证测试"""

    def _make_executor(self, project_id=None):
        project_id = project_id or uuid.uuid4()
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(project_id, MagicMock())
        return executor

    def test_valid_schema_passes(self):
        """正确 schema 通过验证"""
        project_id = uuid.uuid4()
        executor = self._make_executor(project_id)
        schema = f"as_{project_id.hex}"
        sql = f'SELECT * FROM "{schema}"."tbl_abc123"'
        executor._validate_schema_restriction(sql)

    def test_cross_schema_rejected(self):
        """引用其他 schema 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        project_id = uuid.uuid4()
        other_id = uuid.uuid4()
        executor = self._make_executor(project_id)
        sql = f'SELECT * FROM "as_{other_id.hex}"."tbl_abc123"'
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_cross_schema_subquery_rejected(self):
        """子查询中引用其他 schema 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        project_id = uuid.uuid4()
        other_id = uuid.uuid4()
        executor = self._make_executor(project_id)
        sql = (
            f'SELECT * FROM "as_{project_id.hex}"."tbl_aaa" '
            f'WHERE "__id" IN (SELECT "__id" FROM "as_{other_id.hex}"."tbl_bbb")'
        )
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_cross_schema_join_rejected(self):
        """JOIN 中引用其他 schema 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        project_id = uuid.uuid4()
        other_id = uuid.uuid4()
        executor = self._make_executor(project_id)
        sql = (
            f'SELECT a."col1" FROM "as_{project_id.hex}"."tbl_aaa" a '
            f'JOIN "as_{other_id.hex}"."tbl_bbb" b ON a."__id" = b."__id"'
        )
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_no_schema_ref_passes(self):
        """不含 schema 引用的 SQL 通过验证（降级为表白名单检查）"""
        project_id = uuid.uuid4()
        executor = self._make_executor(project_id)
        sql = 'SELECT * FROM "tbl_abc123"'
        executor._validate_schema_restriction(sql)

    def test_multiple_valid_schemas_with_cross_space(self):
        """跨 Space 模式下，允许的多 schema 全部通过"""
        project_id = uuid.uuid4()
        other_id = uuid.uuid4()
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(project_id, MagicMock(), allow_cross_space=True)
        expected_schema = f"as_{project_id.hex}"
        other_schema = f"as_{other_id.hex}"
        executor._allowed_schemas = {expected_schema, other_schema}
        sql = (
            f'SELECT * FROM "{expected_schema}"."tbl_a" '
            f'JOIN "{other_schema}"."tbl_b" ON 1=1'
        )
        executor._validate_schema_restriction(sql)


# ══════════════════════════════════════
# 写入安全测试
# ══════════════════════════════════════

class TestWriteSafety(TestCase):
    """写入安全验证测试"""

    def _make_executor(self):
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(uuid.uuid4(), MagicMock())
        return executor

    def test_update_without_where_rejected(self):
        """UPDATE 无 WHERE 被拒绝"""
        from apps.tabdata.native.agent_sql import WriteUnsafeError
        executor = self._make_executor()
        sql = 'UPDATE "as_xxx"."tbl_yyy" SET "col" = 1'
        with self.assertRaises(WriteUnsafeError):
            executor._validate_write_safety("UPDATE", sql)

    def test_delete_without_flag_rejected(self):
        """DELETE 无 allow_delete 被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        sql = 'DELETE FROM "as_xxx"."tbl_yyy" WHERE "col" = 1'
        with self.assertRaises(ForbiddenSQLError):
            executor._validate_write_safety("DELETE", sql, allow_delete=False)

    def test_delete_with_flag_and_where_passes(self):
        """DELETE + allow_delete + WHERE 通过"""
        executor = self._make_executor()
        sql = 'DELETE FROM "as_xxx"."tbl_yyy" WHERE "col" = 1'
        # 不应抛异常
        executor._validate_write_safety("DELETE", sql, allow_delete=True)

    def test_update_with_where_passes(self):
        """UPDATE + WHERE 通过"""
        executor = self._make_executor()
        sql = 'UPDATE "as_xxx"."tbl_yyy" SET "col" = 1 WHERE "id" = 2'
        # 不应抛异常
        executor._validate_write_safety("UPDATE", sql)

    def test_update_where_true_rejected(self):
        """UPDATE WHERE TRUE 被拒绝"""
        from apps.tabdata.native.agent_sql import WriteUnsafeError
        executor = self._make_executor()
        sql = 'UPDATE "as_xxx"."tbl_yyy" SET "col" = 1 WHERE TRUE'
        with self.assertRaises(WriteUnsafeError):
            executor._validate_write_safety("UPDATE", sql)

    def test_insert_no_where_allowed(self):
        """INSERT 不需要 WHERE"""
        executor = self._make_executor()
        sql = 'INSERT INTO "as_xxx"."tbl_yyy" ("col") VALUES (1)'
        # 不应抛异常
        executor._validate_write_safety("INSERT", sql)


# ══════════════════════════════════════
# 执行测试（Mock cursor）
# ══════════════════════════════════════

class TestExecuteRead(TestCase):
    """execute_read 测试"""

    @patch('django.db.transaction.atomic')
    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.native.agent_sql.NameResolver')
    def test_select_returns_data(self, MockResolver, mock_connections, mock_atomic):
        """SELECT 正确返回数据和列名"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        space_id = uuid.uuid4()
        schema = f"as_{space_id.hex}"

        # Mock resolver
        resolver_instance = MockResolver.return_value
        resolver_instance.resolve_sql.return_value = (
            f'SELECT "col_hex1" FROM "{schema}"."tbl_yyy" LIMIT 1000',
            {"标题": '"col_hex1"', "任务规划": f'"{schema}"."tbl_yyy"'},
        )
        resolver_instance.get_table_ids_from_sql.return_value = set()

        # Mock transaction.atomic as no-op context manager
        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

        # Mock cursor
        mock_cursor = MagicMock()
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)
        mock_cursor.description = [("col_hex1",)]
        mock_cursor.fetchall.return_value = [("测试值",)]
        mock_connections.__getitem__.return_value.cursor.return_value = mock_cursor

        executor = AgentSQLExecutor(space_id, MagicMock())
        result = executor.execute_read('SELECT "标题" FROM "任务规划"')

        self.assertIn("columns", result)
        self.assertIn("rows", result)
        self.assertIn("row_count", result)
        self.assertEqual(result["row_count"], 1)
        # 列名应反向映射为中文
        self.assertIn("标题", result["columns"])

    @patch('apps.tabdata.native.agent_sql.NameResolver')
    def test_read_rejects_insert(self, MockResolver):
        """execute_read 拒绝 INSERT"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor, ForbiddenSQLError

        executor = AgentSQLExecutor(uuid.uuid4(), MagicMock())
        with self.assertRaises(ForbiddenSQLError):
            executor.execute_read('INSERT INTO t (a) VALUES (1)')


class TestExecuteWrite(TestCase):
    """execute_write 测试"""

    @patch('apps.tabdata.models.Table')
    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.native.agent_sql.NameResolver')
    def test_update_returns_affected_rows(self, MockResolver, mock_connections, MockTable):
        """UPDATE 正确返回受影响行数"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        resolver_instance = MockResolver.return_value
        table_id = uuid.uuid4()
        project_id = uuid.uuid4()
        schema = f"as_{project_id.hex}"
        tbl = f"tbl_{table_id.hex}"

        resolver_instance.resolve_sql.return_value = (
            f'UPDATE "{schema}"."{tbl}" SET "col" = %s WHERE "col2" = %s',
            {"任务规划": f'"{schema}"."{tbl}"'},
        )
        resolver_instance.get_table_ids_from_sql.return_value = {table_id}

        # Mock Table.objects.using().filter().values_list() for whitelist validation
        MockTable.objects.using.return_value.filter.return_value.values_list.return_value = [table_id]

        mock_cursor = MagicMock()
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)
        mock_cursor.rowcount = 3
        mock_connections.__getitem__.return_value.cursor.return_value = mock_cursor

        with patch('apps.tabdata.services.record_service.next_record_version', return_value=42), \
             patch('apps.tabdata.services.table_event_service.table_event_service') as mock_event:

            mock_user = MagicMock()
            mock_user.id = uuid.uuid4()
            executor = AgentSQLExecutor(project_id, mock_user)
            result = executor.execute_write(
                'UPDATE "任务规划" SET "状态" = %s WHERE "标题" = %s',
                params=["完成", "旧"],
            )

        self.assertEqual(result["affected_rows"], 3)
        self.assertEqual(result["sql_type"], "UPDATE")
        self.assertIn(str(table_id), result["versions"])

    @patch('apps.tabdata.native.agent_sql.NameResolver')
    def test_write_rejects_select(self, MockResolver):
        """execute_write 拒绝 SELECT"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor, ForbiddenSQLError

        executor = AgentSQLExecutor(uuid.uuid4(), MagicMock())
        with self.assertRaises(ForbiddenSQLError):
            executor.execute_write('SELECT * FROM t')


# ══════════════════════════════════════
# 写入元数据注入测试
# ══════════════════════════════════════

class TestWriteMetadataInjection(TestCase):
    """写入元数据注入测试"""

    def _make_executor(self):
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            user = MagicMock()
            user.id = uuid.uuid4()
            executor = AgentSQLExecutor(uuid.uuid4(), user)
        return executor

    def test_update_injects_version(self):
        """UPDATE 注入绝对 __version"""
        executor = self._make_executor()
        sql = 'UPDATE "as_xxx"."tbl_yyy" SET "col" = 1 WHERE "id" = 2'
        result = executor._inject_write_metadata("UPDATE", sql, version=42)
        self.assertIn('"__version" = 42', result)
        self.assertIn('"__updated_at" = NOW()', result)

    def test_insert_injects_system_cols(self):
        """INSERT 注入系统列"""
        executor = self._make_executor()
        sql = 'INSERT INTO "as_xxx"."tbl_yyy" ("col1") VALUES (1)'
        result = executor._inject_write_metadata("INSERT", sql, version=10)
        self.assertIn("__version", result)
        self.assertIn("__created_at", result)


# ══════════════════════════════════════
# 错误码测试
# ══════════════════════════════════════

class TestErrorCodes(TestCase):
    """Agent SQL 错误码存在性测试"""

    def test_sql_error_codes_exist(self):
        """所有 SQL 错误码已注册"""
        from apps.tabdata.error_codes import ErrorCode, ErrorMessage

        codes = [
            ErrorCode.SQL_FORBIDDEN,
            ErrorCode.SQL_SCHEMA_VIOLATION,
            ErrorCode.SQL_NAME_RESOLUTION_FAILED,
            ErrorCode.SQL_WRITE_UNSAFE,
            ErrorCode.SQL_EXECUTION_ERROR,
        ]
        for code in codes:
            self.assertIn(code, ErrorMessage.MESSAGES)


# ══════════════════════════════════════
# Schema 定义测试
# ══════════════════════════════════════

class TestSchemas(TestCase):
    """Agent SQL Schema 存在性测试"""

    def test_query_request_schema(self):
        """AgentSQLQueryRequest schema 存在且可实例化"""
        from apps.tabdata.schemas import AgentSQLQueryRequest
        req = AgentSQLQueryRequest(sql="SELECT 1")
        self.assertEqual(req.sql, "SELECT 1")
        self.assertIsNone(req.params)

    def test_execute_request_schema(self):
        """AgentSQLExecuteRequest schema 存在且可实例化"""
        from apps.tabdata.schemas import AgentSQLExecuteRequest
        req = AgentSQLExecuteRequest(sql="INSERT INTO t (a) VALUES (1)")
        self.assertFalse(req.allow_delete)

    def test_query_request_validates_min_length(self):
        """SQL 空字符串验证失败"""
        from apps.tabdata.schemas import AgentSQLQueryRequest
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            AgentSQLQueryRequest(sql="")


# ══════════════════════════════════════
# Agent 工具测试 — Wave 4a (D4 全删 FC) 后已移除
# ══════════════════════════════════════
#
# 原 TestAgentTools 类断言 SQLCatalogTool / SQLQueryTool / SQLExecuteTool BaseTool
# 包装层属性 + 注册到 ToolHub。Wave 4a 按 D4 全删 FC 把这三个 BaseTool 类删除，
# Agent 走 `tabtin table query/execute` CLI（cli-server 路由 → Open API
# `/spaces/{space_id}/sql/query|execute|catalog`）。底层 AgentSQLExecutor 不变，
# 由下方 TestAPIRegistration / TestSchemaIsolationP009 等覆盖。


# ══════════════════════════════════════
# API 路由注册测试
# ══════════════════════════════════════

class TestAPIRegistration(TestCase):
    """API 路由注册测试"""

    def test_agent_sql_router_exists(self):
        """api_agent_sql 模块的 router 存在"""
        from apps.tabdata.api_agent_sql import router
        self.assertIsNotNone(router)

    def test_api_imports_agent_sql_router(self):
        """api.py 导入了 agent_sql_router"""
        import inspect
        import apps.tabdata.api as api_mod
        source = inspect.getsource(api_mod)
        self.assertIn('agent_sql_router', source)

    def test_error_codes_module_has_sql_codes(self):
        """error_codes 模块包含 SQL 相关错误码"""
        from apps.tabdata.error_codes import ErrorCode
        self.assertTrue(hasattr(ErrorCode, 'SQL_FORBIDDEN'))
        self.assertTrue(hasattr(ErrorCode, 'SQL_SCHEMA_VIOLATION'))
        self.assertTrue(hasattr(ErrorCode, 'SQL_NAME_RESOLUTION_FAILED'))
        self.assertTrue(hasattr(ErrorCode, 'SQL_WRITE_UNSAFE'))
        self.assertTrue(hasattr(ErrorCode, 'SQL_EXECUTION_ERROR'))


# ══════════════════════════════════════
# P0-09 Schema 隔离白名单回归测试
# ══════════════════════════════════════

class TestSchemaIsolationP009(TestCase):
    """
    P0-09 回归测试：_RE_SCHEMA_REF 正则必须匹配 DDLManager 生成的 as_ 前缀 schema。
    确保跨 schema SQL 被正确拦截，系统 schema 被禁止访问。
    """

    def _make_executor(self, space_id=None):
        space_id = space_id or uuid.uuid4()
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(space_id, MagicMock())
        return executor, space_id

    def test_regex_matches_ddl_manager_output(self):
        """_RE_SCHEMA_REF 正则与 DDLManager.schema_name 输出格式一致"""
        from apps.tabdata.native.agent_sql import _RE_SCHEMA_REF
        from apps.tabdata.native.ddl_manager import DDLManager

        for _ in range(10):
            sid = uuid.uuid4()
            schema = DDLManager.schema_name(sid)
            sql = f'SELECT * FROM "{schema}"."tbl_abc"'
            found = _RE_SCHEMA_REF.findall(sql)
            self.assertEqual(found, [schema], f"Regex should capture '{schema}' from SQL")

    def test_regex_does_not_match_proj_prefix(self):
        """_RE_SCHEMA_REF 不匹配旧的 proj_ 前缀（P0-09 根因验证）"""
        from apps.tabdata.native.agent_sql import _RE_SCHEMA_REF

        fake_schema = f"proj_{uuid.uuid4().hex}"
        sql = f'SELECT * FROM "{fake_schema}"."tbl_abc"'
        found = _RE_SCHEMA_REF.findall(sql)
        self.assertEqual(found, [], "Regex must NOT match proj_ prefix schemas")

    def test_cross_schema_select_blocked(self):
        """跨 schema 的 SELECT 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, space_id = self._make_executor()
        attacker_schema = f"as_{uuid.uuid4().hex}"
        sql = f'SELECT * FROM "{attacker_schema}"."tbl_target"'
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_cross_schema_update_blocked(self):
        """跨 schema 的 UPDATE 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, space_id = self._make_executor()
        attacker_schema = f"as_{uuid.uuid4().hex}"
        own_schema = f"as_{space_id.hex}"
        sql = (
            f'UPDATE "{attacker_schema}"."tbl_target" '
            f'SET "col" = 1 WHERE "__id" IN '
            f'(SELECT "__id" FROM "{own_schema}"."tbl_own")'
        )
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_cross_schema_delete_blocked(self):
        """跨 schema 的 DELETE 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, space_id = self._make_executor()
        attacker_schema = f"as_{uuid.uuid4().hex}"
        sql = f'DELETE FROM "{attacker_schema}"."tbl_target" WHERE "col" = 1'
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_cross_schema_insert_blocked(self):
        """跨 schema 的 INSERT 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, space_id = self._make_executor()
        attacker_schema = f"as_{uuid.uuid4().hex}"
        sql = f'INSERT INTO "{attacker_schema}"."tbl_target" ("col") VALUES (1)'
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_cross_schema_union_blocked(self):
        """UNION 中引用其他 schema 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, space_id = self._make_executor()
        own_schema = f"as_{space_id.hex}"
        other_schema = f"as_{uuid.uuid4().hex}"
        sql = (
            f'SELECT "col" FROM "{own_schema}"."tbl_a" '
            f'UNION ALL '
            f'SELECT "col" FROM "{other_schema}"."tbl_b"'
        )
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_system_schema_public_blocked(self):
        """引用 public schema 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, _ = self._make_executor()
        sql = 'SELECT * FROM public.pg_user'
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_system_schema_pg_catalog_blocked(self):
        """引用 pg_catalog schema 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, _ = self._make_executor()
        sql = 'SELECT * FROM pg_catalog.pg_tables'
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_system_schema_information_schema_blocked(self):
        """引用 information_schema 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, _ = self._make_executor()
        sql = 'SELECT * FROM information_schema.tables'
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_system_schema_quoted_public_blocked(self):
        """引用带引号的 "public" schema 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, _ = self._make_executor()
        sql = 'SELECT * FROM "public".pg_user'
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_own_schema_passes(self):
        """当前 space 的 schema 通过验证"""
        executor, space_id = self._make_executor()
        own_schema = f"as_{space_id.hex}"
        sql = f'SELECT * FROM "{own_schema}"."tbl_abc"'
        executor._validate_schema_restriction(sql)

    def test_cross_space_allowed_schema_passes(self):
        """跨 Space 模式下，允许列表内的 schema 通过"""
        space_id = uuid.uuid4()
        other_space_id = uuid.uuid4()
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(space_id, MagicMock(), allow_cross_space=True)

        own_schema = f"as_{space_id.hex}"
        other_schema = f"as_{other_space_id.hex}"
        executor._allowed_schemas = {own_schema, other_schema}
        sql = (
            f'SELECT a."col" FROM "{own_schema}"."tbl_a" a '
            f'JOIN "{other_schema}"."tbl_b" b ON a."__id" = b."__id"'
        )
        executor._validate_schema_restriction(sql)

    def test_cross_space_disallowed_schema_blocked(self):
        """跨 Space 模式下，不在允许列表的 schema 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        space_id = uuid.uuid4()
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(space_id, MagicMock(), allow_cross_space=True)

        own_schema = f"as_{space_id.hex}"
        unauthorized_schema = f"as_{uuid.uuid4().hex}"
        executor._allowed_schemas = {own_schema}
        sql = f'SELECT * FROM "{unauthorized_schema}"."tbl_evil"'
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)

    def test_mixed_valid_invalid_schema_blocked(self):
        """同时引用合法和非法 schema 时被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, space_id = self._make_executor()
        own_schema = f"as_{space_id.hex}"
        evil_schema = f"as_{uuid.uuid4().hex}"
        sql = (
            f'SELECT * FROM "{own_schema}"."tbl_a" '
            f'WHERE "col" IN (SELECT "col" FROM "{evil_schema}"."tbl_b")'
        )
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)


# ══════════════════════════════════════
# SQL 注入专项测试
# ══════════════════════════════════════

class TestSQLInjectionDefense(TestCase):
    """SQL 注入防御测试 — 覆盖注释逃逸、Unicode 混淆、拼接攻击等场景"""

    def _make_executor(self):
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(uuid.uuid4(), MagicMock())
        return executor

    def test_comment_escape_block(self):
        """块注释包裹 DDL 仍被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        # 尝试用注释隐藏危险 SQL
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql("SELECT 1; /* */ DROP TABLE t")

    def test_comment_escape_line(self):
        """行注释后附带额外语句被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql("SELECT 1 -- safe\n; DROP TABLE t")

    def test_semicolon_injection(self):
        """分号注入第二条语句被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql(
                "SELECT * FROM t WHERE id = 1; DELETE FROM t"
            )

    def test_union_select_allowed(self):
        """UNION SELECT 属于 SELECT 类型 — 分类通过"""
        executor = self._make_executor()
        result = executor.classify_sql(
            "SELECT a FROM t1 UNION SELECT b FROM t2"
        )
        self.assertEqual(result, "SELECT")

    def test_stacked_query_ddl(self):
        """堆叠查询中含 CREATE 被拒绝"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor()
        with self.assertRaises(ForbiddenSQLError):
            executor.classify_sql(
                "SELECT 1; CREATE TABLE evil (id INT)"
            )

    def test_user_id_uuid_validation(self):
        """_inject_write_metadata 拒绝非 UUID user_id"""
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            user = MagicMock()
            user.id = "'; DROP TABLE t; --"  # 恶意 user_id
            executor = AgentSQLExecutor(uuid.uuid4(), user)

        sql = 'UPDATE "as_xxx"."tbl_yyy" SET "col" = 1 WHERE "id" = 2'
        with self.assertRaises(ValueError):
            executor._inject_write_metadata("UPDATE", sql, version=1)

    def test_user_id_valid_uuid_passes(self):
        """_inject_write_metadata 接受合法 UUID user_id"""
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            user = MagicMock()
            user.id = uuid.uuid4()
            executor = AgentSQLExecutor(uuid.uuid4(), user)

        sql = 'UPDATE "as_xxx"."tbl_yyy" SET "col" = 1 WHERE "id" = 2'
        result = executor._inject_write_metadata("UPDATE", sql, version=99)
        self.assertIn(str(user.id), result)
        self.assertIn("__version", result)

    def test_cross_schema_via_subquery(self):
        """子查询引用其他 schema 被拒绝"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        project_id = uuid.uuid4()
        other_id = uuid.uuid4()
        with patch('apps.tabdata.native.agent_sql.NameResolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(project_id, MagicMock())

        sql = (
            f'SELECT * FROM "as_{project_id.hex}"."tbl_abc" '
            f'WHERE id IN (SELECT id FROM "as_{other_id.hex}"."tbl_evil")'
        )
        with self.assertRaises(SchemaViolationError):
            executor._validate_schema_restriction(sql)


# ══════════════════════════════════════
# P0-09 Name Resolver as_ 前缀跳过回归测试
# ══════════════════════════════════════

class TestNameResolverSchemaSkip(TestCase):
    """
    P0-09 回归测试：name_resolver._replace_field_name 必须跳过 as_ 前缀标识符，
    不将 schema 名误解析为字段名。
    """

    def _build_resolver(self):
        """构建带 Mock 元数据的 NameResolver。"""
        project_id = uuid.uuid4()
        tid = uuid.uuid4()
        fid = uuid.uuid4()

        tables = [(tid, "mytable")]
        fields = [(fid, tid, "myfield", "text")]

        with patch('apps.tabdata.models.Table') as MockTable, \
             patch('apps.tabdata.models.TableField') as MockField:
            MockTable.objects.filter.return_value.values_list.return_value = tables
            MockField.objects.filter.return_value.values_list.return_value = fields
            from apps.tabdata.native.name_resolver import NameResolver
            resolver = NameResolver(project_id)

        return resolver, project_id, tid, fid

    def test_as_prefix_not_resolved_as_field(self):
        """as_ 前缀的 schema 标识符不被误解析为字段名"""
        resolver, project_id, tid, fid = self._build_resolver()

        schema = f"as_{project_id.hex}"
        tbl = f"tbl_{tid.hex}"
        col = fid.hex
        sql = f'SELECT "{col}" FROM "{schema}"."{tbl}"'

        resolved, mapping = resolver.resolve_sql(sql)
        self.assertIn(schema, resolved)
        self.assertNotIn(schema, mapping)

    def test_proj_prefix_not_skipped_after_fix(self):
        """修复后 proj_ 前缀不再被跳过（旧的 schema 前缀应视为普通标识符）"""
        resolver, project_id, tid, fid = self._build_resolver()

        tbl = f"tbl_{tid.hex}"
        fake_schema = f"proj_{uuid.uuid4().hex}"
        col = fid.hex
        sql = f'SELECT "{col}" FROM "{fake_schema}"."{tbl}"'

        resolved, _ = resolver.resolve_sql(sql)
        self.assertIn(fake_schema, resolved)


# ══════════════════════════════════════
# DV-032 / DV-012 回归测试：事务保护
# ══════════════════════════════════════

class TestExecuteWriteTransaction(SimpleTestCase):
    """
    DV-032: execute_write 必须使用 transaction.atomic() 保护。
    DV-012: 主 SQL 和 _sync_django_model_version 必须在同一事务内。
    """

    def _build_executor_and_mocks(self):
        space_id = uuid.uuid4()
        table_id = uuid.uuid4()
        user = MagicMock()
        user.id = uuid.uuid4()
        user.nickname = "test_agent"

        resolver_mock = MagicMock()
        resolver_mock.resolve_sql.return_value = (
            f'UPDATE "as_{space_id.hex}"."tbl_{table_id.hex}" SET "col" = %s WHERE "__id" = %s',
            {"col": f'"tbl_{table_id.hex}"."col"'},
        )
        resolver_mock.get_table_ids_from_sql.return_value = {table_id}

        with patch('apps.tabdata.native.agent_sql.get_resolver', return_value=resolver_mock):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(space_id, user)

        return executor, space_id, table_id, user

    @patch('apps.tabdata.native.agent_sql.transaction')
    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.services.record_service.next_record_version', return_value=42)
    def test_dv032_execute_write_uses_transaction_atomic(
        self, mock_next_ver, mock_conns, mock_txn,
    ):
        """DV-032: execute_write 必须调用 transaction.atomic()"""
        executor, space_id, table_id, user = self._build_executor_and_mocks()

        mock_cursor = MagicMock()
        mock_cursor.rowcount = 1
        mock_cursor.description = None
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_cursor)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_ctx

        mock_atomic_ctx = MagicMock()
        mock_atomic_ctx.__enter__ = MagicMock()
        mock_atomic_ctx.__exit__ = MagicMock(return_value=False)
        mock_txn.atomic.return_value = mock_atomic_ctx

        with patch.object(executor, '_validate_schema_restriction'), \
             patch.object(executor, '_validate_table_whitelist'), \
             patch.object(executor, '_sync_django_model_version'), \
             patch.object(executor, '_emit_record_history_for_write'), \
             patch.object(executor, '_write_change_log_for_write'), \
             patch.object(executor, '_capture_before_states', return_value={}), \
             patch.object(executor, '_fetch_affected_records', return_value=(None, None)), \
             patch('apps.tabdata.services.table_event_service.table_event_service'):
            executor.execute_write(
                'UPDATE "任务" SET "状态" = %s WHERE "__id" = %s',
                params=["done", "abc"],
            )

        mock_txn.atomic.assert_called()

    @patch('apps.tabdata.native.agent_sql.transaction')
    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.services.record_service.next_record_version', return_value=42)
    def test_dv012_sync_django_model_inside_transaction(
        self, mock_next_ver, mock_conns, mock_txn,
    ):
        """DV-012: _sync_django_model_version 在 transaction.atomic 内调用"""
        executor, space_id, table_id, user = self._build_executor_and_mocks()

        mock_cursor = MagicMock()
        mock_cursor.rowcount = 3
        mock_cursor.description = None
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_cursor)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_ctx

        call_order = []
        mock_atomic_ctx = MagicMock()
        mock_atomic_ctx.__enter__ = MagicMock(side_effect=lambda: call_order.append('atomic_enter'))
        mock_atomic_ctx.__exit__ = MagicMock(side_effect=lambda *a: call_order.append('atomic_exit'))
        mock_txn.atomic.return_value = mock_atomic_ctx

        def tracking_sync(*args, **kwargs):
            call_order.append('sync_version')

        with patch.object(executor, '_validate_schema_restriction'), \
             patch.object(executor, '_validate_table_whitelist'), \
             patch.object(executor, '_sync_django_model_version', side_effect=tracking_sync), \
             patch.object(executor, '_emit_record_history_for_write'), \
             patch.object(executor, '_write_change_log_for_write'), \
             patch.object(executor, '_capture_before_states', return_value={}), \
             patch.object(executor, '_fetch_affected_records', return_value=(None, None)), \
             patch('apps.tabdata.services.table_event_service.table_event_service'):
            executor.execute_write(
                'UPDATE "任务" SET "状态" = %s WHERE "__id" = %s',
                params=["done", "abc"],
            )

        self.assertIn('sync_version', call_order)
        sync_idx = call_order.index('sync_version')
        enter_idx = call_order.index('atomic_enter')
        exit_idx = call_order.index('atomic_exit')
        self.assertGreater(sync_idx, enter_idx, "_sync should be called after atomic enter")
        self.assertLess(sync_idx, exit_idx, "_sync should be called before atomic exit")

    @patch('apps.tabdata.native.agent_sql.transaction')
    @patch('apps.tabdata.native.agent_sql.connections')
    def test_delete_allocates_and_marks_its_table_version_inside_transaction(
        self,
        mock_conns,
        mock_txn,
    ):
        executor, space_id, table_id, _user = self._build_executor_and_mocks()
        joined_table_id = uuid.uuid4()
        executor.resolver.get_table_ids_from_sql.return_value = {table_id, joined_table_id}
        executor.resolver.resolve_sql.return_value = (
            f'DELETE FROM "as_{space_id.hex}"."tbl_{table_id.hex}" AS t '
            f'USING "as_{space_id.hex}"."tbl_{joined_table_id.hex}" AS u '
            'WHERE t."__id" = %s AND u."__id" = t."__id"',
            {},
        )

        call_order = []
        mock_atomic_ctx = MagicMock()
        mock_atomic_ctx.__enter__ = MagicMock(
            side_effect=lambda: call_order.append('atomic_enter')
        )
        mock_atomic_ctx.__exit__ = MagicMock(
            side_effect=lambda *args: call_order.append('atomic_exit')
        )
        mock_txn.atomic.return_value = mock_atomic_ctx

        mock_cursor = MagicMock()
        mock_cursor.rowcount = 1
        mock_cursor.description = None
        mock_cursor_ctx = MagicMock()
        mock_cursor_ctx.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor_ctx.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_cursor_ctx

        record_id = str(uuid.uuid4())
        with patch(
            'apps.tabdata.services.record_service.next_record_version',
            side_effect=lambda _table_id: call_order.append('allocate_version') or 43,
        ), patch(
            'apps.tabdata.services.view_version_sync.mark_table_record_delete_version',
            side_effect=lambda **_kwargs: call_order.append('mark_watermark'),
        ) as mark_watermark, patch.object(
            executor,
            '_capture_before_states',
            return_value={table_id: {record_id: {}}},
        ), patch.object(
            executor,
            '_lock_table_fences',
            side_effect=lambda _table_ids: call_order.append('lock_fences'),
        ) as lock_fences, patch.object(
            executor, '_estimate_affected_rows'
        ), patch.object(
            executor, '_validate_schema_restriction'
        ), patch.object(
            executor, '_validate_table_whitelist'
        ), patch.object(
            executor, '_validate_no_forbidden_tables'
        ), patch.object(
            executor, '_sync_django_model_delete'
        ), patch.object(
            executor, '_write_change_log_for_write'
        ), patch.object(
            executor, '_emit_record_history_for_write'
        ), patch.object(
            executor, '_fetch_affected_records', return_value=(None, None)
        ), patch(
            'apps.tabdata.services.table_event_service.table_event_service'
        ):
            result = executor.execute_write(
                'DELETE FROM "任务" WHERE "__id" = %s',
                params=[record_id],
                allow_delete=True,
            )

        self.assertEqual(result['versions'][str(table_id)], 43)
        self.assertNotIn(str(joined_table_id), result['versions'])
        lock_fences.assert_called_once_with({table_id, joined_table_id})
        mark_watermark.assert_called_once_with(
            table_id=table_id,
            version=43,
            db_alias=executor.db_alias,
        )
        self.assertLess(call_order.index('atomic_enter'), call_order.index('allocate_version'))
        self.assertLess(call_order.index('lock_fences'), call_order.index('allocate_version'))
        self.assertLess(call_order.index('allocate_version'), call_order.index('mark_watermark'))
        self.assertLess(call_order.index('mark_watermark'), call_order.index('atomic_exit'))

    def test_delete_before_state_query_preserves_alias_and_using(self):
        executor, space_id, table_id, _user = self._build_executor_and_mocks()
        joined_table_id = uuid.uuid4()
        target = f'"as_{space_id.hex}"."tbl_{table_id.hex}"'
        joined = f'"as_{space_id.hex}"."tbl_{joined_table_id.hex}"'

        captured_table_id, select_sql = executor._build_delete_before_state_query(
            f'DELETE FROM {target} AS t USING {joined} AS u '
            'WHERE t."link" = u."__id" AND u."state" = %s',
            {table_id, joined_table_id},
        )

        self.assertEqual(captured_table_id, table_id)
        self.assertEqual(
            select_sql,
            f'SELECT DISTINCT ON (t."__id") t.* FROM {target} AS t, {joined} AS u '
            f'WHERE t."link" = u."__id" AND u."state" = %s LIMIT {executor.MAX_WRITE_ROWS + 1}',
        )

    @patch('apps.tabdata.native.agent_sql.connections')
    def test_delete_before_state_capture_fails_closed(self, mock_connections):
        from apps.tabdata.native.agent_sql import AgentSQLError

        executor, space_id, table_id, _user = self._build_executor_and_mocks()
        target = f'"as_{space_id.hex}"."tbl_{table_id.hex}"'
        cursor = MagicMock()
        cursor.execute.side_effect = RuntimeError('capture failed')
        mock_connections.__getitem__.return_value.cursor.return_value.__enter__.return_value = cursor

        with self.assertRaises(AgentSQLError):
            executor._capture_before_states(
                f'DELETE FROM {target} AS t WHERE t."__id" = %s',
                ['record-1'],
                'DELETE',
                {table_id},
            )

    @patch('apps.tabdata.native.agent_sql.connections')
    def test_delete_before_state_capture_rejects_more_than_write_limit(self, mock_connections):
        from apps.tabdata.native.agent_sql import WriteUnsafeError

        executor, space_id, table_id, _user = self._build_executor_and_mocks()
        target = f'"as_{space_id.hex}"."tbl_{table_id.hex}"'
        cursor = MagicMock()
        cursor.description = [('__id',)]
        cursor.fetchall.return_value = [
            (str(uuid.uuid4()),)
            for _ in range(executor.MAX_WRITE_ROWS + 1)
        ]
        mock_connections.__getitem__.return_value.cursor.return_value.__enter__.return_value = cursor

        with self.assertRaises(WriteUnsafeError):
            executor._capture_before_states(
                f'DELETE FROM {target} AS t WHERE t."state" = %s',
                ['done'],
                'DELETE',
                {table_id},
            )


# ══════════════════════════════════════
# DV-002 回归测试：RecordHistory 写入
# ══════════════════════════════════════

class TestExecuteWriteRecordHistory(SimpleTestCase):
    """DV-002: execute_write 完成后必须 emit RecordHistory 事件。"""

    def _build_executor_and_mocks(self):
        space_id = uuid.uuid4()
        table_id = uuid.uuid4()
        user = MagicMock()
        user.id = uuid.uuid4()
        user.nickname = "test_agent"

        resolver_mock = MagicMock()
        resolver_mock.resolve_sql.return_value = (
            f'INSERT INTO "as_{space_id.hex}"."tbl_{table_id.hex}" ("col") VALUES (%s)',
            {},
        )
        resolver_mock.get_table_ids_from_sql.return_value = {table_id}
        resolver_mock.get_referenced_tables.return_value = {}

        with patch('apps.tabdata.native.agent_sql.get_resolver', return_value=resolver_mock):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(space_id, user)

        return executor, space_id, table_id, user

    @patch('apps.tabdata.native.agent_sql.transaction')
    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.services.record_service.next_record_version', return_value=10)
    def test_dv002_emit_record_history_called_after_insert(
        self, mock_next_ver, mock_conns, mock_txn,
    ):
        """DV-002: INSERT 完成后调用 _emit_record_history_for_write"""
        executor, space_id, table_id, user = self._build_executor_and_mocks()

        record_id = uuid.uuid4()
        mock_cursor = MagicMock()
        mock_cursor.rowcount = 1
        mock_cursor.description = [('__id',)]
        mock_cursor.fetchall.return_value = [(record_id,)]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_cursor)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_ctx

        mock_atomic = MagicMock()
        mock_atomic.__enter__ = MagicMock()
        mock_atomic.__exit__ = MagicMock(return_value=False)
        mock_txn.atomic.return_value = mock_atomic

        with patch.object(executor, '_validate_schema_restriction'), \
             patch.object(executor, '_validate_table_whitelist'), \
             patch.object(executor, '_sync_django_model_version'), \
             patch.object(executor, '_emit_record_history_for_write') as mock_emit, \
             patch.object(executor, '_write_change_log_for_write'), \
             patch.object(executor, '_fetch_affected_records', return_value=(None, None)), \
             patch('apps.tabdata.services.table_event_service.table_event_service'):
            executor.execute_write(
                'INSERT INTO "任务" ("标题") VALUES (%s)',
                params=["新任务"],
            )

        mock_emit.assert_called_once()
        call_kwargs = mock_emit.call_args
        self.assertEqual(call_kwargs.kwargs['sql_type'], 'INSERT')
        self.assertEqual(call_kwargs.kwargs['affected_rows'], 1)

    @patch('apps.tabdata.native.agent_sql.transaction')
    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.services.record_service.next_record_version', return_value=10)
    def test_dv002_no_emit_when_zero_rows_affected(
        self, mock_next_ver, mock_conns, mock_txn,
    ):
        """DV-002: 0 行受影响时不调用 _emit_record_history_for_write"""
        executor, space_id, table_id, user = self._build_executor_and_mocks()

        executor.resolver.resolve_sql.return_value = (
            f'UPDATE "as_{space_id.hex}"."tbl_{table_id.hex}" SET "col" = %s WHERE "__id" = %s',
            {},
        )

        mock_cursor = MagicMock()
        mock_cursor.rowcount = 0
        mock_cursor.description = None
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_cursor)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_ctx

        mock_atomic = MagicMock()
        mock_atomic.__enter__ = MagicMock()
        mock_atomic.__exit__ = MagicMock(return_value=False)
        mock_txn.atomic.return_value = mock_atomic

        with patch.object(executor, '_validate_schema_restriction'), \
             patch.object(executor, '_validate_table_whitelist'), \
             patch.object(executor, '_sync_django_model_version'), \
             patch.object(executor, '_emit_record_history_for_write') as mock_emit, \
             patch.object(executor, '_write_change_log_for_write'), \
             patch.object(executor, '_capture_before_states', return_value={}), \
             patch.object(executor, '_fetch_affected_records', return_value=(None, None)), \
             patch('apps.tabdata.services.table_event_service.table_event_service'):
            executor.execute_write(
                'UPDATE "任务" SET "状态" = %s WHERE "__id" = %s',
                params=["done", "no-match"],
            )

        mock_emit.assert_not_called()


# ══════════════════════════════════════
# DV-003 + DV-016 回归测试：VersionHistory + ChangeLog
# ══════════════════════════════════════

class TestExecuteWriteCollabHistory(SimpleTestCase):
    """
    DV-003: execute_write 必须写入 VersionHistory 快照。
    DV-016: execute_write 必须写入 ChangeLog 并关联 agent_run_id。
    """

    def _build_executor_and_mocks(self):
        space_id = uuid.uuid4()
        table_id = uuid.uuid4()
        user = MagicMock()
        user.id = uuid.uuid4()
        user.nickname = "test_agent"

        resolver_mock = MagicMock()
        resolver_mock.resolve_sql.return_value = (
            f'UPDATE "as_{space_id.hex}"."tbl_{table_id.hex}" SET "col" = %s WHERE "__id" = %s',
            {},
        )
        resolver_mock.get_table_ids_from_sql.return_value = {table_id}
        resolver_mock.get_referenced_tables.return_value = {}

        with patch('apps.tabdata.native.agent_sql.get_resolver', return_value=resolver_mock):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(space_id, user)

        return executor, space_id, table_id, user

    @patch('apps.tabdata.native.agent_sql.transaction')
    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.services.record_service.next_record_version', return_value=10)
    def test_dv003_version_history_written_after_write(
        self, mock_next_ver, mock_conns, mock_txn,
    ):
        """DV-003: 写入后必须调用 _write_change_log_for_write"""
        executor, space_id, table_id, user = self._build_executor_and_mocks()

        mock_cursor = MagicMock()
        mock_cursor.rowcount = 2
        mock_cursor.description = None
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_cursor)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_ctx

        mock_atomic = MagicMock()
        mock_atomic.__enter__ = MagicMock()
        mock_atomic.__exit__ = MagicMock(return_value=False)
        mock_txn.atomic.return_value = mock_atomic

        with patch.object(executor, '_validate_schema_restriction'), \
             patch.object(executor, '_validate_table_whitelist'), \
             patch.object(executor, '_sync_django_model_version'), \
             patch.object(executor, '_emit_record_history_for_write'), \
             patch.object(executor, '_write_change_log_for_write') as mock_collab, \
             patch.object(executor, '_capture_before_states', return_value={}), \
             patch.object(executor, '_fetch_affected_records', return_value=(None, None)), \
             patch('apps.tabdata.services.table_event_service.table_event_service'):
            executor.execute_write(
                'UPDATE "任务" SET "状态" = %s WHERE "__id" = %s',
                params=["done", "abc"],
            )

        mock_collab.assert_called_once()
        call_kwargs = mock_collab.call_args
        self.assertEqual(call_kwargs.kwargs['sql_type'], 'UPDATE')
        self.assertEqual(call_kwargs.kwargs['affected_rows'], 2)

    @patch('apps.tabdata.native.agent_sql.transaction')
    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.services.record_service.next_record_version', return_value=10)
    def test_dv016_agent_run_id_passed_to_changelog(
        self, mock_next_ver, mock_conns, mock_txn,
    ):
        """DV-016: agent_run_id 参数传递到 _write_change_log_for_write"""
        executor, space_id, table_id, user = self._build_executor_and_mocks()

        mock_cursor = MagicMock()
        mock_cursor.rowcount = 1
        mock_cursor.description = None
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_cursor)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_ctx

        mock_atomic = MagicMock()
        mock_atomic.__enter__ = MagicMock()
        mock_atomic.__exit__ = MagicMock(return_value=False)
        mock_txn.atomic.return_value = mock_atomic

        test_run_id = "run_abc123"

        with patch.object(executor, '_validate_schema_restriction'), \
             patch.object(executor, '_validate_table_whitelist'), \
             patch.object(executor, '_sync_django_model_version'), \
             patch.object(executor, '_emit_record_history_for_write'), \
             patch.object(executor, '_write_change_log_for_write') as mock_collab, \
             patch.object(executor, '_capture_before_states', return_value={}), \
             patch.object(executor, '_fetch_affected_records', return_value=(None, None)), \
             patch('apps.tabdata.services.table_event_service.table_event_service'):
            executor.execute_write(
                'UPDATE "任务" SET "状态" = %s WHERE "__id" = %s',
                params=["done", "abc"],
                agent_run_id=test_run_id,
            )

        call_kwargs = mock_collab.call_args
        self.assertEqual(call_kwargs.kwargs['agent_run_id'], test_run_id)

    @patch('apps.tabdata.native.agent_sql.transaction')
    @patch('apps.tabdata.native.agent_sql.connections')
    @patch('apps.tabdata.services.record_service.next_record_version', return_value=10)
    def test_dv003_dv016_no_history_when_zero_affected(
        self, mock_next_ver, mock_conns, mock_txn,
    ):
        """DV-003 / DV-016: 0 行受影响时 _write_change_log_for_write 内部 early return"""
        executor, space_id, table_id, user = self._build_executor_and_mocks()

        mock_cursor = MagicMock()
        mock_cursor.rowcount = 0
        mock_cursor.description = None
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_cursor)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_ctx

        mock_atomic = MagicMock()
        mock_atomic.__enter__ = MagicMock()
        mock_atomic.__exit__ = MagicMock(return_value=False)
        mock_txn.atomic.return_value = mock_atomic

        call_tracker = []
        original_write = executor._write_change_log_for_write

        def tracking_write(**kwargs):
            call_tracker.append(kwargs)
            original_write(**kwargs)

        with patch.object(executor, '_validate_schema_restriction'), \
             patch.object(executor, '_validate_table_whitelist'), \
             patch.object(executor, '_sync_django_model_version'), \
             patch.object(executor, '_emit_record_history_for_write'), \
             patch.object(executor, '_write_change_log_for_write', side_effect=tracking_write), \
             patch.object(executor, '_capture_before_states', return_value={}), \
             patch.object(executor, '_fetch_affected_records', return_value=(None, None)), \
             patch('apps.tabdata.services.table_event_service.table_event_service'):
            executor.execute_write(
                'UPDATE "任务" SET "状态" = %s WHERE "__id" = %s',
                params=["done", "no-match"],
            )

        self.assertEqual(len(call_tracker), 1)
        self.assertEqual(call_tracker[0]['affected_rows'], 0)


# ══════════════════════════════════════
# DV-016 回归测试：SQLExecuteTool agent_run_id 传递 — Wave 4a 后已移除
# ══════════════════════════════════════
#
# 原 TestSQLExecuteToolExecutionRunId 测试 BaseTool 包装层 SQLExecuteTool.run
# 是否将 agent_run_id 透传给 AgentSQLExecutor.execute_write。Wave 4a 按 D4
# 全删 FC 把 SQLExecuteTool 删除——Agent 走 CLI；agent_run_id 仍由
# api_agent_sql.sql_execute_impl 直接传递给 AgentSQLExecutor.execute_write
# (HTTP API 路径)。底层透传由 test_dv002_dv003_dv012_dv016_dv032_regression
# 的 TestDV016ExecutionRunIdPropagation 类继续覆盖。


# ══════════════════════════════════════
# DV-004 系统表名白名单缺口回归测试
# ══════════════════════════════════════

class TestForbiddenTableValidation(TestCase):
    """
    DV-004 回归测试：_validate_no_forbidden_tables 必须拦截
    Django ORM 裸表名和 PostgreSQL 系统表的直接引用。

    根因：_validate_schema_restriction 仅检查 as_* schema 引用，
    _validate_table_whitelist 仅匹配 tbl_* 格式表名。
    不含 as_ 前缀的裸表名（tabdata_record、collab_version_history 等）
    两道检查都不触发，可直接在 PostgreSQL 连接上执行任意 DML。
    """

    def _make_executor(self, space_id=None):
        space_id = space_id or uuid.uuid4()
        with patch('apps.tabdata.native.agent_sql.get_resolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(space_id, MagicMock())
        return executor, space_id

    # ── SELECT 攻击向量 ──

    def test_select_tabdata_record_blocked(self):
        """SELECT FROM tabdata_record 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'SELECT * FROM "tabdata_record"'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    def test_select_collab_version_history_blocked(self):
        """SELECT FROM collab_version_history 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'SELECT * FROM collab_version_history'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    def test_select_collab_change_log_blocked(self):
        """SELECT FROM collab_change_log 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'SELECT * FROM "collab_change_log"'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    def test_select_django_migrations_blocked(self):
        """SELECT FROM django_migrations 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'SELECT * FROM django_migrations'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    def test_select_auth_user_blocked(self):
        """SELECT FROM auth_user 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'SELECT * FROM auth_user'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    def test_select_pg_catalog_unqualified_blocked(self):
        """SELECT FROM pg_tables（无 schema 限定）被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'SELECT * FROM pg_tables'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    # ── UPDATE/DELETE 攻击向量 ──

    def test_update_tabdata_record_blocked(self):
        """UPDATE tabdata_record 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'UPDATE "tabdata_record" SET "data" = %s WHERE "id" = %s'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    def test_delete_collab_version_history_blocked(self):
        """DELETE FROM collab_version_history 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'DELETE FROM "collab_version_history" WHERE "id" = %s'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    def test_insert_into_tabdata_record_blocked(self):
        """INSERT INTO tabdata_record 被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'INSERT INTO "tabdata_record" ("id", "data") VALUES (%s, %s)'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    # ── JOIN 攻击向量 ──

    def test_join_with_system_table_blocked(self):
        """JOIN 中引用系统表被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, space_id = self._make_executor()
        schema = f"as_{space_id.hex}"
        sql = (
            f'SELECT a.* FROM "{schema}"."tbl_{"a" * 32}" a '
            f'JOIN "tabdata_record" b ON a."__id" = b."id"'
        )
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    # ── 子查询攻击向量 ──

    def test_subquery_with_system_table_blocked(self):
        """子查询中引用系统表被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, space_id = self._make_executor()
        schema = f"as_{space_id.hex}"
        sql = (
            f'SELECT * FROM "{schema}"."tbl_{"b" * 32}" '
            f'WHERE "__id" IN (SELECT "id" FROM "tabdata_record")'
        )
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    # ── 字符串字面量中的表名不应误判 ──

    def test_string_literal_not_false_positive(self):
        """字符串字面量中包含禁止表名不应误报"""
        executor, space_id = self._make_executor()
        schema = f"as_{space_id.hex}"
        tbl = f"tbl_{'c' * 32}"
        sql = (
            f"SELECT * FROM \"{schema}\".\"{tbl}\" "
            f"WHERE \"name\" = 'tabdata_record'"
        )
        executor._validate_no_forbidden_tables(sql)

    # ── 合法 SQL 不应被拦截 ──

    def test_legitimate_space_table_passes(self):
        """合法的 Space 表引用（as_xxx.tbl_yyy）通过验证"""
        executor, space_id = self._make_executor()
        schema = f"as_{space_id.hex}"
        tbl = f"tbl_{'d' * 32}"
        sql = f'SELECT * FROM "{schema}"."{tbl}" WHERE "__id" = %s'
        executor._validate_no_forbidden_tables(sql)

    def test_legitimate_join_passes(self):
        """合法的多表 JOIN 通过验证"""
        executor, space_id = self._make_executor()
        schema = f"as_{space_id.hex}"
        tbl_a = f"tbl_{'e' * 32}"
        tbl_b = f"tbl_{'f' * 32}"
        sql = (
            f'SELECT a."col1" FROM "{schema}"."{tbl_a}" a '
            f'JOIN "{schema}"."{tbl_b}" b ON a."__id" = b."ref_id"'
        )
        executor._validate_no_forbidden_tables(sql)

    # ── 各 Django App 表前缀覆盖测试 ──

    def test_all_postgresql_app_prefixes_blocked(self):
        """所有 PostgreSQL Django App 的表前缀都被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError, _FORBIDDEN_TABLE_PREFIXES
        executor, _ = self._make_executor()

        pg_app_prefixes = [
            'tabdata_', 'collab_', 'tabtinspace_', 'orchestration_',
            'scheduler_', 'tabdoc_', 'tabslide_',
            'tabcode_', 'tabvideo_', 'tabsite_', 'rag_', 'schema_',
        ]
        for prefix in pg_app_prefixes:
            self.assertIn(prefix, _FORBIDDEN_TABLE_PREFIXES,
                          f"Prefix '{prefix}' missing from forbidden list")
            table_name = f"{prefix}sometable"
            sql = f'SELECT * FROM "{table_name}"'
            with self.assertRaises(SchemaViolationError,
                                   msg=f"Should block table: {table_name}"):
                executor._validate_no_forbidden_tables(sql)

    def test_all_mysql_app_prefixes_blocked(self):
        """所有 MySQL Django App 的表前缀都被拦截（defense-in-depth）"""
        from apps.tabdata.native.agent_sql import SchemaViolationError, _FORBIDDEN_TABLE_PREFIXES
        executor, _ = self._make_executor()

        mysql_app_prefixes = [
            'users_', 'membership_', 'wallet_', 'payment_',
            'billing_', 'channel_', 'conversation_', 'skills_',
            'updater_', 'tinapps_',  # tinapps 模块已废弃删除，前缀保留以防访问残留表
            'sms_', 'email_', 'oss_',
        ]
        for prefix in mysql_app_prefixes:
            self.assertIn(prefix, _FORBIDDEN_TABLE_PREFIXES,
                          f"Prefix '{prefix}' missing from forbidden list")
            table_name = f"{prefix}sometable"
            sql = f'SELECT * FROM "{table_name}"'
            with self.assertRaises(SchemaViolationError,
                                   msg=f"Should block table: {table_name}"):
                executor._validate_no_forbidden_tables(sql)

    def test_django_and_system_prefixes_blocked(self):
        """Django 框架表和 PG 系统表前缀被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError, _FORBIDDEN_TABLE_PREFIXES
        executor, _ = self._make_executor()

        system_prefixes = ['django_', 'auth_', 'pg_', 'sql_']
        for prefix in system_prefixes:
            self.assertIn(prefix, _FORBIDDEN_TABLE_PREFIXES,
                          f"Prefix '{prefix}' missing from forbidden list")
            table_name = f"{prefix}sometable"
            sql = f'SELECT * FROM "{table_name}"'
            with self.assertRaises(SchemaViolationError,
                                   msg=f"Should block table: {table_name}"):
                executor._validate_no_forbidden_tables(sql)

    # ── 大小写绕过防御 ──

    def test_case_insensitive_blocked(self):
        """大小写混合的禁止表名仍被拦截"""
        from apps.tabdata.native.agent_sql import SchemaViolationError
        executor, _ = self._make_executor()
        sql = 'SELECT * FROM "TabData_Record"'
        with self.assertRaises(SchemaViolationError):
            executor._validate_no_forbidden_tables(sql)

    # ── execute_write 空 table_ids 白名单验证 ──

    def test_write_no_space_tables_rejected(self):
        """写操作未引用任何合法 Space 表时被拒绝（白名单正向验证）

        测试 execute_write 中的 affected_table_ids 非空检查：即使 SQL 语法
        通过了禁止表检查（表名不匹配已知前缀），只要未解析出合法的 tbl_* 表 ID，
        写操作仍被拒绝。
        """
        from apps.tabdata.native.agent_sql import SchemaViolationError

        executor, space_id = self._make_executor()
        schema = f"as_{space_id.hex}"
        mock_resolver = executor.resolver
        mock_resolver.resolve_sql.return_value = (
            f'UPDATE "{schema}"."not_a_real_tbl" SET "col" = 1 WHERE "id" = 2',
            {},
        )
        mock_resolver.get_table_ids_from_sql.return_value = set()

        with patch.object(executor, '_validate_table_whitelist'), \
             self.assertRaises(SchemaViolationError, msg="Should reject write with no valid Space tables"):
            executor.execute_write(
                'UPDATE "some_table" SET "col" = 1 WHERE "id" = 2',
            )

    def test_escaped_string_with_backslash(self):
        """转义字符串中的禁止表名不应误报"""
        executor, space_id = self._make_executor()
        schema = f"as_{space_id.hex}"
        tbl = f"tbl_{'a' * 32}"
        sql = (
            f"SELECT * FROM \"{schema}\".\"{tbl}\" "
            f"WHERE \"desc\" = 'test\\'s tabdata_record value'"
        )
        executor._validate_no_forbidden_tables(sql)


# ══════════════════════════════════════
# SQ-001/002/003 回归测试：sql_mode 策略强制
# ══════════════════════════════════════

class TestSqlModePolicyEnforcement(SimpleTestCase):
    """
    SQ-001/002/003 回归测试：
    - validate_sql() 不再是死代码，在 execute_read 入口被调用
    - sql_mode 配置在 Django 执行路径中生效
    - classify_sql 与 sql_mode 联动
    """

    def _make_executor(self, sql_mode="read_write"):
        with patch('apps.tabdata.native.agent_sql.get_resolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(
                uuid.uuid4(), MagicMock(), sql_mode=sql_mode,
            )
        return executor

    # ── sql_mode=blocked ──

    def test_blocked_rejects_select(self):
        """SQ-003: sql_mode=blocked 时 execute_read 拒绝 SELECT"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor(sql_mode="blocked")
        with self.assertRaises(ForbiddenSQLError) as ctx:
            executor.execute_read('SELECT * FROM "t"')
        self.assertIn("blocked", str(ctx.exception).lower())

    def test_blocked_rejects_insert(self):
        """SQ-003: sql_mode=blocked 时 execute_write 拒绝 INSERT"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor(sql_mode="blocked")
        with self.assertRaises(ForbiddenSQLError) as ctx:
            executor.execute_write('INSERT INTO "t" ("a") VALUES (1)')
        self.assertIn("blocked", str(ctx.exception).lower())

    def test_blocked_rejects_update(self):
        """SQ-003: sql_mode=blocked 时 execute_write 拒绝 UPDATE"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor(sql_mode="blocked")
        with self.assertRaises(ForbiddenSQLError) as ctx:
            executor.execute_write('UPDATE "t" SET "a" = 1 WHERE "b" = 2')
        self.assertIn("blocked", str(ctx.exception).lower())

    # ── sql_mode=read_only ──

    def test_read_only_allows_select(self):
        """SQ-002: sql_mode=read_only 时 execute_read 允许 SELECT（通过 validate_sql 后到达 classify_sql）"""
        executor = self._make_executor(sql_mode="read_only")
        # validate_sql 通过 → classify_sql 通过 → 到 resolve_sql 时抛出（resolver 被 mock）
        # 关键点：没有抛出 ForbiddenSQLError("blocked") 或 ForbiddenSQLError("read_only")
        try:
            executor.execute_read('SELECT "a" FROM "t"')
        except Exception as e:
            from apps.tabdata.native.agent_sql import ForbiddenSQLError
            if isinstance(e, ForbiddenSQLError):
                self.assertNotIn("blocked", str(e).lower())
                self.assertNotIn("read_only", str(e).lower())

    def test_read_only_rejects_write(self):
        """SQ-002: sql_mode=read_only 时 execute_write 拒绝写操作"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor(sql_mode="read_only")
        with self.assertRaises(ForbiddenSQLError) as ctx:
            executor.execute_write('INSERT INTO "t" ("a") VALUES (1)')
        self.assertIn("read_only", str(ctx.exception).lower())

    def test_read_only_rejects_update(self):
        """SQ-002: sql_mode=read_only 时 execute_write 拒绝 UPDATE"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor(sql_mode="read_only")
        with self.assertRaises(ForbiddenSQLError) as ctx:
            executor.execute_write('UPDATE "t" SET "a" = 1 WHERE "b" = 2')
        self.assertIn("read_only", str(ctx.exception).lower())

    def test_read_only_rejects_delete(self):
        """SQ-002: sql_mode=read_only 时 execute_write 拒绝 DELETE"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor(sql_mode="read_only")
        with self.assertRaises(ForbiddenSQLError) as ctx:
            executor.execute_write(
                'DELETE FROM "t" WHERE "a" = 1', allow_delete=True,
            )
        self.assertIn("read_only", str(ctx.exception).lower())

    # ── sql_mode=read_write（无回归）──

    def test_read_write_allows_select(self):
        """sql_mode=read_write 时 SELECT 正常通过 sql_mode 检查"""
        executor = self._make_executor(sql_mode="read_write")
        try:
            executor.execute_read('SELECT "a" FROM "t"')
        except Exception as e:
            from apps.tabdata.native.agent_sql import ForbiddenSQLError
            if isinstance(e, ForbiddenSQLError):
                self.assertNotIn("blocked", str(e).lower())
                self.assertNotIn("read_only", str(e).lower())

    def test_read_write_allows_insert(self):
        """sql_mode=read_write 时 INSERT 正常通过 sql_mode 检查"""
        executor = self._make_executor(sql_mode="read_write")
        try:
            executor.execute_write('INSERT INTO "t" ("a") VALUES (1)')
        except Exception as e:
            from apps.tabdata.native.agent_sql import ForbiddenSQLError
            if isinstance(e, ForbiddenSQLError):
                self.assertNotIn("blocked", str(e).lower())
                self.assertNotIn("read_only", str(e).lower())

    # ── SQ-001: validate_sql 被 execute_read 消费 ──

    def test_validate_sql_called_in_execute_read(self):
        """SQ-001: validate_sql() 在 execute_read 中被实际调用"""
        executor = self._make_executor(sql_mode="blocked")
        with patch(
            'apps.services.common.sandbox_policy.validate_sql',
            return_value="blocked by policy",
        ) as mock_validate:
            from apps.tabdata.native.agent_sql import ForbiddenSQLError
            with self.assertRaises(ForbiddenSQLError):
                executor.execute_read('SELECT 1')
            mock_validate.assert_called_once()

    # ── SQ-001: validate_sql 在 read_only 模式下拦截 DDL ──

    def test_read_only_rejects_ddl_via_validate_sql(self):
        """SQ-001: validate_sql 在 read_only 模式下拦截 DDL 类语句"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor(sql_mode="read_only")
        with self.assertRaises(ForbiddenSQLError):
            executor.execute_read('DROP TABLE "t"')

    # ── SQ-002: HTTP 直调路径的 sql_mode 默认值 ──

    def test_default_sql_mode_is_read_write(self):
        """默认 sql_mode 为 read_write，不破坏向后兼容"""
        with patch('apps.tabdata.native.agent_sql.get_resolver'):
            from apps.tabdata.native.agent_sql import AgentSQLExecutor
            executor = AgentSQLExecutor(uuid.uuid4(), MagicMock())
        self.assertEqual(executor._sql_mode, "read_write")

    # ── SQ-001: validate_sql 拦截多语句 ──

    def test_validate_sql_rejects_multi_statement_in_read(self):
        """validate_sql 在 execute_read 中拦截多语句 SQL"""
        from apps.tabdata.native.agent_sql import ForbiddenSQLError
        executor = self._make_executor(sql_mode="read_write")
        with self.assertRaises(ForbiddenSQLError):
            executor.execute_read('SELECT 1; SELECT 2')

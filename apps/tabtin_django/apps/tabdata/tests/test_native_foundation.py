"""
Phase 0 基础设施测试

验证原生列存储模块的所有基础组件：
- pg_type_map: 字段类型 → PG 类型映射
- ddl_manager: Schema / Table / Column DDL
- query_builder: 筛选 / 排序 / 聚合 SQL 构建
- record_io: 原生记录读写
- value_converter: 值转换
- feature_flags: 迁移阶段控制
"""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase, TestCase, override_settings

from apps.tabdata.native.pg_type_map import (
    FIELD_TYPE_TO_PG_TYPE,
    SYSTEM_COLUMN_FIELD_TYPES,
    SYSTEM_COLUMNS,
    UnknownNativeFieldTypeError,
    get_column_definition,
    get_pg_default,
    get_pg_type,
    get_type_cast_using,
    is_system_field,
    get_all_field_types,
)
from apps.tabdata.native.feature_flags import NativeStoragePhase
from apps.tabdata.native.value_converter import (
    python_to_pg,
    pg_to_python,
    convert_record_for_insert,
    convert_native_row_to_record_data,
)


# ══════════════════════════════════════
# pg_type_map 测试
# ══════════════════════════════════════

class TestPgTypeMap(SimpleTestCase):
    """字段类型 → PostgreSQL 类型映射测试"""

    def test_all_field_types_have_mapping(self):
        """所有在用字段类型都有映射（用户列或系统列）"""
        expected_types = {
            'text', 'long_text', 'number', 'rating',
            'percent', 'currency',
            'select', 'multi_select', 'checkbox',
            'date', 'created_time', 'last_modified_time',
            'url', 'email', 'phone',
            'user', 'created_by', 'last_modified_by',
            'attachment',
            'link',
        }
        all_mapped = set(FIELD_TYPE_TO_PG_TYPE.keys()) | set(SYSTEM_COLUMN_FIELD_TYPES.keys())
        for ft in expected_types:
            self.assertIn(ft, all_mapped, f'Field type {ft} has no mapping')

    def test_text_types_map_to_text(self):
        """文本类字段映射到 TEXT"""
        for ft in ('text', 'long_text', 'url', 'email', 'phone', 'select'):
            self.assertEqual(get_pg_type(ft), 'TEXT', f'{ft} should map to TEXT')

    def test_number_types(self):
        """数值字段映射"""
        self.assertEqual(get_pg_type('number'), 'DOUBLE PRECISION')
        self.assertEqual(get_pg_type('percent'), 'DOUBLE PRECISION')
        self.assertEqual(get_pg_type('currency'), 'DOUBLE PRECISION')
        self.assertEqual(get_pg_type('rating'), 'INTEGER')

    def test_boolean_type(self):
        """布尔字段映射"""
        self.assertEqual(get_pg_type('checkbox'), 'BOOLEAN')

    def test_date_types(self):
        """日期字段映射"""
        self.assertEqual(get_pg_type('date'), 'DATE')
        self.assertEqual(
            get_pg_type('date', {'formatting': {'time': 'HH:mm:ss'}}),
            'TIMESTAMPTZ',
        )

    def test_timestamp_to_date_cast_uses_configured_timezone(self):
        using = get_type_cast_using(
            'date',
            'date',
            'date_field',
            {'formatting': {'time': 'HH:mm:ss', 'timeZone': 'Asia/Shanghai'}},
            {'formatting': {'time': 'None', 'timeZone': 'Asia/Shanghai'}},
        )

        self.assertEqual(
            using,
            '("date_field" AT TIME ZONE \'Asia/Shanghai\')::DATE',
        )

    def test_jsonb_types(self):
        """JSONB 字段映射"""
        for ft in ('multi_select', 'user', 'attachment', 'link'):
            self.assertEqual(get_pg_type(ft), 'JSONB', f'{ft} should map to JSONB')

    def test_system_fields_return_none(self):
        """系统字段类型不生成用户列"""
        for ft in ('created_time', 'last_modified_time', 'created_by', 'last_modified_by'):
            self.assertIsNone(get_pg_type(ft), f'{ft} should return None (system column)')
            self.assertTrue(is_system_field(ft))

    def test_system_columns_definition(self):
        """系统列定义完整"""
        expected_cols = {'__id', '__auto_number', '__order', '__version',
                        '__created_at', '__updated_at', '__created_by', '__updated_by'}
        self.assertEqual(set(SYSTEM_COLUMNS.keys()), expected_cols)

    def test_get_pg_default(self):
        """默认值生成"""
        self.assertEqual(get_pg_default('checkbox'), 'false')
        self.assertEqual(get_pg_default('multi_select'), "'[]'::jsonb")
        self.assertIsNone(get_pg_default('text'))
        self.assertIsNone(get_pg_default('number'))

    def test_get_column_definition(self):
        """列定义生成"""
        field_id = 'a1b2c3d4e5f6'
        result = get_column_definition(field_id, 'text')
        self.assertIsNotNone(result)
        col_name, col_def = result
        self.assertEqual(col_name, f'"{field_id}"')
        self.assertEqual(col_def, 'TEXT')

        result = get_column_definition(field_id, 'checkbox')
        col_name, col_def = result
        self.assertEqual(col_def, 'BOOLEAN DEFAULT false')

        # 系统字段返回 None
        result = get_column_definition(field_id, 'created_time')
        self.assertIsNone(result)

    def test_get_column_definition_rejects_unknown_user_field_type(self):
        """非系统字段缺少 native 映射时必须硬失败，避免元数据/物理列失配。"""
        with self.assertRaises(UnknownNativeFieldTypeError):
            get_column_definition('a1b2c3d4e5f6', 'unsupported_new_type')

    def test_type_cast_using(self):
        """类型转换 USING 表达式"""
        fid = 'test_col'

        # TEXT → DOUBLE PRECISION
        using = get_type_cast_using('text', 'number', fid)
        self.assertIn('DOUBLE PRECISION', using)

        # TEXT → BOOLEAN
        using = get_type_cast_using('text', 'checkbox', fid)
        self.assertIn('CASE', using)

        # 相同类型无需转换
        using = get_type_cast_using('text', 'select', fid)
        self.assertIsNone(using)

        # DOUBLE PRECISION → TEXT
        using = get_type_cast_using('number', 'text', fid)
        self.assertIn('::TEXT', using)

    def test_get_all_field_types(self):
        """字段类型列表完整"""
        all_types = get_all_field_types()
        self.assertEqual(
            set(all_types),
            set(FIELD_TYPE_TO_PG_TYPE) | set(SYSTEM_COLUMN_FIELD_TYPES),
        )


# ══════════════════════════════════════
# feature_flags 测试
# ══════════════════════════════════════

class TestFeatureFlags(TestCase):
    """迁移阶段控制测试"""

    @override_settings(NATIVE_STORAGE_PHASE='disabled')
    def test_disabled_phase(self):
        """disabled 阶段：全部关闭"""
        self.assertEqual(NativeStoragePhase.current(), 'disabled')
        self.assertFalse(NativeStoragePhase.is_native_write_enabled())
        self.assertFalse(NativeStoragePhase.is_native_read_enabled())
        self.assertTrue(NativeStoragePhase.is_json_write_enabled())
        self.assertTrue(NativeStoragePhase.is_json_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='dual_write')
    def test_dual_write_phase(self):
        """dual_write 阶段：写两边，读 JSON"""
        self.assertTrue(NativeStoragePhase.is_native_write_enabled())
        self.assertFalse(NativeStoragePhase.is_native_read_enabled())
        self.assertTrue(NativeStoragePhase.is_json_write_enabled())
        self.assertTrue(NativeStoragePhase.is_json_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='switch_read')
    def test_switch_read_phase(self):
        """switch_read 阶段：写两边，读原生"""
        self.assertTrue(NativeStoragePhase.is_native_write_enabled())
        self.assertTrue(NativeStoragePhase.is_native_read_enabled())
        self.assertTrue(NativeStoragePhase.is_json_write_enabled())
        self.assertFalse(NativeStoragePhase.is_json_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='native_only')
    def test_native_only_phase(self):
        """native_only 阶段：仅原生"""
        self.assertTrue(NativeStoragePhase.is_native_write_enabled())
        self.assertTrue(NativeStoragePhase.is_native_read_enabled())
        self.assertFalse(NativeStoragePhase.is_json_write_enabled())
        self.assertFalse(NativeStoragePhase.is_json_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='invalid_value')
    def test_invalid_phase_defaults_disabled(self):
        """无效阶段值回退到 disabled"""
        self.assertEqual(NativeStoragePhase.current(), 'disabled')
        self.assertFalse(NativeStoragePhase.is_native_write_enabled())

    def test_default_phase_is_disabled(self):
        """未配置时默认 disabled"""
        # 不设置 NATIVE_STORAGE_PHASE，使用 default
        with self.settings(NATIVE_STORAGE_PHASE='disabled'):
            self.assertEqual(NativeStoragePhase.current(), 'disabled')


# ══════════════════════════════════════
# value_converter 测试
# ══════════════════════════════════════

class TestValueConverter(TestCase):
    """Python ↔ PostgreSQL 值转换测试"""

    # ── 写入转换 (python_to_pg) ──

    def test_text_conversion(self):
        self.assertEqual(python_to_pg('hello', 'text'), 'hello')
        self.assertEqual(python_to_pg(123, 'text'), '123')
        self.assertIsNone(python_to_pg(None, 'text'))

    def test_number_conversion(self):
        self.assertEqual(python_to_pg(42, 'number'), 42.0)
        self.assertEqual(python_to_pg('3.14', 'number'), 3.14)
        self.assertEqual(python_to_pg(Decimal('99.99'), 'number'), 99.99)
        self.assertIsNone(python_to_pg(None, 'number'))
        self.assertIsNone(python_to_pg('not_a_number', 'number'))

    def test_rating_conversion(self):
        self.assertEqual(python_to_pg(3, 'rating'), 3)
        self.assertEqual(python_to_pg('5', 'rating'), 5)
        self.assertIsNone(python_to_pg(None, 'rating'))

    def test_checkbox_conversion(self):
        self.assertTrue(python_to_pg(True, 'checkbox'))
        self.assertFalse(python_to_pg(False, 'checkbox'))
        self.assertTrue(python_to_pg('true', 'checkbox'))
        self.assertFalse(python_to_pg('false', 'checkbox'))
        self.assertTrue(python_to_pg('1', 'checkbox'))
        self.assertTrue(python_to_pg('yes', 'checkbox'))

    def test_date_conversion(self):
        self.assertEqual(python_to_pg('2024-12-25', 'date'), '2024-12-25')
        self.assertEqual(python_to_pg('2024-12-25T10:30:00Z', 'date'), '2024-12-25')
        self.assertEqual(
            python_to_pg('2024-12-25T10:30:00Z', 'date', {'formatting': {'time': 'HH:mm:ss'}}),
            '2024-12-25T10:30:00+00:00',
        )
        d = date(2024, 12, 25)
        self.assertEqual(python_to_pg(d, 'date'), '2024-12-25')

    def test_jsonb_conversion(self):
        """JSONB 类型使用 psycopg2 Json 适配器"""
        result = python_to_pg(['opt1', 'opt2'], 'multi_select')
        self.assertIsNotNone(result)
        # 返回的是 psycopg2.extras.Json 包装对象
        self.assertTrue(hasattr(result, 'adapted'))

    def test_link_cell_uses_json_adapter(self):
        """link 单元格 [{id,title}] 必须 Json 包装，否则 UPDATE 会 can't adapt type 'dict'"""
        from apps.tabdata.native.value_converter import build_native_field_values

        cell = [{'id': '11111111-1111-1111-1111-111111111111', 'title': '演员A'}]
        result = python_to_pg(cell, 'link')
        self.assertTrue(hasattr(result, 'adapted'))

        field_id = uuid.UUID('22222222-2222-2222-2222-222222222222')
        field = type('F', (), {
            'id': field_id,
            'field_type': 'link',
            'config': {'relationship': 'ManyMany'},
        })()
        native = build_native_field_values({str(field_id): cell}, [field])
        self.assertIn(field_id.hex, native)
        self.assertTrue(hasattr(native[field_id.hex], 'adapted'))

    def test_select_as_text(self):
        self.assertEqual(python_to_pg('Option A', 'select'), 'Option A')

    # ── 读取转换 (pg_to_python) ──

    def test_read_number(self):
        """Decimal → float"""
        self.assertEqual(pg_to_python(Decimal('3.14'), 'number'), 3.14)
        self.assertEqual(pg_to_python(42.0, 'number'), 42.0)

    def test_read_date(self):
        """date → ISO 字符串"""
        d = date(2024, 12, 25)
        self.assertEqual(pg_to_python(d, 'date'), '2024-12-25')
        dt = datetime(2024, 12, 25, 10, 30, 0, tzinfo=timezone.utc)
        self.assertEqual(
            pg_to_python(dt, 'date', {'formatting': {'time': 'HH:mm:ss'}}),
            dt.isoformat(),
        )

    def test_read_checkbox(self):
        self.assertTrue(pg_to_python(True, 'checkbox'))
        self.assertFalse(pg_to_python(False, 'checkbox'))

    def test_read_jsonb(self):
        """JSONB 值（psycopg2 已反序列化为 Python 对象）"""
        self.assertEqual(pg_to_python(['a', 'b'], 'multi_select'), ['a', 'b'])
        self.assertEqual(pg_to_python({'id': '123'}, 'user'), {'id': '123'})

    def test_null_roundtrip(self):
        """None 值在转换中保持 None"""
        for ft in ('text', 'number', 'checkbox', 'date', 'multi_select'):
            self.assertIsNone(python_to_pg(None, ft))
            self.assertIsNone(pg_to_python(None, ft))


# ══════════════════════════════════════
# query_builder 测试 (单元测试，不需要 DB)
# ══════════════════════════════════════

class TestQueryBuilder(TestCase):
    """原生 SQL 查询构建器测试"""

    def setUp(self):
        """创建模拟字段对象"""
        self.text_field = self._make_field('text', 'title')
        self.number_field = self._make_field('number', 'score')
        self.select_field = self._make_field('select', 'status', {'choices': ['todo', 'doing', 'done']})
        self.multi_select_field = self._make_field('multi_select', 'tags')
        self.checkbox_field = self._make_field('checkbox', 'completed')
        self.date_field = self._make_field('date', 'due_date')

        self.fields = [
            self.text_field, self.number_field, self.select_field,
            self.multi_select_field, self.checkbox_field, self.date_field,
        ]

        from apps.tabdata.native.query_builder import NativeQueryBuilder
        self.project_id = uuid.uuid4()
        self.table_id = uuid.uuid4()
        self.qb = NativeQueryBuilder(self.project_id, self.table_id, self.fields)

    def _make_field(self, field_type, name, config=None):
        """创建模拟字段对象"""
        field = MagicMock()
        field.id = uuid.uuid4()
        field.field_type = field_type
        field.name = name
        field.config = config or {}
        return field

    # ── Filter 测试 ──

    def test_empty_filter(self):
        """空筛选返回 TRUE"""
        sql, params = self.qb.build_where_clause(None)
        self.assertEqual(sql, 'TRUE')
        self.assertEqual(params, [])

    def test_equals_filter(self):
        """equals 操作符"""
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(self.text_field.id), 'operator': 'equals', 'value': 'hello'},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('= %s', sql)
        self.assertEqual(params, ['hello'])

    def test_equals_null(self):
        """equals None → IS NULL"""
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(self.text_field.id), 'operator': 'equals', 'value': None},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('IS NULL', sql)

    def test_not_equals_filter(self):
        """not_equals 操作符"""
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(self.text_field.id), 'operator': 'not_equals', 'value': 'test'},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('!=', sql)
        self.assertIn('OR', sql)  # (col != %s OR col IS NULL)

    def test_contains_filter(self):
        """contains 操作符 → ILIKE"""
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(self.text_field.id), 'operator': 'contains', 'value': 'test'},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('ILIKE', sql)
        self.assertEqual(params, ['%test%'])

    def test_is_empty_text(self):
        """is_empty 文本字段"""
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(self.text_field.id), 'operator': 'is_empty'},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('IS NULL', sql)
        self.assertIn("= ''", sql)

    def test_greater_than_filter(self):
        """greater_than 操作符"""
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(self.number_field.id), 'operator': 'greater_than', 'value': 10},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('> %s', sql)
        self.assertEqual(params, [10])

    def test_in_filter(self):
        """in 操作符"""
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(self.select_field.id), 'operator': 'in', 'value': ['todo', 'doing']},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('IN', sql)
        self.assertEqual(params, ['todo', 'doing'])

    def test_nested_filter(self):
        """嵌套筛选组"""
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {
                    'conjunction': 'or',
                    'filterSet': [
                        {'field_id': str(self.text_field.id), 'operator': 'equals', 'value': 'A'},
                        {'field_id': str(self.text_field.id), 'operator': 'equals', 'value': 'B'},
                    ],
                },
                {'field_id': str(self.number_field.id), 'operator': 'greater_than', 'value': 5},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('OR', sql)
        self.assertIn('AND', sql)
        self.assertEqual(len(params), 3)  # A, B, 5

    # ── Sort 测试 ──

    def test_default_sort(self):
        """无排序规则时使用默认排序"""
        order, params = self.qb.build_order_clause(None)
        self.assertIn('"__order" ASC', order)
        self.assertIn('"__auto_number" ASC', order)
        self.assertEqual(params, [])

    def test_text_sort(self):
        """文本字段排序"""
        sorts = [{'field_id': str(self.text_field.id), 'order': 'asc'}]
        order, params = self.qb.build_order_clause(sorts)
        self.assertIn('ASC', order)
        self.assertIn('NULLS LAST', order)

    def test_desc_sort(self):
        """降序排序"""
        sorts = [{'field_id': str(self.number_field.id), 'order': 'desc'}]
        order, params = self.qb.build_order_clause(sorts)
        self.assertIn('DESC', order)

    def test_select_sort_uses_array_position(self):
        """select 字段排序使用 ARRAY_POSITION — 选项值参数化"""
        sorts = [{'field_id': str(self.select_field.id), 'order': 'asc'}]
        order, params = self.qb.build_order_clause(sorts)
        self.assertIn('ARRAY_POSITION', order)
        self.assertIn('%s', order)
        self.assertIn('todo', params)
        self.assertIn('doing', params)
        self.assertIn('done', params)

    def test_select_sort_uses_canonical_choice_id_before_label(self):
        """旧格式 {id,label} choice 排序应使用 id，而不是翻译 label。"""
        self.select_field.config = {
            'choices': [
                {'id': 'open', 'label': '打开'},
                {'id': 'closed', 'label': '关闭'},
            ]
        }

        order, params = self.qb.build_order_clause(
            [{'field_id': str(self.select_field.id), 'order': 'asc'}]
        )

        self.assertIn('ARRAY_POSITION', order)
        self.assertEqual(params, ['open', 'closed'])

    def test_select_sort_accepts_options_alias(self):
        """select choices 的 options 别名也应保留定义顺序。"""
        self.select_field.config = {
            'options': [
                {'value': 'pending', 'label': '待处理'},
                {'value': 'done', 'label': '完成'},
            ]
        }

        order, params = self.qb.build_order_clause(
            [{'field_id': str(self.select_field.id), 'order': 'asc'}]
        )

        self.assertIn('ARRAY_POSITION', order)
        self.assertEqual(params, ['pending', 'done'])

    # ── Aggregate 测试 ──

    def test_count_aggregate(self):
        """COUNT 聚合"""
        sql, params = self.qb.build_aggregate_sql(
            {str(self.number_field.id): 'count'}
        )
        self.assertIn('COUNT(*)', sql)
        self.assertIn('SELECT', sql)

    def test_sum_aggregate(self):
        """SUM 聚合"""
        sql, params = self.qb.build_aggregate_sql(
            {str(self.number_field.id): 'sum'}
        )
        self.assertIn('SUM(', sql)

    def test_avg_aggregate(self):
        """AVG 聚合"""
        sql, params = self.qb.build_aggregate_sql(
            {str(self.number_field.id): 'average'}
        )
        self.assertIn('AVG(', sql)

    # ── SELECT 构建测试 ──

    def test_build_select_sql(self):
        """完整 SELECT 查询"""
        where = self.qb.build_where_clause({
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(self.number_field.id), 'operator': 'greater_than', 'value': 0},
            ],
        })
        order = self.qb.build_order_clause(
            [{'field_id': str(self.number_field.id), 'order': 'desc'}]
        )
        sql, params = self.qb.build_select_sql(
            where=where,
            order_by=order,
            limit=50,
            offset=10,
        )
        self.assertIn('SELECT', sql)
        self.assertIn('FROM', sql)
        self.assertIn('WHERE', sql)
        self.assertIn('ORDER BY', sql)
        self.assertIn('LIMIT', sql)
        self.assertIn('OFFSET', sql)

    def test_build_count_sql(self):
        """COUNT 查询"""
        sql, params = self.qb.build_count_sql()
        self.assertIn('COUNT(*)', sql)
        self.assertIn('FROM', sql)

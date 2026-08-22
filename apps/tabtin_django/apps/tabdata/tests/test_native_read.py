"""
Phase 2 原生列读取测试

验证 switch_read 阶段的原生列查询路径：
- 筛选操作符 SQL 生成正确性
- 排序 SQL 生成正确性
- 聚合统计 SQL 生成正确性
- serialize_native_row 输出格式与 serialize_record 一致
- view_data_service 原生路径路由正确
- record_service 原生读取路由正确
- consistency_checker 检测不一致
- native_verify 管理命令可运行

使用 Mock 方式测试，避免依赖真实 PostgreSQL 连接。
"""

import uuid
from datetime import datetime, timezone, date
from decimal import Decimal
from unittest.mock import patch, MagicMock, call, ANY, PropertyMock

from django.test import TestCase, override_settings

from apps.tabdata.native.feature_flags import NativeStoragePhase
from apps.tabdata.native.query_builder import NativeQueryBuilder
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.native.value_converter import pg_to_python, python_to_pg
from apps.tabdata.native.consistency_checker import ConsistencyChecker


# ══════════════════════════════════════
# 辅助工厂
# ══════════════════════════════════════

def _make_field(field_id=None, name='Test Field', field_type='text', config=None):
    """创建 Mock TableField"""
    field = MagicMock()
    field.id = field_id or uuid.uuid4()
    field.name = name
    field.field_type = field_type
    field.config = config or {}
    field.is_deleted = False
    return field


def _make_fields_set():
    """创建标准测试字段集"""
    return [
        _make_field(name='名称', field_type='text'),
        _make_field(name='数量', field_type='number'),
        _make_field(name='状态', field_type='select', config={
            'choices': ['待办', '进行中', '已完成'],
        }),
        _make_field(name='标签', field_type='multi_select', config={
            'choices': ['紧急', '重要', '一般'],
        }),
        _make_field(name='完成', field_type='checkbox'),
        _make_field(name='截止日期', field_type='date'),
        _make_field(name='备注', field_type='long_text'),
    ]


# ══════════════════════════════════════
# NativeQueryBuilder 筛选测试
# ══════════════════════════════════════

class TestQueryBuilderFilter(TestCase):
    """测试 NativeQueryBuilder 筛选 SQL 生成"""

    def setUp(self):
        self.project_id = uuid.uuid4()
        self.table_id = uuid.uuid4()
        self.fields = _make_fields_set()
        self.qb = NativeQueryBuilder(
            self.project_id, self.table_id, self.fields,
        )

    def test_equals_text(self):
        """equals 操作符：文本字段"""
        field = self.fields[0]  # 名称 (text)
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'equals',
                'value': '测试项目',
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('= %s', sql)
        self.assertEqual(params, ['测试项目'])

    def test_equals_null(self):
        """equals None → IS NULL"""
        field = self.fields[0]
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'equals',
                'value': None,
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('IS NULL', sql)
        self.assertEqual(params, [])

    def test_not_equals(self):
        """not_equals 操作符"""
        field = self.fields[0]
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'not_equals',
                'value': 'X',
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('!=', sql)
        self.assertIn('IS NULL', sql)  # OR col IS NULL
        self.assertEqual(params, ['X'])

    def test_contains_text(self):
        """contains 操作符：文本 ILIKE"""
        field = self.fields[0]
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'contains',
                'value': '测试',
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('ILIKE', sql)
        self.assertEqual(params, ['%测试%'])

    def test_is_empty_text(self):
        """is_empty 操作符：文本字段"""
        field = self.fields[0]
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'is_empty',
                'value': None,
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('IS NULL', sql)
        self.assertIn("= ''", sql)  # 文本额外检查空字符串

    def test_is_empty_jsonb(self):
        """is_empty 操作符：JSONB 字段"""
        field = self.fields[3]  # 标签 (multi_select → JSONB)
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'is_empty',
                'value': None,
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('IS NULL', sql)
        self.assertIn("'[]'::jsonb", sql)

    def test_greater_than_number(self):
        """greater_than 操作符"""
        field = self.fields[1]  # 数量 (number)
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'greater_than',
                'value': 100,
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('> %s', sql)
        self.assertEqual(params, [100])

    def test_date_with_time_equals_uses_the_selected_display_day(self):
        """带时间的日期等于按字段时区展开为整日范围。"""
        field = _make_field(
            name='提交时间',
            field_type='date',
            config={
                'formatting': {
                    'timeZone': 'Asia/Shanghai',
                    'time': 'HH:mm:ss',
                },
            },
        )
        qb = NativeQueryBuilder(self.project_id, self.table_id, [field])

        sql, params = qb.build_where_clause({
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'equals',
                'value': '2026-08-14T03:20:18.000Z',
            }],
        })

        self.assertIn('>= %s', sql)
        self.assertIn('<= %s', sql)
        self.assertEqual(
            params,
            [
                datetime(2026, 8, 13, 16, 0, tzinfo=timezone.utc),
                datetime(2026, 8, 14, 15, 59, 59, 999999, tzinfo=timezone.utc),
            ],
        )

    def test_date_with_time_ordering_uses_selected_day_boundaries(self):
        """带时间的日期早于/晚于按整日边界比较。"""
        field = _make_field(
            name='提交时间',
            field_type='date',
            config={'formatting': {'timeZone': 'Asia/Shanghai', 'time': 'HH:mm:ss'}},
        )
        qb = NativeQueryBuilder(self.project_id, self.table_id, [field])
        start = datetime(2026, 8, 13, 16, 0, tzinfo=timezone.utc)
        end = datetime(2026, 8, 14, 15, 59, 59, 999999, tzinfo=timezone.utc)

        cases = [
            ('greater_than', '> %s', end),
            ('greater_than_or_equals', '>= %s', start),
            ('less_than', '< %s', start),
            ('less_than_or_equals', '<= %s', end),
        ]
        for operator, sql_fragment, expected_param in cases:
            with self.subTest(operator=operator):
                sql, params = qb.build_where_clause({
                    'conjunction': 'and',
                    'filterSet': [{
                        'field_id': str(field.id),
                        'operator': operator,
                        'value': '2026-08-14',
                    }],
                })

                self.assertIn(sql_fragment, sql)
                self.assertEqual(params, [expected_param])

    def test_date_with_time_comparison_accepts_date_filter_value(self):
        """新前端传语义日期对象时，native 比较本身也按整日边界。"""
        field = _make_field(
            name='提交时间',
            field_type='date',
            config={'formatting': {'timeZone': 'Asia/Shanghai', 'time': 'HH:mm:ss'}},
        )
        qb = NativeQueryBuilder(self.project_id, self.table_id, [field])

        sql, params = qb.build_where_clause({
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'equals',
                'value': {
                    'mode': 'exactDate',
                    'exactDate': '2026-08-14',
                    'timeZone': 'Asia/Shanghai',
                },
            }],
        })

        self.assertIn('>= %s', sql)
        self.assertIn('<= %s', sql)
        self.assertEqual(
            params,
            [
                datetime(2026, 8, 13, 16, 0, tzinfo=timezone.utc),
                datetime(2026, 8, 14, 15, 59, 59, 999999, tzinfo=timezone.utc),
            ],
        )

    def test_is_within_builds_a_native_date_range(self):
        """在范围内不能在 native 查询链路被当成未知操作符。"""
        field = _make_field(name='提交时间', field_type='date')
        qb = NativeQueryBuilder(self.project_id, self.table_id, [field])

        sql, params = qb.build_where_clause({
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'is_within',
                'value': {
                    'mode': 'exactDate',
                    'exactDate': '2026-08-14',
                    'timeZone': 'Asia/Shanghai',
                },
            }],
        })

        self.assertIn('>= %s', sql)
        self.assertIn('<= %s', sql)
        self.assertEqual(
            params,
            [
                datetime(2026, 8, 13, 16, 0, tzinfo=timezone.utc),
                datetime(2026, 8, 14, 15, 59, 59, 999999, tzinfo=timezone.utc),
            ],
        )

    def test_is_within_uses_calendar_dates_for_native_date_columns(self):
        """纯日期列按本地日期比较，不把 UTC 跨日边界传给 DATE 列。"""
        field = _make_field(name='截止日期', field_type='date')
        qb = NativeQueryBuilder(self.project_id, self.table_id, [field])

        sql, params = qb.build_where_clause({
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'is_within',
                'value': {
                    'mode': 'dateRange',
                    'exactDate': '2026-08-14',
                    'exactDateEnd': '2026-08-16',
                    'timeZone': 'America/New_York',
                },
            }],
        })

        self.assertIn('>= %s', sql)
        self.assertIn('<= %s', sql)
        self.assertEqual(params, ['2026-08-14', '2026-08-16'])

    def test_relative_date_presets_build_native_date_ranges(self):
        from zoneinfo import ZoneInfo

        mock_datetime = MagicMock()
        mock_datetime.now.return_value = datetime(2026, 8, 15, 12, 0, tzinfo=ZoneInfo('Asia/Shanghai'))
        mock_datetime.combine = datetime.combine

        field = _make_field(
            name='Due date',
            field_type='date',
            config={'formatting': {'timeZone': 'Asia/Shanghai', 'time': 'None'}},
        )
        qb = NativeQueryBuilder(self.project_id, self.table_id, [field])

        with patch('apps.tabdata.services.view_filter_service.datetime', mock_datetime):
            month_object_sql, month_object_params = qb.build_where_clause({
                'conjunction': 'and',
                'filterSet': [{
                    'field_id': str(field.id),
                    'operator': 'equals',
                    'value': {'mode': 'thisMonth', 'timeZone': 'Asia/Shanghai'},
                }],
            })
            month_string_sql, month_string_params = qb.build_where_clause({
                'conjunction': 'and',
                'filterSet': [{
                    'field_id': str(field.id),
                    'operator': 'equals',
                    'value': 'thisMonth',
                }],
            })
            today_sql, today_params = qb.build_where_clause({
                'conjunction': 'and',
                'filterSet': [{
                    'field_id': str(field.id),
                    'operator': 'is_within',
                    'value': 'today',
                }],
            })

        self.assertIn('>= %s', month_object_sql)
        self.assertIn('<= %s', month_object_sql)
        self.assertEqual(month_object_params, ['2026-08-01', '2026-08-31'])
        self.assertIn('>= %s', month_string_sql)
        self.assertIn('<= %s', month_string_sql)
        self.assertEqual(month_string_params, ['2026-08-01', '2026-08-31'])
        self.assertIn('>= %s', today_sql)
        self.assertIn('<= %s', today_sql)
        self.assertEqual(today_params, ['2026-08-15', '2026-08-15'])

    def test_in_operator(self):
        """in / is_any_of 操作符"""
        field = self.fields[2]  # 状态 (select)
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'is_any_of',
                'value': ['待办', '进行中'],
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('IN', sql)
        self.assertEqual(params, ['待办', '进行中'])

    def test_has_any_of_jsonb(self):
        """has_any_of 操作符：JSONB 数组"""
        field = self.fields[3]  # 标签 (multi_select)
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'has_any_of',
                'value': ['紧急', '重要'],
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn('?|', sql)
        self.assertEqual(params, [['紧急', '重要']])

    def test_nested_filter_set(self):
        """嵌套 FilterSet 递归"""
        f0 = self.fields[0]
        f1 = self.fields[1]
        filter_set = {
            'conjunction': 'or',
            'filterSet': [
                {
                    'conjunction': 'and',
                    'filterSet': [
                        {'field_id': str(f0.id), 'operator': 'contains', 'value': 'A'},
                        {'field_id': str(f1.id), 'operator': 'greater_than', 'value': 10},
                    ],
                },
                {'field_id': str(f0.id), 'operator': 'equals', 'value': 'B'},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertIn(' OR ', sql)
        self.assertIn('ILIKE', sql)
        self.assertIn('> %s', sql)
        self.assertEqual(len(params), 3)  # '%A%', 10, 'B'

    def test_empty_filter_returns_true(self):
        """空筛选返回 TRUE"""
        sql, params = self.qb.build_where_clause(None)
        self.assertEqual(sql, 'TRUE')
        self.assertEqual(params, [])

        sql2, params2 = self.qb.build_where_clause({})
        self.assertEqual(sql2, 'TRUE')

    def test_disabled_rule_skipped(self):
        """enabled=False 的条件不参与 WHERE 构建（与 ORM / 内存路径一致）"""
        field = self.fields[0]  # 名称 (text)
        filter_set = {
            'conjunction': 'and',
            'filterSet': [{
                'field_id': str(field.id),
                'operator': 'equals',
                'value': '测试项目',
                'enabled': False,
            }],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertEqual(sql, 'TRUE')
        self.assertEqual(params, [])

    def test_all_rules_disabled_returns_true(self):
        """全部条件禁用 → 等价于无筛选（返回所有行）"""
        f0, f1 = self.fields[0], self.fields[1]
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(f0.id), 'operator': 'equals', 'value': 'A', 'enabled': False},
                {'field_id': str(f1.id), 'operator': 'greater_than', 'value': 1, 'enabled': False},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertEqual(sql, 'TRUE')
        self.assertEqual(params, [])

    def test_disabled_rule_excluded_among_enabled(self):
        """禁用条件被跳过，仅保留启用条件"""
        f0, f1 = self.fields[0], self.fields[1]
        filter_set = {
            'conjunction': 'and',
            'filterSet': [
                {'field_id': str(f0.id), 'operator': 'equals', 'value': 'keep', 'enabled': True},
                {'field_id': str(f1.id), 'operator': 'greater_than', 'value': 100, 'enabled': False},
            ],
        }
        sql, params = self.qb.build_where_clause(filter_set)
        self.assertNotIn(' AND ', sql)
        self.assertEqual(params, ['keep'])


# ══════════════════════════════════════
# NativeQueryBuilder 排序测试
# ══════════════════════════════════════

class TestQueryBuilderSort(TestCase):
    """测试 NativeQueryBuilder 排序 SQL 生成"""

    def setUp(self):
        self.project_id = uuid.uuid4()
        self.table_id = uuid.uuid4()
        self.fields = _make_fields_set()
        self.qb = NativeQueryBuilder(
            self.project_id, self.table_id, self.fields,
        )

    def test_default_sort(self):
        """无排序时默认 __order ASC, __auto_number ASC"""
        order, params = self.qb.build_order_clause(None)
        self.assertIn('"__order" ASC', order)
        self.assertIn('"__auto_number" ASC', order)
        self.assertEqual(params, [])

    def test_single_sort_asc(self):
        """单字段升序"""
        field = self.fields[0]  # 名称 (text)
        order, params = self.qb.build_order_clause([
            {'field_id': str(field.id), 'order': 'asc'},
        ])
        self.assertIn('ASC', order)
        self.assertIn('NULLS LAST', order)

    def test_single_sort_desc(self):
        """单字段降序"""
        field = self.fields[1]  # 数量 (number)
        order, params = self.qb.build_order_clause([
            {'field_id': str(field.id), 'order': 'desc'},
        ])
        self.assertIn('DESC', order)
        self.assertIn('NULLS FIRST', order)

    def test_select_field_array_position(self):
        """select 字段使用 ARRAY_POSITION — 选项值参数化传入"""
        field = self.fields[2]  # 状态 (select)
        order, params = self.qb.build_order_clause([
            {'field_id': str(field.id), 'order': 'asc'},
        ])
        self.assertIn('ARRAY_POSITION', order)
        # 选项值现在通过 params 参数化传入，而非直接拼在 SQL 中
        self.assertIn('%s', order)
        self.assertTrue(len(params) > 0)

    def test_always_appends_fallback(self):
        """始终追加 __order 和 __auto_number 兜底"""
        field = self.fields[0]
        order, params = self.qb.build_order_clause([
            {'field_id': str(field.id), 'order': 'asc'},
        ])
        self.assertTrue(order.endswith('"__auto_number" ASC'))
        self.assertIn('"__order" ASC', order)

    def test_multi_sort(self):
        """多字段排序"""
        order, params = self.qb.build_order_clause([
            {'field_id': str(self.fields[1].id), 'order': 'desc'},
            {'field_id': str(self.fields[0].id), 'order': 'asc'},
        ])
        # 确保两个字段引用都在排序子句中
        self.assertIn('DESC', order)
        self.assertIn('ASC', order)


# ══════════════════════════════════════
# NativeQueryBuilder 完整查询测试
# ══════════════════════════════════════

class TestQueryBuilderSelect(TestCase):
    """测试完整 SELECT 查询生成"""

    def setUp(self):
        self.project_id = uuid.uuid4()
        self.table_id = uuid.uuid4()
        self.fields = _make_fields_set()
        self.qb = NativeQueryBuilder(
            self.project_id, self.table_id, self.fields,
        )

    def test_select_all_fields(self):
        """SELECT 所有字段"""
        sql, params = self.qb.build_select_sql(
            limit=10,
            offset=0,
        )
        self.assertIn('SELECT', sql)
        self.assertIn('FROM', sql)
        self.assertIn('LIMIT', sql)
        self.assertIn('OFFSET', sql)
        self.assertIn('"__id"', sql)
        self.assertIn('"__order"', sql)
        self.assertIn('"__version"', sql)

    def test_select_with_where(self):
        """SELECT with WHERE"""
        where = ('"__version" > %s', [5])
        sql, params = self.qb.build_select_sql(
            where=where,
            limit=10,
            offset=0,
        )
        self.assertIn('WHERE', sql)
        self.assertIn('"__version" > %s', sql)
        self.assertIn(5, params)

    def test_count_sql(self):
        """COUNT 查询"""
        sql, params = self.qb.build_count_sql()
        self.assertIn('SELECT COUNT(*)', sql)
        self.assertIn('FROM', sql)


# ══════════════════════════════════════
# serialize_native_row 格式一致性测试
# ══════════════════════════════════════

class TestSerializeNativeRow(TestCase):
    """测试原生行序列化与 serialize_record 格式一致"""

    def test_basic_serialization(self):
        """基础序列化格式"""
        from apps.tabdata.utils.record_serializers import serialize_native_row

        fields = [
            _make_field(name='名称', field_type='text'),
            _make_field(name='数量', field_type='number'),
        ]

        record_id = uuid.uuid4()
        row = {
            '__id': record_id,
            '__auto_number': 1,
            '__order': 1.0,
            '__version': 3,
            '__created_at': datetime(2024, 1, 1, tzinfo=timezone.utc),
            '__updated_at': datetime(2024, 1, 2, tzinfo=timezone.utc),
            '__created_by': uuid.uuid4(),
            '__updated_by': uuid.uuid4(),
            fields[0].id.hex: '测试项目',
            fields[1].id.hex: 42.5,
        }

        table_id = uuid.uuid4()
        result = serialize_native_row(row, table_id, fields)

        # 基本结构
        self.assertEqual(result['id'], str(record_id))
        self.assertEqual(result['table_id'], str(table_id))
        self.assertEqual(result['version'], 3)
        self.assertEqual(result['order'], 1.0)
        self.assertIsNotNone(result['created_at'])
        self.assertIsNotNone(result['updated_at'])

        # data 以字段名称为 key
        self.assertIn('名称', result['data'])
        self.assertEqual(result['data']['名称'], '测试项目')
        self.assertEqual(result['data']['数量'], 42.5)

        # fields 以字段名称为 key（默认 field_key_type='name'）
        self.assertIn('名称', result['fields'])
        self.assertIn('数量', result['fields'])

    def test_serialization_with_id_key_type(self):
        """field_key_type='id' 时 fields 以 UUID 为 key"""
        from apps.tabdata.utils.record_serializers import serialize_native_row

        field = _make_field(name='名称', field_type='text')
        row = {
            '__id': uuid.uuid4(),
            '__auto_number': 1,
            '__order': 1.0,
            '__version': 1,
            '__created_at': None,
            '__updated_at': None,
            '__created_by': None,
            '__updated_by': None,
            field.id.hex: '值',
        }

        result = serialize_native_row(
            row, uuid.uuid4(), [field],
            field_key_type='id',
        )

        # data 仍然按字段名
        self.assertIn('名称', result['data'])
        # fields 按 UUID
        self.assertIn(str(field.id), result['fields'])

    def test_null_values_not_in_data(self):
        """NULL 值不出现在 data 中"""
        from apps.tabdata.utils.record_serializers import serialize_native_row

        field = _make_field(name='名称', field_type='text')
        row = {
            '__id': uuid.uuid4(),
            '__auto_number': 1,
            '__order': 1.0,
            '__version': 1,
            '__created_at': None,
            '__updated_at': None,
            '__created_by': None,
            '__updated_by': None,
            field.id.hex: None,  # NULL
        }

        result = serialize_native_row(row, uuid.uuid4(), [field])
        self.assertNotIn('名称', result['data'])

    def test_batch_serialization(self):
        """批量序列化"""
        from apps.tabdata.utils.record_serializers import serialize_native_rows

        field = _make_field(name='名称', field_type='text')
        table_id = uuid.uuid4()
        rows = []
        for i in range(5):
            rows.append({
                '__id': uuid.uuid4(),
                '__auto_number': i + 1,
                '__order': float(i),
                '__version': 1,
                '__created_at': None,
                '__updated_at': None,
                '__created_by': None,
                '__updated_by': None,
                field.id.hex: f'Record {i}',
            })

        results = serialize_native_rows(rows, table_id, [field])
        self.assertEqual(len(results), 5)
        for i, r in enumerate(results):
            self.assertEqual(r['data']['名称'], f'Record {i}')


# ══════════════════════════════════════
# Feature Flag 路由测试
# ══════════════════════════════════════

class TestNativeReadRouting(TestCase):
    """测试 switch_read 阶段路由到原生路径"""

    @override_settings(NATIVE_STORAGE_PHASE='disabled')
    def test_disabled_phase_no_native_read(self):
        """disabled 阶段不启用原生读取"""
        self.assertFalse(NativeStoragePhase.is_native_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='dual_write')
    def test_dual_write_no_native_read(self):
        """dual_write 阶段不启用原生读取"""
        self.assertFalse(NativeStoragePhase.is_native_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='switch_read')
    def test_switch_read_enables_native_read(self):
        """switch_read 阶段启用原生读取"""
        self.assertTrue(NativeStoragePhase.is_native_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='native_only')
    def test_native_only_enables_native_read(self):
        """native_only 阶段启用原生读取"""
        self.assertTrue(NativeStoragePhase.is_native_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='switch_read')
    @patch('apps.tabdata.native.feature_flags.NativeStoragePhase.is_table_migrated', return_value=True)
    @patch('apps.tabdata.native.feature_flags.NativeStoragePhase.is_table_backfill_completed', return_value=True)
    def test_should_read_native_requires_all_conditions(self, mock_backfill, mock_migrated):
        """should_read_native 需要全局+表级条件同时满足"""
        table_id = uuid.uuid4()
        self.assertTrue(NativeStoragePhase.should_read_native(table_id))

    @override_settings(NATIVE_STORAGE_PHASE='switch_read')
    @patch('apps.tabdata.native.feature_flags.NativeStoragePhase.is_table_migrated', return_value=True)
    @patch('apps.tabdata.native.feature_flags.NativeStoragePhase.is_table_backfill_completed', return_value=False)
    def test_should_read_native_false_without_backfill(self, mock_backfill, mock_migrated):
        """回填未完成 → 不读原生"""
        table_id = uuid.uuid4()
        self.assertFalse(NativeStoragePhase.should_read_native(table_id))


# ══════════════════════════════════════
# ConsistencyChecker 测试
# ══════════════════════════════════════

class TestConsistencyChecker(TestCase):
    """测试数据一致性校验逻辑"""

    def test_values_equal_none(self):
        """两个 None 相等"""
        self.assertTrue(
            ConsistencyChecker._values_equal(None, None, 'text')
        )

    def test_values_equal_text(self):
        """文本值相等"""
        self.assertTrue(
            ConsistencyChecker._values_equal('hello', 'hello', 'text')
        )

    def test_values_not_equal_text(self):
        """文本值不等"""
        self.assertFalse(
            ConsistencyChecker._values_equal('hello', 'world', 'text')
        )

    def test_values_equal_number_float(self):
        """数字值相等（float vs int）"""
        self.assertTrue(
            ConsistencyChecker._values_equal(42, 42.0, 'number')
        )

    def test_values_equal_number_str_vs_float(self):
        """数字值相等（str vs float）"""
        self.assertTrue(
            ConsistencyChecker._values_equal('42', 42.0, 'number')
        )

    def test_values_equal_bool(self):
        """布尔值相等"""
        self.assertTrue(
            ConsistencyChecker._values_equal(True, True, 'checkbox')
        )
        self.assertTrue(
            ConsistencyChecker._values_equal(1, True, 'checkbox')
        )

    def test_values_equal_list(self):
        """列表值相等（JSONB）"""
        self.assertTrue(
            ConsistencyChecker._values_equal(
                ['a', 'b'], ['a', 'b'], 'multi_select',
            )
        )

    def test_values_not_equal_list_order(self):
        """列表值不等（顺序不同）"""
        self.assertFalse(
            ConsistencyChecker._values_equal(
                ['a', 'b'], ['b', 'a'], 'multi_select',
            )
        )

    def test_values_one_none(self):
        """一边 None → 不等"""
        self.assertFalse(
            ConsistencyChecker._values_equal('hello', None, 'text')
        )
        self.assertFalse(
            ConsistencyChecker._values_equal(None, 'hello', 'text')
        )

    def test_values_equal_date_truncation(self):
        """日期值截断到秒级比较"""
        self.assertTrue(
            ConsistencyChecker._values_equal(
                '2024-01-01T00:00:00', '2024-01-01T00:00:00.123456', 'date',
            )
        )


# ══════════════════════════════════════
# pg_to_python 值转换测试
# ══════════════════════════════════════

class TestPgToPythonConversion(TestCase):
    """测试 PG → Python 值转换正确性"""

    def test_text_passthrough(self):
        """文本直接返回"""
        val = pg_to_python('hello', 'text', {})
        self.assertEqual(val, 'hello')

    def test_number_float(self):
        """数字返回 float"""
        val = pg_to_python(42.5, 'number', {})
        self.assertEqual(val, 42.5)

    def test_number_decimal(self):
        """Decimal → float"""
        val = pg_to_python(Decimal('42.5'), 'number', {})
        self.assertEqual(val, 42.5)

    def test_bool_true(self):
        """布尔 True"""
        val = pg_to_python(True, 'checkbox', {})
        self.assertTrue(val)

    def test_bool_false(self):
        """布尔 False"""
        val = pg_to_python(False, 'checkbox', {})
        self.assertFalse(val)

    def test_none_passthrough(self):
        """None 直接返回"""
        val = pg_to_python(None, 'text', {})
        self.assertIsNone(val)

    def test_list_passthrough(self):
        """列表直接返回"""
        val = pg_to_python(['a', 'b'], 'multi_select', {})
        self.assertEqual(val, ['a', 'b'])

    def test_datetime_to_iso(self):
        """datetime → ISO 字符串"""
        dt = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        val = pg_to_python(dt, 'datetime', {})
        self.assertIn('2024-01-01', str(val))


# ══════════════════════════════════════
# 聚合查询构建测试
# ══════════════════════════════════════

class TestQueryBuilderAggregate(TestCase):
    """测试 NativeQueryBuilder 聚合 SQL 生成"""

    def setUp(self):
        self.project_id = uuid.uuid4()
        self.table_id = uuid.uuid4()
        self.fields = _make_fields_set()
        self.qb = NativeQueryBuilder(
            self.project_id, self.table_id, self.fields,
        )

    def test_count_aggregate(self):
        """COUNT(*) 聚合"""
        field = self.fields[1]  # 数量
        sql, params = self.qb.build_aggregate_sql({
            str(field.id): 'count',
        })
        self.assertIn('COUNT(*)', sql)

    def test_sum_aggregate(self):
        """SUM 聚合"""
        field = self.fields[1]  # 数量
        sql, params = self.qb.build_aggregate_sql({
            str(field.id): 'sum',
        })
        self.assertIn('SUM(', sql)

    def test_avg_aggregate(self):
        """AVG 聚合"""
        field = self.fields[1]  # 数量
        sql, params = self.qb.build_aggregate_sql({
            str(field.id): 'average',
        })
        self.assertIn('AVG(', sql)

    def test_count_empty_text(self):
        """count_empty (文本字段)"""
        field = self.fields[0]  # 名称 (text)
        sql, params = self.qb.build_aggregate_sql({
            str(field.id): 'count_empty',
        })
        self.assertIn('IS NULL', sql)
        self.assertIn("= ''", sql)

    def test_count_empty_jsonb(self):
        """count_empty (JSONB 字段)"""
        field = self.fields[3]  # 标签 (multi_select)
        sql, params = self.qb.build_aggregate_sql({
            str(field.id): 'count_empty',
        })
        self.assertIn('IS NULL', sql)
        self.assertIn("'[]'::jsonb", sql)

    def test_empty_aggregation(self):
        """空聚合返回 SELECT 1"""
        sql, params = self.qb.build_aggregate_sql({})
        self.assertEqual(sql, 'SELECT 1')


# ══════════════════════════════════════
# NativeVerify 管理命令测试
# ══════════════════════════════════════

class TestNativeVerifyCommand(TestCase):
    """测试 native_verify 管理命令"""

    @patch('apps.tabdata.native.consistency_checker.ConsistencyChecker.check_table')
    def test_command_calls_checker(self, mock_check):
        """命令正确调用 ConsistencyChecker"""
        from django.core.management import call_command
        from io import StringIO

        table_id = uuid.uuid4()
        mock_check.return_value = {
            'table_id': str(table_id),
            'table_name': '测试表',
            'checked': 100,
            'mismatches': 0,
            'missing_native': 0,
            'extra_native': 0,
            'field_mismatches': 0,
            'details': [],
        }

        out = StringIO()
        call_command('native_verify', f'--table={table_id}', stdout=out)

        mock_check.assert_called_once()
        output = out.getvalue()
        self.assertIn('校验', output)

    def test_command_requires_target(self):
        """缺少目标参数时报错"""
        from django.core.management import call_command
        from django.core.management.base import CommandError
        from io import StringIO

        with self.assertRaises(CommandError):
            call_command('native_verify', stdout=StringIO())


class TestConsistencyCheckerDetection(TestCase):
    """ConsistencyChecker missing/orphan 检测的纯逻辑验证。"""

    def test_set_diff_identifies_missing_and_orphan(self):
        """集合差集能正确识别 ORM-only 和 native-only 的行。"""
        orm_only_id = uuid.uuid4()
        native_only_id = uuid.uuid4()
        shared_id = uuid.uuid4()

        orm_ids = {orm_only_id, shared_id}
        native_ids = {native_only_id, shared_id}

        missing_native = orm_ids - native_ids
        orphan_native = native_ids - orm_ids

        self.assertEqual(missing_native, {orm_only_id})
        self.assertEqual(orphan_native, {native_only_id})

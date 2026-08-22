"""
TabData RLS（行级安全）综合测试

覆盖本轮加固的所有修复点：
- _eval_condition 全操作符（含别名、标准化、边界值）
- _merge_policy_clauses 策略合并逻辑（PERMISSIVE OR / RESTRICTIVE AND）
- ORM fallback 路径 RLS 不被跳过
- NativeQueryBuilder 未知操作符安全兜底
- RLSAccessDenied 异常继承关系
- NameResolver SQL 保留字不被误替换

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/tabdata/tests/test_rls_comprehensive.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import uuid
from unittest.mock import MagicMock, Mock, patch, PropertyMock

import pytest

from apps.tabdata.services.rls_service import RLSService, RLSContext


# ══════════════════════════════════════════════════════════════
# 辅助工厂
# ══════════════════════════════════════════════════════════════

def _make_mock_field(field_id=None, name='test_field', field_type='text'):
    """创建 Mock TableField（用于 NativeQueryBuilder 初始化）"""
    f = MagicMock()
    f.id = field_id or uuid.uuid4()
    f.name = name
    f.field_type = field_type
    f.config = {}
    f.is_deleted = False
    f.is_primary = False
    f.order = 0
    f.api_name = ''
    return f


# ══════════════════════════════════════════════════════════════
# 1. _eval_condition 全操作符参数化测试
# ══════════════════════════════════════════════════════════════

class TestEvalCondition:
    """RLSService._eval_condition 全操作符覆盖，含别名变体和边界值。"""

    @pytest.mark.parametrize("record_value,operator,expected,result", [
        # ── equals / eq ──
        ("hello", "equals", "hello", True),
        ("hello", "equals", "world", False),
        (None, "equals", None, True),
        (42, "eq", 42, True),
        (42, "eq", 43, False),

        # ── not_equals / neq ──
        ("hello", "not_equals", "world", True),
        ("hello", "not_equals", "hello", False),
        (None, "neq", "x", True),

        # ── contains ──
        ("hello world", "contains", "world", True),
        ("hello", "contains", "xyz", False),
        (None, "contains", "", True),

        # ── not_contains ──
        ("hello", "not_contains", "xyz", True),
        ("hello world", "not_contains", "world", False),

        # ── is_empty 变体 ──
        (None, "is_empty", None, True),
        ("", "is_empty", None, True),
        ([], "is_empty", None, True),
        ("hello", "is_empty", None, False),
        (None, "isempty", None, True),
        (None, "empty", None, True),

        # ── is_not_empty 变体 ──
        ("hello", "is_not_empty", None, True),
        (None, "is_not_empty", None, False),
        ("", "isnotempty", None, False),
        ([], "not_empty", None, False),
        ([1], "is_not_empty", None, True),

        # ── greater_than / gt / > ──
        (10, "greater_than", 5, True),
        (5, "greater_than", 10, False),
        (None, "greater_than", 5, False),
        (5, "gt", 3, True),
        (5, ">", 4, True),
        (5, "greater_than", None, False),

        # ── greater_than_or_equals / gte / >= ──
        (10, "greater_than_or_equals", 10, True),
        (10, "gte", 10, True),
        (9, ">=", 10, False),
        (None, "gte", 5, False),

        # ── less_than / lt / < ──
        (5, "less_than", 10, True),
        (10, "less_than", 5, False),
        (10, "lt", 5, False),
        (5, "<", 6, True),
        (None, "lt", 5, False),

        # ── less_than_or_equals / lte / <= ──
        (10, "less_than_or_equals", 10, True),
        (10, "lte", 10, True),
        (11, "<=", 10, False),
        (None, "lte", 10, False),

        # ── in / is_any_of / isanyof ──
        ("apple", "in", ["apple", "banana"], True),
        ("cherry", "in", ["apple", "banana"], False),
        ("cherry", "is_any_of", ["apple", "banana"], False),
        ("apple", "isanyof", ["apple"], True),

        # ── not_in / is_none_of / isnoneof ──
        ("cherry", "not_in", ["apple", "banana"], True),
        ("apple", "not_in", ["apple", "banana"], False),
        ("apple", "is_none_of", ["apple", "banana"], False),
        ("cherry", "isnoneof", ["apple", "banana"], True),

        # ── has_any_of / hasanyof ──
        (["a", "b", "c"], "has_any_of", ["b", "d"], True),
        (["a", "b"], "hasanyof", ["c", "d"], False),
        ("not_a_list", "has_any_of", ["a"], False),
        (123, "has_any_of", ["a"], False),

        # ── has_all_of / hasallof ──
        (["a", "b", "c"], "has_all_of", ["a", "b"], True),
        (["a", "b"], "hasallof", ["a", "b", "c"], False),
        ("not_a_list", "has_all_of", ["a"], False),

        # ── has_none_of / hasnoneof ──
        (["a", "b"], "has_none_of", ["c", "d"], True),
        (["a", "b"], "hasnoneof", ["b", "c"], False),
        ("not_a_list", "has_none_of", ["a"], True),

        # ── is_exactly / isexactly ──
        (["a", "b"], "is_exactly", ["b", "a"], True),
        (["a", "b", "c"], "isexactly", ["a", "b"], False),
        ("not_a_list", "is_exactly", ["a"], False),

        # ── is_not_exactly / isnotexactly ──
        (["a", "b", "c"], "is_not_exactly", ["a", "b"], True),
        (["a", "b"], "isnotexactly", ["b", "a"], False),
        ("not_a_list", "is_not_exactly", ["a"], True),

        # ── like / ilike（过渡期：Python 侧等同 case-sensitive contains）──
        ("hello world", "like", "world", True),
        ("hello", "like", "xyz", False),
        ("hello world", "ilike", "world", True),

        # ── 操作符标准化：连字符 / 大写 / 空格 ──
        (10, "greater-than", 5, True),
        (10, "GREATER_THAN", 5, True),
        (10, " greater_than ", 5, True),

        # ── 未知操作符 → deny ──
        ("hello", "unknown_op", "hello", False),
        (42, "!!!", 42, False),

        # ── 类型不兼容 → deny（TypeError 被捕获）──
        ("abc", "greater_than", 5, False),
        ("abc", "lt", 5, False),
    ])
    def test_eval_condition(self, record_value, operator, expected, result):
        assert RLSService._eval_condition(record_value, operator, expected) is result


# ══════════════════════════════════════════════════════════════
# 2. _merge_policy_clauses 策略合并测试
# ══════════════════════════════════════════════════════════════

class TestMergePolicyClauses:
    """PERMISSIVE OR + RESTRICTIVE AND 合并逻辑，同 PostgreSQL RLS 语义。"""

    def test_single_permissive(self):
        """单个 PERMISSIVE 策略不添加额外括号"""
        result = RLSService._merge_policy_clauses(
            [('owner_id = %s', ['u1'])],
            [],
        )
        assert result == ('owner_id = %s', ['u1'])

    def test_permissive_or(self):
        """多个 PERMISSIVE 策略之间 OR 合并"""
        result = RLSService._merge_policy_clauses(
            [
                ('owner_id = %s', ['u1']),
                ('department = %s', ['eng']),
            ],
            [],
        )
        assert result is not None
        sql, params = result
        assert '(owner_id = %s)' in sql
        assert '(department = %s)' in sql
        assert ' OR ' in sql
        assert params == ['u1', 'eng']

    def test_restrictive_and(self):
        """RESTRICTIVE 策略之间 AND 合并"""
        result = RLSService._merge_policy_clauses(
            [],
            [
                ('status = %s', ['active']),
                ('visible = %s', [True]),
            ],
        )
        assert result is not None
        sql, params = result
        assert '(status = %s)' in sql
        assert '(visible = %s)' in sql
        assert ' AND ' in sql
        assert params == ['active', True]

    def test_combined_permissive_and_restrictive(self):
        """(PERMISSIVE OR) AND (RESTRICTIVE AND) 组合"""
        result = RLSService._merge_policy_clauses(
            [
                ('owner_id = %s', ['u1']),
                ('department = %s', ['eng']),
            ],
            [
                ('status = %s', ['active']),
            ],
        )
        assert result is not None
        sql, params = result
        assert ' OR ' in sql
        assert ' AND ' in sql
        assert params == ['u1', 'eng', 'active']

    def test_empty_returns_none(self):
        """无策略时返回 None"""
        result = RLSService._merge_policy_clauses([], [])
        assert result is None


# ══════════════════════════════════════════════════════════════
# 3. ORM fallback RLS 测试
# ══════════════════════════════════════════════════════════════

class TestORMFallbackRLS:
    """DatabaseError 触发 ORM fallback 时，RLS 仍然生效。"""

    @patch('apps.tabdata.services.record_service.TableField')
    @patch('apps.tabdata.services.record_service.Table')
    @patch('apps.tabdata.services.record_service.TableRecord')
    @patch('apps.tabdata.services.rls_service.apply_rls_to_orm_queryset')
    def test_orm_fallback_applies_rls(
        self, mock_apply_rls, mock_record_model, mock_table_model, mock_field_model,
    ):
        """ORM fallback 路径收到 rls_context 时调用 apply_rls_to_orm_queryset"""
        from apps.tabdata.services.record_service import RecordService

        table_id = uuid.uuid4()
        rls_ctx = RLSContext(user_id='user-1', is_token_auth=True)

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.order_by.return_value = mock_qs
        mock_qs.count.return_value = 0
        mock_qs.__getitem__ = MagicMock(return_value=[])
        mock_record_model.objects.using.return_value.filter.return_value = mock_qs

        mock_apply_rls.return_value = mock_qs

        mock_field_model.objects.using.return_value.filter.return_value = []

        svc = RecordService()
        svc._list_records_orm_fallback(
            table_id,
            rls_context=rls_ctx,
        )

        mock_apply_rls.assert_called_once_with(mock_qs, table_id, rls_ctx)

    @patch('apps.tabdata.services.record_service.TableField')
    @patch('apps.tabdata.services.record_service.Table')
    @patch('apps.tabdata.services.record_service.TableRecord')
    def test_orm_fallback_skips_rls_when_no_context(
        self, mock_record_model, mock_table_model, mock_field_model,
    ):
        """rls_context=None 时不调用 RLS 过滤"""
        from apps.tabdata.services.record_service import RecordService

        table_id = uuid.uuid4()

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.order_by.return_value = mock_qs
        mock_qs.count.return_value = 0
        mock_qs.__getitem__ = MagicMock(return_value=[])
        mock_record_model.objects.using.return_value.filter.return_value = mock_qs

        mock_field_model.objects.using.return_value.filter.return_value = []

        svc = RecordService()
        with patch(
            'apps.tabdata.services.rls_service.apply_rls_to_orm_queryset'
        ) as mock_apply:
            svc._list_records_orm_fallback(
                table_id,
                rls_context=None,
            )
            mock_apply.assert_not_called()

    def test_orm_fallback_narrows_exception(self):
        """_list_records_native 仅捕获 DatabaseError 回退 ORM，其他异常直接传播"""
        from django.db import DatabaseError
        from apps.tabdata.services.record_service import RecordService

        svc = RecordService()
        table_id = uuid.uuid4()

        with patch.object(svc, 'check_table_permission', return_value=True):
            with patch.object(svc, '_list_records_native', side_effect=ValueError("unexpected")):
                with pytest.raises(ValueError, match="unexpected"):
                    svc.list_records(table_id)

        with patch.object(svc, 'check_table_permission', return_value=True):
            with patch.object(svc, '_list_records_native', return_value={"records": []}):
                result = svc.list_records(table_id)
                assert "records" in result


# ══════════════════════════════════════════════════════════════
# 4. NativeQueryBuilder 未知操作符安全兜底 + like/ilike 测试
# ══════════════════════════════════════════════════════════════

class TestQueryBuilderOperatorSafety:
    """NativeQueryBuilder 操作符白名单与 like/ilike 过渡方案。"""

    def _make_query_builder(self):
        """创建带一个 text 字段的 QueryBuilder"""
        from apps.tabdata.native.query_builder import NativeQueryBuilder

        field = _make_mock_field(name='title', field_type='text')
        space_id = uuid.uuid4()
        table_id = uuid.uuid4()
        qb = NativeQueryBuilder(space_id, table_id, [field])
        return qb, field

    def test_unknown_operator_returns_false(self):
        """未知操作符返回 ('FALSE', []) 而非 (None, [])"""
        qb, field = self._make_query_builder()
        rule = {
            'field_id': str(field.id),
            'operator': 'BANANA_OP',
            'value': 'anything',
        }
        sql, params = qb._build_single_condition(rule)
        assert sql == 'FALSE'
        assert params == []

    def test_like_operator_auto_converts(self):
        """like 操作符自动转换为 ILIKE + 通配符（contains 语义）"""
        qb, field = self._make_query_builder()
        rule = {
            'field_id': str(field.id),
            'operator': 'like',
            'value': 'hello',
        }
        sql, params = qb._build_single_condition(rule)
        assert 'ILIKE' in sql
        assert '%hello%' in params[0]

    def test_ilike_operator_escapes_wildcards(self):
        """ilike 操作符转义用户输入中的 % 和 _ 通配符"""
        qb, field = self._make_query_builder()
        rule = {
            'field_id': str(field.id),
            'operator': 'ilike',
            'value': '100%_done',
        }
        sql, params = qb._build_single_condition(rule)
        assert 'ILIKE' in sql
        assert r'100\%\_done' in params[0]

    def test_escape_like_function(self):
        """_escape_like 正确转义所有危险字符"""
        from apps.tabdata.native.query_builder import _escape_like

        assert _escape_like('hello') == 'hello'
        assert _escape_like('100%') == r'100\%'
        assert _escape_like('a_b') == r'a\_b'
        assert _escape_like(r'back\slash') == r'back\\slash'
        assert _escape_like('100%_test\\') == r'100\%\_test\\'


# ══════════════════════════════════════════════════════════════
# 5. RLSAccessDenied 异常测试
# ══════════════════════════════════════════════════════════════

class TestRLSAccessDenied:
    """RLSAccessDenied 异常的继承和行为。"""

    def test_rls_access_denied_is_permission_error(self):
        """RLSAccessDenied 继承 PermissionError"""
        from apps.tabdata.exceptions import RLSAccessDenied

        assert issubclass(RLSAccessDenied, PermissionError)

    def test_rls_access_denied_catchable_as_permission_error(self):
        """可以用 except PermissionError 捕获 RLSAccessDenied"""
        from apps.tabdata.exceptions import RLSAccessDenied

        with pytest.raises(PermissionError):
            raise RLSAccessDenied("行级安全策略拒绝访问")

    def test_rls_access_denied_message(self):
        """异常消息可正常传递"""
        from apps.tabdata.exceptions import RLSAccessDenied

        exc = RLSAccessDenied("custom message")
        assert str(exc) == "custom message"


# ══════════════════════════════════════════════════════════════
# 6. NameResolver SQL 保留字跳过测试
# ══════════════════════════════════════════════════════════════

class TestNameResolverSQLKeywords:
    """NameResolver 不应将 SQL 保留字替换为列名。"""

    def _build_resolver_with_field(self, field_name):
        """创建带指定字段名的 NameResolver（Mock DB 依赖）"""
        from apps.tabdata.native.name_resolver import NameResolver

        space_id = uuid.uuid4()
        table_id = uuid.uuid4()
        field_id = uuid.uuid4()

        table_meta = MagicMock()
        table_meta.qualified_name = f'"as_{space_id.hex}"."tbl_{table_id.hex}"'
        table_meta.fields = {
            field_name: MagicMock(column_name=field_id.hex),
        }

        resolver = NameResolver.__new__(NameResolver)
        resolver._space_id = space_id
        resolver._table_cache = {'my_table': table_meta}
        resolver._referenced_tables = {}

        return resolver, table_meta

    def test_sql_keyword_as_function_not_replaced(self):
        """SQL 函数名（如 COUNT、SUM）出现在 SQL 中时不应被替换为列名"""
        resolver, table_meta = self._build_resolver_with_field('count')

        referenced_tables = {'my_table': table_meta}
        name_mapping = {'my_table': table_meta.qualified_name}

        sql = 'SELECT COUNT(*) FROM my_table'
        result = resolver._resolve_unquoted_identifiers(sql, referenced_tables, name_mapping)

        assert 'COUNT(*)' in result

    def test_regular_field_still_resolved(self):
        """非保留字的普通字段名仍然正确解析"""
        resolver, table_meta = self._build_resolver_with_field('priority')

        referenced_tables = {'my_table': table_meta}
        name_mapping = {'my_table': table_meta.qualified_name}

        col_name = table_meta.fields['priority'].column_name
        sql = 'SELECT priority FROM my_table WHERE priority > 5'
        result = resolver._resolve_unquoted_identifiers(sql, referenced_tables, name_mapping)

        assert f'"{col_name}"' in result


# ══════════════════════════════════════════════════════════════
# 7. RLSContext 变量解析测试
# ══════════════════════════════════════════════════════════════

class TestRLSContextVariables:
    """RLSContext.resolve_variable 正确解析运行时变量。"""

    def test_current_user_id(self):
        ctx = RLSContext(user_id='user-123')
        assert ctx.resolve_variable('$current_user_id') == 'user-123'

    def test_token_user_id_with_token(self):
        token = MagicMock()
        token.user_id = 'token-owner-456'
        ctx = RLSContext(user_id='user-123', api_token=token, is_token_auth=True)
        assert ctx.resolve_variable('$token.user_id') == 'token-owner-456'

    def test_token_user_id_falls_back_to_user(self):
        ctx = RLSContext(user_id='user-123')
        assert ctx.resolve_variable('$token.user_id') == 'user-123'

    def test_token_metadata(self):
        token = MagicMock()
        token.metadata = {'team': 'backend', 'role': 'admin'}
        ctx = RLSContext(api_token=token, is_token_auth=True)
        assert ctx.resolve_variable('$token.metadata.team') == 'backend'
        assert ctx.resolve_variable('$token.metadata.role') == 'admin'
        assert ctx.resolve_variable('$token.metadata.missing') is None

    def test_unknown_variable_returned_as_is(self):
        ctx = RLSContext(user_id='user-123')
        assert ctx.resolve_variable('$unknown.var') == '$unknown.var'
        assert ctx.resolve_variable('plain_text') == 'plain_text'


# ══════════════════════════════════════════════════════════════
# 8. check_rls_for_write 策略评估测试
# ══════════════════════════════════════════════════════════════

class TestCheckRLSForWrite:
    """check_rls_for_write 对写操作的 Python 侧预检。"""

    def _svc_with_policies(self, policies):
        """创建 RLSService 并 Mock 策略返回"""
        svc = RLSService()
        svc.get_policies_for_table = Mock(return_value=policies)
        return svc

    def test_no_policies_allows_all(self):
        svc = self._svc_with_policies([])
        ctx = RLSContext(user_id='u1')
        assert svc.check_rls_for_write(
            uuid.uuid4(), 'INSERT', ctx, {'owner': 'u1'}
        ) is True

    def test_permissive_pass(self):
        """至少一个 PERMISSIVE 策略通过即可"""
        svc = self._svc_with_policies([
            {
                'condition': {'field_id': 'owner', 'operator': 'equals', 'value': 'u1'},
                'policy_type': 'PERMISSIVE',
            },
            {
                'condition': {'field_id': 'owner', 'operator': 'equals', 'value': 'u2'},
                'policy_type': 'PERMISSIVE',
            },
        ])
        ctx = RLSContext(user_id='u1')
        assert svc.check_rls_for_write(
            uuid.uuid4(), 'INSERT', ctx, {'owner': 'u1'}
        ) is True

    def test_permissive_all_fail(self):
        """所有 PERMISSIVE 策略都不通过时拒绝"""
        svc = self._svc_with_policies([
            {
                'condition': {'field_id': 'owner', 'operator': 'equals', 'value': 'u1'},
                'policy_type': 'PERMISSIVE',
            },
        ])
        ctx = RLSContext(user_id='u1')
        assert svc.check_rls_for_write(
            uuid.uuid4(), 'INSERT', ctx, {'owner': 'u999'}
        ) is False

    def test_restrictive_must_all_pass(self):
        """所有 RESTRICTIVE 策略必须通过"""
        svc = self._svc_with_policies([
            {
                'condition': {'field_id': 'status', 'operator': 'equals', 'value': 'active'},
                'policy_type': 'RESTRICTIVE',
            },
            {
                'condition': {'field_id': 'visible', 'operator': 'equals', 'value': True},
                'policy_type': 'RESTRICTIVE',
            },
        ])
        ctx = RLSContext(user_id='u1')
        assert svc.check_rls_for_write(
            uuid.uuid4(), 'INSERT', ctx, {'status': 'active', 'visible': True}
        ) is True
        assert svc.check_rls_for_write(
            uuid.uuid4(), 'INSERT', ctx, {'status': 'active', 'visible': False}
        ) is False

    def test_combined_permissive_and_restrictive(self):
        """PERMISSIVE OR + RESTRICTIVE AND 组合评估"""
        svc = self._svc_with_policies([
            {
                'condition': {'field_id': 'owner', 'operator': 'equals', 'value': 'u1'},
                'policy_type': 'PERMISSIVE',
            },
            {
                'condition': {'field_id': 'status', 'operator': 'equals', 'value': 'active'},
                'policy_type': 'RESTRICTIVE',
            },
        ])
        ctx = RLSContext(user_id='u1')

        assert svc.check_rls_for_write(
            uuid.uuid4(), 'INSERT', ctx, {'owner': 'u1', 'status': 'active'}
        ) is True

        assert svc.check_rls_for_write(
            uuid.uuid4(), 'INSERT', ctx, {'owner': 'u1', 'status': 'archived'}
        ) is False

        assert svc.check_rls_for_write(
            uuid.uuid4(), 'INSERT', ctx, {'owner': 'u999', 'status': 'active'}
        ) is False


# ══════════════════════════════════════════════════════════════
# 9. _normalize_condition 格式转换测试
# ══════════════════════════════════════════════════════════════

class TestNormalizeCondition:
    """简写条件 → FilterSet 规范化。"""

    def test_already_filterset(self):
        cond = {'conjunction': 'and', 'filterSet': [{'field_id': 'x', 'operator': 'equals', 'value': 1}]}
        result = RLSService._normalize_condition(cond)
        assert result is cond

    def test_shorthand_to_filterset(self):
        cond = {'field_id': 'owner', 'operator': 'equals', 'value': 'u1'}
        result = RLSService._normalize_condition(cond)
        assert result['conjunction'] == 'and'
        assert len(result['filterSet']) == 1
        assert result['filterSet'][0]['field_id'] == 'owner'

    def test_empty_condition(self):
        result = RLSService._normalize_condition({})
        assert result['filterSet'] == []

    def test_none_condition(self):
        result = RLSService._normalize_condition(None)
        assert result['filterSet'] == []


# ══════════════════════════════════════════════════════════════
# 10. build_rls_select_where 顶层函数测试
# ══════════════════════════════════════════════════════════════

class TestBuildRLSSelectWhere:
    """build_rls_select_where 入口函数的各种跳过路径。"""

    def test_skips_when_no_context(self):
        from apps.tabdata.services.rls_service import build_rls_select_where

        base = ('status = %s', ['active'])
        result = build_rls_select_where(
            table=MagicMock(rls_enabled=True),
            rls_context=None,
            qb=MagicMock(),
            base_where=base,
        )
        assert result == base

    def test_skips_when_rls_disabled(self):
        from apps.tabdata.services.rls_service import build_rls_select_where

        base = ('status = %s', ['active'])
        table = MagicMock()
        table.rls_enabled = False
        result = build_rls_select_where(
            table=table,
            rls_context=RLSContext(user_id='u1'),
            qb=MagicMock(),
            base_where=base,
        )
        assert result == base

    def test_skips_jwt_when_not_forced(self):
        from apps.tabdata.services.rls_service import build_rls_select_where

        base = ('status = %s', ['active'])
        table = MagicMock()
        table.rls_enabled = True
        table.rls_force = False

        result = build_rls_select_where(
            table=table,
            rls_context=RLSContext(user_id='u1', is_token_auth=False),
            qb=MagicMock(),
            base_where=base,
        )
        assert result == base

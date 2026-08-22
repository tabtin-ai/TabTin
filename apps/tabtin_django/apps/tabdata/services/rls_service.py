"""
Row Level Security (RLS) 服务

在查询执行前解析和注入行级过滤条件。

核心流程：
1. 获取表的活跃 RLS 策略
2. 根据请求上下文（API Token / JWT）筛选适用策略
3. 解析运行时变量（$token.user_id 等）
4. 构建 WHERE 子句并注入查询管道

策略合并逻辑（同 PostgreSQL RLS）：
- PERMISSIVE 策略之间 OR 合并
- RESTRICTIVE 策略之间 AND 合并
- 最终结果 = (p1 OR p2 OR ...) AND (r1 AND r2 AND ...)
"""

import copy
import logging
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from django.core.cache import cache

from apps.tabdata.constants import TABDATA_DB_ALIAS

logger = logging.getLogger('tabdata.rls')

# 缓存 key 前缀和超时
_CACHE_PREFIX = 'tabdata:rls:policies:'
# G-054: 缩短到 15s 减少策略收窄后的旧策略窗口。
# 写操作路径（create/update/delete policy）应主动调用 invalidate_cache()。
_CACHE_TIMEOUT = 15


class RLSContext:
    """RLS 运行时上下文，用于解析策略条件中的变量"""

    def __init__(
        self,
        *,
        user_id: Optional[str] = None,
        api_token: Optional[Any] = None,
        is_token_auth: bool = False,
    ):
        self.user_id = user_id
        self.api_token = api_token
        self.is_token_auth = is_token_auth

    @classmethod
    def from_request(cls, request) -> 'RLSContext':
        """从 Django request 构建 RLS 上下文"""
        api_token = getattr(request, 'api_token', None)
        user = getattr(request, 'auth', None) or getattr(request, 'user', None)
        user_id = str(user.id) if user and hasattr(user, 'id') else None
        return cls(
            user_id=user_id,
            api_token=api_token,
            is_token_auth=api_token is not None,
        )

    def resolve_variable(self, var: str) -> Any:
        """
        解析运行时变量。

        支持的变量：
        - $token.user_id — API Token 所属用户的 ID
        - $token.metadata.xxx — Token 自定义元数据
        - $current_user_id — 当前请求用户 ID
        """
        if var == '$current_user_id':
            return self.user_id
        if var == '$token.user_id':
            if self.api_token and hasattr(self.api_token, 'user_id'):
                return str(self.api_token.user_id)
            return self.user_id
        if var.startswith('$token.metadata.'):
            key = var[len('$token.metadata.'):]
            if self.api_token:
                metadata = getattr(self.api_token, 'metadata', None) or {}
                return metadata.get(key)
            return None
        # 未知变量原样返回
        return var


class RLSService:
    """行级安全策略评估服务"""

    def get_policies_for_table(
        self,
        table_id: UUID,
        operation: str,
        context: RLSContext,
    ) -> List:
        """
        获取表的适用 RLS 策略列表。

        Args:
            table_id: 表格 ID
            operation: 操作类型 (SELECT / INSERT / UPDATE / DELETE)
            context: RLS 运行时上下文

        Returns:
            适用策略列表
        """
        from apps.tabdata.models_rls import RowPolicy

        cache_key = f'{_CACHE_PREFIX}{table_id}'
        all_policies = cache.get(cache_key)

        if all_policies is None:
            all_policies = list(
                RowPolicy.objects.using(TABDATA_DB_ALIAS)
                .filter(table_id=table_id, is_active=True)
                .values(
                    'id', 'name', 'operation', 'policy_type',
                    'condition', 'apply_to_tokens', 'apply_to_jwt',
                )
            )
            cache.set(cache_key, all_policies, _CACHE_TIMEOUT)

        applicable = []
        for p in all_policies:
            # 检查操作匹配
            if p['operation'] != 'ALL' and p['operation'] != operation:
                continue
            # 检查作用范围
            if context.is_token_auth and not p['apply_to_tokens']:
                continue
            if not context.is_token_auth and not p['apply_to_jwt']:
                continue
            applicable.append(p)

        return applicable

    def build_rls_where(
        self,
        table_id: UUID,
        operation: str,
        context: RLSContext,
        query_builder,
    ) -> Optional[Tuple[str, List[Any]]]:
        """
        根据 RLS 策略构建 WHERE 子句。

        合并逻辑：
        - PERMISSIVE 策略之间 OR 合并
        - RESTRICTIVE 策略之间 AND 合并
        - 最终 = (p1 OR p2 ...) AND (r1 AND r2 ...)

        Args:
            table_id: 表格 ID
            operation: 操作类型
            context: RLS 运行时上下文
            query_builder: NativeQueryBuilder 实例，用于构建 WHERE

        Returns:
            (where_clause, params) 或 None（无策略时）
        """
        policies = self.get_policies_for_table(table_id, operation, context)
        if not policies:
            return None

        permissive_clauses = []
        restrictive_clauses = []

        for policy in policies:
            condition = self._resolve_condition(policy['condition'], context)
            clause = query_builder.build_where_clause(
                self._normalize_condition(condition)
            )
            if clause and clause[0] not in ('TRUE', ''):
                if policy['policy_type'] == 'PERMISSIVE':
                    permissive_clauses.append(clause)
                else:
                    restrictive_clauses.append(clause)

        return self._merge_policy_clauses(permissive_clauses, restrictive_clauses)

    def check_rls_for_write(
        self,
        table_id: UUID,
        operation: str,
        context: RLSContext,
        record_data: Dict[str, Any],
        query_builder=None,
    ) -> bool:
        """
        检查写操作（INSERT/UPDATE）的记录是否符合 RLS 策略。

        对于写操作，RLS 条件用于验证记录数据是否满足策略要求。
        如果策略中的字段引用了 $token.user_id，则检查记录中对应字段是否匹配。

        合并逻辑同 build_rls_where()（同 PostgreSQL RLS）：
        - PERMISSIVE 策略之间 OR 合并（至少一条通过即可）
        - RESTRICTIVE 策略之间 AND 合并（全部必须通过）
        - 最终 = (p1 OR p2 ...) AND (r1 AND r2 ...)

        Args:
            table_id: 表格 ID
            operation: INSERT / UPDATE
            context: RLS 运行时上下文
            record_data: 要写入的记录数据
            query_builder: NativeQueryBuilder（可选）

        Returns:
            True 如果记录满足所有适用的 RLS 策略
        """
        policies = self.get_policies_for_table(table_id, operation, context)
        if not policies:
            return True

        permissive_results = []
        restrictive_results = []

        for policy in policies:
            condition = self._resolve_condition(policy['condition'], context)
            normalized = self._normalize_condition(condition)
            result = self._check_record_against_condition(record_data, normalized)

            if policy.get('policy_type') == 'RESTRICTIVE':
                restrictive_results.append(result)
            else:
                permissive_results.append(result)

        # PERMISSIVE: at least one must pass (OR)
        if permissive_results and not any(permissive_results):
            return False

        # RESTRICTIVE: all must pass (AND)
        if restrictive_results and not all(restrictive_results):
            return False

        return True

    def invalidate_cache(self, table_id: UUID) -> None:
        """清除策略缓存"""
        cache.delete(f'{_CACHE_PREFIX}{table_id}')

    # ── Internal ─────────────────────────────────────────

    def _resolve_condition(self, condition: Any, context: RLSContext) -> Any:
        """递归解析条件中的运行时变量"""
        if condition is None:
            return condition

        if isinstance(condition, str):
            if condition.startswith('$'):
                return context.resolve_variable(condition)
            return condition

        if isinstance(condition, list):
            return [self._resolve_condition(item, context) for item in condition]

        if isinstance(condition, dict):
            resolved = {}
            for key, val in condition.items():
                resolved[key] = self._resolve_condition(val, context)
            return resolved

        return condition

    @staticmethod
    def _normalize_condition(condition: Dict) -> Dict:
        """
        将简写条件规范化为 FilterSet 格式。

        简写：{"field_id": "owner", "operator": "equals", "value": "xxx"}
        规范化：{"conjunction": "and", "filterSet": [{"field_id": "owner", "operator": "equals", "value": "xxx"}]}
        """
        if not condition:
            return {'conjunction': 'and', 'filterSet': []}

        # 已经是 FilterSet 格式
        if 'filterSet' in condition or 'conjunction' in condition:
            return condition

        # 简写格式 → 规范化
        if 'field_id' in condition or 'field' in condition:
            return {
                'conjunction': 'and',
                'filterSet': [condition],
            }

        return {'conjunction': 'and', 'filterSet': []}

    @staticmethod
    def _merge_policy_clauses(
        permissive: List[Tuple[str, list]],
        restrictive: List[Tuple[str, list]],
    ) -> Optional[Tuple[str, List[Any]]]:
        """
        合并策略 WHERE 子句。

        PERMISSIVE OR + RESTRICTIVE AND
        """
        parts = []
        all_params = []

        # Permissive: OR
        if permissive:
            if len(permissive) == 1:
                parts.append(permissive[0][0])
                all_params.extend(permissive[0][1])
            else:
                or_parts = [f'({sql})' for sql, _ in permissive]
                parts.append(f'({" OR ".join(or_parts)})')
                for _, params in permissive:
                    all_params.extend(params)

        # Restrictive: AND
        for sql, params in restrictive:
            parts.append(f'({sql})')
            all_params.extend(params)

        if not parts:
            return None

        combined = ' AND '.join(parts)
        return (combined, all_params)

    @staticmethod
    def _check_record_against_condition(
        record_data: Dict[str, Any],
        condition: Dict,
    ) -> bool:
        """
        在 Python 侧检查记录数据是否满足条件。

        用于写操作（INSERT/UPDATE）的预检查。
        """
        filter_set = condition.get('filterSet', [])
        conjunction = condition.get('conjunction', 'and').lower()

        if not filter_set:
            return True

        results = []
        for item in filter_set:
            if 'filterSet' in item:
                # 嵌套组
                results.append(
                    RLSService._check_record_against_condition(record_data, item)
                )
            else:
                field = item.get('field_id') or item.get('field')
                operator = (item.get('operator') or '').lower()
                value = item.get('value')

                if not field:
                    results.append(True)
                    continue

                # If field is missing from record_data, record_value is None.
                # The condition is still evaluated — e.g. "equals null" would pass,
                # "equals 'x'" would fail. This matches PostgreSQL RLS behavior
                # where missing columns evaluate to NULL.
                record_value = record_data.get(field)
                results.append(
                    RLSService._eval_condition(record_value, operator, value)
                )

        if conjunction == 'or':
            return any(results) if results else True
        return all(results) if results else True

    @staticmethod
    def _eval_condition(record_value: Any, operator: str, expected: Any) -> bool:
        """评估单个条件"""
        op = operator.strip().lower().replace('-', '_').replace(' ', '_')

        if op in ('equals', 'eq'):
            return record_value == expected
        if op in ('not_equals', 'neq'):
            return record_value != expected
        if op in ('contains',):
            return expected in str(record_value or '')
        if op == 'not_contains':
            return expected not in str(record_value or '')
        if op in ('is_empty', 'isempty', 'empty'):
            return record_value is None or record_value == '' or record_value == []
        if op in ('is_not_empty', 'isnotempty', 'not_empty'):
            return record_value is not None and record_value != '' and record_value != []

        if op in ('greater_than', 'gt', '>'):
            try:
                return record_value is not None and expected is not None and record_value > expected
            except TypeError:
                return False
        if op in ('greater_than_or_equals', 'gte', '>='):
            try:
                return record_value is not None and expected is not None and record_value >= expected
            except TypeError:
                return False
        if op in ('less_than', 'lt', '<'):
            try:
                return record_value is not None and expected is not None and record_value < expected
            except TypeError:
                return False
        if op in ('less_than_or_equals', 'lte', '<='):
            try:
                return record_value is not None and expected is not None and record_value <= expected
            except TypeError:
                return False

        if op in ('in', 'is_any_of', 'isanyof'):
            vals = expected if isinstance(expected, (list, tuple)) else [expected]
            return record_value in vals
        if op in ('not_in', 'is_none_of', 'isnoneof'):
            vals = expected if isinstance(expected, (list, tuple)) else [expected]
            return record_value not in vals

        if op in ('has_any_of', 'hasanyof'):
            if not isinstance(record_value, (list, tuple)):
                return False
            vals = set(expected if isinstance(expected, (list, tuple)) else [expected])
            return bool(set(record_value) & vals)
        if op in ('has_all_of', 'hasallof'):
            if not isinstance(record_value, (list, tuple)):
                return False
            vals = set(expected if isinstance(expected, (list, tuple)) else [expected])
            return vals.issubset(set(record_value))
        if op in ('has_none_of', 'hasnoneof'):
            if not isinstance(record_value, (list, tuple)):
                return True
            vals = set(expected if isinstance(expected, (list, tuple)) else [expected])
            return not bool(set(record_value) & vals)
        if op in ('is_exactly', 'isexactly'):
            if not isinstance(record_value, (list, tuple)):
                return False
            vals = expected if isinstance(expected, (list, tuple)) else [expected]
            return sorted(str(v) for v in record_value) == sorted(str(v) for v in vals)
        if op in ('is_not_exactly', 'isnotexactly'):
            if not isinstance(record_value, (list, tuple)):
                return True
            vals = expected if isinstance(expected, (list, tuple)) else [expected]
            return sorted(str(v) for v in record_value) != sorted(str(v) for v in vals)

        if op in ('like', 'ilike'):
            return str(expected or '') in str(record_value or '')

        logger.warning("RLS _eval_condition: unknown operator %r, denying", operator)
        return False


rls_service = RLSService()


def build_rls_select_where(table, rls_context, qb, base_where):
    """
    对 SELECT 操作应用 RLS 过滤，返回合并后的 WHERE 子句。

    如果 RLS 不适用（未启用 / 上下文不匹配），原样返回 base_where。
    适用于视图数据查询、统计等原生 SQL 路径。

    Args:
        table: Table 模型实例（需要 rls_enabled / rls_force 属性）
        rls_context: RLSContext 或 None
        qb: NativeQueryBuilder 实例
        base_where: 现有 WHERE 子句 (sql, params) 或 None

    Returns:
        合并后的 (sql, params) 或原 base_where
    """
    if rls_context is None or not getattr(table, 'rls_enabled', False):
        return base_where
    should_apply = rls_context.is_token_auth if not getattr(table, 'rls_force', False) else True
    if not should_apply:
        return base_where
    rls_where = rls_service.build_rls_where(
        table_id=table.id,
        operation='SELECT',
        context=rls_context,
        query_builder=qb,
    )
    if not rls_where:
        return base_where
    from .view_grid_service import merge_native_where_clauses
    return merge_native_where_clauses(base_where, rls_where)


def apply_rls_to_orm_queryset(queryset, table_id, rls_context):
    """
    对 ORM QuerySet 应用 RLS 过滤（适用于 ORM fallback / 导出路径）。

    通过 native SQL 获取 RLS 允许的记录 ID 后过滤 queryset。
    异常时返回 queryset.none()（fail-closed）。

    Args:
        queryset: Django QuerySet（TableRecord）
        table_id: 表 ID（UUID）
        rls_context: RLSContext 或 None

    Returns:
        过滤后的 QuerySet
    """
    if rls_context is None:
        return queryset
    try:
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table, TableField
        table_obj = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        if not getattr(table_obj, 'rls_enabled', False):
            return queryset
        should_apply = rls_context.is_token_auth if not getattr(table_obj, 'rls_force', False) else True
        if not should_apply:
            return queryset
        from apps.tabdata.native.query_builder import NativeQueryBuilder
        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
        all_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
        )
        if not all_fields:
            return queryset
        qb = NativeQueryBuilder(resolve_schema_partition_id(table_obj), table_id, all_fields)
        rls_where = rls_service.build_rls_where(
            table_id=table_id,
            operation='SELECT',
            context=rls_context,
            query_builder=qb,
        )
        if not rls_where:
            return queryset
        rls_sql, rls_params = rls_where
        db_table = queryset.model._meta.db_table
        subquery_sql = f'SELECT "__id" FROM {qb.qualified_name} WHERE {rls_sql}'
        queryset = queryset.extra(
            where=[f'"{db_table}"."id" IN ({subquery_sql})'],
            params=rls_params,
        )
        return queryset
    except Exception:
        logger.exception("RLS ORM filtering failed for table %s, denying all", table_id)
        return queryset.none()


__all__ = ['RLSService', 'RLSContext', 'rls_service', 'build_rls_select_where', 'apply_rls_to_orm_queryset']

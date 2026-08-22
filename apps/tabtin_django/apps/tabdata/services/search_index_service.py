"""
搜索索引服务

第一阶段：索引管理（状态查询、启停、修复）
第二阶段：搜索查询（服务端搜索、命中索引返回、分页）
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple
from uuid import UUID

from django.conf import settings
from django.db import connections, router
from django.db.utils import DatabaseError

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord, TableView
from apps.tabdata.utils.searchable_cell_text import (
    USER_SEARCH_FIELD_TYPES,
    build_searchable_cell_sql_expr,
    build_searchable_jsonb_sql_expr,
    build_user_reference_match_sql,
    cell_text_matches_search_query,
    resolve_organization_user_ids_by_display_name,
    user_cell_references_any_id,
)
from apps.tabdata.utils.view_serializers import build_view_column_meta, get_visible_field_ids_from_column_meta
from .base import BaseService
from apps.tabdata.native.community_capabilities import CommunityRecordIndexOperations

logger = logging.getLogger(__name__)

SEARCH_INDEX_TYPE = 'search'
SEARCH_INDEX_NAME_PREFIX = 'idx_tt_s'
SEARCH_QUERY_MAX_TAKE = 1000


class SearchIndexService(BaseService):
    """
    表格搜索索引服务：
    - 查询索引状态
    - 启用/停用索引
    - 修复异常索引
    """

    @staticmethod
    def _table_token(table_id: UUID) -> str:
        return str(table_id).replace('-', '')[:16]

    @staticmethod
    def _field_token(field_id: UUID) -> str:
        return str(field_id).replace('-', '')[:16]

    @classmethod
    def _build_index_name(cls, table_id: UUID, field_id: UUID) -> str:
        return f"{SEARCH_INDEX_NAME_PREFIX}_{cls._table_token(table_id)}_{cls._field_token(field_id)}"

    @classmethod
    def _build_index_prefix(cls, table_id: UUID) -> str:
        return f"{SEARCH_INDEX_NAME_PREFIX}_{cls._table_token(table_id)}_"

    def _get_connection(self):
        db_alias = router.db_for_read(TableRecord)
        return connections[db_alias]

    def _assert_table_exists(self, table_id: UUID) -> None:
        if not Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).exists():
            raise Table.DoesNotExist()

    def _assert_permission(self, table_id: UUID, required_role: str) -> None:
        if not self.check_table_permission(str(table_id), required_role):
            raise PermissionError("无权限访问该表格")

    def _list_searchable_fields(self, table_id: UUID) -> List[TableField]:
        fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        ).only('id', 'name', 'field_type', 'order').order_by('order', 'created_at', 'id')
        return list(fields)

    def _fetch_existing_indexes(self, table_id: UUID) -> Dict[str, str]:
        connection = self._get_connection()
        if connection.vendor != 'postgresql':
            return {}

        table_name = TableRecord._meta.db_table.split('.')[-1]
        index_pattern = f"{self._build_index_prefix(table_id)}%"

        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE tablename = %s
                AND indexname LIKE %s
                """,
                [table_name, index_pattern],
            )
            rows = cursor.fetchall()

        return {str(index_name): str(index_def or '') for index_name, index_def in rows}

    def _ensure_pg_trgm_extension(self) -> None:
        if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
            return
        connection = self._get_connection()
        with connection.cursor() as cursor:
            cursor.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    def _create_single_index(self, table_id: UUID, field_id: UUID) -> None:
        connection = self._get_connection()
        if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
            CommunityRecordIndexOperations(connection).create_search_index(
                table_id,
                field_id,
            )
            return
        table_name = connection.ops.quote_name(TableRecord._meta.db_table)
        index_name = connection.ops.quote_name(self._build_index_name(table_id, field_id))
        field_id_raw = str(field_id)
        table_id_raw = str(table_id)

        sql = (
            f"CREATE INDEX IF NOT EXISTS {index_name} "
            f"ON {table_name} USING gin ((COALESCE(data->>'{field_id_raw}', '')) gin_trgm_ops) "
            f"WHERE table_id = '{table_id_raw}'::uuid AND is_deleted = false"
        )

        with connection.cursor() as cursor:
            cursor.execute(sql)

    def _drop_index(self, index_name: str) -> None:
        connection = self._get_connection()
        quoted_index_name = connection.ops.quote_name(index_name)
        with connection.cursor() as cursor:
            cursor.execute(f"DROP INDEX IF EXISTS {quoted_index_name}")

    def _build_expected_index_map(
        self,
        table_id: UUID,
        fields: Iterable[TableField],
    ) -> Dict[str, TableField]:
        return {
            self._build_index_name(table_id, field.id): field
            for field in fields
        }

    @staticmethod
    def _normalize_index_def(index_def: str) -> str:
        return str(index_def or '').lower().replace(' ', '').replace('"', '')

    def _collect_abnormal_indexes(
        self,
        expected_indexes: Dict[str, TableField],
        existing_indexes: Dict[str, str],
    ) -> List[Dict[str, Any]]:
        abnormalities: List[Dict[str, Any]] = []

        for index_name, field in expected_indexes.items():
            existing_def = existing_indexes.get(index_name)
            if existing_def is None:
                abnormalities.append({
                    'index_name': index_name,
                    'issue': 'missing',
                    'field_id': str(field.id),
                    'field_name': field.name,
                })
                continue

            normalized_def = self._normalize_index_def(existing_def)
            field_signature = str(field.id).lower().replace('-', '')
            if field_signature not in normalized_def.replace('-', ''):
                abnormalities.append({
                    'index_name': index_name,
                    'issue': 'definition_mismatch',
                    'field_id': str(field.id),
                    'field_name': field.name,
                })

        for index_name in existing_indexes:
            if index_name in expected_indexes:
                continue
            abnormalities.append({
                'index_name': index_name,
                'issue': 'redundant',
            })

        issue_order = {'missing': 0, 'definition_mismatch': 1, 'redundant': 2}
        abnormalities.sort(key=lambda item: (issue_order.get(item.get('issue'), 99), item.get('index_name', '')))
        return abnormalities

    def get_search_index_status(self, table_id: UUID) -> Dict[str, Any]:
        self._assert_table_exists(table_id)
        self._assert_permission(table_id, 'viewer')

        connection = self._get_connection()
        searchable_fields = self._list_searchable_fields(table_id)

        if connection.vendor != 'postgresql':
            return {
                'type': SEARCH_INDEX_TYPE,
                'supported': False,
                'database_vendor': connection.vendor,
                'enabled': False,
                'index_count': 0,
                'expected_count': len(searchable_fields),
                'abnormal_count': 0,
                'abnormal_indexes': [],
                'fields': [
                    {
                        'field_id': str(field.id),
                        'field_name': field.name,
                        'field_type': field.field_type,
                        'indexed': False,
                    }
                    for field in searchable_fields
                ],
                'reason': 'unsupported_database',
            }

        existing_indexes = self._fetch_existing_indexes(table_id)
        expected_indexes = self._build_expected_index_map(table_id, searchable_fields)
        abnormalities = self._collect_abnormal_indexes(expected_indexes, existing_indexes)

        return {
            'type': SEARCH_INDEX_TYPE,
            'supported': True,
            'database_vendor': connection.vendor,
            'enabled': bool(existing_indexes),
            'index_count': len(existing_indexes),
            'expected_count': len(expected_indexes),
            'abnormal_count': len(abnormalities),
            'abnormal_indexes': abnormalities,
            'fields': [
                {
                    'field_id': str(field.id),
                    'field_name': field.name,
                    'field_type': field.field_type,
                    'indexed': self._build_index_name(table_id, field.id) in existing_indexes,
                }
                for field in searchable_fields
            ],
        }

    def toggle_search_index(self, table_id: UUID, enabled: Optional[bool] = None) -> Dict[str, Any]:
        self._assert_table_exists(table_id)
        self._assert_permission(table_id, 'editor')

        connection = self._get_connection()
        if connection.vendor != 'postgresql':
            raise ValueError("当前数据库不支持搜索索引")

        try:
            existing_indexes = self._fetch_existing_indexes(table_id)
            current_enabled = bool(existing_indexes)
            target_enabled = (not current_enabled) if enabled is None else bool(enabled)

            if target_enabled == current_enabled:
                return self.get_search_index_status(table_id)

            if target_enabled:
                fields = self._list_searchable_fields(table_id)
                self._ensure_pg_trgm_extension()
                for field in fields:
                    self._create_single_index(table_id, field.id)
            else:
                if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
                    CommunityRecordIndexOperations(
                        connection
                    ).drop_search_indexes(table_id)
                else:
                    for index_name in existing_indexes.keys():
                        self._drop_index(index_name)

            return self.get_search_index_status(table_id)
        except DatabaseError as exc:
            raise ValueError(f"搜索索引切换失败: {exc}") from exc

    def repair_search_index(self, table_id: UUID) -> Dict[str, Any]:
        self._assert_table_exists(table_id)
        self._assert_permission(table_id, 'editor')

        connection = self._get_connection()
        if connection.vendor != 'postgresql':
            raise ValueError("当前数据库不支持搜索索引")

        try:
            searchable_fields = self._list_searchable_fields(table_id)
            existing_indexes = self._fetch_existing_indexes(table_id)
            if not existing_indexes:
                # 未启用索引时，无修复对象
                return self.get_search_index_status(table_id)

            expected_indexes = self._build_expected_index_map(table_id, searchable_fields)
            abnormalities = self._collect_abnormal_indexes(expected_indexes, existing_indexes)

            if not abnormalities:
                return self.get_search_index_status(table_id)

            if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
                operations = CommunityRecordIndexOperations(connection)
                operations.drop_search_indexes(table_id)
                for field in searchable_fields:
                    operations.create_search_index(table_id, field.id)
                return self.get_search_index_status(table_id)

            drop_names: List[str] = []
            create_field_ids: List[UUID] = []

            field_map = {str(field.id): field for field in searchable_fields}
            for item in abnormalities:
                issue = item.get('issue')
                index_name = item.get('index_name')
                field_id = item.get('field_id')

                if issue in {'redundant', 'definition_mismatch'} and isinstance(index_name, str):
                    drop_names.append(index_name)

                if issue in {'missing', 'definition_mismatch'} and isinstance(field_id, str):
                    field = field_map.get(field_id)
                    if field:
                        create_field_ids.append(field.id)

            if drop_names or create_field_ids:
                self._ensure_pg_trgm_extension()

            for index_name in set(drop_names):
                self._drop_index(index_name)

            for field_id in {field_id for field_id in create_field_ids}:
                self._create_single_index(table_id, field_id)

            return self.get_search_index_status(table_id)
        except DatabaseError as exc:
            raise ValueError(f"搜索索引修复失败: {exc}") from exc

    # =================================================================
    # =================================================================

    def _resolve_search_fields(
        self,
        table_id: UUID,
        field_id: Optional[str] = None,
        view_id: Optional[UUID] = None,
    ) -> List[TableField]:
        """
        解析搜索范围对应的字段列表。

        - field_id 为 None 或空字符串或 'all_fields': 搜索所有可搜索字段
        - field_id 为逗号分隔的字段 ID: 仅搜索指定字段
        - 若指定 view_id，且字段有视图可见性限制，进行交叉过滤
        """
        all_fields = self._list_searchable_fields(table_id)
        if not all_fields:
            return []

        # 全局搜索
        if not field_id or field_id in ('', 'all_fields'):
            target_fields = all_fields
        else:
            # 按指定字段 ID 过滤
            requested_ids = {fid.strip() for fid in field_id.split(',') if fid.strip()}
            target_fields = [f for f in all_fields if str(f.id) in requested_ids]
            if not target_fields:
                target_fields = all_fields

        # 若有视图限制，交叉过滤
        if view_id:
            try:
                view = TableView.objects.using(TABDATA_DB_ALIAS).get(id=view_id)
                visible_names = self._get_view_visible_field_names(view)
                if visible_names:
                    target_fields = [
                        f for f in target_fields
                        if f.name in visible_names or str(f.id) in visible_names
                    ]
            except TableView.DoesNotExist:
                pass

        return target_fields

    @staticmethod
    def _get_view_visible_field_names(view: TableView) -> Optional[set]:
        """
        从视图的 column_meta 推导可见字段 ID 集合。
        回退到 visible_fields 兼容历史数据。
        """
        column_meta = build_view_column_meta(view)
        if column_meta:
            visible = get_visible_field_ids_from_column_meta(column_meta)
            if visible:
                return visible

        if view.visible_fields and isinstance(view.visible_fields, list):
            return set(str(f) for f in view.visible_fields)
        return None

    @staticmethod
    def _escape_like(value: str) -> str:
        """转义 SQL LIKE 通配符"""
        return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')

    @staticmethod
    def _resolve_matching_user_ids(
        table_id: UUID,
        fields: List[TableField],
        search_value: str,
    ) -> List[str]:
        if not any(field.field_type in USER_SEARCH_FIELD_TYPES for field in fields):
            return []
        organization_id = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .only('organization_id')
            .get(id=table_id)
            .organization_id
        )
        return resolve_organization_user_ids_by_display_name(
            organization_id,
            search_value,
        )

    @staticmethod
    def _build_field_search_condition(
        field: TableField,
        field_id_str: str,
        like_pattern: str,
        matching_user_ids: List[str],
    ) -> Tuple[str, List[Any]]:
        if field.field_type == 'created_by':
            json_expr = 'to_jsonb(created_by_id)'
            text_expr = build_searchable_jsonb_sql_expr(json_expr)
        elif field.field_type == 'last_modified_by':
            json_expr = 'to_jsonb(updated_by_id)'
            text_expr = build_searchable_jsonb_sql_expr(json_expr)
        else:
            json_expr = f"data->'{field_id_str}'"
            text_expr = build_searchable_cell_sql_expr(field_id_str)
        conditions = [f"{text_expr} LIKE %s ESCAPE '\\'"]
        params: List[Any] = [like_pattern]

        if (
            field.field_type in USER_SEARCH_FIELD_TYPES
            and matching_user_ids
        ):
            user_condition, user_params = build_user_reference_match_sql(
                json_expr,
                matching_user_ids,
            )
            conditions.append(user_condition)
            params.extend(user_params)

        return f"({' OR '.join(conditions)})", params

    def _build_search_conditions_sql(
        self,
        fields: List[TableField],
        search_value: str,
        table_id: UUID,
        matching_user_ids: Optional[List[str]] = None,
    ) -> Tuple[str, List[Any]]:
        """
        构建搜索 WHERE 条件 SQL 片段。

        对每个字段匹配「展示文本」而非整段 JSON，避免 link/user/attachment
        的 UUID id 被数字查询误命中。

        Returns:
            (sql_fragment, params) - SQL OR 条件片段 和 对应参数列表
        """
        escaped_value = self._escape_like(search_value.lower())
        like_pattern = f'%{escaped_value}%'

        conditions: List[str] = []
        params: List[Any] = []

        for field in fields:
            field_id_str = self._sanitize_identifier(str(field.id))
            if not field_id_str:
                continue
            condition, condition_params = self._build_field_search_condition(
                field,
                field_id_str,
                like_pattern,
                matching_user_ids or [],
            )
            conditions.append(condition)
            params.extend(condition_params)

        if not conditions:
            return 'FALSE', []

        return f"({' OR '.join(conditions)})", params

    def _build_field_match_case_sql(
        self,
        fields: List[TableField],
        search_value: str,
        matching_user_ids: Optional[List[str]] = None,
    ) -> Tuple[str, List[Any]]:
        """
        构建 CASE WHEN SQL 来确定每条记录匹配了哪些字段。
        对每个字段返回一个 CASE 表达式，结果通过 LATERAL unnest 展开。

        Returns:
            (case_sql, params)
        """
        escaped_value = self._escape_like(search_value.lower())
        like_pattern = f'%{escaped_value}%'

        case_parts: List[str] = []
        params: List[Any] = []

        for field in fields:
            field_id_str = self._sanitize_identifier(str(field.id))
            if not field_id_str:
                continue
            condition, condition_params = self._build_field_search_condition(
                field,
                field_id_str,
                like_pattern,
                matching_user_ids or [],
            )
            case_parts.append(
                f"CASE WHEN {condition} "
                f"THEN '{field_id_str}' ELSE NULL END"
            )
            params.extend(condition_params)

        if not case_parts:
            return "ARRAY[]::text[]", []

        array_expr = f"array_remove(ARRAY[{', '.join(case_parts)}], NULL)"
        return array_expr, params

    def search_records(
        self,
        table_id: UUID,
        search_value: str,
        field_id: Optional[str] = None,
        hide_not_match_row: bool = False,
        view_id: Optional[UUID] = None,
        skip: int = 0,
        take: int = 100,
    ) -> Optional[List[Dict[str, Any]]]:
        """
        服务端搜索记录，返回命中记录的索引列表。


        Args:
            table_id: 表格 ID
            search_value: 搜索关键词
            field_id: 字段 ID（逗号分隔或 'all_fields'）
            hide_not_match_row: 是否隐藏不匹配行（影响 index 计算方式）
            view_id: 视图 ID（可选，用于排序和过滤）
            skip: 分页偏移
            take: 每页数量（最大 1000）

        Returns:
            匹配结果列表 [{index, fieldId, recordId}, ...] 或 None
        """
        self._assert_table_exists(table_id)
        self._assert_permission(table_id, 'viewer')

        if take > SEARCH_QUERY_MAX_TAKE:
            raise ValueError(f"单次搜索最大返回 {SEARCH_QUERY_MAX_TAKE} 条")

        normalized_value = (search_value or '').strip()[:1000]
        if not normalized_value:
            return None

        search_fields = self._resolve_search_fields(table_id, field_id, view_id)
        if not search_fields:
            return None
        matching_user_ids = self._resolve_matching_user_ids(
            table_id,
            search_fields,
            normalized_value,
        )

        connection = self._get_connection()
        if connection.vendor != 'postgresql':
            # 非 PostgreSQL 回退到简化实现
            return self._search_records_fallback(
                table_id, normalized_value, field_id, hide_not_match_row,
                view_id, skip, take, matching_user_ids,
            )

        table_name = TableRecord._meta.db_table
        table_id_str = str(table_id)

        # 构建搜索条件
        search_where, search_params = self._build_search_conditions_sql(
            search_fields, normalized_value, table_id, matching_user_ids,
        )

        # 构建字段匹配 CASE
        field_match_array, field_match_params = self._build_field_match_case_sql(
            search_fields, normalized_value, matching_user_ids,
        )

        # 获取视图排序
        order_clause = self._build_view_order_clause(view_id)

        # 获取视图过滤
        view_filter_clause, view_filter_params = self._build_view_filter_clause(
            view_id, table_id,
        )

        if hide_not_match_row:
            # hideNotMatchRow=true: 索引 = 在过滤后结果中的顺序位置
            # COUNT(*) OVER() 在分页查询中同时计算总数，避免单独的 count 查询
            sql = f"""
                WITH search_hits AS (
                    SELECT
                        id AS __id,
                        {field_match_array} AS matched_columns,
                        ROW_NUMBER() OVER ({order_clause}) AS row_num
                    FROM {table_name}
                    WHERE table_id = %s::uuid
                      AND is_deleted = false
                      AND {search_where}
                      {view_filter_clause}
                ),
                search_expanded AS (
                    SELECT
                        __id,
                        row_num,
                        matched_column
                    FROM search_hits,
                         LATERAL unnest(matched_columns) AS matched_column
                    WHERE array_length(matched_columns, 1) > 0
                )
                SELECT __id, row_num, matched_column, COUNT(*) OVER() AS total_count
                FROM search_expanded
                ORDER BY row_num, matched_column
                OFFSET %s LIMIT %s
            """
            params = (
                field_match_params
                + [table_id_str]
                + search_params
                + view_filter_params
                + [skip, take]
            )
        else:
            # hideNotMatchRow=false: 索引 = 在完整视图中的行号
            sql = f"""
                WITH all_rows AS (
                    SELECT
                        id AS __id,
                        ROW_NUMBER() OVER ({order_clause}) AS row_num
                    FROM {table_name}
                    WHERE table_id = %s::uuid
                      AND is_deleted = false
                      {view_filter_clause}
                ),
                search_hits AS (
                    SELECT
                        id AS __id,
                        {field_match_array} AS matched_columns
                    FROM {table_name}
                    WHERE table_id = %s::uuid
                      AND is_deleted = false
                      AND {search_where}
                      {view_filter_clause}
                ),
                search_expanded AS (
                    SELECT
                        sh.__id,
                        ar.row_num,
                        matched_column
                    FROM search_hits sh
                    JOIN all_rows ar ON ar.__id = sh.__id,
                         LATERAL unnest(sh.matched_columns) AS matched_column
                    WHERE array_length(sh.matched_columns, 1) > 0
                )
                SELECT __id, row_num, matched_column, COUNT(*) OVER() AS total_count
                FROM search_expanded
                ORDER BY row_num, matched_column
                OFFSET %s LIMIT %s
            """
            params = (
                [table_id_str]
                + view_filter_params
                + field_match_params
                + [table_id_str]
                + search_params
                + view_filter_params
                + [skip, take]
            )

        try:
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                rows = cursor.fetchall()

            if not rows:
                return None

            results: List[Dict[str, Any]] = []
            total_count = 0
            for row in rows:
                record_id, row_num, matched_field_id, tc = row
                total_count = int(tc)
                results.append({
                    'index': int(row_num),
                    'fieldId': str(matched_field_id),
                    'recordId': str(record_id),
                })

            # 在首页结果中附加总数元信息（后续页不需要重复调用 count API）
            if results and skip == 0:
                results.insert(0, {'__meta': True, 'total_count': total_count})

            return results

        except DatabaseError as exc:
            logger.error("搜索查询执行失败: %s", exc)
            raise ValueError(f"搜索查询失败: {exc}") from exc

    def search_count(
        self,
        table_id: UUID,
        search_value: str,
        field_id: Optional[str] = None,
        view_id: Optional[UUID] = None,
    ) -> int:
        """
        返回搜索匹配的总数（命中的 field-record 对数量）。

        """
        self._assert_table_exists(table_id)
        self._assert_permission(table_id, 'viewer')

        normalized_value = (search_value or '').strip()[:1000]
        if not normalized_value:
            return 0

        connection = self._get_connection()
        search_fields = self._resolve_search_fields(table_id, field_id, view_id)
        if not search_fields:
            return 0
        matching_user_ids = self._resolve_matching_user_ids(
            table_id,
            search_fields,
            normalized_value,
        )

        if connection.vendor != 'postgresql':
            return self._search_count_fallback(
                table_id, normalized_value, field_id, view_id, matching_user_ids,
            )

        table_name = TableRecord._meta.db_table
        table_id_str = str(table_id)

        search_where, search_params = self._build_search_conditions_sql(
            search_fields, normalized_value, table_id, matching_user_ids,
        )
        field_match_array, field_match_params = self._build_field_match_case_sql(
            search_fields, normalized_value, matching_user_ids,
        )
        view_filter_clause, view_filter_params = self._build_view_filter_clause(
            view_id, table_id,
        )

        sql = f"""
            WITH search_hits AS (
                SELECT
                    id AS __id,
                    {field_match_array} AS matched_columns
                FROM {table_name}
                WHERE table_id = %s::uuid
                  AND is_deleted = false
                  AND {search_where}
                  {view_filter_clause}
            )
            SELECT COALESCE(SUM(array_length(matched_columns, 1)), 0) AS total
            FROM search_hits
            WHERE array_length(matched_columns, 1) > 0
        """
        params = (
            field_match_params
            + [table_id_str]
            + search_params
            + view_filter_params
        )

        try:
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                row = cursor.fetchone()
            return int(row[0]) if row else 0
        except DatabaseError as exc:
            logger.error("搜索计数查询失败: %s", exc)
            return 0

    def _build_view_order_clause(self, view_id: Optional[UUID]) -> str:
        """构建视图排序 SQL 子句"""
        if not view_id:
            return "ORDER BY created_at, id"

        try:
            view = TableView.objects.using(TABDATA_DB_ALIAS).get(id=view_id)
            config = view.config if isinstance(view.config, dict) else {}
            sorts = config.get('sorts', [])

            if not sorts:
                return "ORDER BY created_at, id"

            order_parts: List[str] = []
            for sort_item in sorts:
                field_name = sort_item.get('field') or sort_item.get('fieldId', '')
                direction = sort_item.get('direction', 'asc').lower()
                if direction not in ('asc', 'desc'):
                    direction = 'asc'
                if field_name:
                    # 使用 data->> 进行 JSON 字段排序
                    order_parts.append(
                        f"data->>'{self._sanitize_identifier(field_name)}' {direction} NULLS LAST"
                    )

            if not order_parts:
                return "ORDER BY created_at, id"

            return f"ORDER BY {', '.join(order_parts)}, created_at, id"
        except TableView.DoesNotExist:
            return "ORDER BY created_at, id"

    def _build_view_filter_clause(
        self,
        view_id: Optional[UUID],
        table_id: UUID,
    ) -> Tuple[str, List[Any]]:
        """构建视图过滤 SQL 子句（简化版：仅处理基本条件）"""
        # 当前简化实现：不额外注入视图过滤（视图过滤由前端传入的 hideNotMatchRow 控制）
        # 后续可扩展为从视图配置提取 filter 并注入 SQL
        return "", []

    @staticmethod
    def _sanitize_identifier(name: str) -> str:
        """清理标识符，防止 SQL 注入"""
        return re.sub(r"[^a-zA-Z0-9_\-]", "", name)

    def _search_records_fallback(
        self,
        table_id: UUID,
        search_value: str,
        field_id: Optional[str],
        hide_not_match_row: bool,
        view_id: Optional[UUID],
        skip: int,
        take: int,
        matching_user_ids: Optional[List[str]] = None,
    ) -> Optional[List[Dict[str, Any]]]:
        """非 PostgreSQL 的回退搜索实现（使用 Django ORM）"""
        from django.db.models import Q

        search_fields = self._resolve_search_fields(table_id, field_id, view_id)
        if not search_fields:
            return None

        queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        ).order_by('created_at', 'id')

        # 构建搜索条件
        search_q = Q()
        for field in search_fields:
            if field.field_type == 'created_by':
                search_q |= Q(created_by_id__in=matching_user_ids or [])
                continue
            if field.field_type == 'last_modified_by':
                search_q |= Q(updated_by_id__in=matching_user_ids or [])
                continue
            search_q |= Q(**{f"data__{str(field.id)}__icontains": search_value})
            if field.field_type in USER_SEARCH_FIELD_TYPES:
                for user_id in matching_user_ids or []:
                    search_q |= Q(**{f"data__{str(field.id)}__icontains": user_id})

        matched_qs = queryset.filter(search_q)

        if hide_not_match_row:
            # 索引 = 在过滤后结果中的位置
            results: List[Dict[str, Any]] = []
            idx = 0
            for record in matched_qs.only(
                'id', 'data', 'created_by_id', 'updated_by_id',
            )[skip:skip + take]:
                idx += 1
                actual_index = skip + idx
                _rd = record.__dict__.get('data') or {}
                for field in search_fields:
                    val = self._get_fallback_field_value(record, field, _rd)
                    if (
                        cell_text_matches_search_query(search_value, val)
                        or (
                            field.field_type in USER_SEARCH_FIELD_TYPES
                            and user_cell_references_any_id(val, matching_user_ids or [])
                        )
                    ):
                        results.append({
                            'index': actual_index,
                            'fieldId': str(field.id),
                            'recordId': str(record.id),
                        })
            return results if results else None
        else:
            # 索引 = 在完整视图中的行号
            all_ids = list(queryset.values_list('id', flat=True))
            id_to_row = {rid: i + 1 for i, rid in enumerate(all_ids)}

            results = []
            for record in matched_qs.only(
                'id', 'data', 'created_by_id', 'updated_by_id',
            ):
                row_num = id_to_row.get(record.id)
                if row_num is None:
                    continue
                _rd = record.__dict__.get('data') or {}
                for field in search_fields:
                    val = self._get_fallback_field_value(record, field, _rd)
                    if (
                        cell_text_matches_search_query(search_value, val)
                        or (
                            field.field_type in USER_SEARCH_FIELD_TYPES
                            and user_cell_references_any_id(val, matching_user_ids or [])
                        )
                    ):
                        results.append({
                            'index': row_num,
                            'fieldId': str(field.id),
                            'recordId': str(record.id),
                        })

            results.sort(key=lambda x: (x['index'], x['fieldId']))
            paginated = results[skip:skip + take]
            return paginated if paginated else None

    def _search_count_fallback(
        self,
        table_id: UUID,
        search_value: str,
        field_id: Optional[str],
        view_id: Optional[UUID],
        matching_user_ids: Optional[List[str]] = None,
    ) -> int:
        """非 PostgreSQL 的回退计数实现"""
        from django.db.models import Q

        search_fields = self._resolve_search_fields(table_id, field_id, view_id)
        if not search_fields:
            return 0

        queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        )

        count = 0
        search_q = Q()
        for field in search_fields:
            if field.field_type == 'created_by':
                search_q |= Q(created_by_id__in=matching_user_ids or [])
                continue
            if field.field_type == 'last_modified_by':
                search_q |= Q(updated_by_id__in=matching_user_ids or [])
                continue
            search_q |= Q(**{f"data__{str(field.id)}__icontains": search_value})
            if field.field_type in USER_SEARCH_FIELD_TYPES:
                for user_id in matching_user_ids or []:
                    search_q |= Q(**{f"data__{str(field.id)}__icontains": user_id})

        # 匹配的记录数（不是 field-record 对数，简化实现）
        for record in queryset.filter(search_q).only(
            'id', 'data', 'created_by_id', 'updated_by_id',
        ):
            _rd = record.__dict__.get('data') or {}
            for field in search_fields:
                val = self._get_fallback_field_value(record, field, _rd)
                if (
                    cell_text_matches_search_query(search_value, val)
                    or (
                        field.field_type in USER_SEARCH_FIELD_TYPES
                        and user_cell_references_any_id(val, matching_user_ids or [])
                    )
                ):
                    count += 1

        return count

    @staticmethod
    def _get_fallback_field_value(
        record: TableRecord,
        field: TableField,
        record_data: Dict[str, Any],
    ) -> Any:
        if field.field_type == 'created_by':
            return record.created_by_id
        if field.field_type == 'last_modified_by':
            return record.updated_by_id
        return record_data.get(str(field.id), '')

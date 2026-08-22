"""
视图数据服务

根据视图类型和配置，提供不同格式的数据查询服务
"""
from typing import Dict, Any, Optional, List, Set, Tuple, Iterable, Literal
from uuid import UUID
from datetime import datetime, date, timedelta
from functools import reduce
import math
from django.conf import settings
from django.db import connections, DatabaseError
from django.db.models import Q, QuerySet, Count, Max
from django.db.models.expressions import RawSQL
from django.utils import timezone

from apps.tabdata.constants import FILE_BASED_FIELD_TYPES, TABDATA_DB_ALIAS
from apps.tabdata.models import TableView, TableRecord, TableField
from apps.tabdata.services.base import BaseService
from .view_filter_service import (
    normalize_filter_operator as _normalize_filter_operator_fn,
    get_field_maps as _get_field_maps_fn,
    normalize_filter_value as _normalize_filter_value_fn,
    normalize_filters as _normalize_filters_fn,
    split_field_path as _split_field_path_fn,
    is_boolean_field as _is_boolean_field_fn,
    is_boolean_unchecked_filter as _is_boolean_unchecked_filter_fn,
    build_boolean_checked_q as _build_boolean_checked_q_fn,
    build_boolean_unchecked_q as _build_boolean_unchecked_q_fn,
    build_alias_presence_q as _build_alias_presence_q_fn,
    build_boolean_alias_fallback_q as _build_boolean_alias_fallback_q_fn,
    build_single_filter_q as _build_single_filter_q_fn,
    build_filter_q as _build_filter_q_fn,
    is_nested_filter as _is_nested_filter_fn,
    build_filter_set_q as _build_filter_set_q_fn,
    apply_view_filters as _apply_view_filters_fn,
    parse_checkbox_state as _parse_checkbox_state_fn,
    resolve_effective_filter as _resolve_effective_filter_fn,
)
from .view_statistics_service import (
    get_valid_stat_funcs as _get_valid_stat_funcs_fn,
    normalize_stat_func as _normalize_stat_func_fn,
    is_cell_value_empty as _is_cell_value_empty_fn,
    normalize_statistic_value_key as _normalize_statistic_value_key_fn,
    parse_numeric_value as _parse_numeric_value_fn,
    collect_numeric_values as _collect_numeric_values_fn,
    parse_timestamp as _parse_timestamp_fn,
    collect_date_candidates as _collect_date_candidates_fn,
    calculate_month_diff as _calculate_month_diff_fn,
    format_percent_value as _format_percent_value_fn,
    normalize_date_output_value as _normalize_date_output_value_fn,
    resolve_stat_value as _resolve_stat_value_fn,
    extract_field_value_for_stats as _extract_field_value_for_stats_fn,
    get_view_column_statistics_orm_compat as _get_view_column_statistics_orm_compat_fn,
    get_view_column_statistics_native as _get_view_column_statistics_native_fn,
    compute_native_stat as _compute_native_stat_fn,
)
from .view_group_sort_service import (
    build_group_metadata as _build_group_metadata_fn,
    build_group_metadata_native as _build_group_metadata_native_fn,
    apply_view_sorts as _apply_view_sorts_fn,
    build_group_sort_prefix as _build_group_sort_prefix_fn,
)
from . import view_constants as _vc
from apps.tabdata.utils.record_serializers import serialize_records, serialize_native_rows
from apps.tabdata.utils.record_data_access import read_data
from apps.tabdata.utils.view_serializers import (
    build_view_column_meta,
    build_view_column_meta_payload,
    get_visible_field_ids_from_column_meta,
)
from .view_sub_record_tree_service import (
    apply_sub_record_tree_order as _apply_sub_record_tree_order_fn,
)
from .view_version_sync import (
    get_version_token_base as _get_version_token_base,
    is_monotonic_version_token as _is_monotonic_version_token,
    encode_monotonic_version_token as _encode_monotonic_version_token,
    decode_monotonic_version_token as _decode_monotonic_version_token,
    get_latest_version_state as _get_latest_version_state,
    get_latest_version as _get_latest_version,
    has_changes_since_version as _has_changes_since_version,
    filter_queryset_since_version as _filter_queryset_since_version,
)
from .view_kanban_service import (
    get_kanban_data as _get_kanban_data_fn,
    get_kanban_groups_native as _get_kanban_groups_native_fn,
    get_kanban_groups_orm as _get_kanban_groups_orm_fn,
)
from .view_calendar_service import (
    get_calendar_data as _get_calendar_data_fn,
    get_calendar_events_native as _get_calendar_events_native_fn,
    get_calendar_events_orm as _get_calendar_events_orm_fn,
)
from .view_gallery_service import (
    get_gallery_data as _get_gallery_data_fn,
    get_gallery_records_native as _get_gallery_records_native_fn,
)
from .view_grid_service import (
    get_grid_data as _get_grid_data_fn,
    get_grid_data_orm_compat as _get_grid_data_orm_compat_fn,
    get_grid_data_native as _get_grid_data_native_fn,
    merge_native_where_clauses as _merge_native_where_clauses_fn,
    escape_like_for_sql as _escape_like_for_sql_fn,
    build_native_search_where as _build_native_search_where_fn,
    filter_native_record_fields as _filter_native_record_fields_fn,
)

import logging

_logger = logging.getLogger('tabdata.view_data_service')

_ORM_FALLBACK_MAX_RECORDS = 50_000


class ViewDataService(BaseService):
    """视图数据服务 - 根据视图类型返回不同结构的数据"""

    VERSION_TOKEN_BASE_DEFAULT = _vc.VERSION_TOKEN_BASE_DEFAULT
    MODEL_FIELDS = _vc.MODEL_FIELDS
    COLUMN_STATISTIC_FUNCS_CONFIG_KEY = _vc.COLUMN_STATISTIC_FUNCS_CONFIG_KEY

    STAT_FUNC_NONE = _vc.STAT_FUNC_NONE
    STAT_FUNC_COUNT = _vc.STAT_FUNC_COUNT
    STAT_FUNC_EMPTY = _vc.STAT_FUNC_EMPTY
    STAT_FUNC_FILLED = _vc.STAT_FUNC_FILLED
    STAT_FUNC_UNIQUE = _vc.STAT_FUNC_UNIQUE
    STAT_FUNC_SUM = _vc.STAT_FUNC_SUM
    STAT_FUNC_AVERAGE = _vc.STAT_FUNC_AVERAGE
    STAT_FUNC_MIN = _vc.STAT_FUNC_MIN
    STAT_FUNC_MAX = _vc.STAT_FUNC_MAX
    STAT_FUNC_CHECKED = _vc.STAT_FUNC_CHECKED
    STAT_FUNC_UNCHECKED = _vc.STAT_FUNC_UNCHECKED
    STAT_FUNC_PERCENT_EMPTY = _vc.STAT_FUNC_PERCENT_EMPTY
    STAT_FUNC_PERCENT_FILLED = _vc.STAT_FUNC_PERCENT_FILLED
    STAT_FUNC_PERCENT_UNIQUE = _vc.STAT_FUNC_PERCENT_UNIQUE
    STAT_FUNC_PERCENT_CHECKED = _vc.STAT_FUNC_PERCENT_CHECKED
    STAT_FUNC_PERCENT_UNCHECKED = _vc.STAT_FUNC_PERCENT_UNCHECKED
    STAT_FUNC_EARLIEST_DATE = _vc.STAT_FUNC_EARLIEST_DATE
    STAT_FUNC_LATEST_DATE = _vc.STAT_FUNC_LATEST_DATE
    STAT_FUNC_DATE_RANGE_DAYS = _vc.STAT_FUNC_DATE_RANGE_DAYS
    STAT_FUNC_DATE_RANGE_MONTHS = _vc.STAT_FUNC_DATE_RANGE_MONTHS

    CHECKBOX_TRUE_VALUES = _vc.CHECKBOX_TRUE_VALUES
    CHECKBOX_FALSE_VALUES = _vc.CHECKBOX_FALSE_VALUES
    CHECKBOX_TRUE_STORAGE_STRINGS = _vc.CHECKBOX_TRUE_STORAGE_STRINGS
    CHECKBOX_FALSE_STORAGE_STRINGS = _vc.CHECKBOX_FALSE_STORAGE_STRINGS
    FILTER_OPERATOR_ALIASES = _vc.FILTER_OPERATOR_ALIASES
    FILTER_NEGATIVE_OPERATOR_MAP = _vc.FILTER_NEGATIVE_OPERATOR_MAP

    def _get_view_visible_field_keys(
        self,
        view: TableView,
        *,
        field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
        prefetched_fields: Optional[List[TableField]] = None,
    ) -> Optional[Set[str]]:
        """
        获取视图配置的可见字段 key 集合（按指定 key 类型）。

        优先从 column_meta 推导，回退到 visible_fields 兼容历史数据。
        当提供 prefetched_fields 时跳过数据库查询。
        """
        if prefetched_fields is not None:
            fields = [
                {'id': f.id, 'name': f.name, 'config': f.config}
                for f in prefetched_fields
            ]
        else:
            fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=view.table_id,
                    is_deleted=False,
                ).values('id', 'name', 'config')
            )
        if not fields:
            return None

        id_to_name = {str(item['id']): str(item['name']) for item in fields}
        name_to_id = {str(item['name']): str(item['id']) for item in fields}
        id_to_db_field_name = {
            str(item['id']): str((item.get('config') or {}).get('db_field_name') or item['name'])
            for item in fields
        }

        column_meta = build_view_column_meta(view)
        visible_ids: Set[str] = set()

        if column_meta:
            visible_ids = get_visible_field_ids_from_column_meta(column_meta, set(id_to_name.keys()))
        elif view.visible_fields:
            for raw in view.visible_fields:
                key = str(raw)
                if key in id_to_name:
                    visible_ids.add(key)
                    continue
                field_id = name_to_id.get(key)
                if field_id:
                    visible_ids.add(field_id)

        if not visible_ids:
            return None

        if field_key_type == 'id':
            return set(visible_ids)
        if field_key_type == 'dbFieldName':
            return {id_to_db_field_name.get(field_id, id_to_name[field_id]) for field_id in visible_ids}

        return {id_to_name[field_id] for field_id in visible_ids}

    def _get_valid_stat_funcs(self, field_type: str) -> Set[str]:
        return _get_valid_stat_funcs_fn(field_type)

    def _normalize_stat_func(self, raw_func: Any) -> Optional[str]:
        return _normalize_stat_func_fn(raw_func)

    def _normalize_filter_operator(self, operator: Any) -> str:
        return _normalize_filter_operator_fn(operator)

    def _is_cell_value_empty(self, value: Any) -> bool:
        return _is_cell_value_empty_fn(value)

    def _normalize_statistic_value_key(self, value: Any) -> str:
        return _normalize_statistic_value_key_fn(value)

    def _parse_numeric_value(self, value: Any) -> Optional[float]:
        return _parse_numeric_value_fn(value)

    def _collect_numeric_values(self, value: Any, target: List[float]) -> None:
        _collect_numeric_values_fn(value, target)

    def _parse_timestamp(self, value: Any) -> Optional[float]:
        return _parse_timestamp_fn(value)

    def _collect_date_candidates(self, value: Any, target: List[Tuple[float, Any]]) -> None:
        _collect_date_candidates_fn(value, target)

    def _parse_checkbox_state(self, value: Any) -> Optional[bool]:
        return _parse_checkbox_state_fn(value)

    def _get_version_token_base(self) -> int:
        return _get_version_token_base()

    def _is_monotonic_version_token(self, version_value) -> bool:
        return _is_monotonic_version_token(version_value)

    def _encode_monotonic_version_token(self, latest_record_version: int) -> int:
        return _encode_monotonic_version_token(latest_record_version)

    def _decode_monotonic_version_token(self, version_token: int) -> int:
        return _decode_monotonic_version_token(version_token)

    def _get_latest_version_state(self, queryset, *, table_id=None):
        return _get_latest_version_state(queryset, table_id=table_id)

    def _get_latest_version(self, queryset, *, table_id=None) -> int:
        return _get_latest_version(queryset, table_id=table_id)

    def _has_changes_since_version(self, *, since_version, version_state) -> bool:
        return _has_changes_since_version(since_version=since_version, version_state=version_state)

    def _filter_queryset_since_version(self, queryset, since_version: int):
        return _filter_queryset_since_version(queryset, since_version)

    def _calculate_month_diff(self, max_timestamp: float, min_timestamp: float) -> int:
        return _calculate_month_diff_fn(max_timestamp, min_timestamp)

    def _format_percent_value(self, value: float) -> str:
        return _format_percent_value_fn(value)

    def _normalize_date_output_value(self, raw_value: Any) -> Any:
        return _normalize_date_output_value_fn(raw_value)

    def _resolve_stat_value(self, stat_func: str, state: Dict[str, Any], total_rows: int) -> Any:
        return _resolve_stat_value_fn(stat_func, state, total_rows)

    def get_view_column_statistics(
        self,
        view_id: UUID,
        column_statistic_funcs: Optional[Dict[str, Any]] = None,
        filters: Optional[List[Dict[str, Any]]] = None,
        filter_logic: Optional[str] = None,
        rls_context=None,
    ) -> Dict[str, Any]:
        """
        获取视图列统计信息（总览统计）。

        统计函数来源优先级：
        1. 入参 column_statistic_funcs
        2. view.config.column_statistic_funcs
        """
        view = TableView.objects.using(TABDATA_DB_ALIAS).select_related('table').get(id=view_id)

        if not self.check_table_permission(view.table.id, 'viewer'):
            raise PermissionError("无权限访问该视图")

        # ── 原生列统计路径（Phase 3D: 唯一路径）──
        return self._get_view_column_statistics_native(
            view, column_statistic_funcs, filters, filter_logic,
            rls_context=rls_context,
        )

    def get_view_records(
        self,
        view_id: UUID,
        page: int = 1,
        page_size: int = 100,
        fields: Optional[List[str]] = None,
        field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
        since_version: Optional[int] = None,
        only_delta: bool = False,
        filters: Optional[List[Dict[str, Any]]] = None,
        filter_logic: Optional[str] = None,
        groups: Optional[List[Dict[str, Any]]] = None,
        sorts: Optional[List[Dict[str, Any]]] = None,
        search: Optional[str] = None,
        search_field_ids: Optional[List[str]] = None,
        search_hide_not_match_rows: bool = False,
        rls_context=None,
        *,
        skip_permission_check: bool = False,
        **kwargs
    ) -> Dict[str, Any]:
        """
        获取视图数据（根据视图类型返回不同结构）

        Args:
            view_id: 视图ID
            page: 页码
            page_size: 每页大小
            fields: 仅返回的字段列表
            since_version: 客户端已同步的最新版本号
            only_delta: 是否仅返回增量数据（目前仅对 grid 视图生效）
            skip_permission_check: 仅 ``TableShareService`` 在
                ``verify_share_access`` 之后用于公开分享读路径；禁止其它调用方绕过 ACL
            **kwargs: 额外参数（如日历视图的date_range）

        Returns:
            视图数据字典
        """
        view = TableView.objects.using(TABDATA_DB_ALIAS).select_related('table').get(id=view_id)

        if not skip_permission_check and not self.check_table_permission(view.table.id, 'viewer'):
            raise PermissionError("无权限访问该视图")

        all_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=view.table_id,
                is_deleted=False,
            )
        )

        # None = 未指定投影；[] = 显式「无字段」（分享角色可见性收口需要区分）
        fields_set = set(fields) if fields is not None else None
        view_visible_keys = self._get_view_visible_field_keys(
            view, field_key_type=field_key_type, prefetched_fields=all_fields,
        )
        if view_visible_keys:
            if fields_set is None:
                fields_set = view_visible_keys
            else:
                fields_set = fields_set & view_visible_keys

        # ：角色 visibility_roles + 派生依赖闭包（与 RecordService 同一策略）
        # skip_permission_check 分享路径由调用方已传入角色投影；仍再求交一次作纵深防御
        from apps.tabdata.services.field_visibility import (
            get_visible_field_key_sets,
            resolve_effective_table_role,
            sanitize_filter_rules_for_visibility,
            sanitize_sorts_for_visibility,
        )

        role = resolve_effective_table_role(self.user, view.table)
        role_keys = get_visible_field_key_sets(
            view.table_id, role, fields=all_fields,
        )
        if field_key_type == 'id':
            role_visible = set(role_keys.get('ids') or set())
        elif field_key_type == 'dbFieldName':
            role_visible = set(role_keys.get('dbFieldNames') or set()) | set(
                role_keys.get('names') or set()
            )
        else:
            role_visible = set(role_keys.get('names') or set())

        if fields_set is None:
            fields_set = role_visible
        else:
            fields_set = fields_set & role_visible

        # ：filter/sort 侧信道——隐藏字段不得参与查询收窄
        filters = sanitize_filter_rules_for_visibility(filters, role_keys)
        sorts = sanitize_sorts_for_visibility(sorts, role_keys)

        if view.view_type == 'kanban':
            return self._get_kanban_data(
                view,
                page,
                page_size,
                fields_set,
                field_key_type=field_key_type,
                since_version=since_version,
                filters=filters,
                filter_logic=filter_logic,
                groups=groups,
                sorts=sorts,
                per_group_limit=kwargs.get('per_group_limit'),
                group_offsets=kwargs.get('group_offsets'),
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                all_fields=all_fields,
                rls_context=rls_context,
            )
        elif view.view_type == 'calendar':
            date_range = kwargs.get('date_range')
            return self._get_calendar_data(
                view,
                date_range,
                page,
                page_size,
                fields_set,
                field_key_type=field_key_type,
                since_version=since_version,
                filters=filters,
                filter_logic=filter_logic,
                sorts=sorts,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                rls_context=rls_context,
            )
        elif view.view_type == 'gallery':
            return self._get_gallery_data(
                view,
                page,
                page_size,
                fields_set,
                field_key_type=field_key_type,
                since_version=since_version,
                filters=filters,
                filter_logic=filter_logic,
                sorts=sorts,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                rls_context=rls_context,
            )
        elif view.view_type == 'flashcard':
            return self._get_grid_data(
                view,
                page,
                page_size,
                fields_set,
                field_key_type=field_key_type,
                since_version=since_version,
                only_delta=only_delta,
                metadata_view_type='flashcard',
                filters=filters,
                filter_logic=filter_logic,
                groups=groups,
                sorts=sorts,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                all_fields=all_fields,
                rls_context=rls_context,
            )
        elif view.view_type == 'form':
            return self._get_grid_data(
                view,
                page,
                page_size,
                fields_set,
                field_key_type=field_key_type,
                since_version=since_version,
                only_delta=only_delta,
                metadata_view_type='form',
                filters=filters,
                filter_logic=filter_logic,
                groups=groups,
                sorts=sorts,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                all_fields=all_fields,
                rls_context=rls_context,
            )
        elif view.view_type == 'list':
            return self._get_grid_data(
                view,
                page,
                page_size,
                fields_set,
                field_key_type=field_key_type,
                since_version=since_version,
                only_delta=only_delta,
                metadata_view_type='list',
                filters=filters,
                filter_logic=filter_logic,
                groups=groups,
                sorts=sorts,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                all_fields=all_fields,
                rls_context=rls_context,
            )
        else:  # grid
            return self._get_grid_data(
                view,
                page,
                page_size,
                fields_set,
                field_key_type=field_key_type,
                since_version=since_version,
                only_delta=only_delta,
                filters=filters,
                filter_logic=filter_logic,
                groups=groups,
                sorts=sorts,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                all_fields=all_fields,
                rls_context=rls_context,
            )

    def _get_field_maps(self, view: TableView) -> Tuple[Dict[str, TableField], Dict[str, TableField]]:
        return _get_field_maps_fn(view)

    def _normalize_filter_value(self, field_meta: Optional[TableField], value: Any) -> Any:
        return _normalize_filter_value_fn(field_meta, value)

    def _normalize_filters(self, view: TableView, filters: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        return _normalize_filters_fn(view, filters)

    def _split_field_path(self, field_name: str) -> Tuple[str, str, str]:
        return _split_field_path_fn(field_name)

    def _is_boolean_field(self, field_meta: Optional[TableField]) -> bool:
        return _is_boolean_field_fn(field_meta)

    def _is_boolean_unchecked_filter(self, operator: str, value: Any, field_meta: Optional[TableField]) -> bool:
        return _is_boolean_unchecked_filter_fn(operator, value, field_meta)

    def _build_boolean_checked_q(
        self,
        field_name: str,
        lookup_base: str,
    ) -> Q:
        return _build_boolean_checked_q_fn(field_name, lookup_base)

    def _build_boolean_unchecked_q(
        self,
        field_name: str,
        lookup_base: str,
        data_lookup: str,
        parent_lookup: str,
        last_key: str,
    ) -> Q:
        return _build_boolean_unchecked_q_fn(field_name, lookup_base, data_lookup, parent_lookup, last_key)

    def _build_alias_presence_q(self, field_name: str) -> Q:
        return _build_alias_presence_q_fn(field_name)

    def _build_boolean_alias_fallback_q(
        self,
        field_names: List[str],
        operator: str,
        value: Any,
        field_meta: TableField,
    ) -> Optional[Q]:
        return _build_boolean_alias_fallback_q_fn(field_names, operator, value, field_meta)

    def _build_single_filter_q(
        self,
        field_name: str,
        operator: str,
        value: Any,
        field_meta: Optional[TableField] = None
    ) -> Optional[Q]:
        return _build_single_filter_q_fn(field_name, operator, value, field_meta=field_meta)

    def _build_filter_q(
        self,
        field_names: Iterable[str],
        operator: str,
        value: Any,
        field_meta: Optional[TableField] = None
    ) -> Optional[Q]:
        return _build_filter_q_fn(field_names, operator, value, field_meta=field_meta)

    # ------------------------------------------------------------------
    # 嵌套过滤器支持
    # ------------------------------------------------------------------

    @staticmethod
    def _is_nested_filter(obj: Any) -> bool:
        """判断是否为嵌套 FilterSet 结构"""
        return _is_nested_filter_fn(obj)

    def _build_filter_set_q(
        self,
        view: TableView,
        filter_set: Dict[str, Any],
    ) -> Optional[Q]:
        """
        递归构建嵌套 FilterSet 的 Q 对象。

        filter_set 结构:
        {
            "conjunction": "and" | "or",
            "filterSet": [
                {"field_id": "...", "operator": "...", "value": ...},  # FilterItem
                {"conjunction": "...", "filterSet": [...]},            # 嵌套 FilterSet
            ]
        }
        """
        return _build_filter_set_q_fn(view, filter_set)

    def _apply_view_filters(
        self,
        view: TableView,
        queryset: QuerySet,
        filters: Optional[Any] = None,
        filter_logic: Optional[str] = None
    ) -> QuerySet:
        """
        应用视图的过滤条件。

        支持两种格式：
        1. 嵌套 FilterSet：{"conjunction": "and", "filterSet": [...]}
        2. 旧版扁平数组：[{field_id, operator, value, enabled}, ...]

        优先读取嵌套格式；扁平数组 + filter_logic 会被自动包装为 FilterSet。
        """
        return _apply_view_filters_fn(view, queryset, filters, filter_logic)

    def _build_group_metadata(
        self,
        view: TableView,
        queryset: QuerySet,
        groups: Optional[List[Dict[str, Any]]]
    ) -> Optional[Dict[str, Any]]:
        return _build_group_metadata_fn(view, queryset, groups)

    def _apply_view_sorts(
        self,
        view: TableView,
        queryset: QuerySet,
        sorts_override: Optional[List[Dict[str, Any]]] = None,
    ) -> QuerySet:
        return _apply_view_sorts_fn(view, queryset, sorts_override)

    def _get_grid_data(
        self,
        view: TableView,
        page: int,
        page_size: int,
        fields: Optional[Set[str]] = None,
        field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
        since_version: Optional[int] = None,
        only_delta: bool = False,
        metadata_view_type: str = 'grid',
        filters: Optional[List[Dict[str, Any]]] = None,
        filter_logic: Optional[str] = None,
        groups: Optional[List[Dict[str, Any]]] = None,
        sorts: Optional[List[Dict[str, Any]]] = None,
        search: Optional[str] = None,
        search_field_ids: Optional[List[str]] = None,
        search_hide_not_match_rows: bool = False,
        all_fields: Optional[List[TableField]] = None,
        rls_context=None,
    ) -> Dict[str, Any]:
        """委托给 view_grid_service.get_grid_data"""
        return _get_grid_data_fn(
            view, page, page_size, fields,
            field_key_type=field_key_type,
            since_version=since_version,
            only_delta=only_delta,
            metadata_view_type=metadata_view_type,
            filters=filters,
            filter_logic=filter_logic,
            groups=groups,
            sorts=sorts,
            search=search,
            search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
            serialized_view=self._serialize_view(view),
            all_fields=all_fields,
            rls_context=rls_context,
        )

    def _get_grid_data_orm_compat(
        self,
        view: TableView,
        page: int,
        page_size: int,
        fields: Optional[Set[str]] = None,
        field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
        since_version: Optional[int] = None,
        only_delta: bool = False,
        metadata_view_type: str = 'grid',
        filters: Optional[List[Dict[str, Any]]] = None,
        filter_logic: Optional[str] = None,
        groups: Optional[List[Dict[str, Any]]] = None,
        sorts: Optional[List[Dict[str, Any]]] = None,
        search: Optional[str] = None,
        search_field_ids: Optional[List[str]] = None,
        search_hide_not_match_rows: bool = False,
    ) -> Dict[str, Any]:
        """委托给 view_grid_service.get_grid_data_orm_compat"""
        return _get_grid_data_orm_compat_fn(
            view, page, page_size, fields,
            field_key_type=field_key_type,
            since_version=since_version,
            only_delta=only_delta,
            metadata_view_type=metadata_view_type,
            filters=filters,
            filter_logic=filter_logic,
            groups=groups,
            sorts=sorts,
            search=search,
            search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
            serialized_view=self._serialize_view(view),
        )

    def _get_grid_data_native(
        self,
        view: TableView,
        page: int,
        page_size: int,
        fields: Optional[Set[str]] = None,
        field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
        since_version: Optional[int] = None,
        only_delta: bool = False,
        metadata_view_type: str = 'grid',
        filters: Optional[List[Dict[str, Any]]] = None,
        filter_logic: Optional[str] = None,
        groups: Optional[List[Dict[str, Any]]] = None,
        sorts: Optional[List[Dict[str, Any]]] = None,
        search: Optional[str] = None,
        search_field_ids: Optional[List[str]] = None,
        search_hide_not_match_rows: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """委托给 view_grid_service.get_grid_data_native"""
        return _get_grid_data_native_fn(
            view, page, page_size, fields,
            field_key_type=field_key_type,
            since_version=since_version,
            only_delta=only_delta,
            metadata_view_type=metadata_view_type,
            filters=filters,
            filter_logic=filter_logic,
            groups=groups,
            sorts=sorts,
            search=search,
            search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
            serialized_view=self._serialize_view(view),
        )

    def _resolve_effective_filter(
        self,
        view: TableView,
        filters: Optional[Any],
        filter_logic: Optional[str],
    ) -> Optional[Dict]:
        return _resolve_effective_filter_fn(view, filters, filter_logic)

    @staticmethod
    def _merge_native_where_clauses(
        base_where: Optional[Tuple[str, list]],
        extra_where: Optional[Tuple[str, list]],
    ) -> Tuple[str, list]:
        """委托给 view_grid_service.merge_native_where_clauses"""
        return _merge_native_where_clauses_fn(base_where, extra_where)

    @staticmethod
    def _escape_like_for_sql(value: str) -> str:
        """委托给 view_grid_service.escape_like_for_sql"""
        return _escape_like_for_sql_fn(value)

    def _build_native_search_where(
        self,
        qb,
        all_fields: List[TableField],
        search_value: str,
        search_field_ids: Optional[List[str]] = None,
    ) -> Optional[Tuple[str, list]]:
        """委托给 view_grid_service.build_native_search_where"""
        return _build_native_search_where_fn(qb, all_fields, search_value, search_field_ids)

    @staticmethod
    def _build_group_sort_prefix(
        groups: List[Dict[str, Any]],
    ) -> Tuple[List[Dict[str, Any]], set]:
        return _build_group_sort_prefix_fn(groups)

    @staticmethod
    def _filter_native_record_fields(
        records: List[Dict[str, Any]],
        fields_set: Set[str],
        *,
        all_fields: Optional[List[TableField]] = None,
        field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
    ) -> List[Dict[str, Any]]:
        """委托给 view_grid_service.filter_native_record_fields"""
        return _filter_native_record_fields_fn(
            records, fields_set,
            all_fields=all_fields, field_key_type=field_key_type,
        )

    def _build_group_metadata_native(
        self,
        qb,
        native_io,
        all_fields: List[TableField],
        groups: List[Dict[str, Any]],
        where: Optional[Tuple[str, list]],
        table_id: UUID,
    ) -> Optional[Dict[str, Any]]:
        return _build_group_metadata_native_fn(qb, native_io, all_fields, groups, where, table_id)

    def _apply_sub_record_tree_order(
        self,
        records_serialized: List[Dict[str, Any]],
        parent_field_id: str,
        table_id: UUID,
        *,
        has_filter: bool = False,
        space_id: Optional[UUID] = None,
        all_fields: Optional[list] = None,
        field_key_type: str = 'id',
    ) -> Optional[Dict[str, Dict[str, Any]]]:
        """委托给 view_sub_record_tree_service.apply_sub_record_tree_order"""
        return _apply_sub_record_tree_order_fn(
            records_serialized,
            parent_field_id,
            table_id,
            has_filter=has_filter,
            space_id=space_id,
            all_fields=all_fields,
            field_key_type=field_key_type,
        )

    @staticmethod
    def _extract_field_value_for_stats(record_data: Any, field_meta: TableField) -> Any:
        return _extract_field_value_for_stats_fn(record_data, field_meta)

    def _get_view_column_statistics_orm_compat(
        self,
        view: TableView,
        column_statistic_funcs: Optional[Dict[str, Any]],
        filters: Optional[List[Dict[str, Any]]],
        filter_logic: Optional[str],
    ) -> Dict[str, Any]:
        return _get_view_column_statistics_orm_compat_fn(
            view, column_statistic_funcs, filters, filter_logic,
        )

    def _get_view_column_statistics_native(
        self,
        view: TableView,
        column_statistic_funcs: Optional[Dict[str, Any]],
        filters: Optional[List[Dict[str, Any]]],
        filter_logic: Optional[str],
        rls_context=None,
    ) -> Dict[str, Any]:
        return _get_view_column_statistics_native_fn(
            view, column_statistic_funcs, filters, filter_logic,
            rls_context=rls_context,
        )

    def _compute_native_stat(
        self,
        qualified_table: str,
        col_ref: str,
        agg_func: str,
        where_sql: str,
        where_params: list,
        total_rows: int,
        field_meta: TableField,
    ) -> Any:
        return _compute_native_stat_fn(
            qualified_table, col_ref, agg_func,
            where_sql, where_params, total_rows, field_meta,
        )

    def _get_kanban_data(
        self,
        view: TableView,
        page: int,
        page_size: int,
        fields: Optional[Set[str]] = None,
        field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
        since_version: Optional[int] = None,
        filters: Optional[List[Dict[str, Any]]] = None,
        filter_logic: Optional[str] = None,
        groups: Optional[List[Dict[str, Any]]] = None,
        sorts: Optional[List[Dict[str, Any]]] = None,
        per_group_limit: Optional[int] = None,
        group_offsets: Optional[Dict[str, int]] = None,
        search: Optional[str] = None,
        search_field_ids: Optional[List[str]] = None,
        search_hide_not_match_rows: bool = False,
        all_fields: Optional[List[TableField]] = None,
        rls_context=None,
    ) -> Dict[str, Any]:
        return _get_kanban_data_fn(
            view, page, page_size, fields,
            field_key_type=field_key_type,
            since_version=since_version,
            filters=filters,
            filter_logic=filter_logic,
            groups=groups,
            sorts=sorts,
            serialized_view=self._serialize_view(view),
            per_group_limit=per_group_limit,
            group_offsets=group_offsets,
            search=search,
            search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
            all_fields=all_fields,
            rls_context=rls_context,
        )

    def _get_calendar_data(
        self,
        view: TableView,
        date_range: Optional[str] = None,
        page: int = 1,
        page_size: int = 100,
        fields: Optional[Set[str]] = None,
        field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
        since_version: Optional[int] = None,
        filters: Optional[List[Dict[str, Any]]] = None,
        filter_logic: Optional[str] = None,
        sorts: Optional[List[Dict[str, Any]]] = None,
        search: Optional[str] = None,
        search_field_ids: Optional[List[str]] = None,
        search_hide_not_match_rows: bool = False,
        rls_context=None,
    ) -> Dict[str, Any]:
        return _get_calendar_data_fn(
            view, date_range, page, page_size, fields,
            field_key_type=field_key_type,
            since_version=since_version,
            filters=filters,
            filter_logic=filter_logic,
            sorts=sorts,
            serialized_view=self._serialize_view(view),
            search=search,
            search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
            rls_context=rls_context,
        )

    def _get_gallery_data(
        self,
        view: TableView,
        page: int,
        page_size: int,
        fields: Optional[Set[str]] = None,
        field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
        since_version: Optional[int] = None,
        filters: Optional[List[Dict[str, Any]]] = None,
        filter_logic: Optional[str] = None,
        sorts: Optional[List[Dict[str, Any]]] = None,
        search: Optional[str] = None,
        search_field_ids: Optional[List[str]] = None,
        search_hide_not_match_rows: bool = False,
        rls_context=None,
    ) -> Dict[str, Any]:
        return _get_gallery_data_fn(
            view, page, page_size, fields,
            field_key_type=field_key_type,
            since_version=since_version,
            filters=filters,
            filter_logic=filter_logic,
            sorts=sorts,
            serialized_view=self._serialize_view(view),
            search=search,
            search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
            rls_context=rls_context,
        )

    def _get_gallery_records_native(
        self, view, page, page_size, fields, field_key_type,
        filters, filter_logic,
    ) -> List[Dict[str, Any]]:
        return _get_gallery_records_native_fn(
            view, page, page_size, fields, field_key_type,
            filters, filter_logic,
        )

    def _get_kanban_groups_native(
        self, view, queryset, group_field, group_field_keys, options,
        is_select_field, *,
        fields=None, field_key_type='name',
        filters=None, filter_logic=None,
        sorts: Optional[List[Dict[str, Any]]] = None,
        per_group_limit: int = 50,
        group_offsets: Optional[Dict[str, int]] = None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        return _get_kanban_groups_native_fn(
            view, queryset, group_field, group_field_keys, options,
            is_select_field,
            fields=fields, field_key_type=field_key_type,
            filters=filters, filter_logic=filter_logic,
            sorts=sorts,
            per_group_limit=per_group_limit,
            group_offsets=group_offsets,
        )

    def _get_kanban_groups_orm(
        self, queryset, group_field, group_field_keys, options,
        is_select_field, *,
        fields=None, field_key_type='name',
        sorts: Optional[List[Dict[str, Any]]] = None,
        view=None,
        per_group_limit: int = 50,
        group_offsets: Optional[Dict[str, int]] = None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        return _get_kanban_groups_orm_fn(
            queryset, group_field, group_field_keys, options,
            is_select_field,
            fields=fields, field_key_type=field_key_type,
            sorts=sorts, view=view,
            per_group_limit=per_group_limit,
            group_offsets=group_offsets,
        )

    def _get_calendar_events_native(
        self, view, date_field, date_field_id_str, date_range,
        page, page_size, fields, field_key_type, filters, filter_logic,
        *, sorts=None, search=None, search_field_ids=None,
        search_hide_not_match_rows: bool = False, rls_context=None,
        end_date_field=None, end_date_field_id_str=None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """子类化扩展点：默认透传到模块函数，签名与最新 wave 1 契约一致。"""
        return _get_calendar_events_native_fn(
            view, date_field, date_field_id_str, date_range,
            page, page_size, fields, field_key_type, filters, filter_logic,
            sorts=sorts, search=search, search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
            rls_context=rls_context,
            end_date_field=end_date_field,
            end_date_field_id_str=end_date_field_id_str,
        )

    def _get_calendar_events_orm(
        self, queryset, date_field, date_field_keys, date_range,
        page, page_size, fields, field_key_type,
        *, sorts=None, view=None,
        end_date_field=None, end_date_field_keys=None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """子类化扩展点：默认透传到模块函数，签名与最新 wave 1 契约一致。"""
        return _get_calendar_events_orm_fn(
            queryset, date_field, date_field_keys, date_range,
            page, page_size, fields, field_key_type,
            sorts=sorts, view=view,
            end_date_field=end_date_field,
            end_date_field_keys=end_date_field_keys,
        )

    def _serialize_view(self, view: TableView) -> Dict[str, Any]:
        """序列化视图对象"""
        return {
            'id': str(view.id),
            'table_id': str(view.table_id),
            'name': view.name,
            'view_type': view.view_type,
            'description': view.description,
            'config': view.config,
            'filters': view.filters,
            'sorts': view.sorts,
            'groups': view.groups,
            'visible_fields': view.visible_fields,
            'field_order': view.field_order,
            **build_view_column_meta_payload(view),
        }


    def check_table_permission(self, table_id: UUID, required_role: str = 'viewer') -> bool:
        """
        检查用户对表格的权限（通过 Space -> Organization）

        Args:
            table_id: 表格ID
            required_role: 所需角色 (viewer/editor/owner)

        Returns:
            是否有权限
        """
        from apps.tabdata.services.table_service import TableService

        table_service = TableService(user=self.user)
        return table_service.check_table_permission(str(table_id), required_role)

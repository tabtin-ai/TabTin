"""
记录管理服务

提供记录的增删改查和批量操作功能
"""
from contextlib import contextmanager
from typing import List, Optional, Dict, Any, Tuple, Set, Iterable, Callable
from uuid import UUID, uuid4
import uuid
from datetime import datetime
import math
import logging
import hashlib
import copy
from django.conf import settings
from django.db import transaction, connections, router, DatabaseError
from django.db.models import QuerySet, Max, Q
from django.contrib.auth import get_user_model
from django.utils import timezone

from django.db.models import F

from apps.tabtinspace.services.organization_control_guard import (
    assert_organization_resource_write_allowed_optional,
)
from apps.tabdata.constants import (
    TABDATA_DB_ALIAS,
    BULK_WRITE_CHUNK_SIZE,
    DEFAULT_PAGE,
    DEFAULT_PAGE_SIZE,
    MAX_BULK_RECORDS,
    MAX_PAGE_SIZE,
    SYSTEM_MANAGED_FIELD_TYPES,
)
from apps.tabdata.exceptions import RecordVersionConflictError
from apps.tabdata.history_events import emit_record_history_event, get_editor_type
from apps.tabdata.models import Table, TableRecord, TableField
from apps.tabdata.request_context import get_current_window_id
from apps.tabdata.utils.field_types import validate_field_value, format_field_value, get_field_type_label
from apps.tabdata.utils.choice_utils import (
    extract_choice_values,
    iter_select_cell_values,
    merge_select_choice_values,
)
from apps.tabdata.utils.field_target_validators import MAX_OPTIONS_COUNT
from apps.tabdata.services.attachment_service import AttachmentService
from apps.tabdata.utils.field_validation_rules import validate_with_rules
from apps.tabdata.services.table_event_service import table_event_service
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.native.query_builder import NativeQueryBuilder, merge_where as _merge_where
from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
from apps.tabdata.native.community_capabilities import CommunityRecordIndexOperations
from apps.tabdata.native.value_converter import (
    convert_record_for_insert, convert_native_row_to_record_data, python_to_pg,
)
from apps.tabdata.native.pg_type_map import is_system_field
from apps.tabdata.utils.record_data_access import read_data
from apps.tabdata.utils.record_serializers import (
    serialize_native_row,
    serialize_native_rows,
    serialize_records,
    filter_native_record_fields,
)
from apps.users.membership.services.quota_service import QuotaService
from .base import BaseService

User = get_user_model()
logger = logging.getLogger(__name__)

SEARCH_FILTER_FIELD_LIMIT = 24
SEARCH_FILTER_MAX_KEYS = 64
SORT_INDEX_ROW_THRESHOLD = 20000

# record-level change_type 常量（AP-001: 与字段级 CHANGE_TYPE_* 对齐）
_CHANGE_TYPE_CREATE_RECORD = "create_record"
_CHANGE_TYPE_UPDATE_RECORD = "update_record"
_CHANGE_TYPE_DELETE_RECORD = "delete_record"
_CHANGE_TYPE_BATCH_CREATE_RECORDS = "batch_create_records"
_CHANGE_TYPE_BATCH_UPDATE_RECORDS = "batch_update_records"
ORDER_GAP_MIN = 1e-6
ORDER_REBALANCE_STEP = 1024.0

from .view_constants import VERSION_TOKEN_BASE_DEFAULT


def next_record_version(table_id: UUID, count: int = 1) -> int:
    """
    原子递增 ``Table.record_version_seq``，返回分配给本次变更的最大版本号。

    当 *count* > 1 时，调用方可倒推每条记录的版本号为
    ``[返回值 - count + 1, 返回值]``。

    在数据库层面通过 ``UPDATE ... SET record_version_seq = record_version_seq + count``
    保证原子性，无需额外锁。
    """
    if count <= 0:
        count = 1
    db_alias = router.db_for_write(Table)
    connection = connections[db_alias]
    table_name = connection.ops.quote_name(Table._meta.db_table)

    if connection.vendor == "postgresql":
        with connection.cursor() as cursor:
            cursor.execute(
                (
                    f"UPDATE {table_name} "
                    "SET record_version_seq = record_version_seq + %s "
                    "WHERE id = %s "
                    "RETURNING record_version_seq"
                ),
                [count, str(table_id)],
            )
            row = cursor.fetchone()
        if row:
            return int(row[0] or count)
        return int(datetime.now().timestamp() * 1000)

    with transaction.atomic(using=db_alias):
        table_obj = (
            Table.objects.using(db_alias)
            .select_for_update()
            .filter(id=table_id)
            .only('id', 'record_version_seq')
            .first()
        )
        if table_obj is None:
            return int(datetime.now().timestamp() * 1000)
        new_seq = (table_obj.record_version_seq or 0) + count
        Table.objects.using(db_alias).filter(id=table_id).update(
            record_version_seq=new_seq,
        )
        return int(new_seq)


def _chunked(items: List[Any], size: int) -> Iterable[List[Any]]:
    if size <= 0:
        yield items
        return
    for index in range(0, len(items), size):
        yield items[index:index + size]


def _run_after_tabdata_commit(callback: Callable[[], None]) -> None:
    """在 tabdata 事务提交后执行副作用；若当前不在事务中则立即执行。"""
    if connections[TABDATA_DB_ALIAS].in_atomic_block:
        transaction.on_commit(callback, using=TABDATA_DB_ALIAS)
    else:
        callback()


def _sync_records_to_ydoc(*args, **kwargs):
    from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc

    return sync_records_to_ydoc(*args, **kwargs)


def _invalidate_table_collab_version(
    table_id: UUID,
    record_version: int,
) -> None:
    """VS-001: DB-first 写入后通知 collab-live 更新 Y.Doc meta.version。

    record_version 是 record.version（原始整数），此函数负责编码为
    VERSION_TOKEN_BASE + record_version 格式后调用 invalidate-version。
    fire-and-forget：失败不阻断主路径，仅日志。
    """
    if record_version <= 0:
        return
    try:
        from apps.collab.api import _invalidate_collab_version

        encoded_version = VERSION_TOKEN_BASE_DEFAULT + int(record_version)

        def _invalidate_after_commit() -> None:
            try:
                result = _invalidate_collab_version(
                    "table", str(table_id), encoded_version,
                )
                if not result.get("success"):
                    logger.warning(
                        "invalidate_table_collab_version failed: table=%s version=%s",
                        table_id, encoded_version,
                    )
            except Exception as exc:
                logger.warning(
                    "invalidate_table_collab_version call error: table=%s err=%s",
                    table_id, exc,
                )

        _run_after_tabdata_commit(_invalidate_after_commit)
    except Exception as exc:
        logger.warning("_invalidate_table_collab_version setup failed: %s", exc)


def _trigger_scheduler_automations(*args, **kwargs):
    from apps.tabdata.utils.scheduler_bridge import trigger_scheduler_automations
    return trigger_scheduler_automations(*args, **kwargs)


_DEFAULT_ACTOR_UNSET = object()


class RecordService(BaseService):
    """
    记录管理服务

    提供记录的CRUD操作和批量处理
    """
    # 进程内缓存，避免重复执行 CREATE INDEX
    _ready_sort_indexes: Set[str] = set()

    # ------------------------------------------------------------------
    # 全局递增版本号（委托到模块级函数）
    # ------------------------------------------------------------------

    @staticmethod
    def _next_record_version(table_id: UUID, count: int = 1) -> int:
        return next_record_version(table_id, count)

    @staticmethod
    def _fix_unicode_surrogates(data: Any) -> Any:
        """递归清理数据中的不完整 Unicode 代理对和危险不可见字符。

        委托给 unicode_security.sanitize_text_for_storage（保留正常的 emoji）。
        """
        from apps.services.common.unicode_security import sanitize_text_for_storage

        if isinstance(data, str):
            return sanitize_text_for_storage(data)
        elif isinstance(data, dict):
            return {k: RecordService._fix_unicode_surrogates(v) for k, v in data.items()}
        elif isinstance(data, list):
            return [RecordService._fix_unicode_surrogates(item) for item in data]
        return data

    # ──────────────────────────────────
    # 原生列存储双写钩子
    # ──────────────────────────────────

    @staticmethod
    def _native_get_io(table: Table) -> NativeRecordIO:
        """获取原生 I/O 实例。

        Phase 3D: 原生列是唯一数据路径，不再检查 feature flag。
        """
        return NativeRecordIO(
            space_id=resolve_schema_partition_id(table),
            table_id=table.id,
        )

    @staticmethod
    def _native_write_record(
        native_io: NativeRecordIO,
        record: TableRecord,
        fields: List[TableField],
        source_data: Optional[Dict[str, Any]] = None,
    ) -> None:
        """写入单条记录到原生表。

        Phase 3D: 原生列是唯一数据路径，错误直接抛出。
        """
        data = source_data if source_data is not None else read_data(record)
        field_values = convert_record_for_insert(
            data,
            [f for f in fields if not is_system_field(f.field_type)],
        )
        system_values = {
            '__order': float(record.order or 0),
            '__version': int(record.version or 1),
            '__created_at': record.created_at,
            '__updated_at': record.updated_at,
            '__created_by': record.created_by_id,
            '__updated_by': record.updated_by_id,
        }
        native_io.insert_record(
            record_id=record.id,
            field_values=field_values,
            system_values=system_values,
        )

    @staticmethod
    def _native_update_record(
        native_io: NativeRecordIO,
        record: TableRecord,
        updated_field_values: Dict[str, Any],
        fields: List[TableField],
    ) -> None:
        """更新原生表记录。

        Phase 3D: 原生列是唯一数据路径，错误直接抛出。
        """
        pg_field_values = convert_record_for_insert(
            updated_field_values,
            [f for f in fields if not is_system_field(f.field_type)],
        )
        system_updates = {
            '__version': int(record.version or 1),
            '__updated_at': record.updated_at,
            '__updated_by': record.updated_by_id,
        }
        native_io.update_record(
            record_id=record.id,
            field_values=pg_field_values,
            system_updates=system_updates,
        )

    @staticmethod
    def _native_delete_record(native_io: NativeRecordIO, record: TableRecord) -> None:
        """从原生表删除记录。

        Phase 3D: 原生列是唯一数据路径，错误直接抛出。
        """
        native_io.delete_record(
            record_id=record.id,
            version=int(record.version or 0),
            updated_by=record.updated_by_id,
        )

    # ──────────────────────────────────
    # 原生列存储读取路径
    # ──────────────────────────────────

    def _get_record_native(
        self,
        record_id: UUID,
        *,
        fields_filter: Optional[Set[str]] = None,
        field_key_type: str = 'name',
        rls_context=None,
    ) -> Optional[Dict[str, Any]]:
        """
        从原生列读取单条记录并序列化为 API 格式。

        Args:
            record_id: 记录 UUID
            fields_filter: 字段过滤集合（字段名称），None 表示全部
            field_key_type: 字段 key 类型（name / id）
            rls_context: RLS 运行时上下文（可选）

        Returns:
            与 serialize_record() 格式一致的 dict，或 None（记录不存在）
        """
        try:
            record_orm = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id=record_id, is_deleted=False,
            ).only('id', 'table_id').first()
            if not record_orm:
                return None

            # 权限检查
            if not self.check_table_permission(str(record_orm.table_id), 'viewer'):
                return None

            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=record_orm.table_id)
            all_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id, is_deleted=False,
            ))
            user_fields = [f for f in all_fields if not is_system_field(f.field_type)]
            visible_keys = self._get_visible_field_keys(
                table.id, fields=all_fields, table=table,
            )

            native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
            row = native_io.read_single(record_id)
            if not row:
                return None

            # ── RLS SELECT 行级安全检查（SQL EXISTS） ──
            if rls_context is not None and table.rls_enabled:
                should_apply = rls_context.is_token_auth if not table.rls_force else True
                if should_apply:
                    from apps.tabdata.services.rls_service import rls_service
                    qb = NativeQueryBuilder(resolve_schema_partition_id(table), table.id, all_fields)
                    rls_where = rls_service.build_rls_where(
                        table_id=table.id, operation='SELECT',
                        context=rls_context, query_builder=qb,
                    )
                    if rls_where:
                        rls_sql, rls_params = rls_where
                        check_sql = (
                            f'SELECT EXISTS('
                            f'SELECT 1 FROM {qb.qualified_name} '
                            f'WHERE "__id" = %s AND ({rls_sql})'
                            f')'
                        )
                        with connections['postgresql'].cursor() as cursor:
                            cursor.execute(check_sql, [str(record_id)] + rls_params)
                            if not cursor.fetchone()[0]:
                                from apps.tabdata.exceptions import RLSAccessDenied
                                raise RLSAccessDenied("行级安全策略限制了对此记录的访问")

            result = serialize_native_row(
                row, table.id, user_fields,
                field_key_type=field_key_type,
            )

            # 角色可见性：先按 visibility_roles + 依赖闭包收口
            if result:
                self._apply_visibility_to_native_records(
                    [result],
                    visible_keys,
                    all_fields=all_fields,
                    field_key_type=field_key_type,
                )

            # 调用方 fields_filter：再与显式投影求交
            # ``fields_filter`` 按 ``field_key_type`` 给出；``data`` 固定按字段名输出
            if fields_filter and result:
                filter_native_record_fields(
                    [result], fields_filter,
                    all_fields=all_fields, field_key_type=field_key_type,
                )

            return result
        except Table.DoesNotExist:
            return None

    def _list_records_native(
        self,
        table_id: UUID,
        *,
        page: int = 1,
        page_size: int = 100,
        search: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        sort_by: Optional[str] = None,
        sort_order: str = 'asc',
        since_version: Optional[int] = None,
        only_delta: bool = False,
        field_key_type: str = 'name',
        rls_context=None,
        cursor_value: Optional[float] = None,
        cursor_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        从原生列读取记录列表。

        Phase 3D: 原生列是唯一数据路径。

        目前支持基本的分页、简单 filter、排序。
        复杂 filter/sort 仍由 view_data_service 的原生路径处理。

        keyset 分页：当 cursor_value 传入时，使用 WHERE __order > cursor
        替代 OFFSET 扫描，深页查询性能从 O(offset+limit) 降至 O(limit)。
        仅在默认排序（__order ASC）时可用；自定义排序时回退 OFFSET。

        Returns:
            与 list_records() 一致的返回格式
        """
        native_vendor = connections['postgresql'].vendor
        if native_vendor != 'postgresql':
            return self._list_records_orm_fallback(
                table_id=table_id,
                page=page,
                page_size=page_size,
                search=search,
                filters=filters,
                sort_by=sort_by,
                sort_order=sort_order,
                since_version=since_version,
                only_delta=only_delta,
                field_key_type=field_key_type,
                rls_context=rls_context,
            )

        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
                fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id, is_deleted=False,
                ))
                user_fields = [f for f in fields if not is_system_field(f.field_type)]
                visible_keys, filters, sort_by = self._prepare_query_visibility(
                    table_id,
                    fields=fields,
                    filters=filters,
                    sort_by=sort_by,
                    table=table,
                )
                visible_ids = set((visible_keys or {}).get('ids') or set())
                searchable_fields = [
                    f for f in user_fields if str(f.id) in visible_ids
                ]

                partition_id = resolve_schema_partition_id(table)
                query_builder = NativeQueryBuilder(
                    space_id=partition_id,
                    table_id=table_id,
                    fields=fields,
                )
                native_io = NativeRecordIO(partition_id, table_id)

                # 构建 WHERE
                where: Optional[Tuple[str, List[Any]]] = None
                if filters:
                    if 'filterSet' in filters or 'conjunction' in filters:
                        filter_where = query_builder.build_where_clause(filters)
                        if filter_where and filter_where[0] != 'TRUE':
                            where = _merge_where(where, filter_where)
                    else:
                        conditions = []
                        params = []
                        for field_name, value in filters.items():
                            col_ref = query_builder._resolve_column_ref(field_name)
                            if col_ref:
                                field = query_builder._get_field_for_ref(field_name)
                                pg_type = query_builder._get_pg_type(field_name) if field else None
                                coerced = NativeQueryBuilder._coerce_value_for_pg(value, pg_type)
                                conditions.append(f'{col_ref} = %s')
                                params.append(coerced)
                            else:
                                logger.warning('filter 字段无法解析，已跳过: %s', field_name)
                        if conditions:
                            where = (' AND '.join(conditions), params)

                normalized_search = (search or '').strip()
                if normalized_search:
                    escaped = normalized_search.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_').lower()
                    like_pattern = f'%{escaped}%'
                    prioritized_fields = sorted(
                        searchable_fields,
                        key=lambda field: (
                            0 if field.is_primary else 1,
                            field.order if field.order is not None else 10**6,
                            str(field.id),
                        ),
                    )
                    from apps.tabdata.utils.searchable_cell_text import (
                        build_searchable_column_sql_expr,
                    )

                    search_conditions: List[str] = []
                    search_params: List[str] = []
                    for field in prioritized_fields:
                        # 展示文本匹配，避免结构化列 UUID id 误命中
                        text_expr = build_searchable_column_sql_expr(f'"{field.id.hex}"')
                        search_conditions.append(
                            f"{text_expr} LIKE %s ESCAPE '\\'"
                        )
                        search_params.append(like_pattern)
                        if len(search_conditions) >= SEARCH_FILTER_MAX_KEYS:
                            break
                    search_where: Tuple[str, List[Any]]
                    if search_conditions:
                        search_where = (f"({' OR '.join(search_conditions)})", search_params)
                    else:
                        search_where = ('FALSE', [])
                    where = _merge_where(where, search_where)

                # ── RLS 行级安全策略注入 ──
                if table.rls_enabled and rls_context is not None:
                    should_apply = rls_context.is_token_auth if not table.rls_force else True
                    if should_apply:
                        from apps.tabdata.services.rls_service import rls_service
                        rls_where = rls_service.build_rls_where(
                            table_id=table_id,
                            operation='SELECT',
                            context=rls_context,
                            query_builder=query_builder,
                        )
                        if rls_where is not None:
                            where = _merge_where(where, rls_where)

                version_state = self._get_latest_version_state(
                    TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False),
                    table_id=table_id,
                )
                latest_version = int(version_state['latest_version'])
                has_changes = True
                if since_version is not None:
                    has_changes = self._has_changes_since_version(
                        since_version=since_version,
                        version_state=version_state,
                    )
                requires_full_reload = bool(
                    only_delta
                    and since_version is not None
                    and self._requires_full_reload_since_version(
                        since_version=since_version,
                        version_state=version_state,
                    )
                )
                if requires_full_reload:
                    has_changes = True

                # 构建 ORDER BY（结构化元组格式）
                order_by = None
                if sort_by:
                    sort_key = self._resolve_sort_key(table_id, sort_by)
                    if sort_key:
                        row_count = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False).count()
                        self._ensure_data_sort_index(
                            table_id=table_id,
                            sort_key=sort_key,
                            row_count=row_count,
                        )

                    col_ref = query_builder._resolve_column_ref(sort_by)
                    if not col_ref and sort_key:
                        col_ref = query_builder._resolve_column_ref(sort_key)
                    if col_ref:
                        direction = 'DESC' if sort_order == 'desc' else 'ASC'
                        nulls = 'NULLS LAST' if sort_order == 'desc' else 'NULLS FIRST'
                        order_by = (f'{col_ref} {direction} {nulls}, "__order" ASC', [])

                if not order_by:
                    order_by = ('"__order" ASC', [])

                rows: List[Dict[str, Any]] = []
                total = 0
                matched_total = 0

                use_delta_query = bool(only_delta and since_version is not None)
                working_where = where
                if use_delta_query:
                    total = native_io.count_records(where=where)
                    if requires_full_reload or not has_changes:
                        matched_total = 0
                    else:
                        delta_where: Optional[Tuple[str, List[Any]]] = None
                        try:
                            since_value = int(since_version)
                        except (TypeError, ValueError):
                            since_value = None

                        if since_value is not None:
                            if self._is_monotonic_version_token(since_value):
                                delta_where = (
                                    '"__version" > %s',
                                    [self._decode_monotonic_version_token(since_value)],
                                )
                            else:
                                try:
                                    since_datetime = datetime.fromtimestamp(
                                        since_value / 1000,
                                        tz=timezone.get_current_timezone()
                                    )
                                    delta_where = ('"__updated_at" > %s', [since_datetime])
                                except (OSError, OverflowError, ValueError):
                                    delta_where = ('FALSE', [])

                        working_where = _merge_where(where, delta_where)
                        offset = (page - 1) * page_size
                        rows, matched_total = native_io.read_records(
                            query_builder,
                            where=working_where,
                            order_by=order_by,
                            limit=page_size,
                            offset=offset,
                        )
                else:
                    # keyset 分页：默认排序 + 有游标时启用，深页 O(limit) 替代 O(offset+limit)
                    _can_keyset = (
                        cursor_value is not None
                        and not sort_by
                        and not search
                    )
                    offset = (page - 1) * page_size
                    rows, total = native_io.read_records(
                        query_builder,
                        where=working_where,
                        order_by=order_by,
                        limit=page_size,
                        offset=0 if _can_keyset else offset,
                        cursor_value=cursor_value if _can_keyset else None,
                        cursor_id=cursor_id if _can_keyset else None,
                    )
                    matched_total = total

                serialized = serialize_native_rows(
                    rows, table_id, user_fields,
                    field_key_type=field_key_type,
                )
                serialized = self._apply_visibility_to_native_records(
                    serialized,
                    visible_keys,
                    all_fields=fields,
                    field_key_type=field_key_type,
                )

                result: Dict[str, Any] = {
                    "records": serialized,
                    "total": total,
                    "matched_total": matched_total,
                    "latest_version": latest_version,
                    "has_changes": has_changes,
                    "requires_full_reload": requires_full_reload,
                }

                if serialized:
                    last = rows[-1] if rows else None
                    if last:
                        result["next_cursor_value"] = last.get("__order")
                        result["next_cursor_id"] = str(last.get("__id", ""))

                return result
        except DatabaseError as exc:
            logger.warning("list_records native 查询失败（DatabaseError），回退 ORM: table=%s err=%s", table_id, exc)
            return self._list_records_orm_fallback(
                table_id=table_id,
                page=page,
                page_size=page_size,
                search=search,
                filters=filters,
                sort_by=sort_by,
                sort_order=sort_order,
                since_version=since_version,
                only_delta=only_delta,
                field_key_type=field_key_type,
                rls_context=rls_context,
            )

    def _list_records_orm_fallback(
        self,
        table_id: UUID,
        *,
        page: int = 1,
        page_size: int = 100,
        search: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        sort_by: Optional[str] = None,
        sort_order: str = 'asc',
        since_version: Optional[int] = None,
        only_delta: bool = False,
        field_key_type: str = 'name',
        rls_context=None,
    ) -> Dict[str, Any]:
        """
        native 查询不可用时的 ORM 回退路径（用于测试与止血场景）。
        """
        all_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
        working_qs = all_qs

        if rls_context is not None:
            from apps.tabdata.services.rls_service import apply_rls_to_orm_queryset
            working_qs = apply_rls_to_orm_queryset(working_qs, table_id, rls_context)

        fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False))
        name_map, id_map, db_field_name_map = self._build_field_input_maps(fields)
        user_fields = [f for f in fields if not is_system_field(f.field_type)]
        visible_keys, filters, sort_by = self._prepare_query_visibility(
            table_id,
            fields=fields,
            filters=filters,
            sort_by=sort_by,
        )
        visible_ids = set((visible_keys or {}).get('ids') or set())
        searchable_fields = [f for f in user_fields if str(f.id) in visible_ids]

        # ── filters（精确匹配）──
        if filters:
            filter_q = Q()
            for raw_key, value in filters.items():
                key = str(raw_key)
                if key in {'id', 'row_id', 'status'}:
                    filter_q &= Q(**{key: value})
                    continue
                if key in {'order', 'version'}:
                    filter_q &= Q(**{key: value})
                    continue

                field = name_map.get(key) or id_map.get(key) or db_field_name_map.get(key)
                if field:
                    fid = str(field.id)
                    q = Q(**{f'data__{fid}': value})
                    if field.name and field.name != fid:
                        q |= Q(**{f'data__{field.name}': value})
                    db_key = self._field_db_key(field)
                    if db_key and db_key not in {fid, field.name}:
                        q |= Q(**{f'data__{db_key}': value})
                    filter_q &= q
            working_qs = working_qs.filter(filter_q)

        # ── search（优先原生列 ILIKE，降级 JSONB 路径；仅可见字段）──
        normalized_search = (search or '').strip()
        if normalized_search:
            prioritized_fields = sorted(
                searchable_fields,
                key=lambda field: (
                    0 if field.is_primary else 1,
                    field.order if field.order is not None else 10**6,
                    str(field.id),
                ),
            )

            native_searched = False
            try:
                from apps.tabdata.native.ddl_manager import DDLManager
                table_obj = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
                qualified = DDLManager.qualified_table_name(
                    resolve_schema_partition_id(table_obj), table_id,
                )
                escaped = normalized_search.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_').lower()
                like_pattern = f'%{escaped}%'
                from apps.tabdata.utils.searchable_cell_text import (
                    build_searchable_column_sql_expr,
                )

                native_conds: list = []
                native_params: list = []
                for field in prioritized_fields:
                    text_expr = build_searchable_column_sql_expr(f'"{field.id.hex}"')
                    native_conds.append(f"{text_expr} LIKE %s ESCAPE '\\'")
                    native_params.append(like_pattern)
                    if len(native_conds) >= SEARCH_FILTER_MAX_KEYS:
                        break
                if native_conds:
                    native_sql = (
                        f'"row_id" IN (SELECT "__id" FROM {qualified} '
                        f'WHERE {" OR ".join(native_conds)})'
                    )
                    working_qs = working_qs.extra(where=[native_sql], params=native_params)
                    native_searched = True
            except Exception:
                logger.debug('Native search fallback failed for table %s, using JSONB path', table_id)

            if not native_searched:
                search_q = Q()
                condition_count = 0
                for field in prioritized_fields:
                    fid = str(field.id)
                    search_q |= Q(**{f'data__{fid}__icontains': normalized_search})
                    condition_count += 1
                    if condition_count >= SEARCH_FILTER_MAX_KEYS:
                        break
                    if field.name and field.name != fid:
                        search_q |= Q(**{f'data__{field.name}__icontains': normalized_search})
                        condition_count += 1
                        if condition_count >= SEARCH_FILTER_MAX_KEYS:
                            break
                    db_key = self._field_db_key(field)
                    if db_key and db_key not in {fid, field.name}:
                        search_q |= Q(**{f'data__{db_key}__icontains': normalized_search})
                        condition_count += 1
                        if condition_count >= SEARCH_FILTER_MAX_KEYS:
                            break
                working_qs = working_qs.filter(search_q)

        # ── 版本状态（基于整表）──
        version_state = self._get_latest_version_state(all_qs, table_id=table_id)
        latest_version = int(version_state['latest_version'])
        has_changes = True
        if since_version is not None:
            has_changes = self._has_changes_since_version(
                since_version=since_version,
                version_state=version_state,
            )
        requires_full_reload = bool(
            only_delta
            and since_version is not None
            and self._requires_full_reload_since_version(
                since_version=since_version,
                version_state=version_state,
            )
        )
        if requires_full_reload:
            has_changes = True

        # ── 排序 ──
        sort_key = None
        if sort_by:
            sort_key = self._resolve_sort_key(table_id, sort_by)
            if sort_key:
                row_count = all_qs.count()
                self._ensure_data_sort_index(
                    table_id=table_id,
                    sort_key=sort_key,
                    row_count=row_count,
                )

                direction = '-' if sort_order == 'desc' else ''
                order_fields = [f'{direction}data__{sort_key}', f'{direction}order', '-created_at']
                try:
                    working_qs = working_qs.order_by(*order_fields)
                except Exception:  # noqa: BLE001
                    working_qs = working_qs.order_by('order', '-created_at')
            else:
                working_qs = working_qs.order_by('order', '-created_at')
        else:
            working_qs = working_qs.order_by('order', '-created_at')

        total = working_qs.count()
        matched_total = total
        query_for_page = working_qs

        # ── 增量过滤 ──
        if only_delta and since_version is not None:
            if requires_full_reload or not has_changes:
                matched_total = 0
                query_for_page = working_qs.none()
            else:
                query_for_page = self._filter_queryset_since_version(working_qs, since_version)
                matched_total = query_for_page.count()
        else:
            matched_total = total

        start = max(0, (page - 1) * page_size)
        end = start + page_size
        records = list(query_for_page[start:end]) if matched_total > 0 else []
        # 先序列化再按角色收口，避免 ``_filtered_data={}`` 被当成空而回退原生全量
        serialized = serialize_records(
            records,
            field_key_type=field_key_type if field_key_type in {'id', 'name', 'dbFieldName'} else 'name',
        )
        serialized = self._apply_visibility_to_native_records(
            serialized,
            visible_keys,
            all_fields=fields,
            field_key_type=field_key_type,
        )

        return {
            "records": serialized,
            "total": total,
            "matched_total": matched_total,
            "latest_version": latest_version,
            "has_changes": has_changes,
            "requires_full_reload": requires_full_reload,
        }

    def _sync_attachments(self, record: TableRecord) -> None:
        """同步记录附件引用"""
        AttachmentService(user=self.user).sync_record_attachments(record)

    def _publish_table_event(self, table_id, record_ids, action, records=None):
        """向后兼容包装 → utils/ws_notify.py"""
        from apps.tabdata.utils.ws_notify import publish_table_record_event
        publish_table_record_event(
            table_id=table_id,
            record_ids=record_ids,
            action=action,
            records=records,
            user_id=str(self.user.id) if self.user else None,
        )

    @staticmethod
    def _build_field_changes(
        old_data: Optional[Dict[str, Any]],
        new_data: Optional[Dict[str, Any]],
    ) -> Dict[str, Dict[str, Any]]:
        """
        构建字段级 old/new 变更集。
        """
        old_map = old_data or {}
        new_map = new_data or {}
        field_changes: Dict[str, Dict[str, Any]] = {}
        all_keys = set(old_map.keys()) | set(new_map.keys())
        for key in all_keys:
            old_value = old_map.get(key)
            new_value = new_map.get(key)
            if old_value != new_value:
                field_changes[str(key)] = {
                    "old": old_value,
                    "new": new_value,
                }
        return field_changes



    @staticmethod
    def _build_field_maps(fields: List[TableField]) -> Tuple[Dict[str, TableField], Dict[str, TableField]]:
        """
        构建字段名称/字段ID映射。
        """
        name_map = {field.name: field for field in fields}
        id_map = {str(field.id): field for field in fields}
        return name_map, id_map

    @staticmethod
    def _field_db_key(field: TableField) -> Optional[str]:
        config = field.config or {}
        raw = config.get('db_field_name')
        if raw in (None, ''):
            return None
        return str(raw)

    @classmethod
    def _build_field_input_maps(
        cls,
        fields: List[TableField],
    ) -> Tuple[Dict[str, TableField], Dict[str, TableField], Dict[str, TableField]]:
        """
        构建可用于输入解析的字段映射（name/id/db_field_name）。
        """
        name_map, id_map = cls._build_field_maps(fields)
        db_field_name_map: Dict[str, TableField] = {}

        for field in fields:
            db_key = cls._field_db_key(field)
            if not db_key:
                continue
            db_field_name_map[db_key] = field

        return name_map, id_map, db_field_name_map

    @staticmethod
    def _build_bulk_operation_stats(
        *,
        total_count: int,
        processed_count: int,
        failed_count: int,
        batches_completed: int,
        batch_size: int = BULK_WRITE_CHUNK_SIZE,
    ) -> Dict[str, int]:
        total_batches = (total_count + batch_size - 1) // batch_size if total_count > 0 else 0
        return {
            "total_count": total_count,
            "processed_count": processed_count,
            "failed_count": failed_count,
            "batch_size": batch_size,
            "batches_completed": batches_completed,
            "total_batches": total_batches,
        }

    def _set_last_bulk_operation_stats(self, stats: Dict[str, int]) -> None:
        """
        保存最近一次批量操作统计，供 API 层返回进度信息。
        """
        self.last_bulk_operation_stats = stats

    def _collect_unknown_field_keys(
        self,
        data: Optional[Dict[str, Any]],
        fields: List[TableField],
    ) -> List[str]:
        """返回 data 中无法解析为表字段的 key（保持输入顺序、去重）。"""
        if not data:
            return []
        name_map, id_map, db_map = self._build_field_input_maps(fields)
        unknown: List[str] = []
        seen: Set[str] = set()
        for raw_key in data.keys():
            key = str(raw_key)
            if key in seen:
                continue
            if name_map.get(key) or id_map.get(key) or db_map.get(key):
                continue
            seen.add(key)
            unknown.append(key)
        return unknown

    @staticmethod
    def _next_append_order(records_queryset: QuerySet) -> float:
        """
        计算追加到尾部时的新顺序值。
        """
        max_order = records_queryset.aggregate(Max('order')).get('order__max')
        if max_order is None:
            return ORDER_REBALANCE_STEP
        return float(max_order) + ORDER_REBALANCE_STEP

    def _rebalance_record_orders(self, table_id: UUID) -> None:
        """
        对整表记录进行顺序重排，拉开 order 间距，避免浮点间隙耗尽。
        """
        records = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).order_by('order', 'created_at', 'id').only('id', 'order', 'position_id')
        )
        if not records:
            return

        next_order = ORDER_REBALANCE_STEP
        has_updates = False
        now = timezone.now()
        records_needing_update: list = []
        for record in records:
            current_order = float(record.order or 0)
            if abs(current_order - next_order) > 1e-9:
                record.order = next_order
                # Rebalance rewrites the legacy coordinate space. Any sparse
                # explicit PositionId derived from the old coordinates would
                # make a subsequent legacy REST move ineffective.
                record.position_id = None
                record.updated_at = now
                if self.user:
                    record.updated_by_id = self.user.id
                has_updates = True
                records_needing_update.append(record)
            next_order += ORDER_REBALANCE_STEP

        if records_needing_update:
            version_end = self._next_record_version(table_id, count=len(records_needing_update))
            version_start = version_end - len(records_needing_update) + 1
            for i, record in enumerate(records_needing_update):
                record.version = version_start + i

        if has_updates:
            update_fields = ['order', 'position_id', 'updated_at', 'version']
            if self.user:
                update_fields.append('updated_by_id')
            TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                records_needing_update,
                update_fields,
                batch_size=BULK_WRITE_CHUNK_SIZE,
            )
            _sync_records_to_ydoc(
                table_id,
                records_needing_update,
                fields=[],
                rebalance_record_ids=[str(record.id) for record in records_needing_update],
                source="rebalance_record_orders",
            )

    def _resolve_record_order(
        self,
        table_id: UUID,
        order_context: Optional[Dict[str, Any]],
        allow_rebalance: bool = True,
    ) -> Tuple[Optional[float], Optional[str]]:
        """
        根据 order_context 计算新记录 order。

        支持：
        - end（默认）：追加到末尾
        - before/after：按锚点插入
        """
        records_queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        )
        context = order_context or {}
        position = str(context.get('position') or 'end').strip().lower()

        if position not in {'before', 'after', 'end'}:
            return None, "order_context.position 仅支持 before/after/end"

        if position == 'end':
            return self._next_append_order(records_queryset), None

        anchor_record_id = context.get('anchor_record_id')
        if not anchor_record_id:
            return None, "order_context.anchor_record_id 不能为空"

        try:
            anchor_uuid = UUID(str(anchor_record_id))
        except (TypeError, ValueError):
            return None, "order_context.anchor_record_id 格式无效"

        anchor_record = records_queryset.filter(id=anchor_uuid).only('id', 'order').first()
        if not anchor_record:
            return None, "锚点记录不存在或不属于当前表格"

        anchor_order = float(anchor_record.order or self._next_append_order(records_queryset))

        if position == 'before':
            prev_record = (
                records_queryset
                .filter(order__lt=anchor_order)
                .order_by('-order', '-created_at', '-id')
                .only('order')
                .first()
            )
            left_order = float(prev_record.order) if prev_record and prev_record.order is not None else anchor_order - ORDER_REBALANCE_STEP
            right_order = anchor_order
        else:
            next_record = (
                records_queryset
                .filter(order__gt=anchor_order)
                .order_by('order', 'created_at', 'id')
                .only('order')
                .first()
            )
            left_order = anchor_order
            right_order = float(next_record.order) if next_record and next_record.order is not None else anchor_order + ORDER_REBALANCE_STEP

        gap = right_order - left_order
        if (not math.isfinite(left_order)) or (not math.isfinite(right_order)) or right_order <= left_order or gap <= ORDER_GAP_MIN:
            if not allow_rebalance:
                return None, "无法为新记录分配顺序，请稍后重试"
            self._rebalance_record_orders(table_id)
            return self._resolve_record_order(
                table_id=table_id,
                order_context=order_context,
                allow_rebalance=False,
            )

        return (left_order + right_order) / 2.0, None

    def _resolve_bulk_record_orders(
        self,
        table_id: UUID,
        count: int,
        order_context: Optional[Dict[str, Any]],
        allow_rebalance: bool = True,
    ) -> Tuple[List[float], Optional[str]]:
        """
        为批量创建一次性计算顺序值，保证同一请求内新记录顺序稳定。
        """
        if count <= 0:
            return [], None

        records_queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        )
        context = order_context or {}
        position = str(context.get('position') or 'end').strip().lower()

        if position not in {'before', 'after', 'end'}:
            return [], "order_context.position 仅支持 before/after/end"

        if position == 'end':
            first_order = self._next_append_order(records_queryset)
            return [
                first_order + ORDER_REBALANCE_STEP * index
                for index in range(count)
            ], None

        anchor_record_id = context.get('anchor_record_id')
        if not anchor_record_id:
            return [], "order_context.anchor_record_id 不能为空"

        try:
            anchor_uuid = UUID(str(anchor_record_id))
        except (TypeError, ValueError):
            return [], "order_context.anchor_record_id 格式无效"

        anchor_record = records_queryset.filter(id=anchor_uuid).only('id', 'order').first()
        if not anchor_record:
            return [], "锚点记录不存在或不属于当前表格"

        anchor_order = float(anchor_record.order or self._next_append_order(records_queryset))

        if position == 'before':
            prev_record = (
                records_queryset
                .filter(order__lt=anchor_order)
                .order_by('-order', '-created_at', '-id')
                .only('order')
                .first()
            )
            if not prev_record or prev_record.order is None:
                start_order = anchor_order - ORDER_REBALANCE_STEP * count
                return [
                    start_order + ORDER_REBALANCE_STEP * index
                    for index in range(count)
                ], None
            left_order = float(prev_record.order)
            right_order = anchor_order
        else:
            next_record = (
                records_queryset
                .filter(order__gt=anchor_order)
                .order_by('order', 'created_at', 'id')
                .only('order')
                .first()
            )
            if not next_record or next_record.order is None:
                start_order = anchor_order + ORDER_REBALANCE_STEP
                return [
                    start_order + ORDER_REBALANCE_STEP * index
                    for index in range(count)
                ], None
            left_order = anchor_order
            right_order = float(next_record.order)

        gap = right_order - left_order
        step = gap / (count + 1)
        if (
            (not math.isfinite(left_order)) or
            (not math.isfinite(right_order)) or
            right_order <= left_order or
            step <= ORDER_GAP_MIN
        ):
            if not allow_rebalance:
                return [], "无法为新记录分配顺序，请稍后重试"
            self._rebalance_record_orders(table_id)
            return self._resolve_bulk_record_orders(
                table_id=table_id,
                count=count,
                order_context=order_context,
                allow_rebalance=False,
            )

        return [
            left_order + step * (index + 1)
            for index in range(count)
        ], None

    @staticmethod
    def _resolve_sort_key(table_id: UUID, sort_by: Optional[str]) -> Optional[str]:
        """
        将排序字段解析为真实查询 key。

        优先使用模型字段，其次将字段名解析为字段 UUID key，减少 JSON 名称键排序歧义。
        """
        if not sort_by:
            return None

        model_fields = {'created_at', 'updated_at', 'order', 'row_id', 'status'}
        if sort_by in model_fields:
            return sort_by

        sort_key_query = Q(name=sort_by)
        if RecordService._is_uuid_key(sort_by):
            sort_key_query |= Q(id=sort_by)

        field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        ).filter(sort_key_query).only('id').first()

        if field:
            return str(field.id)

        return sort_by

    @staticmethod
    def _is_uuid_key(value: Optional[str]) -> bool:
        if not value:
            return False
        try:
            UUID(str(value))
            return True
        except (TypeError, ValueError):
            return False

    @classmethod
    def _build_sort_index_name(cls, table_id: UUID, sort_key: str) -> str:
        digest = hashlib.md5(f"{table_id}:{sort_key}".encode("utf-8")).hexdigest()[:16]
        return f"tabdata_sort_idx_{digest}"

    def _ensure_data_sort_index(
        self,
        *,
        table_id: UUID,
        sort_key: str,
        row_count: int,
    ) -> None:
        """
        为大表 JSON 字段排序创建局部表达式索引，降低排序扫描成本。

        索引策略：
        - 仅对字段 UUID key 生效（避免任意输入导致 SQL 注入与索引泛滥）
        - 仅在大表（row_count >= SORT_INDEX_ROW_THRESHOLD）触发
        - 按 table_id + field_id 建 partial index，控制索引大小与命中率
        """
        if row_count < SORT_INDEX_ROW_THRESHOLD:
            return
        if not self._is_uuid_key(sort_key):
            return

        normalized_sort_key = str(UUID(str(sort_key)))
        index_name = self._build_sort_index_name(table_id, normalized_sort_key)
        if index_name in self._ready_sort_indexes:
            return

        db_alias = router.db_for_read(TableRecord)
        connection = connections[db_alias]
        if connection.vendor != "postgresql":
            return

        if connection.in_atomic_block:
            logger.debug(
                "跳过排序索引创建：当前在事务块内 table_id=%s sort_key=%s",
                table_id,
                normalized_sort_key,
            )
            return

        if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
            try:
                created = CommunityRecordIndexOperations(
                    connection
                ).create_sort_index(table_id, UUID(normalized_sort_key))
                if created:
                    self._ready_sort_indexes.add(index_name)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "创建 Community 排序索引失败（查询继续走无索引路径） "
                    "table_id=%s sort_key=%s error=%s",
                    table_id,
                    normalized_sort_key,
                    exc,
                )
            return

        table_id_str = str(table_id)
        # sort_key 已严格限制为 UUID，table_id 为 UUID 主键，可安全作为 SQL 字面量拼接
        create_sql = (
            f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {index_name} "
            "ON tabdata_record (table_id, is_deleted, ((data->>'"
            f"{normalized_sort_key}"
            "'))) "
            "WHERE table_id = '"
            f"{table_id_str}"
            "' AND is_deleted = false"
        )

        try:
            with connection.cursor() as cursor:
                cursor.execute(create_sql)
            self._ready_sort_indexes.add(index_name)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "创建排序索引失败（已忽略） table_id=%s sort_key=%s error=%s",
                table_id,
                normalized_sort_key,
                exc,
            )

    @staticmethod
    def _apply_search_filter(
        queryset: QuerySet,
        table_id: UUID,
        search: str,
        visible_keys: Optional[Dict[str, Set[str]]] = None,
    ) -> QuerySet:
        """
        搜索优化：
        - 优先按 JSON key 精确路径检索，避免 data::text ILIKE 的全 JSON 扫描。
        - 字段很多时仅保留高优先级字段（主键列 + 前序列），降低 OR 查询开销。
        """
        normalized = (search or '').strip()
        if not normalized:
            return queryset

        fields_queryset = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).only('id', 'name', 'is_primary', 'order')
        )

        if not fields_queryset:
            return queryset.extra(where=["data::text ILIKE %s"], params=[f'%{normalized}%'])

        allowed_ids: Optional[Set[str]] = None
        allowed_names: Optional[Set[str]] = None
        allowed_db_field_names: Optional[Set[str]] = None
        if visible_keys:
            allowed_ids = set(visible_keys.get('ids') or set())
            allowed_names = set(visible_keys.get('names') or set())
            allowed_db_field_names = set(visible_keys.get('dbFieldNames') or set())

        prioritized_fields = sorted(
            fields_queryset,
            key=lambda field: (
                0 if field.is_primary else 1,
                field.order if field.order is not None else 10**6,
                str(field.id),
            )
        )

        search_keys: List[str] = []
        seen_keys: Set[str] = set()
        for field in prioritized_fields:
            field_id = str(field.id)
            field_name = field.name
            field_db_name = str((field.config or {}).get('db_field_name') or '') or None

            include_by_visibility = True
            if (allowed_ids is not None) or (allowed_names is not None) or (allowed_db_field_names is not None):
                include_by_visibility = (
                    (allowed_ids is not None and field_id in allowed_ids) or
                    (allowed_names is not None and field_name in allowed_names) or
                    (allowed_db_field_names is not None and bool(field_db_name) and field_db_name in allowed_db_field_names)
                )

            if not include_by_visibility:
                continue

            for key in (field_id, field_name, field_db_name):
                if not key:
                    continue
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                search_keys.append(key)

            if len(search_keys) >= SEARCH_FILTER_MAX_KEYS:
                break

        if not search_keys:
            return queryset.extra(where=["data::text ILIKE %s"], params=[f'%{normalized}%'])

        if len(prioritized_fields) > SEARCH_FILTER_FIELD_LIMIT:
            logger.debug(
                "表格 %s 搜索字段过多(%s)，本次按优先级裁剪到 %s 个字段",
                table_id,
                len(prioritized_fields),
                len(search_keys),
            )

        search_q = Q()
        for key in search_keys:
            search_q |= Q(**{f"data__{key}__icontains": normalized})

        return queryset.filter(search_q)

    def _format_record_data(
        self,
        input_data: Dict[str, Any],
        *,
        fields: List[TableField],
        preserve_existing: Optional[Dict[str, Any]] = None,
        skip_system_managed_inputs: bool = True,
    ) -> Dict[str, Any]:
        """
        将输入数据标准化为以字段 UUID 为 key 的记录数据。

        Args:
            input_data: 输入数据（字段名或字段ID）
            fields: 当前表格字段
            preserve_existing: 需要先保留的原始数据（通常是更新场景）
            skip_system_managed_inputs: 是否忽略系统托管字段的输入
        """
        formatted_data = dict(preserve_existing or {})
        name_map, id_map, db_field_name_map = self._build_field_input_maps(fields)

        for raw_key, value in (input_data or {}).items():
            normalized_key = str(raw_key)
            field = (
                name_map.get(normalized_key)
                or id_map.get(normalized_key)
                or db_field_name_map.get(normalized_key)
            )
            if field:
                if skip_system_managed_inputs and field.field_type in SYSTEM_MANAGED_FIELD_TYPES:
                    continue
                formatted_data[field.id.hex] = format_field_value(
                    field.field_type,
                    value,
                    field.config,
                )
            else:
                # 未知字段保留，兼容历史数据
                formatted_data[normalized_key] = value

        return formatted_data

    @staticmethod
    def _find_system_managed_input_keys(data: Dict[str, Any], fields: List[TableField]) -> List[str]:
        """
        找出请求里试图修改系统托管字段的 key。
        """
        if not data:
            return []

        name_map, id_map, db_field_name_map = RecordService._build_field_input_maps(fields)
        blocked_keys: List[str] = []

        for key in data.keys():
            normalized_key = str(key)
            field = (
                name_map.get(normalized_key)
                or id_map.get(normalized_key)
                or db_field_name_map.get(normalized_key)
            )
            if field and field.field_type in SYSTEM_MANAGED_FIELD_TYPES:
                blocked_keys.append(normalized_key)

        return blocked_keys

    def _get_version_token_base(self) -> int:
        raw_value = getattr(settings, "TABDATA_VERSION_TOKEN_BASE", VERSION_TOKEN_BASE_DEFAULT)
        try:
            base = int(raw_value)
        except (TypeError, ValueError):
            base = VERSION_TOKEN_BASE_DEFAULT
        if base <= 2_000_000_000_000 or base >= 9_000_000_000_000_000:
            return VERSION_TOKEN_BASE_DEFAULT
        return base

    def _is_monotonic_version_token(self, version_value: Optional[int]) -> bool:
        if version_value is None:
            return False
        try:
            normalized = int(version_value)
        except (TypeError, ValueError):
            return False
        return normalized >= self._get_version_token_base()

    def _encode_monotonic_version_token(self, latest_record_version: int) -> int:
        if latest_record_version <= 0:
            return 0
        return self._get_version_token_base() + int(latest_record_version)

    def _decode_monotonic_version_token(self, version_token: int) -> int:
        return max(0, int(version_token) - self._get_version_token_base())

    def _get_latest_version_state(
        self,
        queryset: QuerySet,
        *,
        table_id: Optional[UUID] = None,
    ) -> Dict[str, int]:
        summary = queryset.aggregate(max_updated=Max('updated_at'), max_version=Max('version'))
        latest_updated = summary.get('max_updated')
        latest_updated_ms = int(latest_updated.timestamp() * 1000) if latest_updated else 0
        latest_record_version = int(summary.get('max_version') or 0)
        latest_delete_version = 0
        if table_id is not None:
            table_state = (
                Table.objects.using(queryset.db)
                .filter(id=table_id)
                .values('record_version_seq', 'record_delete_version')
                .first()
                or {}
            )
            latest_record_version = max(
                latest_record_version,
                int(table_state.get('record_version_seq') or 0),
            )
            latest_delete_version = int(table_state.get('record_delete_version') or 0)
        if latest_record_version > 0:
            latest_version = self._encode_monotonic_version_token(latest_record_version)
        else:
            latest_version = latest_updated_ms
        return {
            "latest_version": int(latest_version),
            "latest_updated_ms": int(latest_updated_ms),
            "latest_record_version": int(latest_record_version),
            "latest_delete_version": int(latest_delete_version),
        }

    def _has_changes_since_version(
        self,
        *,
        since_version: Optional[int],
        version_state: Dict[str, int],
    ) -> bool:
        if since_version is None:
            return True
        try:
            since_value = int(since_version)
        except (TypeError, ValueError):
            return True
        if since_value == 0:
            return True
        if self._is_monotonic_version_token(since_value):
            return int(version_state["latest_record_version"]) > self._decode_monotonic_version_token(since_value)
        return int(version_state["latest_updated_ms"]) > since_value

    def _requires_full_reload_since_version(
        self,
        *,
        since_version: Optional[int],
        version_state: Dict[str, int],
    ) -> bool:
        if since_version is None:
            return False
        latest_delete_version = int(version_state.get("latest_delete_version") or 0)
        if latest_delete_version <= 0:
            return False
        try:
            since_value = int(since_version)
        except (TypeError, ValueError):
            return True
        if since_value == 0:
            return False
        if self._is_monotonic_version_token(since_value):
            return latest_delete_version > self._decode_monotonic_version_token(since_value)
        return True

    def _filter_queryset_since_version(self, queryset: QuerySet, since_version: int) -> QuerySet:
        """
        按 since_version 过滤增量记录。

        - 新 token（base+version）走 version__gt
        - 旧时间戳 token 走 updated_at__gt
        """
        try:
            since_value = int(since_version)
        except (TypeError, ValueError):
            return queryset

        if self._is_monotonic_version_token(since_value):
            return queryset.filter(version__gt=self._decode_monotonic_version_token(since_value))

        try:
            since_datetime = datetime.fromtimestamp(
                since_value / 1000,
                tz=timezone.get_current_timezone(),
            )
        except (OSError, OverflowError, ValueError):
            return queryset.none()

        return queryset.filter(updated_at__gt=since_datetime)

    def list_records(
        self,
        table_id: UUID,
        page: int = 1,
        page_size: int = 100,
        search: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        sort_by: Optional[str] = None,
        sort_order: str = 'asc',
        since_version: Optional[int] = None,
        only_delta: bool = False,
        field_key_type: str = 'name',
        rls_context=None,
        cursor_value: Optional[float] = None,
        cursor_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        获取表格的记录列表（支持分页、搜索、过滤、排序、增量同步）

        Args:
            table_id: 表格ID
            page: 页码（从1开始）
            page_size: 每页记录数
            search: 搜索关键词（在所有文本字段中搜索）
            filters: 过滤条件，格式：{"field_name": "value", ...}
            sort_by: 排序字段名
            sort_order: 排序方向（asc/desc）
            since_version: 客户端已同步的最新版本号
            only_delta: 是否仅返回增量数据
            field_key_type: 字段 key 类型（name / id / dbFieldName）
            rls_context: RLS 运行时上下文（可选，用于行级安全过滤）
            cursor_value: keyset 分页游标 — 上一页最后一行的 __order 值。
                当深页 (page > KEYSET_PAGE_THRESHOLD) 且默认排序时自动启用。
                传入后忽略 page/offset，性能从 O(offset+limit) 降至 O(limit)。
            cursor_id: keyset 分页游标 — 上一页最后一行的 __id（可选，
                用于 __order 相同时精确去重）。

        Returns:
            包含记录、总数、版本信息的字典。keyset 模式下额外返回
            ``next_cursor_value`` / ``next_cursor_id`` 供下次请求使用。
        """
        if not self.check_table_permission(str(table_id), 'viewer'):
            return {"records": [], "total": 0, "matched_total": 0, "latest_version": 0, "has_changes": False}

        # 统一分页边界，防止服务层被绕过时出现超限参数
        page = max(DEFAULT_PAGE, int(page or DEFAULT_PAGE))
        page_size = max(1, min(MAX_PAGE_SIZE, int(page_size or DEFAULT_PAGE_SIZE)))

        # ── 原生列读取路径（Phase 3D: 唯一路径）──
        return self._list_records_native(
            table_id,
            page=page,
            page_size=page_size,
            search=search,
            filters=filters,
            sort_by=sort_by,
            sort_order=sort_order,
            since_version=since_version,
            only_delta=only_delta,
            field_key_type=field_key_type,
            rls_context=rls_context,
            cursor_value=cursor_value,
            cursor_id=cursor_id,
        )

    def get_record(self, record_id: UUID) -> Optional[TableRecord]:
        """
        获取记录 ORM 对象（仅用于内部逻辑，如 update/delete）。

        注意：Phase 3D 后 record.data 可能为空 {}，
        如需序列化数据请使用 get_record_data()。

        Args:
            record_id: 记录ID

        Returns:
            TableRecord: 记录对象，如果无权限则返回None
        """
        try:
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id, is_deleted=False)

            # 检查表格权限
            if not self.check_table_permission(str(record.table_id), 'viewer'):
                return None

            return record
        except TableRecord.DoesNotExist:
            return None

    def get_record_data(
        self,
        record_id: UUID,
        *,
        fields: Optional[Set[str]] = None,
        field_key_type: str = 'name',
        rls_context=None,
    ) -> Optional[Dict[str, Any]]:
        """
        获取记录详情（序列化后的 API 格式数据）。

        Phase 3D: 从原生列读取，返回与 serialize_record() 格式一致的 dict。

        Args:
            record_id: 记录 UUID
            fields: 字段过滤集合（字段名称），None 表示全部
            field_key_type: 字段 key 类型（name / id）
            rls_context: RLS 运行时上下文（可选，用于行级安全过滤）

        Returns:
            序列化后的记录字典，或 None（记录不存在 / 无权限）
        """
        return self._get_record_native(
            record_id,
            fields_filter=fields,
            field_key_type=field_key_type,
            rls_context=rls_context,
        )

    def _ensure_select_choices_from_data(
        self,
        fields: List[TableField],
        records_data: Iterable[Dict[str, Any]],
        *,
        persist: bool = True,
    ) -> Dict[str, List[str]]:
        """把写入数据里出现的 select/multi_select 值并入字段 options.choices。

        Agent 建表时常只声明 field_type=select 而不传 choices；写记录后下拉与
        字段设置仍为空。写路径在校验前先补齐内存配置，保证校验可通过；调用方
        可延后数据库持久化，以便先完成乐观锁检查。
        """
        select_fields = [f for f in fields if f.field_type in ('select', 'multi_select')]
        if not select_fields:
            return {}

        records = [data for data in (records_data or []) if data]
        if not records:
            return {}

        field_name_map, field_id_map, field_db_field_name_map = self._build_field_input_maps(
            select_fields
        )
        values_by_field_id: Dict[str, List[str]] = {str(f.id): [] for f in select_fields}

        for data in records:
            for key, value in data.items():
                field = (
                    field_name_map.get(str(key))
                    or field_id_map.get(str(key))
                    or field_db_field_name_map.get(str(key))
                )
                if not field:
                    continue
                values_by_field_id[str(field.id)].extend(
                    iter_select_cell_values(value, field.field_type)
                )

        dirty: List[TableField] = []
        now = timezone.now()
        for field in select_fields:
            new_values = values_by_field_id.get(str(field.id)) or []
            if not new_values:
                continue
            options = dict(field.config or {})
            existing = options.get('choices') or []
            existing_values = extract_choice_values(existing)
            if all(v in existing_values for v in new_values):
                continue
            options['choices'] = merge_select_choice_values(
                existing,
                new_values,
                max_options=MAX_OPTIONS_COUNT,
            )
            field.config = options
            field.updated_at = now
            dirty.append(field)

        if dirty and persist:
            TableField.objects.using(TABDATA_DB_ALIAS).bulk_update(
                dirty, ['config', 'updated_at']
            )

        return {
            field_id: values
            for field_id, values in values_by_field_id.items()
            if values
        }

    def _validate_record_data(self, table_id: UUID, data: Dict[str, Any], _preloaded_fields=None) -> Tuple[bool, Optional[str]]:
        """
        验证记录数据

        Args:
            table_id: 表格ID
            data: 记录数据
            _preloaded_fields: 预加载的字段列表，传入时跳过内部查询

        Returns:
            tuple: (是否有效, 错误信息)
        """
        if _preloaded_fields is not None:
            fields_list = _preloaded_fields
        else:
            fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False
            )
            fields_list = list(fields)
        field_name_map, field_id_map, field_db_field_name_map = self._build_field_input_maps(fields_list)
        data = data or {}

        # 非空输入必须至少命中一个已知字段，避免「success 但格子全空」的静默空写。
        if data:
            matched_count = 0
            unknown_keys: List[str] = []
            for field_name in data.keys():
                normalized_key = str(field_name)
                field = (
                    field_name_map.get(normalized_key)
                    or field_id_map.get(normalized_key)
                    or field_db_field_name_map.get(normalized_key)
                )
                if field:
                    matched_count += 1
                else:
                    unknown_keys.append(normalized_key)
            if matched_count == 0:
                available = [
                    f.name for f in fields_list
                    if not getattr(f, 'is_hidden', False)
                ][:20]
                unknown_preview = ', '.join(unknown_keys[:10])
                if len(unknown_keys) > 10:
                    unknown_preview = f"{unknown_preview} 等{len(unknown_keys)}个"
                available_preview = ', '.join(available) if available else '(无可用字段)'
                return False, (
                    f"无有效字段匹配（输入 key 均不在表字段中）。"
                    f"未知: {unknown_preview}；可用字段: {available_preview}"
                )

        # 验证每个字段的数据类型
        for field_name, value in data.items():
            normalized_key = str(field_name)
            field = (
                field_name_map.get(normalized_key)
                or field_id_map.get(normalized_key)
                or field_db_field_name_map.get(normalized_key)
            )
            if not field:
                # 跳过未定义的字段（允许额外字段，上方已拦截「全部未命中」）
                continue

            # 系统托管字段由系统管理，忽略用户输入。
            if field.field_type in SYSTEM_MANAGED_FIELD_TYPES:
                continue
            if (field.default_value or {}).get('mode') == 'last_modified_time':
                continue

            # 验证字段类型
            if not validate_field_value(field.field_type, value, field.config):
                label = get_field_type_label(field.field_type)
                return False, f"字段 '{field.name}' 格式不符：{label}类型不支持此值"

            # 验证自定义规则
            rules = dict(field.validation_rules or {})
            is_valid, rule_error = validate_with_rules(rules, value)
            if not is_valid:
                if rule_error:
                    return False, f"字段 '{field.name}' 校验失败: {rule_error}"
                return False, f"字段 '{field.name}' 未通过验证规则"

        return True, None

    def _check_record_quota(self, table_id: UUID, increment: int, _preloaded_table: Optional[Table] = None) -> None:
        """
        检查单表记录数配额（按 organization 主体）。
        """
        table = _preloaded_table or Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
        if not table:
            raise ValueError("表格不存在")

        current_usage = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False).count()

        QuotaService().check_quota(
            quota_type="max_records_per_table",
            increment=max(1, int(increment or 1)),
            current_usage=current_usage,
            organization_id=str(table.organization_id) if table.organization_id else None,
            actor=self.user,
        )

    def create_record(
        self,
        table_id: UUID,
        data: Dict[str, Any],
        order_context: Optional[Dict[str, Any]] = None,
        operation_group_id: Optional[UUID] = None,
        rls_context=None,
        skip_side_effects: bool = False,
        default_actor_id: Any = _DEFAULT_ACTOR_UNSET,
    ) -> Tuple[Optional[TableRecord], Optional[str]]:
        """
        创建记录

        Args:
            table_id: 表格ID
            data: 记录数据
            order_context: 插入顺序上下文（before/after/end）
        Returns:
            tuple: (创建的记录, 错误信息)

        Raises:
            PermissionError: 无权限操作
        """
        # ── Facade 前置检查（权限 / 配额 / RLS）──
        if not self.check_table_permission(str(table_id), 'editor'):
            raise PermissionError("无权限")

        if not self.user:
            raise ValueError("用户未登录")

        table_obj = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        assert_organization_resource_write_allowed_optional(table_obj.organization_id)

        self._check_record_quota(table_id=table_id, increment=1, _preloaded_table=table_obj)

        data = self._fix_unicode_surrogates(data)

        fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False))
        select_choice_values = self._ensure_select_choices_from_data(
            fields,
            [data],
            persist=False,
        )

        is_valid, error_msg = self._validate_record_data(
            table_id, data,
            _preloaded_fields=fields,
        )
        if not is_valid:
            return None, error_msg

        formatted_for_pre = self._format_record_data(data, fields=fields, skip_system_managed_inputs=True)
        from apps.tabdata.utils.default_values import apply_record_defaults
        resolved_default_actor_id = (
            str(self.user.id)
            if default_actor_id is _DEFAULT_ACTOR_UNSET
            else default_actor_id
        )
        apply_record_defaults(
            formatted_for_pre,
            fields,
            is_create=True,
            actor_id=resolved_default_actor_id,
        )

        # RLS INSERT WITH CHECK（使用格式化后的数据）
        if rls_context is not None:
            if table_obj.rls_enabled:
                should_apply = rls_context.is_token_auth if not table_obj.rls_force else True
                if should_apply:
                    from apps.tabdata.services.rls_service import rls_service
                    if not rls_service.check_rls_for_write(
                        table_id=table_id,
                        operation='INSERT',
                        context=rls_context,
                        record_data=formatted_for_pre,
                    ):
                        from apps.tabdata.exceptions import RLSAccessDenied
                        raise RLSAccessDenied("Record data violates row-level security policy")

        new_order, order_error = self._resolve_record_order(
            table_id=table_id,
            order_context=order_context,
        )
        if order_error:
            return None, order_error
        if new_order is None:
            return None, "无法为新记录分配顺序"

        # ── 构建 Context 委托 Handler ──
        from apps.tabdata.domain.value_objects import RecordCommandContext
        from apps.tabdata.handlers import RecordHandlerFactory

        skip_flags = {'all_side_effects': True} if skip_side_effects else None

        context = RecordCommandContext(
            table_id=table_id,
            data=formatted_for_pre,
            user_id=str(self.user.id),
            order_context=order_context,
            operation_group_id=operation_group_id,
            skip_flags=skip_flags,
            resolved_order_value=new_order,
            select_choice_values=select_choice_values or None,
        )

        handler = RecordHandlerFactory.create_handler(user=self.user)
        snapshot, error = handler.handle(context)

        if error:
            return None, error

        try:
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=snapshot.id)
        except TableRecord.DoesNotExist:
            return None, "记录创建后无法检索"

        if snapshot.version and snapshot.version > 0:
            _invalidate_table_collab_version(UUID(str(table_id)), snapshot.version)

        return record, None

    def update_record(
        self,
        record_id: UUID,
        data: Dict[str, Any],
        operation_group_id: Optional[UUID] = None,
        _skip_ws_notification: bool = False,
        _preloaded_fields: Optional[List] = None,
        _skip_ydoc_sync: bool = False,
        rls_context=None,
        share_grant=None,
        expected_version: Optional[int] = None,
    ) -> Tuple[Optional[TableRecord], Optional[str]]:
        """
        更新记录

        Args:
            record_id: 记录ID
            data: 更新的数据
            _skip_ws_notification: 内部参数，批量更新时跳过单条 WS 通知
            _preloaded_fields: 内部参数，批量更新时预加载的字段列表，避免 N+1
            rls_context: RLS 运行时上下文（可选，用于行级安全检查）

        Returns:
            tuple: (更新后的记录, 错误信息)

        Raises:
            PermissionError: 无权限操作
            TableRecord.DoesNotExist: 记录不存在
        """
        try:
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id, is_deleted=False)

            if not self.check_table_permission(
                str(record.table_id), 'editor',
            ) and not self._share_grant_allows_edit(share_grant, record.table_id):
                raise PermissionError("无权限")

            table_obj = Table.objects.using(TABDATA_DB_ALIAS).get(id=record.table_id)
            assert_organization_resource_write_allowed_optional(table_obj.organization_id)

            # ── RLS UPDATE 行级安全检查 ──
            if rls_context is not None and table_obj.rls_enabled:
                should_apply = rls_context.is_token_auth if not table_obj.rls_force else True
                if should_apply:
                    from apps.tabdata.services.rls_service import rls_service
                    existing_data = read_data(record)
                    if not rls_service.check_rls_for_write(
                        table_id=table_obj.id,
                        operation='UPDATE',
                        context=rls_context,
                        record_data=existing_data,
                    ):
                        from apps.tabdata.exceptions import RLSAccessDenied
                        raise RLSAccessDenied("Record data violates row-level security policy")

            data = dict(data)
            raw_data = copy.deepcopy(data)

            fields = _preloaded_fields or list(
                TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=record.table_id, is_deleted=False,
                )
            )

            from apps.tabdata.services.field_visibility import reject_invisible_field_writes

            visibility_write_err = reject_invisible_field_writes(
                data,
                user=self.user,
                table=table_obj,
                fields=fields,
                share=share_grant,
            )
            if visibility_write_err:
                return None, visibility_write_err

            select_choice_values = self._ensure_select_choices_from_data(
                fields,
                [data],
                persist=False,
            )

            blocked_keys = self._find_system_managed_input_keys(data, fields)
            if blocked_keys:
                return None, f"系统托管字段不可编辑: {', '.join(blocked_keys)}"

            is_valid, error_msg = self._validate_record_data(
                record.table_id, data, _preloaded_fields=fields,
            )
            if not is_valid:
                return None, error_msg

            data = self._format_record_data(data, fields=fields, skip_system_managed_inputs=True)
            from apps.tabdata.utils.default_values import apply_record_defaults
            apply_record_defaults(
                data,
                fields,
                is_create=False,
                actor_id=str(self.user.id) if self.user else None,
            )

            if rls_context is not None and table_obj.rls_enabled:
                should_apply = rls_context.is_token_auth if not table_obj.rls_force else True
                if should_apply:
                    from apps.tabdata.services.rls_service import rls_service
                    prospective_data = dict(read_data(record) or {})
                    prospective_data.update(data)
                    if not rls_service.check_rls_for_write(
                        table_id=table_obj.id,
                        operation='UPDATE',
                        context=rls_context,
                        record_data=prospective_data,
                    ):
                        from apps.tabdata.exceptions import RLSAccessDenied
                        raise RLSAccessDenied("Record data violates row-level security policy")

            # ── 构建 Context 委托 Handler ──
            from apps.tabdata.domain.value_objects import RecordCommandContext
            from apps.tabdata.handlers import RecordHandlerFactory

            skip_flags: Dict[str, bool] = {}
            if _skip_ws_notification:
                skip_flags['ws_notification'] = True
            if _skip_ydoc_sync:
                skip_flags['ydoc_sync'] = True

            context = RecordCommandContext(
                table_id=record.table_id,
                record_id=UUID(str(record_id)),
                data=data,
                raw_data=raw_data,
                user_id=str(self.user.id) if self.user else None,
                operation_group_id=operation_group_id,
                skip_flags=skip_flags or None,
                expected_version=expected_version,
                select_choice_values=select_choice_values or None,
            )

            handler = RecordHandlerFactory.update_handler(user=self.user)
            snapshot, error = handler.handle(context)

            if error:
                return None, error
            if snapshot is None:
                # delete-wins：handler 在事务内发现记录生命周期已经结束时，
                # 不能把 ``(None, None)`` 继续交给 API 序列化（会变成 500）。
                # 复用既有 validation error 契约，让旧客户端也能安全结束本次更新。
                tombstone = (
                    TableRecord.objects.using(TABDATA_DB_ALIAS)
                    .select_related("updated_by")
                    .filter(id=record_id, is_deleted=True)
                    .first()
                )
                deleted_by = getattr(tombstone, "updated_by", None)
                deleted_by_name = (
                    deleted_by.get_display_name() or "其他协作者"
                    if deleted_by is not None
                    else "其他协作者"
                )
                return (
                    None,
                    f"该记录已被{deleted_by_name}删除，您刚才的修改未保存",
                )

            try:
                updated_record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=snapshot.id)
            except TableRecord.DoesNotExist:
                return None, "记录更新后无法检索"

            if snapshot.version and snapshot.version > 0:
                _invalidate_table_collab_version(UUID(str(record.table_id)), snapshot.version)

            return updated_record, None

        except TableRecord.DoesNotExist:
            raise

    @staticmethod
    def _share_grant_allows_edit(share_grant, table_id: UUID) -> bool:
        """分享链接只授予当前表的记录内容编辑权，不提升为协作者权限。"""
        if share_grant is None:
            return False
        if getattr(share_grant, "permission", None) != "edit":
            return False
        if not getattr(share_grant, "is_active", True):
            return False
        if getattr(share_grant, "share_type", None) == "form":
            return False
        return str(getattr(share_grant, "table_id", "")) == str(table_id)

    def delete_record(
        self,
        record_id: UUID,
        operation_group_id: Optional[UUID] = None,
        _skip_ydoc_sync: bool = False,
        _skip_table_event_publish: bool = False,
        rls_context=None,
        expected_version: Optional[int] = None,
    ) -> bool:
        """
        删除记录（不可恢复）

        Args:
            record_id: 记录ID
            rls_context: RLS 运行时上下文（可选，用于行级安全检查）
            expected_version: 调用方读取到的记录版本；不传时保持旧版无条件删除

        Returns:
            bool: 是否删除成功
        """
        try:
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id, is_deleted=False)

            if not self.check_table_permission(str(record.table_id), 'editor'):
                return False

            table_obj = Table.objects.using(TABDATA_DB_ALIAS).only(
                'id', 'organization_id', 'rls_enabled', 'rls_force',
            ).get(id=record.table_id)
            assert_organization_resource_write_allowed_optional(table_obj.organization_id)

            # ── RLS DELETE 行级安全检查 ──
            if rls_context is not None:
                if table_obj.rls_enabled:
                    should_apply = rls_context.is_token_auth if not table_obj.rls_force else True
                    if should_apply:
                        from apps.tabdata.services.rls_service import rls_service
                        existing_data = read_data(record)
                        if not rls_service.check_rls_for_write(
                            table_id=table_obj.id,
                            operation='DELETE',
                            context=rls_context,
                            record_data=existing_data,
                        ):
                            return False

            # ── 构建 Context 委托 Handler ──
            from apps.tabdata.domain.value_objects import RecordCommandContext
            from apps.tabdata.handlers import RecordHandlerFactory

            skip_flags: Dict[str, bool] = {}
            if _skip_ydoc_sync:
                skip_flags['ydoc_sync'] = True
            if _skip_table_event_publish:
                skip_flags['table_event'] = True

            context = RecordCommandContext(
                table_id=record.table_id,
                record_id=UUID(str(record_id)),
                user_id=str(self.user.id) if self.user else None,
                operation_group_id=operation_group_id,
                skip_flags=skip_flags or None,
                expected_version=expected_version,
            )

            handler = RecordHandlerFactory.delete_handler(user=self.user)

            def _is_already_deleted() -> bool:
                return not TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id=record_id,
                ).exists()

            try:
                success = handler.handle(context)
            except RecordVersionConflictError:
                # 若另一请求已经完成删除，本次重复 DELETE 保持幂等成功。
                if not _is_already_deleted():
                    raise
                success = True
            else:
                # 另一请求也可能在外层预读与 Handler 读取之间提交，此时
                # Handler 返回 False 而不是抛版本冲突。
                if not success and _is_already_deleted():
                    success = True

            if success:
                try:
                    table_version = Table.objects.using(TABDATA_DB_ALIAS).filter(
                        id=record.table_id,
                    ).values_list('record_version_seq', flat=True).first()
                    if table_version:
                        _invalidate_table_collab_version(
                            UUID(str(record.table_id)), int(table_version),
                        )
                except Exception:
                    pass

            return success

        except TableRecord.DoesNotExist:
            # ：活跃行已不存在 → 幂等成功，便于前端清投影
            return True

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def bulk_create_records(
        self,
        table_id: UUID,
        records_data: List[Dict[str, Any]],
        record_ids: Optional[List[Optional[str]]] = None,
        field_key_type: str = 'name',
        order_context: Optional[Dict[str, Any]] = None,
        operation_group_id: Optional[UUID] = None,
        rls_context=None,
    ) -> Tuple[List[TableRecord], List[str]]:
        """
        批量创建记录

        Args:
            table_id: 表格ID
            records_data: 记录数据列表
            record_ids: 客户端指定的记录 ID 列表（与 records_data 等长），
                        每项为 UUID 字符串或 None；为 None 时由服务端生成
            field_key_type: 字段 key 类型（name / id / dbFieldName）
            order_context: 批量创建共用的插入顺序上下文
            operation_group_id: 操作组ID；为空时服务端自动生成

        Returns:
            tuple: (创建的记录列表, 错误信息列表)
        """
        # ── Facade 前置检查 ──
        if not self.check_table_permission(str(table_id), 'editor'):
            raise PermissionError("无权限")

        if not self.user:
            raise ValueError("用户未登录")

        table_for_control = Table.objects.using(TABDATA_DB_ALIAS).only(
            'id', 'organization_id',
        ).get(id=table_id)
        assert_organization_resource_write_allowed_optional(table_for_control.organization_id)

        if not records_data:
            errors = ["批量创建记录不能为空"]
            self._set_last_bulk_operation_stats(
                self._build_bulk_operation_stats(
                    total_count=0,
                    processed_count=0,
                    failed_count=len(errors),
                    batches_completed=0,
                )
            )
            return [], errors

        self._check_record_quota(table_id=table_id, increment=len(records_data))

        total_count = len(records_data)
        if total_count > MAX_BULK_RECORDS:
            raise ValueError(f"批量创建记录单次最多支持 {MAX_BULK_RECORDS} 条")

        # -- 校验客户端指定的 record_ids --
        safe_ids = record_ids or []
        parsed_client_ids: List[Optional[uuid.UUID]] = [None] * total_count
        seen_client_ids: set = set()
        for ci_idx, raw_id in enumerate(safe_ids[:total_count]):
            if raw_id is None:
                continue
            try:
                cid = uuid.UUID(str(raw_id))
            except (ValueError, AttributeError):
                errors_pre = [f"第{ci_idx+1}条: id '{raw_id}' 不是有效的 UUID 格式"]
                self._set_last_bulk_operation_stats(
                    self._build_bulk_operation_stats(
                        total_count=total_count, processed_count=0,
                        failed_count=1, batches_completed=0,
                    )
                )
                return [], errors_pre
            if cid in seen_client_ids:
                errors_pre = [f"第{ci_idx+1}条: id '{raw_id}' 在批量请求中重复"]
                self._set_last_bulk_operation_stats(
                    self._build_bulk_operation_stats(
                        total_count=total_count, processed_count=0,
                        failed_count=1, batches_completed=0,
                    )
                )
                return [], errors_pre
            seen_client_ids.add(cid)
            parsed_client_ids[ci_idx] = cid

        if seen_client_ids:
            existing_ids = set(
                TableRecord.objects.using(TABDATA_DB_ALIAS)
                .filter(table_id=table_id, id__in=seen_client_ids)
                .values_list('id', flat=True)
            )
            if existing_ids:
                dup_str = ', '.join(str(x) for x in existing_ids)
                errors_pre = [f"以下 id 在表中已存在: {dup_str}"]
                self._set_last_bulk_operation_stats(
                    self._build_bulk_operation_stats(
                        total_count=total_count, processed_count=0,
                        failed_count=1, batches_completed=0,
                    )
                )
                return [], errors_pre

        errors: List[str] = []
        resolved_operation_group_id = operation_group_id or uuid.uuid4()
        self.last_bulk_field_warnings: List[str] = []

        fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False))
        select_choice_values = self._ensure_select_choices_from_data(
            fields,
            records_data,
            persist=False,
        )

        # ── RLS INSERT WITH CHECK（预加载表元数据）──
        _rls_check_fn = None
        if rls_context is not None:
            try:
                _rls_table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            except Table.DoesNotExist:
                _rls_table = None
            if _rls_table and _rls_table.rls_enabled:
                should_apply = rls_context.is_token_auth if not _rls_table.rls_force else True
                if should_apply:
                    from apps.tabdata.services.rls_service import rls_service as _rls_svc
                    _rls_check_fn = lambda rd: _rls_svc.check_rls_for_write(
                        table_id=table_id, operation='INSERT',
                        context=rls_context, record_data=rd,
                    )

        # 逐条验证 + 格式化 + RLS 过滤
        prepared_data: List[Dict[str, Any]] = []
        client_ids_for_prepared: List = []
        unknown_keys_seen: Set[str] = set()

        for idx, data in enumerate(records_data):
            is_valid, error_msg = self._validate_record_data(table_id, data, _preloaded_fields=fields)
            if not is_valid:
                errors.append(f"第{idx+1}条: {error_msg}")
                continue

            for key in self._collect_unknown_field_keys(data, fields):
                unknown_keys_seen.add(key)

            formatted = self._format_record_data(data, fields=fields, skip_system_managed_inputs=True)
            from apps.tabdata.utils.default_values import apply_record_defaults
            apply_record_defaults(
                formatted,
                fields,
                is_create=True,
                actor_id=str(self.user.id),
            )
            if _rls_check_fn is not None and not _rls_check_fn(formatted):
                errors.append(f"第{idx+1}条: Record data violates row-level security policy")
                continue

            prepared_data.append(formatted)
            client_ids_for_prepared.append(parsed_client_ids[idx])

        if unknown_keys_seen:
            self.last_bulk_field_warnings = [
                f'未知字段已忽略: {k}' for k in sorted(unknown_keys_seen)
            ]

        if not prepared_data:
            self._set_last_bulk_operation_stats(
                self._build_bulk_operation_stats(
                    total_count=total_count, processed_count=total_count,
                    failed_count=len(errors), batches_completed=0,
                )
            )
            return [], errors

        # 排序值解析
        record_orders, order_error = self._resolve_bulk_record_orders(
            table_id=table_id, count=len(prepared_data), order_context=order_context,
        )
        if order_error:
            raise ValueError(order_error)

        # ── 构建 Context 委托 Handler ──
        from apps.tabdata.domain.value_objects import RecordCommandContext
        from apps.tabdata.handlers import RecordHandlerFactory

        context = RecordCommandContext(
            table_id=table_id,
            records_data=prepared_data,
            user_id=str(self.user.id),
            field_key_type=field_key_type,
            order_context=order_context,
            operation_group_id=resolved_operation_group_id,
            resolved_order_values=record_orders,
            client_record_ids_list=client_ids_for_prepared or None,
            select_choice_values=select_choice_values or None,
        )

        handler = RecordHandlerFactory.batch_create_handler(user=self.user)
        snapshots, handler_errors = handler.handle(context)
        errors.extend(handler_errors)

        # 转换 RecordSnapshot → TableRecord
        created_records: List[TableRecord] = []
        if snapshots:
            records_map = {
                r.id: r
                for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=[s.id for s in snapshots],
                )
            }
            for s in snapshots:
                rec = records_map.get(s.id)
                if rec:
                    created_records.append(rec)

            max_ver = max((s.version for s in snapshots if s.version), default=0)
            if max_ver > 0:
                _invalidate_table_collab_version(UUID(str(table_id)), max_ver)

        self._set_last_bulk_operation_stats(
            self._build_bulk_operation_stats(
                total_count=total_count,
                processed_count=total_count,
                failed_count=len(errors),
                batches_completed=1,
            )
        )

        return created_records, errors

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def bulk_update_records(
        self,
        record_updates: List[Dict[str, Any]],
        operation_group_id: Optional[UUID] = None,
        rls_context=None,
    ) -> Tuple[List[TableRecord], List[str]]:
        """
        批量更新记录 — 部分成功语义。

        外层 @transaction.atomic 保证基础设施级一致性（DB 连接断开等极端
        情况整体回滚）。内部对每条记录使用 savepoint，单条失败时 rollback
        到 savepoint 并记录错误，不影响其余记录的提交。

        Args:
            record_updates: 更新列表，格式:[{"record_id": "uuid", "data": {...}}, ...]
            rls_context: RLS 运行时上下文（可选，用于行级安全检查）

        Returns:
            tuple: (成功更新的记录列表, 错误信息列表)
        """
        from apps.i18n import _ as _i18n

        if not record_updates:
            errors = [_i18n("tabdata.batch_update_records_empty")]
            self._set_last_bulk_operation_stats(
                self._build_bulk_operation_stats(
                    total_count=0, processed_count=0,
                    failed_count=len(errors), batches_completed=0,
                )
            )
            return [], errors

        total_count = len(record_updates)
        if total_count > MAX_BULK_RECORDS:
            raise ValueError(_i18n("tabdata.bulk_size_exceeded", max_size=MAX_BULK_RECORDS))

        errors: List[str] = []
        resolved_operation_group_id = operation_group_id or uuid.uuid4()

        # ── Phase 1: 批量预加载 + 权限 / RLS 过滤 ──
        valid_ids: List[UUID] = []
        for item in record_updates:
            rid = item.get('record_id')
            if rid:
                try:
                    valid_ids.append(UUID(rid))
                except (ValueError, AttributeError):
                    pass

        records_map: Dict[UUID, TableRecord] = {}
        if valid_ids:
            records_map = {
                r.id: r
                for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=valid_ids, is_deleted=False,
                )
            }

        table_ids = set(r.table_id for r in records_map.values())
        permitted_tables: set = set()
        for tid in table_ids:
            if self.check_table_permission(str(tid), 'editor'):
                permitted_tables.add(tid)

        _tables_cache: Dict[UUID, Table] = {
            t.id: t
            for t in Table.objects.using(TABDATA_DB_ALIAS).filter(id__in=table_ids).only(
                'id', 'organization_id', 'rls_enabled', 'rls_force',
            )
        }
        if table_ids:
            for org_id in (
                Table.objects.using(TABDATA_DB_ALIAS)
                .filter(id__in=permitted_tables)
                .values_list('organization_id', flat=True)
                .distinct()
            ):
                assert_organization_resource_write_allowed_optional(org_id)

        # 逐条过滤：权限 + RLS
        table_groups: Dict[UUID, List[Dict[str, Any]]] = {}
        for idx, item in enumerate(record_updates):
            record_id = item.get('record_id')
            if not record_id:
                errors.append(_i18n("tabdata.batch_update_record_missing_id", row_no=idx + 1))
                continue
            try:
                rid = UUID(record_id)
            except (ValueError, AttributeError):
                errors.append(_i18n("tabdata.batch_update_invalid_record_id", row_no=idx + 1))
                continue

            record = records_map.get(rid)
            if record is None or record.table_id not in permitted_tables:
                errors.append(_i18n("tabdata.batch_update_record_not_found_or_no_permission", row_no=idx + 1))
                continue

            if rls_context is not None:
                table_obj = _tables_cache.get(record.table_id)
                if table_obj is None:
                    continue
                if table_obj.rls_enabled:
                    should_apply = rls_context.is_token_auth if not table_obj.rls_force else True
                    if should_apply:
                        from apps.tabdata.services.rls_service import rls_service
                        existing_data = read_data(record)
                        if not rls_service.check_rls_for_write(
                            table_id=table_obj.id, operation='UPDATE',
                            context=rls_context, record_data=existing_data,
                        ):
                            errors.append(_i18n("tabdata.batch_update_rls_denied", row_no=idx + 1))
                            continue

            table_groups.setdefault(record.table_id, []).append(item)

        if not table_groups:
            self._set_last_bulk_operation_stats(
                self._build_bulk_operation_stats(
                    total_count=total_count, processed_count=total_count,
                    failed_count=len(errors), batches_completed=0,
                )
            )
            return [], errors

        # ── Phase 2: 按表分组委托 Handler ──
        from apps.tabdata.domain.value_objects import RecordCommandContext
        from apps.tabdata.handlers import RecordHandlerFactory

        all_snapshots = []
        for tid, group_items in table_groups.items():
            table_fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=tid, is_deleted=False,
                )
            )
            select_choice_values = self._ensure_select_choices_from_data(
                table_fields,
                [item.get('data') or {} for item in group_items],
                persist=False,
            )
            validated_items: List[Dict[str, Any]] = []
            for item in group_items:
                raw_data = copy.deepcopy(item.get('data', {}))
                # 系统托管字段永不可写，下游
                # _format_record_data(skip_system_managed_inputs=True) 本就会剥离它们。
                # 历史实现一旦发现 patch 含这类 key 就整条拒绝——但编辑对话框（ 修复
                # 后）回填会原样带回未改动的系统字段，整条回传时用户真正改动的业务字段
                # 被连坐丢弃（「输入的值没更新到表格」的后端根因）。改为静默剔除系统托管
                # key、继续提交其余字段，从根上消除「整条被拒」，且不影响「系统字段不落库」
                # 这一既有保证。
                blocked_keys = self._find_system_managed_input_keys(raw_data, table_fields)
                if blocked_keys:
                    blocked_set = set(blocked_keys)
                    raw_data = {k: v for k, v in raw_data.items() if str(k) not in blocked_set}
                is_valid, error_msg = self._validate_record_data(
                    tid, raw_data, _preloaded_fields=table_fields,
                )
                if not is_valid:
                    errors.append(_i18n(
                        "tabdata.batch_update_record_failed",
                        row_no=item.get('record_id'),
                        detail=error_msg or "",
                    ))
                    continue
                formatted_item = self._format_record_data(
                    raw_data, fields=table_fields, skip_system_managed_inputs=True,
                )
                from apps.tabdata.utils.default_values import apply_record_defaults
                apply_record_defaults(
                    formatted_item,
                    table_fields,
                    is_create=False,
                    actor_id=str(self.user.id) if self.user else None,
                )
                if rls_context is not None:
                    table_obj = _tables_cache.get(tid)
                    should_apply = bool(
                        table_obj
                        and table_obj.rls_enabled
                        and (rls_context.is_token_auth if not table_obj.rls_force else True)
                    )
                    if should_apply:
                        from apps.tabdata.services.rls_service import rls_service
                        record = records_map.get(UUID(str(item.get('record_id'))))
                        prospective_data = dict(read_data(record) or {}) if record else {}
                        prospective_data.update(formatted_item)
                        if not rls_service.check_rls_for_write(
                            table_id=tid,
                            operation='UPDATE',
                            context=rls_context,
                            record_data=prospective_data,
                        ):
                            errors.append(_i18n(
                                "tabdata.batch_update_rls_denied",
                                row_no=item.get('record_id'),
                            ))
                            continue
                validated_item = dict(item)
                validated_item['data'] = formatted_item
                # 锁外校验只提供快速反馈；Handler 等到 Table/Record 锁后必须
                # 用这份未格式化请求按最新 schema 再校验、再格式化。
                validated_item['raw_data'] = raw_data
                validated_items.append(validated_item)

            if not validated_items:
                continue

            context = RecordCommandContext(
                table_id=tid,
                records_data=validated_items,
                user_id=str(self.user.id) if self.user else None,
                operation_group_id=resolved_operation_group_id,
                select_choice_values=select_choice_values or None,
            )
            handler = RecordHandlerFactory.batch_update_handler(user=self.user)
            snapshots, handler_errors = handler.handle(context)
            all_snapshots.extend(snapshots)
            errors.extend(handler_errors)

        # ── Phase 3: 转换 RecordSnapshot → TableRecord ──
        updated_records: List[TableRecord] = []
        if all_snapshots:
            fresh_map = {
                r.id: r
                for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=[s.id for s in all_snapshots],
                )
            }
            for s in all_snapshots:
                rec = fresh_map.get(s.id)
                if rec:
                    updated_records.append(rec)

        for tid in table_groups:
            try:
                table_version = Table.objects.using(TABDATA_DB_ALIAS).filter(
                    id=tid,
                ).values_list('record_version_seq', flat=True).first()
                if table_version:
                    _invalidate_table_collab_version(
                        UUID(str(tid)), int(table_version),
                    )
            except Exception:
                pass

        # ── Phase 4: 冲突感知（Advisory）——检测 base_snapshot 与预加载值的差异 ──
        conflicts: List[Dict[str, Any]] = []
        for item in record_updates:
            base_snapshot = item.get('base_snapshot')
            if not base_snapshot or not isinstance(base_snapshot, dict):
                continue
            rid_str = item.get('record_id')
            if not rid_str:
                continue
            try:
                rid = UUID(rid_str)
            except (ValueError, AttributeError):
                continue
            pre_record = records_map.get(rid)
            if pre_record is None:
                continue
            pre_data = read_data(pre_record)
            request_data = item.get('data', {})
            for field_id, base_val in base_snapshot.items():
                if field_id not in request_data:
                    continue
                pre_val = pre_data.get(field_id)
                if pre_val != base_val:
                    conflicts.append({
                        'record_id': rid_str,
                        'field_id': field_id,
                        'your_value': request_data[field_id],
                        'server_value': pre_val,
                    })

        self._set_last_bulk_operation_stats(
            self._build_bulk_operation_stats(
                total_count=total_count,
                processed_count=total_count,
                failed_count=len(errors),
                batches_completed=1,
            )
        )

        self._last_bulk_update_conflicts = conflicts
        return updated_records, errors

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def reorder_records(
        self,
        table_id: UUID,
        record_ids: List[UUID],
        *,
        anchor_record_id: Optional[UUID] = None,
        position: str = "end",
        view_id: Optional[UUID] = None,
        group_values: Optional[Dict[str, Any]] = None,
        rls_context=None,
    ) -> Tuple[List[TableRecord], List[str]]:
        """
        重排记录顺序（支持多条记录拖拽）。

        规则：
        - position=end: 追加到末尾
        - position=before|after: 相对锚点插入
        - group_values: 可选，同步更新被移动记录的分组字段值
        """
        normalized_position = str(position or "end").strip().lower()
        if normalized_position not in {"before", "after", "end"}:
            raise ValueError("position 仅支持 before/after/end")

        if not record_ids:
            raise ValueError("record_ids 不能为空")

        if len(record_ids) > MAX_BULK_RECORDS:
            raise ValueError(f"批量重排记录单次最多支持 {MAX_BULK_RECORDS} 条")

        # 预加载 Table 对象（后续原生列写入和权限检查都需要）
        try:
            table_obj = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        except Table.DoesNotExist:
            raise ValueError(f"表格不存在: {table_id}")

        # 检查权限（需要 editor 或 owner）
        if not self.check_table_permission(str(table_id), 'editor'):
            errors = ["无权限操作"]
            self._set_last_bulk_operation_stats(
                self._build_bulk_operation_stats(
                    total_count=len(record_ids),
                    processed_count=0,
                    failed_count=len(errors),
                    batches_completed=0,
                )
            )
            return [], errors

        # 去重并保持输入顺序，保证拖拽多选顺序可控
        ordered_unique_ids: List[UUID] = []
        seen_ids: Set[UUID] = set()
        for raw_id in record_ids:
            if raw_id in seen_ids:
                continue
            seen_ids.add(raw_id)
            ordered_unique_ids.append(raw_id)

        # 收集需锁定的 ID 集合：被移动记录 + 锚点记录（不再锁全表）
        ids_to_lock = set(ordered_unique_ids)
        if anchor_record_id:
            ids_to_lock.add(anchor_record_id)

        locked_records = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .select_for_update()
            .filter(table_id=table_id, is_deleted=False, id__in=ids_to_lock)
            .order_by('id')
        )
        locked_map = {record.id: record for record in locked_records}

        errors: List[str] = []
        moving_records: List[TableRecord] = []
        for idx, record_id in enumerate(ordered_unique_ids):
            record = locked_map.get(record_id)
            if not record:
                errors.append(f"第{idx + 1}条: 记录不存在或不属于当前表格")
                continue
            moving_records.append(record)

        if rls_context is not None and table_obj.rls_enabled:
            should_apply = rls_context.is_token_auth if not table_obj.rls_force else True
            if should_apply:
                from apps.tabdata.services.rls_service import rls_service
                rls_passed: List[TableRecord] = []
                for record in moving_records:
                    existing_data = read_data(record)
                    if not rls_service.check_rls_for_write(
                        table_id=table_id, operation='UPDATE',
                        context=rls_context, record_data=existing_data,
                    ):
                        errors.append(f"记录 {record.id} 不满足行级安全策略，无法重排")
                    else:
                        rls_passed.append(record)
                moving_records = rls_passed

        if not moving_records:
            self._set_last_bulk_operation_stats(
                self._build_bulk_operation_stats(
                    total_count=len(ordered_unique_ids),
                    processed_count=0,
                    failed_count=len(errors),
                    batches_completed=0,
                )
            )
            return [], errors

        moving_id_set = {record.id for record in moving_records}

        if normalized_position in {"before", "after"} and not anchor_record_id:
            raise ValueError("before/after 模式下 anchor_record_id 不能为空")

        if anchor_record_id and anchor_record_id in moving_id_set:
            raise ValueError("anchor_record_id 不能是被移动记录")

        formatted_group_values: Optional[Dict[str, Any]] = None
        if group_values:
            fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False))
            blocked_keys = self._find_system_managed_input_keys(group_values, fields)
            if blocked_keys:
                raise ValueError(f"系统托管字段不可编辑: {', '.join(blocked_keys)}")

            is_valid, validation_error = self._validate_record_data(
                table_id,
                group_values,
            )
            if not is_valid:
                raise ValueError(validation_error or "group_values 校验失败")

            formatted_group_values = self._format_record_data(
                group_values,
                fields=fields,
                skip_system_managed_inputs=True,
            )

        left_order = 0.0
        interval = ORDER_REBALANCE_STEP
        moving_count = len(moving_records)
        max_rebalance_attempts = 1
        attempt = 0
        operation_group_id = uuid.uuid4()
        old_states_by_record_id = {
            record.id: {
                'order': record.order,
                'data': copy.deepcopy(read_data(record)),
            }
            for record in moving_records
        }

        # 查询邻居使用无锁 queryset（仅读 order 值），避免锁扩散。
        # 并发折衷：邻居 order 可能在读取后被其他事务修改，极端情况下
        # 计算出的 interval 小于预期。_rebalance_record_orders 兜底处理。
        while True:
            stationary_queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).exclude(id__in=moving_id_set)

            if normalized_position == "end":
                current_max = stationary_queryset.aggregate(Max('order')).get('order__max')
                left_order = float(current_max or 0.0)
                right_order = left_order + ORDER_REBALANCE_STEP * (moving_count + 1)
            else:
                anchor_record = locked_map.get(anchor_record_id)
                if not anchor_record:
                    raise ValueError("锚点记录不存在或不属于当前表格")

                anchor_order = float(anchor_record.order or self._next_append_order(stationary_queryset))
                if normalized_position == "before":
                    prev_record = (
                        stationary_queryset
                        .filter(order__lt=anchor_order)
                        .order_by('-order', '-created_at', '-id')
                        .only('order')
                        .first()
                    )
                    left_order = (
                        float(prev_record.order)
                        if prev_record and prev_record.order is not None
                        else anchor_order - ORDER_REBALANCE_STEP * (moving_count + 1)
                    )
                    right_order = anchor_order
                else:
                    next_record = (
                        stationary_queryset
                        .filter(order__gt=anchor_order)
                        .order_by('order', 'created_at', 'id')
                        .only('order')
                        .first()
                    )
                    left_order = anchor_order
                    right_order = (
                        float(next_record.order)
                        if next_record and next_record.order is not None
                        else anchor_order + ORDER_REBALANCE_STEP * (moving_count + 1)
                    )

            gap = right_order - left_order
            next_interval = gap / (moving_count + 1)
            is_valid_interval = (
                math.isfinite(left_order)
                and math.isfinite(right_order)
                and right_order > left_order
                and next_interval > ORDER_GAP_MIN
            )
            if is_valid_interval:
                interval = next_interval
                break

            if attempt >= max_rebalance_attempts:
                raise ValueError("无法为移动记录分配顺序，请稍后重试")

            self._rebalance_record_orders(table_id)
            attempt += 1

        now = timezone.now()
        moving_count = len(moving_records)
        version_end = self._next_record_version(table_id, count=moving_count)
        version_start = version_end - moving_count + 1
        for index, record in enumerate(moving_records):
            record.order = left_order + interval * (index + 1)
            if formatted_group_values:
                merged_data = dict(read_data(record))
                merged_data.update(formatted_group_values)
                record.__dict__['data'] = merged_data
            if self.user:
                record.updated_by_id = self.user.id
            record.updated_at = now
            record.version = version_start + index

        reordered_record_ids = {
            record.id
            for record in moving_records
            if old_states_by_record_id[record.id]['order'] != record.order
        }
        position_ids_to_clear = {
            record.id
            for record in moving_records
            if (
                record.id in reordered_record_ids
                and record.position_id is not None
            )
        }
        for record in moving_records:
            if record.id in position_ids_to_clear:
                record.position_id = None

        update_fields = ['order', 'updated_at', 'version']
        if position_ids_to_clear:
            update_fields.append('position_id')
        if self.user:
            update_fields.append('updated_by_id')
        if formatted_group_values:
            update_fields.append('data')

        TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
            moving_records,
            update_fields,
            batch_size=BULK_WRITE_CHUNK_SIZE,
        )

        ordered_ids = [record.id for record in moving_records]
        refreshed_map = {
            record.id: record
            for record in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
                id__in=ordered_ids,
            )
        }
        updated_records = [refreshed_map[record_id] for record_id in ordered_ids if record_id in refreshed_map]

        # ── 原生列写入（Phase 3D: 唯一数据路径）──
        native_io = self._native_get_io(table_obj)
        for record in updated_records:
            system_updates = {
                '__order': float(record.order or 0),
                '__version': int(record.version or 0),
                '__updated_at': record.updated_at,
                '__updated_by': record.updated_by_id,
            }
            field_values = {}
            if formatted_group_values:
                reorder_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id, is_deleted=False,
                ))
                field_values = convert_record_for_insert(
                    formatted_group_values,
                    [f for f in reorder_fields if not is_system_field(f.field_type)],
                )
            native_io.update_record(
                record_id=record.id,
                field_values=field_values,
                system_updates=system_updates,
            )

        for record in updated_records:
            old_state = old_states_by_record_id.get(record.id) or {}
            old_order = old_state.get('order')
            old_data = old_state.get('data') or {}
            new_data = read_data(record)

            field_changes: Dict[str, Dict[str, Any]] = {}
            if old_order != record.order:
                field_changes['_order'] = {
                    'old': old_order,
                    'new': record.order,
                }

            if formatted_group_values:
                for field_key in formatted_group_values.keys():
                    key = str(field_key)
                    old_value = old_data.get(key)
                    new_value = new_data.get(key)
                    if old_value != new_value:
                        field_changes[key] = {
                            'old': old_value,
                            'new': new_value,
                        }

            if field_changes:
                emit_record_history_event(
                    record=record,
                    action='update',
                    field_changes=field_changes,
                    user=self.user,
                    window_id=get_current_window_id(),
                    operation_group_id=operation_group_id,
                    push_to_stack=False,
                    editor_type=get_editor_type(),
                    sender=self.__class__,
                )

        from apps.tabdata.utils.ws_notify import publish_table_record_event
        publish_table_record_event(
            table_id=table_id,
            record_ids=[str(record.id) for record in updated_records],
            action="reorder_records",
            records=updated_records,
            user_id=str(self.user.id) if self.user else None,
        )

        # REST / 旧客户端是 DB-first：提交后把精确 moved rows 的顺序意图推入
        # 当前 Y.Doc，由 TabData apply-ops seam 原子重算 PositionId 与 legacy
        # 投影。否则在线文档里的旧 PositionId 会在下一次 cell persist 时复活。
        records_to_sync_order = [
            record for record in updated_records if record.id in reordered_record_ids
        ]
        if records_to_sync_order:
            _sync_records_to_ydoc(
                table_id,
                records_to_sync_order,
                fields=[],
                reorder_record_ids=[str(record.id) for record in records_to_sync_order],
                source="reorder_records",
            )

        self._set_last_bulk_operation_stats(
            self._build_bulk_operation_stats(
                total_count=len(ordered_unique_ids),
                processed_count=len(updated_records),
                failed_count=len(errors),
                batches_completed=1,
            )
        )

        # view_id 仅用于语义对齐，当前模型层不持久化视图独立顺序
        _ = view_id

        # VH + CL：排序变更写入统一版本历史，支持 Checkpoint 回滚
        reorder_record_ids = [str(r.id) for r in updated_records]
        reorder_record_count = len(updated_records)
        reorder_table_id = str(table_id)
        reorder_user_id = str(self.user.id) if self.user else None

        try:
            from apps.services.common.platform_context import get_current_run_id, get_current_session_id
            reorder_agent_run_id = get_current_run_id() or ""
            reorder_session_id = get_current_session_id() or ""  # QC-05
        except ImportError:
            reorder_agent_run_id = ""
            reorder_session_id = ""

        def _write_reorder_vh_cl() -> None:
            try:
                from apps.collab.registry import get_adapter
                from apps.collab.service import VersionHistoryService
                from apps.collab.models import ChangeLog
                from django.db import transaction as db_tx

                adapter = get_adapter("table")
                if not adapter:
                    return

                resource = adapter.get_resource(reorder_table_id)
                if not resource:
                    return

                version_data = adapter.get_version_data(resource)
                if version_data is None:
                    return

                editor_info = {
                    "editor_type": "user" if reorder_user_id else "system",
                    "editor_id": reorder_user_id or "",
                    "editor_name": "",
                }

                svc = VersionHistoryService(adapter)
                organization_id = getattr(resource, "organization_id", None)

                with db_tx.atomic(using="postgresql"):
                    vh = svc.create_history(
                        resource.id,
                        version_data,
                        editor_info,
                        force_snapshot=True,
                        organization_id=organization_id,
                    )
                    ChangeLog.objects.using("postgresql").create(
                        resource_type="table",
                        resource_id=resource.id,
                        change_type="reorder_records",
                        summary="",
                        changes={
                            "record_ids": reorder_record_ids[:50],
                            "record_count": reorder_record_count,
                        },
                        editor_type="user" if reorder_user_id else "system",
                        editor_id=reorder_user_id or "",
                        version_history=vh,
                        agent_run_id=reorder_agent_run_id,
                        session_id=reorder_session_id,
                    )
            except Exception:
                logger.warning(
                    "reorder_records: VH+CL write failed table=%s (non-fatal)",
                    reorder_table_id,
                    exc_info=True,
                )

        transaction.on_commit(_write_reorder_vh_cl, using=TABDATA_DB_ALIAS)

        return updated_records, errors

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def bulk_delete_records(
        self,
        record_ids: List[UUID],
        operation_group_id: Optional[UUID] = None,
        rls_context=None,
    ) -> Tuple[int, List[str], List[str], List[str]]:
        """
        批量删除记录（部分成功语义）。

        Args:
            record_ids: 记录ID列表
            rls_context: RLS 运行时上下文（可选，用于行级安全检查）

        Returns:
            tuple: (删除成功数量, 错误信息列表, 成功/已不存在可清理的记录ID, 失败的记录ID)

            活跃行不存在（软删 / 幽灵 / 从未落库）计入成功 ID，便于前端幂等清投影；
            有活跃行但无 editor 权限才记入失败。
        """
        if not record_ids:
            errors = ["批量删除记录不能为空"]
            self._set_last_bulk_operation_stats(
                self._build_bulk_operation_stats(
                    total_count=0, processed_count=0,
                    failed_count=len(errors), batches_completed=0,
                )
            )
            return 0, errors, [], []

        total_count = len(record_ids)
        if total_count > MAX_BULK_RECORDS:
            raise ValueError(f"批量删除记录单次最多支持 {MAX_BULK_RECORDS} 条")

        errors: List[str] = []
        failed_record_ids: List[str] = []
        # ：活跃行不存在（已软删 / 幽灵 / 从未落库）→ 幂等成功，供前端清投影
        deleted_record_ids: List[str] = []
        resolved_operation_group_id = operation_group_id or uuid.uuid4()

        # ── Phase 1: 预加载 + 权限 / RLS 过滤 ──
        records_map: Dict[str, TableRecord] = {
            str(r.id): r
            for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=record_ids, is_deleted=False,
            )
        }

        table_ids = set(r.table_id for r in records_map.values())
        permitted_tables: set = set()
        for tid in table_ids:
            if self.check_table_permission(str(tid), 'editor'):
                permitted_tables.add(tid)

        _tables_cache: Dict[UUID, Table] = {
            t.id: t
            for t in Table.objects.using(TABDATA_DB_ALIAS).filter(id__in=table_ids).only(
                'id', 'organization_id', 'rls_enabled', 'rls_force',
            )
        }
        if permitted_tables:
            for org_id in (
                Table.objects.using(TABDATA_DB_ALIAS)
                .filter(id__in=permitted_tables)
                .values_list('organization_id', flat=True)
                .distinct()
            ):
                assert_organization_resource_write_allowed_optional(org_id)

        table_groups: Dict[UUID, List[UUID]] = {}
        for idx, rid in enumerate(record_ids):
            rid_str = str(rid)
            record = records_map.get(rid_str)
            if record is None:
                # 权威库无活跃行：幂等成功，前端可清 Y.Doc / 网格投影
                deleted_record_ids.append(rid_str)
                continue
            if record.table_id not in permitted_tables:
                errors.append(f"第{idx+1}条: 删除失败，无权限")
                failed_record_ids.append(rid_str)
                continue

            if rls_context is not None:
                table_obj = _tables_cache.get(record.table_id)
                if table_obj is None:
                    failed_record_ids.append(rid_str)
                    continue
                if table_obj.rls_enabled:
                    should_apply = rls_context.is_token_auth if not table_obj.rls_force else True
                    if should_apply:
                        from apps.tabdata.services.rls_service import rls_service
                        existing_data = read_data(record)
                        if not rls_service.check_rls_for_write(
                            table_id=table_obj.id, operation='DELETE',
                            context=rls_context, record_data=existing_data,
                        ):
                            errors.append(f"第{idx+1}条: 行级安全策略拒绝删除")
                            failed_record_ids.append(rid_str)
                            continue

            table_groups.setdefault(record.table_id, []).append(UUID(rid_str))

        if not table_groups:
            self._set_last_bulk_operation_stats(
                self._build_bulk_operation_stats(
                    total_count=total_count, processed_count=total_count,
                    failed_count=len(errors), batches_completed=0,
                )
            )
            return len(deleted_record_ids), errors, deleted_record_ids, failed_record_ids

        # ── Phase 2: 按表分组委托 Handler ──
        from apps.tabdata.domain.value_objects import RecordCommandContext
        from apps.tabdata.handlers import RecordHandlerFactory

        deleted_count = len(deleted_record_ids)
        for tid, group_ids in table_groups.items():
            context = RecordCommandContext(
                table_id=tid,
                record_ids=group_ids,
                user_id=str(self.user.id) if self.user else None,
                operation_group_id=resolved_operation_group_id,
            )
            handler = RecordHandlerFactory.batch_delete_handler(user=self.user)
            count, handler_errors, handler_deleted, handler_failed = handler.handle(context)
            deleted_count += count
            errors.extend(handler_errors)
            deleted_record_ids.extend(str(rid) for rid in handler_deleted)
            failed_record_ids.extend(str(rid) for rid in handler_failed)

        for tid in table_groups:
            try:
                max_ver_agg = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=tid,
                ).aggregate(max_version=Max('version'))
                max_ver = int(max_ver_agg.get('max_version') or 0)
                if max_ver > 0:
                    _invalidate_table_collab_version(UUID(str(tid)), max_ver)
            except Exception:
                pass

        self._set_last_bulk_operation_stats(
            self._build_bulk_operation_stats(
                total_count=total_count,
                processed_count=total_count,
                failed_count=len(errors),
                batches_completed=1,
            )
        )

        return deleted_count, errors, deleted_record_ids, failed_record_ids

    def get_record_count(self, table_id: UUID, *, rls_context=None) -> int:
        """
        获取表格的记录总数

        Args:
            table_id: 表格ID
            rls_context: RLSContext，传入时对 RLS 保护表执行行级过滤后再 count

        Returns:
            int: 记录总数
        """
        if not self.check_table_permission(str(table_id), 'viewer'):
            return 0

        queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False
        )

        if rls_context is not None:
            try:
                table = Table.objects.using(TABDATA_DB_ALIAS).only(
                    'rls_enabled', 'rls_force',
                ).get(id=table_id)
                if table.rls_enabled:
                    should_apply = rls_context.is_token_auth if not table.rls_force else True
                    if should_apply:
                        from apps.tabdata.services.rls_service import apply_rls_to_orm_queryset
                        queryset = apply_rls_to_orm_queryset(queryset, table_id, rls_context)
            except Table.DoesNotExist:
                pass

        return queryset.count()
    def _resolve_visibility_role(self, table_id: UUID, table=None) -> Optional[str]:
        """解析当前请求对表的有效字段角色（含分享上限）。"""
        from apps.tabdata.services.field_visibility import resolve_effective_table_role

        return resolve_effective_table_role(
            self.user,
            table if table is not None else table_id,
        )

    def _get_visible_field_keys(
        self,
        table_id: UUID,
        *,
        fields: Optional[List[TableField]] = None,
        role: Optional[str] = None,
        table=None,
    ) -> Optional[Dict[str, Set[str]]]:
        """返回角色可见字段 key 集合（含派生依赖闭包）。

        消费 ``field_visibility`` 单一策略；无权角色返回空集合（调用方应已做
        table permission 检查，此处作为纵深防御）。
        """
        from apps.tabdata.services.field_visibility import get_visible_field_key_sets

        effective_role = role if role is not None else self._resolve_visibility_role(
            table_id, table=table,
        )
        return get_visible_field_key_sets(table_id, effective_role, fields=fields)

    def _apply_visibility_filter(
        self,
        record: TableRecord,
        visible_keys: Optional[Dict[str, Set[str]]],
    ) -> None:
        """就地过滤 ORM record.data；空结果也要打标，避免序列化回退加载全量。"""
        from apps.tabdata.services.field_visibility import filter_record_data

        if visible_keys is None:
            return
        record._filtered_data = filter_record_data(read_data(record), visible_keys)
        record._visibility_filtered = True
        # 供 serialize_record 系统字段注入消费同一可见集合（ review）
        record._visible_field_keys = visible_keys

    def _apply_visibility_to_native_records(
        self,
        records: List[Dict[str, Any]],
        visible_keys: Optional[Dict[str, Set[str]]],
        *,
        all_fields: List[TableField],
        field_key_type: str,
    ) -> List[Dict[str, Any]]:
        """按角色可见字段过滤原生序列化结果。"""
        if not records or visible_keys is None:
            return records

        from apps.tabdata.services.field_visibility import flatten_visible_keys

        if field_key_type == 'id':
            fields_set = set(visible_keys.get('ids') or set())
        elif field_key_type == 'dbFieldName':
            fields_set = set(visible_keys.get('dbFieldNames') or set()) | set(
                visible_keys.get('names') or set()
            )
        else:
            fields_set = set(visible_keys.get('names') or set())

        # 若配置了 visibility 但仍无可见字段，返回空 data/fields，避免泄漏
        if not fields_set and not flatten_visible_keys(visible_keys):
            for record in records:
                if isinstance(record.get('data'), dict):
                    record['data'] = {}
                if isinstance(record.get('fields'), dict):
                    record['fields'] = {}
            return records

        return filter_native_record_fields(
            records,
            fields_set,
            all_fields=all_fields,
            field_key_type=field_key_type if field_key_type in {'id', 'name', 'dbFieldName'} else 'name',
            data_fields_set=set(visible_keys.get('names') or set()),
        )

    def _prepare_query_visibility(
        self,
        table_id: UUID,
        *,
        fields: Optional[List[TableField]] = None,
        filters: Optional[Dict[str, Any]] = None,
        sort_by: Optional[str] = None,
        table=None,
    ) -> Tuple[Optional[Dict[str, Set[str]]], Optional[Dict[str, Any]], Optional[str]]:
        """解析可见字段，并净化 filters/sort，杜绝隐藏字段侧信道。"""
        from apps.tabdata.services.field_visibility import (
            resolve_sort_by_for_visibility,
            sanitize_filters_for_visibility,
        )

        visible_keys = self._get_visible_field_keys(
            table_id, fields=fields, table=table,
        )
        safe_filters = sanitize_filters_for_visibility(filters, visible_keys)
        safe_sort_by = resolve_sort_by_for_visibility(sort_by, visible_keys)
        return visible_keys, safe_filters, safe_sort_by

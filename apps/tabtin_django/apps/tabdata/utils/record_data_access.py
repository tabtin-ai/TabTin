"""
统一记录数据访问层

替代直接使用 record.data (JSONField) 的所有读写路径。
原生 PostgreSQL 列是 Phase 3D 后的唯一数据路径，本模块提供：

读取：
  read_data(record)                   — 单条记录数据读取（带实例缓存）
  read_data_fresh(record, table)      — 从原生列强制刷新
  read_data_bulk(records, table)      — 批量预加载原生数据
  read_field_value(record, field_id)  — 单字段值快速读取

写入（双写 JSONField + 原生列）：
  write_field_value(record, field_id, value, table, field)
  write_fields(record, changes, table, fields)
  write_record_data(record, new_data, table, fields)

缓存：
  invalidate_cache(record) — 清除实例缓存

所有函数均可安全调用，内部已处理降级和异常。

──────────────────────────────────────────────────────────────────
迁移状态（2026-03）：
- NativeStoragePhase 默认 native_only
- 写入：create_record / update_record 仍双写 JSONField，因为 Kanban/Calendar/Gallery
  等视图服务的 data__ ORM 查询尚未迁移到 NativeQueryBuilder
- 读取：所有读路径已统一到 read_data()，优先原生列缓存

剩余 data__ 查询迁移清单（约 25 处）：
  - record_service._list_records_orm_fallback（精确筛选 + 搜索 + 排序）
  - link_field_service（data__has_key / data__xxx__icontains）
  - view_filter_service.split_field_path
  - view_group_sort_service（分组统计查询）
  - search_index_service（全文搜索）
  - import_service._fetch_records_by_primary_key（JSON fallback）

目标：全部迁移到 NativeQueryBuilder 后，移除 TableRecord.data JSONField
──────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Dict, List, Optional, TYPE_CHECKING
from uuid import UUID

if TYPE_CHECKING:
    from apps.tabdata.models import TableRecord, Table, TableField

logger = logging.getLogger('tabdata.record_data_access')

_CACHE_ATTR = '_rda_cached_data'


def read_data(record: TableRecord) -> dict:
    """
    读取记录数据（推荐替代 record.data or {}）。

    优先级：
    1. 实例缓存（由 read_data_bulk 预加载）
    2. _native_formatted_data（由 RecordService 写入时附加）
    3. JSONField __dict__ 直接访问（绕过 DeprecationWarning）

    不触发额外 DB 查询。要获取最新原生列数据，使用 read_data_fresh()。
    """
    cached = getattr(record, _CACHE_ATTR, None)
    if cached is not None:
        return cached

    native = getattr(record, '_native_formatted_data', None)
    if native:
        object.__setattr__(record, _CACHE_ATTR, native)
        return native

    raw = record.__dict__.get('data') or {}
    return raw


def read_data_fresh(record: TableRecord, table: Optional[Table] = None) -> dict:
    """
    从原生 PostgreSQL 列读取最新数据（会触发 DB 查询）。

    结果会缓存到实例上。
    """
    try:
        from apps.tabdata.models import Table as TableModel, TableField
        from apps.tabdata.native.record_io import NativeRecordIO
        from apps.tabdata.native.value_converter import convert_native_row_to_record_data
        from apps.tabdata.native.pg_type_map import is_system_field

        if table is None:
            table = TableModel.objects.using('postgresql').get(id=record.table_id)

        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
        native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
        row = native_io.read_single(record.id)
        if row:
            user_fields = list(TableField.objects.using('postgresql').filter(
                table_id=table.id, is_deleted=False,
            ))
            user_fields = [f for f in user_fields if not is_system_field(f.field_type)]
            result = convert_native_row_to_record_data(row, user_fields)
            if result:
                object.__setattr__(record, _CACHE_ATTR, result)
                return result
    except Exception as exc:
        logger.debug("read_data_fresh failed for record %s: %s", record.id, exc)

    return record.__dict__.get('data') or {}


def read_data_bulk(
    records: List[TableRecord],
    table: Table,
    fields: Optional[List[TableField]] = None,
) -> None:
    """
    批量预加载原生列数据到 record 实例上。

    调用后，read_data(record) 不再需要额外 DB 查询。
    适用于循环处理大量记录的场景。
    """
    if not records:
        return

    try:
        from apps.tabdata.models import TableField as TF
        from apps.tabdata.native.record_io import NativeRecordIO
        from apps.tabdata.native.value_converter import convert_native_row_to_record_data
        from apps.tabdata.native.pg_type_map import is_system_field

        if fields is None:
            fields = list(TF.objects.using('postgresql').filter(
                table_id=table.id, is_deleted=False,
            ))

        user_fields = [f for f in fields if not is_system_field(f.field_type)]
        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
        partition_id = resolve_schema_partition_id(table)
        native_io = NativeRecordIO(partition_id, table.id)

        record_ids = [r.id for r in records]
        placeholders = ', '.join(['%s'] * len(record_ids))
        where = (f'"__id" IN ({placeholders})', [str(rid) for rid in record_ids])

        from apps.tabdata.native.query_builder import NativeQueryBuilder
        qb = NativeQueryBuilder(partition_id, table.id, fields)
        rows, _ = native_io.read_records(
            qb,
            where=where,
            limit=len(record_ids),
            offset=0,
            include_count=False,
        )

        row_map: Dict[str, dict] = {}
        for row in rows:
            rid = row.get('__id') or row.get('id')
            if rid:
                data = convert_native_row_to_record_data(row, user_fields)
                row_map[str(rid)] = data

        for record in records:
            native_data = row_map.get(str(record.id))
            if native_data is not None:
                object.__setattr__(record, _CACHE_ATTR, native_data)
    except Exception as exc:
        logger.warning("read_data_bulk failed for table %s: %s", table.id, exc)


def read_field_value(record: TableRecord, field_id_str: str) -> Any:
    """读取单个字段值（推荐替代 record.data.get(field_id_str)）。"""
    data = read_data(record)
    return data.get(field_id_str)


def invalidate_cache(record: TableRecord) -> None:
    """清除实例缓存，下次 read_data 将重新读取。"""
    try:
        delattr(record, _CACHE_ATTR)
    except AttributeError:
        pass


# ══════════════════════════════════════════════════════════════
# 写入路径：双写 JSONField + 原生列
# ══════════════════════════════════════════════════════════════

def write_field_value(
    record: TableRecord,
    field_id_str: str,
    value: Any,
    table: Table,
    field: TableField,
) -> None:
    """
    写入单个字段值到 JSONField 和原生列（双写）。

    替代直接 record.data[field_id_str] = value 的模式。
    注意：调用后仍需 record.save(update_fields=['data', ...])。
    """
    raw_data = record.__dict__.get('data')
    if raw_data is None:
        raw_data = {}
    raw_data[field_id_str] = value
    record.__dict__['data'] = raw_data
    invalidate_cache(record)

    try:
        from apps.tabdata.native.record_io import NativeRecordIO
        from apps.tabdata.native.value_converter import python_to_pg
        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

        native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
        pg_value = python_to_pg(value, field.field_type, field.config)
        native_io.update_record(
            record_id=record.id,
            field_values={field.id.hex: pg_value},
        )
    except Exception as exc:
        logger.warning(
            "write_field_value native sync failed: record=%s field=%s err=%s",
            record.id, field_id_str, exc,
        )


def write_fields(
    record: TableRecord,
    changes: Dict[str, Any],
    table: Table,
    fields: List[TableField],
) -> None:
    """
    批量写入字段值（双写 JSONField + 原生列）。

    Args:
        changes: {field_id_str: value, ...}，field_id_str 为带连字符的 UUID
        fields: 对应的 TableField 对象列表

    调用后仍需 record.save(update_fields=['data', ...])。
    """
    raw_data = record.__dict__.get('data')
    if raw_data is None:
        raw_data = {}

    raw_data.update(changes)
    record.__dict__['data'] = raw_data
    invalidate_cache(record)

    try:
        from apps.tabdata.native.record_io import NativeRecordIO
        from apps.tabdata.native.value_converter import python_to_pg

        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
        field_map = {str(f.id): f for f in fields}
        native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
        pg_values: Dict[str, Any] = {}

        for field_id_str, value in changes.items():
            field = field_map.get(field_id_str)
            if not field:
                continue
            pg_values[field.id.hex] = python_to_pg(value, field.field_type, field.config)

        if pg_values:
            # Native storage may still be provisioning or temporarily unavailable.
            # Isolate its write in a savepoint so the advertised JSON fallback does
            # not leave the caller's outer transaction in an aborted state.
            from django.db import transaction

            with transaction.atomic(using=native_io.db_alias):
                native_io.update_record(record_id=record.id, field_values=pg_values)
    except Exception as exc:
        logger.warning(
            "write_fields native sync failed: record=%s err=%s", record.id, exc,
        )


def write_record_data(
    record: TableRecord,
    new_data: dict,
    table: Table,
    fields: List[TableField],
) -> None:
    """
    完整替换记录数据（双写 JSONField + 原生列）。

    替代 record.data = new_data 的模式。
    调用后仍需 record.save(update_fields=['data', ...])。
    """
    record.__dict__['data'] = new_data
    invalidate_cache(record)

    try:
        from apps.tabdata.native.record_io import NativeRecordIO
        from apps.tabdata.native.value_converter import python_to_pg

        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
        field_map = {str(f.id): f for f in fields}
        native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
        pg_values: Dict[str, Any] = {}

        for field_id_str, value in new_data.items():
            if field_id_str.startswith('_meta:'):
                continue
            field = field_map.get(field_id_str)
            if not field:
                continue
            pg_values[field.id.hex] = python_to_pg(value, field.field_type, field.config)

        if pg_values:
            # Native storage may still be provisioning or temporarily unavailable.
            # Isolate its write in a savepoint so the advertised JSON fallback does
            # not leave the caller's outer transaction in an aborted state.
            from django.db import transaction

            with transaction.atomic(using=native_io.db_alias):
                native_io.update_record(record_id=record.id, field_values=pg_values)
    except Exception as exc:
        logger.warning(
            "write_record_data native sync failed: record=%s err=%s", record.id, exc,
        )


# ══════════════════════════════════════════════════════════════
# 历史记录跳过
# ══════════════════════════════════════════════════════════════

@contextmanager
def skip_record_history(*records):
    """上下文管理器：临时标记记录跳过历史记录写入。

    用法：
        with skip_record_history(rec1, rec2):
            rec1.save(...)
            rec2.save(...)
        # 退出时自动清除标记，即使 save 抛异常也不泄漏

    也支持列表：
        with skip_record_history(*batch):
            TableRecord.objects.bulk_update(batch, ...)
    """
    for r in records:
        r._skip_record_history = True
    try:
        yield
    finally:
        for r in records:
            r.__dict__.pop('_skip_record_history', None)

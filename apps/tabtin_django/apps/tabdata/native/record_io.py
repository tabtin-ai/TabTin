"""
原生记录读写服务

负责对原生列表执行 INSERT / SELECT / UPDATE / DELETE 操作。
使用 django.db.connections['postgresql'].cursor() 执行参数化 SQL。
"""

import logging
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from django.db import connections, DatabaseError, transaction

from .ddl_manager import DDLManager
from apps.tabdata.constants import TABDATA_DB_ALIAS as DB_ALIAS
from apps.tabdata.exceptions import RecordVersionConflictError
from .pg_type_map import SYSTEM_COLUMN_NAMES, is_system_field
from .query_builder import NativeQueryBuilder
from .value_converter import convert_record_for_insert, pg_to_python, python_to_pg

logger = logging.getLogger('tabdata.native.record_io')

MAX_BULK_RECORDS = 2000

# ── COUNT 缓存 ──────────────────────────────
# 短时进程级缓存，避免同一请求周期内多次 COUNT(*) 全表扫描。
_COUNT_CACHE_TTL = 5  # 秒
_count_cache: Dict[str, Tuple[int, float]] = {}  # key → (count, expiry_ts)
_count_cache_lock = threading.Lock()

_RE_HEX_UUID = re.compile(r'^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
_RE_MISSING_COLUMN = re.compile(r'column\s+"?([0-9a-f]{32})"?\s+.*does not exist', re.IGNORECASE)


def _validate_column_name(name: str) -> bool:
    """校验列名是否为合法的系统列名或 UUID hex 格式"""
    return name in SYSTEM_COLUMN_NAMES or bool(_RE_HEX_UUID.match(name))


def _assert_column_names(names):
    """批量校验列名，非法列名抛出 ValueError"""
    for name in names:
        if not _validate_column_name(name):
            raise ValueError(
                f"非法列名: {name!r}，列名必须是系统列或 32 位十六进制 UUID"
            )


def _handle_database_error(exc: DatabaseError, operation: str, qualified: str) -> None:
    """检查 DatabaseError 是否为列不存在错误，输出友好日志后 re-raise。

    DDL 竞争场景：列已被 drop_column 删除但 field_map_hex 未刷新，
    SQL 引用了不存在的列导致 DatabaseError。
    """
    msg = str(exc)
    match = _RE_MISSING_COLUMN.search(msg)
    if match:
        missing_col = match.group(1)
        logger.error(
            "DDL 竞争条件：%s 操作引用了已删除的列 %r（表 %s）。"
            "可能原因：字段已通过 drop_column 删除但 field_map_hex 未同步刷新。"
            "原始错误：%s",
            operation, missing_col, qualified, msg,
        )
    raise exc


class NativeRecordIO:
    """
    原生列表记录的低级 I/O 操作。

    所有操作使用参数化 SQL 防止注入。
    """

    def __init__(
        self,
        space_id: UUID,
        table_id: UUID,
        db_alias: str = DB_ALIAS,
    ):
        self.space_id = space_id
        self.table_id = table_id
        self.db_alias = db_alias
        self.ddl = DDLManager(db_alias)
        self.qualified = self._qualified_name()

    def _qualified_name(self) -> str:
        schema = DDLManager.schema_name(self.space_id)
        table = DDLManager.table_name(self.table_id)
        return f'"{schema}"."{table}"'

    # ──────────────────────────────────
    # INSERT
    # ──────────────────────────────────

    def insert_record(
        self,
        record_id: UUID,
        field_values: Dict[str, Any],
        system_values: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        插入一条记录。

        Args:
            record_id: 记录 UUID (对应 __id)
            field_values: {field_id_hex: pg_value, ...} — 已经过 value_converter 转换
            system_values: {system_col_name: value, ...}
                可选 keys: __order, __version, __created_at, __updated_at,
                           __created_by, __updated_by

        Returns:
            True 表示成功
        """
        system_values = system_values or {}

        # 构建列名和值
        columns = ['"__id"']
        values = [str(record_id)]

        # 系统列
        for sys_col in ('__order', '__version', '__created_at', '__updated_at',
                        '__created_by', '__updated_by'):
            if sys_col in system_values and system_values[sys_col] is not None:
                columns.append(f'"{sys_col}"')
                val = system_values[sys_col]
                if sys_col in ('__created_by', '__updated_by') and isinstance(val, UUID):
                    val = str(val)
                values.append(val)

        # 用户字段列（校验列名合法性）
        _assert_column_names(field_values.keys())
        for field_id_raw, pg_value in field_values.items():
            if pg_value is not None:
                field_id_hex = field_id_raw.replace('-', '') if '-' in field_id_raw else field_id_raw
                columns.append(f'"{field_id_hex}"')
                values.append(pg_value)

        col_str = ', '.join(columns)
        placeholders = ', '.join(['%s'] * len(values))

        sql = f'INSERT INTO {self.qualified} ({col_str}) VALUES ({placeholders})'

        try:
            with connections[self.db_alias].cursor() as cursor:
                cursor.execute(sql, values)
        except DatabaseError as exc:
            _handle_database_error(exc, 'insert_record', self.qualified)

        self.invalidate_count_cache(self.qualified)
        logger.debug('Record inserted: %s in %s', record_id, self.qualified)
        return True

    def bulk_insert_records(
        self,
        records: List[Dict[str, Any]],
    ) -> int:
        """
        批量插入记录。

        Args:
            records: 记录列表，每条格式：
                {
                    '__id': UUID,
                    '__order': float,
                    '__version': int,
                    '__created_at': datetime,
                    '__updated_at': datetime,
                    '__created_by': UUID,
                    '__updated_by': UUID,
                    'field_hex_1': value1,
                    'field_hex_2': value2,
                    ...
                }

        Returns:
            插入的记录数
        """
        if not records:
            return 0

        if len(records) > MAX_BULK_RECORDS:
            raise ValueError(
                f"批量插入数量 {len(records)} 超过上限 {MAX_BULK_RECORDS}，请分批调用"
            )

        # 收集所有出现的列名（取并集）
        all_columns = set()
        for record in records:
            all_columns.update(record.keys())

        # 校验所有列名合法性
        _assert_column_names(all_columns)

        # 排序确保一致性：系统列在前，字段列在后
        system_cols = [c for c in all_columns if c.startswith('__')]
        field_cols = sorted(c for c in all_columns if not c.startswith('__'))
        ordered_columns = sorted(system_cols) + field_cols

        col_str = ', '.join(f'"{c}"' for c in ordered_columns)
        placeholders = ', '.join(['%s'] * len(ordered_columns))

        sql = (
            f'INSERT INTO {self.qualified} ({col_str}) '
            f'VALUES ({placeholders}) '
            f'ON CONFLICT ("__id") DO UPDATE SET '
        )

        # ON CONFLICT UPDATE（用于回填的幂等性）— 排除主键和创建时不可变列
        _IMMUTABLE_ON_CONFLICT = {'__id', '__created_at', '__created_by', '__auto_number'}
        update_parts = []
        for c in ordered_columns:
            if c not in _IMMUTABLE_ON_CONFLICT:
                update_parts.append(f'"{c}" = EXCLUDED."{c}"')
        sql += ', '.join(update_parts)

        rows = []
        for record in records:
            row = []
            for col in ordered_columns:
                val = record.get(col)
                if col in ('__id', '__created_by', '__updated_by') and isinstance(val, UUID):
                    val = str(val)
                row.append(val)
            rows.append(row)

        try:
            with transaction.atomic(using=self.db_alias):
                try:
                    from psycopg2.extras import execute_batch as _exec_batch
                    with connections[self.db_alias].cursor() as cursor:
                        _exec_batch(cursor, sql, rows, page_size=200)
                except ImportError:
                    with connections[self.db_alias].cursor() as cursor:
                        cursor.executemany(sql, rows)
        except DatabaseError as exc:
            _handle_database_error(exc, 'bulk_insert_records', self.qualified)

        count = len(rows)
        self.invalidate_count_cache(self.qualified)
        logger.info('Bulk inserted %d records into %s', count, self.qualified)
        return count

    # ──────────────────────────────────
    # UPDATE
    # ──────────────────────────────────

    def update_record(
        self,
        record_id: UUID,
        field_values: Optional[Dict[str, Any]] = None,
        system_updates: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        更新一条记录。

        Args:
            record_id: 记录 UUID
            field_values: {field_id_hex: pg_value, ...} — 仅包含需更新的字段
            system_updates: {system_col: value, ...} — 系统列更新

        Returns:
            True 表示成功
        """
        field_values = field_values or {}
        system_updates = system_updates or {}

        set_parts = []
        params = []

        # 系统列更新
        for sys_col, val in system_updates.items():
            if sys_col in SYSTEM_COLUMN_NAMES and sys_col != '__id':
                set_parts.append(f'"{sys_col}" = %s')
                if isinstance(val, UUID):
                    val = str(val)
                params.append(val)

        # 字段列更新（校验列名合法性）
        _assert_column_names(field_values.keys())
        for field_id_raw, pg_value in field_values.items():
            field_id_hex = field_id_raw.replace('-', '') if '-' in field_id_raw else field_id_raw
            set_parts.append(f'"{field_id_hex}" = %s')
            params.append(pg_value)

        if not set_parts:
            return False

        set_clause = ', '.join(set_parts)
        params.append(str(record_id))

        sql = f'UPDATE {self.qualified} SET {set_clause} WHERE "__id" = %s'

        try:
            with connections[self.db_alias].cursor() as cursor:
                cursor.execute(sql, params)
                affected = cursor.rowcount
        except DatabaseError as exc:
            _handle_database_error(exc, 'update_record', self.qualified)

        logger.debug(
            'Record updated: %s in %s (affected=%d)',
            record_id, self.qualified, affected,
        )
        self.invalidate_count_cache(self.qualified)
        return affected > 0

    def bulk_update_records(
        self,
        records: List[Dict[str, Any]],
    ) -> int:
        """
        批量更新记录（每条记录必须包含 '__id'）。

        按列集合分组执行，确保不会因列缺失而将原值覆盖为 NULL。
        相同列集合的记录共享同一条 SQL 模板，通过 execute_batch 批量提交。

        Args:
            records: 记录列表，每条格式：
                {
                    '__id': UUID,         # 必需
                    'field_hex_1': value1, # 要更新的列
                    ...
                }

        Returns:
            实际更新的行数
        """
        if not records:
            return 0

        if len(records) > MAX_BULK_RECORDS:
            raise ValueError(
                f"批量更新数量 {len(records)} 超过上限 {MAX_BULK_RECORDS}，请分批调用"
            )

        from collections import defaultdict

        groups: dict[tuple, list] = defaultdict(list)
        for record in records:
            record_id = record.get('__id')
            if not record_id:
                continue
            col_key = tuple(sorted(k for k in record.keys() if k != '__id'))
            if not col_key:
                continue
            # 校验所有列名合法性
            _assert_column_names(col_key)
            groups[col_key].append(record)

        total = 0

        try:
            with transaction.atomic(using=self.db_alias):
                for col_key, group in groups.items():
                    system_cols = sorted(c for c in col_key if c.startswith('__'))
                    field_cols = sorted(c for c in col_key if not c.startswith('__'))
                    ordered_columns = system_cols + field_cols

                    set_parts = ', '.join(f'"{c}" = %s' for c in ordered_columns)
                    sql = f'UPDATE {self.qualified} SET {set_parts} WHERE "__id" = %s'

                    rows = []
                    for record in group:
                        params = []
                        for col in ordered_columns:
                            val = record.get(col)
                            if col in ('__created_by', '__updated_by') and isinstance(val, UUID):
                                val = str(val)
                            params.append(val)
                        rid = record['__id']
                        params.append(str(rid) if isinstance(rid, UUID) else rid)
                        rows.append(params)

                    if rows:
                        try:
                            from psycopg2.extras import execute_batch as _exec_batch
                            with connections[self.db_alias].cursor() as cursor:
                                _exec_batch(cursor, sql, rows, page_size=200)
                        except ImportError:
                            with connections[self.db_alias].cursor() as cursor:
                                cursor.executemany(sql, rows)
                        total += len(rows)
        except DatabaseError as exc:
            _handle_database_error(exc, 'bulk_update_records', self.qualified)

        if total > 0:
            self.invalidate_count_cache(self.qualified)
        logger.info('Bulk updated %d records in %s', total, self.qualified)
        return total

    def delete_record(
        self,
        record_id: UUID,
        version: int,
        updated_by: Optional[UUID] = None,
    ) -> bool:
        """从原生表永久删除记录。

        当 version > 0 时启用乐观锁，WHERE 同时匹配版本号，防止并发误删。
        """
        if version and version > 0:
            sql = f'DELETE FROM {self.qualified} WHERE "__id" = %s AND "__version" = %s'
            params = [str(record_id), version]
        else:
            sql = f'DELETE FROM {self.qualified} WHERE "__id" = %s'
            params = [str(record_id)]

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(sql, params)
            affected = cursor.rowcount

        if affected == 0 and version and version > 0:
            logger.warning(
                'Optimistic lock conflict on delete: record=%s version=%s in %s',
                record_id, version, self.qualified,
            )
            raise RecordVersionConflictError(record_id, expected_version=version)

        if affected > 0:
            self.invalidate_count_cache(self.qualified)
        logger.debug(
            'Record deleted from native: %s in %s (affected=%d)',
            record_id, self.qualified, affected,
        )
        return affected > 0

    def delete_all_records(self) -> int:
        """Physically clear all native rows for an authoritative table replacement."""
        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(f'DELETE FROM {self.qualified}')
            affected = cursor.rowcount
        if affected > 0:
            self.invalidate_count_cache(self.qualified)
        logger.info('Deleted all %d native records from %s', affected, self.qualified)
        return affected

    # ──────────────────────────────────
    # SELECT
    # ──────────────────────────────────

    def read_records(
        self,
        query_builder: NativeQueryBuilder,
        *,
        where: Optional[Tuple[str, list]] = None,
        order_by=None,
        limit: int = 100,
        offset: int = 0,
        field_ids: Optional[List[str]] = None,
        cursor_value: Optional[float] = None,
        cursor_id: Optional[str] = None,
        include_count: bool = True,
    ) -> Tuple[List[Dict], int]:
        """
        查询记录列表。

        Args:
            cursor_value: keyset 分页游标 — 上一页最后一行的 __order 值。
                传入后忽略 offset，深页查询从 O(offset+limit) 降至 O(limit)。
            cursor_id: keyset 分页游标 — 上一页最后一行的 __id（可选，
                用于 __order 相同时精确去重）。
            include_count: 是否执行 COUNT 查询。调用方已自行统计时传 False
                可避免双重全表扫描。

        Returns:
            (rows, total_count)  — include_count=False 时 total_count 为 -1
            rows: [{col_name: value, ...}, ...]
        """
        select_sql, select_params = query_builder.build_select_sql(
            field_ids=field_ids,
            where=where,
            order_by=order_by,
            limit=limit,
            offset=offset,
            cursor_value=cursor_value,
            cursor_id=cursor_id,
        )

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(select_sql, select_params)
            col_names = [desc[0] for desc in cursor.description]
            raw_rows = cursor.fetchall()

        rows = [dict(zip(col_names, row)) for row in raw_rows]

        if include_count:
            total = self.count_records(where=where)
        else:
            total = -1

        return (rows, total)

    def read_single(
        self,
        record_id: UUID,
        field_ids: Optional[List[str]] = None,
    ) -> Optional[Dict]:
        """
        读取单条记录。

        Args:
            record_id: 记录 UUID
            field_ids: 要读取的字段列表（None = 全部）

        Returns:
            {col_name: value, ...} 或 None
        """
        if field_ids:
            # 系统列 + 指定字段列
            columns = [
                '"__id"', '"__auto_number"', '"__order"', '"__version"',
                '"__created_at"', '"__updated_at"', '"__created_by"', '"__updated_by"',
            ]
            for fid in field_ids:
                clean = fid.replace('-', '')
                if not _validate_column_name(clean):
                    raise ValueError(
                        f"非法字段 ID: {fid!r}，必须是 32 位十六进制 UUID"
                    )
                columns.append(f'"{clean}"')
            select_clause = ', '.join(columns)
        else:
            select_clause = '*'

        sql = f'SELECT {select_clause} FROM {self.qualified} WHERE "__id" = %s LIMIT 1'

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(sql, [str(record_id)])
            if not cursor.description:
                return None
            col_names = [desc[0] for desc in cursor.description]
            row = cursor.fetchone()

        if not row:
            return None

        return dict(zip(col_names, row))

    def read_batch(
        self,
        record_ids: List[UUID],
    ) -> Dict[str, Dict]:
        """
        批量读取多条记录，返回 {record_id_str: row_dict}。

        一次 SQL 替代 N 次 read_single，减少 DB 往返。
        """
        if not record_ids:
            return {}

        placeholders = ', '.join(['%s'] * len(record_ids))
        sql = f'SELECT * FROM {self.qualified} WHERE "__id" IN ({placeholders})'
        params = [str(rid) for rid in record_ids]

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(sql, params)
            if not cursor.description:
                return {}
            col_names = [desc[0] for desc in cursor.description]
            raw_rows = cursor.fetchall()

        result: Dict[str, Dict] = {}
        for row in raw_rows:
            row_dict = dict(zip(col_names, row))
            rid = str(row_dict.get('__id', ''))
            if rid:
                result[rid] = row_dict
        return result

    def record_exists(self, record_id: UUID) -> bool:
        """检查记录是否存在"""
        sql = f'SELECT EXISTS (SELECT 1 FROM {self.qualified} WHERE "__id" = %s)'
        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(sql, [str(record_id)])
            row = cursor.fetchone()
            return bool(row and row[0])

    def count_records(
        self,
        where: Optional[Tuple[str, list]] = None,
    ) -> int:
        """
        统计记录总数，带 5 秒进程级缓存。

        缓存 key 由 qualified table name + WHERE 子句 + 参数组成，
        避免同一请求内重复全表扫描。
        """
        if where:
            where_sql, where_params = where
        else:
            where_sql, where_params = '', []

        cache_key = f"{self.qualified}|{where_sql}|{repr(where_params)}"
        now = time.monotonic()

        with _count_cache_lock:
            cached = _count_cache.get(cache_key)
            if cached is not None:
                count_val, expiry = cached
                if now < expiry:
                    return count_val

        if where_sql:
            sql = f'SELECT COUNT(*) FROM {self.qualified} WHERE {where_sql}'
            params = where_params
        else:
            sql = f'SELECT COUNT(*) FROM {self.qualified}'
            params = []

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(sql, params)
            result = cursor.fetchone()[0]

        with _count_cache_lock:
            _count_cache[cache_key] = (result, now + _COUNT_CACHE_TTL)
            # 惰性清理过期条目，控制缓存大小
            if len(_count_cache) > 500:
                expired_keys = [k for k, (_, exp) in _count_cache.items() if now >= exp]
                for k in expired_keys:
                    _count_cache.pop(k, None)

        return result

    def count_and_version_state(
        self,
        filter_where: Optional[Tuple[str, list]] = None,
    ) -> Tuple[int, int, int]:
        """
        单次 SQL 获取：匹配过滤条件的记录总数 + 全表最大 version + 最大 updated_at（毫秒）。

        Returns:
            (filtered_count, max_version, max_updated_ms)
        """
        if filter_where:
            fw_sql, fw_params = filter_where
            sql = (
                f'SELECT '
                f'  COUNT(*) FILTER (WHERE {fw_sql}), '
                f'  COALESCE(MAX("__version"), 0), '
                f'  COALESCE(EXTRACT(EPOCH FROM MAX("__updated_at")) * 1000, 0) '
                f'FROM {self.qualified}'
            )
            params = fw_params
        else:
            sql = (
                f'SELECT COUNT(*), '
                f'  COALESCE(MAX("__version"), 0), '
                f'  COALESCE(EXTRACT(EPOCH FROM MAX("__updated_at")) * 1000, 0) '
                f'FROM {self.qualified}'
            )
            params = []

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(sql, params)
            row = cursor.fetchone()
        return int(row[0]), int(row[1]), int(row[2])

    @staticmethod
    def invalidate_count_cache(qualified_name: Optional[str] = None) -> None:
        """
        主动失效 COUNT 缓存。

        写操作（INSERT / UPDATE / DELETE）后调用，确保后续 count 返回最新值。
        qualified_name 为 None 时清除所有缓存。
        """
        with _count_cache_lock:
            if qualified_name is None:
                _count_cache.clear()
            else:
                keys_to_remove = [
                    k for k in _count_cache if k.startswith(f"{qualified_name}|")
                ]
                for k in keys_to_remove:
                    _count_cache.pop(k, None)

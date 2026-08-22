"""D2 Schema Integrity V2 — 统一 "元数据 vs PG DDL 漂移" 检查与修复服务。

设计来源
--------

- PRD §D2（Schema Integrity V2）
- Harness 笔记 W3.4

职责
----

1. **检查 (check)**：遍历 ORM ``TableField`` 与 PG ``information_schema``，
   产出结构化 ``DriftItem`` 列表，覆盖 5 种以上漂移类型。
2. **修复 (repair)**：对 ``auto_fixable=True`` 的 ``DriftItem`` 执行修复操作，
   以 Python generator（yield ``RepairEvent``）方式提供 SSE 流式进度。

漂移类型
--------

===================  ============================================================
类型                  含义
===================  ============================================================
column_missing        ORM 有活跃字段但 PG 物理列缺失
native_table_missing  ORM 有活跃 Table 但 PG 物理表缺失
column_orphan         PG 有物理列但 ORM 无对应活跃字段（孤儿列）
type_mismatch         ORM 字段类型与 PG 列类型不匹配
ref_stale             FieldReference 中 from_field/to_field 已被删除（stale 边）
row_count_mismatch    ORM ``TableRecord`` 行数 vs native 表行数不一致
===================  ============================================================
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Generator, List, Optional
from uuid import UUID

from django.db import connections, transaction

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import FieldReference, Table, TableField, TableRecord
from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
from apps.tabdata.native.pg_type_map import (
    FIELD_TYPE_TO_PG_TYPE,
    SYSTEM_COLUMN_FIELD_TYPES,
    is_system_field,
)

logger = logging.getLogger(__name__)

_PG_TYPE_NORMALIZE: Dict[str, str] = {
    'double precision': 'DOUBLE PRECISION',
    'integer': 'INTEGER',
    'text': 'TEXT',
    'boolean': 'BOOLEAN',
    'date': 'DATE',
    'jsonb': 'JSONB',
    'timestamp with time zone': 'TIMESTAMPTZ',
    'timestamptz': 'TIMESTAMPTZ',
}


def _normalize_pg_type(raw: str) -> str:
    """将 ``information_schema.columns.data_type`` 归一化到与
    ``FIELD_TYPE_TO_PG_TYPE`` 相同的大写形式。"""
    return _PG_TYPE_NORMALIZE.get(raw.lower().strip(), raw.upper().strip())


# ── 数据类 ──────────────────────────────────────────────────


@dataclass
class DriftItem:
    """单条漂移检查结果。"""

    type: str
    field_id: Optional[str] = None
    field_name: Optional[str] = None
    column_name: Optional[str] = None
    expected: Optional[str] = None
    actual: Optional[str] = None
    auto_fixable: bool = False
    detail: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class SchemaCheckReport:
    """完整检查报告。"""

    table_id: str
    table_name: str
    drift_items: List[DriftItem] = field(default_factory=list)
    checked_fields: int = 0
    checked_refs: int = 0
    orm_row_count: int = 0
    native_row_count: int = 0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d['drift_items'] = [item.to_dict() for item in self.drift_items]
        if d.get('error') is None:
            d.pop('error', None)
        return d


@dataclass
class RepairEvent:
    """单次修复操作的进度事件（用于 SSE 推送）。"""

    seq: int
    drift_type: str
    field_id: Optional[str] = None
    status: str = 'pending'  # pending / success / failed / skipped
    message: str = ''

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}


# ── 服务 ──────────────────────────────────────────────────────


class IntegrityV2Service:
    """Schema Integrity V2 — 检查 + 修复。"""

    def __init__(self, db_alias: str = TABDATA_DB_ALIAS):
        self.db_alias = db_alias
        self._ddl = DDLManager(db_alias=db_alias)

    # ------------------------------------------------------------------ check

    def check(self, table_id: UUID) -> SchemaCheckReport:
        """对单张表执行完整 Schema 一致性检查。

        返回 ``SchemaCheckReport``，包含所有 ``DriftItem``。
        """
        try:
            table = Table.objects.using(self.db_alias).get(id=table_id)
        except Table.DoesNotExist:
            return SchemaCheckReport(
                table_id=str(table_id),
                table_name='',
                error=f'Table {table_id} not found',
            )

        report = SchemaCheckReport(
            table_id=str(table_id),
            table_name=table.name,
        )

        partition_id = resolve_schema_partition_id(table)
        if not self._ddl.native_table_exists(partition_id, table.id):
            report.drift_items.append(DriftItem(
                type='native_table_missing',
                expected='active Table has a native physical table',
                actual='<missing>',
                auto_fixable=True,
                detail=(
                    f'Active table "{table.name}" ({table.id}) has no native physical table'
                ),
            ))
            return report

        active_fields = list(
            TableField.objects.using(self.db_alias)
            .filter(table_id=table_id, is_deleted=False)
        )
        report.checked_fields = len(active_fields)

        pg_columns = self._ddl.list_columns(partition_id, table.id)
        pg_col_map: Dict[str, Dict] = {c['name']: c for c in pg_columns}

        self._check_column_missing(active_fields, pg_col_map, report)
        self._check_column_orphan(active_fields, pg_col_map, report, table_id)
        self._check_type_mismatch(active_fields, pg_col_map, report)
        self._check_ref_stale(table_id, report)
        self._check_row_count(table, report)

        logger.info(
            'IntegrityV2 check table=%s drifts=%d',
            table_id, len(report.drift_items),
        )
        return report

    # ── 5 种检查项 ────────────────────────────────────────────

    def _check_column_missing(
        self,
        active_fields: List[TableField],
        pg_col_map: Dict[str, Dict],
        report: SchemaCheckReport,
    ) -> None:
        for f in active_fields:
            if is_system_field(f.field_type):
                continue
            col_name = f.id.hex
            if col_name not in pg_col_map:
                report.drift_items.append(DriftItem(
                    type='column_missing',
                    field_id=str(f.id),
                    field_name=f.name,
                    expected=f'PG column "{col_name}" ({f.field_type})',
                    actual='<missing>',
                    auto_fixable=True,
                    detail=f'ORM field "{f.name}" ({f.field_type}) has no PG column',
                ))

    def _check_column_orphan(
        self,
        active_fields: List[TableField],
        pg_col_map: Dict[str, Dict],
        report: SchemaCheckReport,
        table_id: UUID,
    ) -> None:
        active_hex_ids = {f.id.hex for f in active_fields if not is_system_field(f.field_type)}

        soft_deleted_hex_ids = {
            fid.hex for fid in
            TableField.objects.using(self.db_alias)
            .filter(table_id=table_id, is_deleted=True)
            .values_list('id', flat=True)
        }

        system_col_names = {
            '__id', '__auto_number', '__order', '__version',
            '__created_at', '__updated_at', '__created_by', '__updated_by',
        }
        for col_name, col_info in pg_col_map.items():
            if col_name in system_col_names:
                continue
            if col_name in active_hex_ids or col_name in soft_deleted_hex_ids:
                continue
            report.drift_items.append(DriftItem(
                type='column_orphan',
                field_id=None,
                field_name=None,
                column_name=col_name,
                expected='<no ORM field>',
                actual=f'PG column "{col_name}" ({col_info.get("data_type", "?")})',
                auto_fixable=True,
                detail=f'PG column "{col_name}" has no corresponding active or soft-deleted ORM field',
            ))

    def _check_type_mismatch(
        self,
        active_fields: List[TableField],
        pg_col_map: Dict[str, Dict],
        report: SchemaCheckReport,
    ) -> None:
        for f in active_fields:
            if is_system_field(f.field_type):
                continue
            col_name = f.id.hex
            col_info = pg_col_map.get(col_name)
            if col_info is None:
                continue

            expected_pg = FIELD_TYPE_TO_PG_TYPE.get(f.field_type)
            if expected_pg is None:
                continue

            actual_pg = _normalize_pg_type(col_info.get('data_type', ''))
            if actual_pg != expected_pg:
                report.drift_items.append(DriftItem(
                    type='type_mismatch',
                    field_id=str(f.id),
                    field_name=f.name,
                    expected=expected_pg,
                    actual=actual_pg,
                    auto_fixable=False,
                    detail=(
                        f'Field "{f.name}" ({f.field_type}): '
                        f'expected PG type {expected_pg}, got {actual_pg}'
                    ),
                ))

    def _check_ref_stale(
        self, table_id: UUID, report: SchemaCheckReport,
    ) -> None:
        refs = list(
            FieldReference.objects.using(self.db_alias)
            .filter(from_field__table_id=table_id)
            .select_related('from_field', 'to_field')
        )
        refs += list(
            FieldReference.objects.using(self.db_alias)
            .filter(to_field__table_id=table_id)
            .select_related('from_field', 'to_field')
        )
        seen_ref_ids = set()
        for ref in refs:
            if ref.id in seen_ref_ids:
                continue
            seen_ref_ids.add(ref.id)
            report.checked_refs += 1

            from_ok = TableField.objects.using(self.db_alias).filter(
                id=ref.from_field_id, is_deleted=False,
            ).exists()
            to_ok = TableField.objects.using(self.db_alias).filter(
                id=ref.to_field_id, is_deleted=False,
            ).exists()

            if not from_ok or not to_ok:
                stale_side = []
                if not from_ok:
                    stale_side.append(f'from_field={ref.from_field_id}')
                if not to_ok:
                    stale_side.append(f'to_field={ref.to_field_id}')

                report.drift_items.append(DriftItem(
                    type='ref_stale',
                    field_id=str(ref.id),
                    expected='both sides active',
                    actual=', '.join(stale_side) + ' deleted/missing',
                    auto_fixable=True,
                    detail=f'FieldReference {ref.id}: stale edge ({", ".join(stale_side)})',
                ))

    def _check_row_count(
        self, table: Table, report: SchemaCheckReport,
    ) -> None:
        orm_count = (
            TableRecord.objects.using(self.db_alias)
            .filter(table_id=table.id, is_deleted=False)
            .count()
        )
        report.orm_row_count = orm_count

        schema = DDLManager.schema_name(resolve_schema_partition_id(table))
        tbl = DDLManager.table_name(table.id)
        qualified = f'"{schema}"."{tbl}"'

        try:
            with connections[self.db_alias].cursor() as cursor:
                cursor.execute(f'SELECT COUNT(*) FROM {qualified}')
                row = cursor.fetchone()
                native_count = row[0] if row else 0
        except Exception as exc:
            report.drift_items.append(DriftItem(
                type='row_count_mismatch',
                expected=str(orm_count),
                actual=f'<query failed: {exc}>',
                auto_fixable=False,
                detail=f'Cannot count native rows: {exc}',
            ))
            return

        report.native_row_count = native_count

        if orm_count != native_count:
            report.drift_items.append(DriftItem(
                type='row_count_mismatch',
                expected=str(orm_count),
                actual=str(native_count),
                auto_fixable=native_count < orm_count,
                detail=(
                    f'ORM has {orm_count} active records, '
                    f'native table has {native_count} rows'
                ),
            ))

    # ----------------------------------------------------------------- repair

    def repair_stream(
        self, table_id: UUID,
    ) -> Generator[RepairEvent, None, None]:
        """对所有 ``auto_fixable`` 漂移项执行修复，yield 每步进度。

        适合用于 SSE 流式返回。
        """
        report = self.check(table_id)
        if report.error:
            yield RepairEvent(
                seq=0, drift_type='error', status='failed',
                message=report.error,
            )
            return

        fixable = [d for d in report.drift_items if d.auto_fixable]
        if not fixable:
            yield RepairEvent(
                seq=0, drift_type='none', status='success',
                message='No auto-fixable drift items found',
            )
            return

        try:
            table = Table.objects.using(self.db_alias).get(id=table_id)
        except Table.DoesNotExist:
            yield RepairEvent(
                seq=0, drift_type='error', status='failed',
                message=f'Table {table_id} not found',
            )
            return

        yield RepairEvent(
            seq=0, drift_type='start', status='pending',
            message=f'Starting repair: {len(fixable)} items to fix '
                    f'(of {len(report.drift_items)} total drifts)',
        )

        seq = 0
        for item in fixable:
            seq += 1
            evt = RepairEvent(
                seq=seq, drift_type=item.type,
                field_id=item.field_id, status='pending',
            )
            try:
                self._repair_one(table, item)
                evt.status = 'success'
                evt.message = f'Repaired: {item.detail or item.type}'
            except Exception as exc:
                logger.exception(
                    'IntegrityV2 repair failed: table=%s type=%s field=%s',
                    table_id, item.type, item.field_id,
                )
                evt.status = 'failed'
                evt.message = str(exc)
            yield evt

        yield RepairEvent(
            seq=seq + 1, drift_type='summary', status='success',
            message=f'Repair completed: {seq} items processed',
        )

    def _repair_one(self, table: Table, item: DriftItem) -> None:
        """修复单条漂移。"""
        if item.type == 'native_table_missing':
            self._repair_native_table_missing(table)
        elif item.type == 'column_missing':
            self._repair_column_missing(table, item)
        elif item.type == 'column_orphan':
            self._repair_column_orphan(table, item)
        elif item.type == 'ref_stale':
            self._repair_ref_stale(item)
        elif item.type == 'row_count_mismatch':
            self._repair_row_count(table, item)
        else:
            raise ValueError(f'Unknown drift type: {item.type}')

    def _repair_native_table_missing(self, table: Table) -> None:
        """缺失的 native 表：重建结构，并从 ORM TableRecord 回填可恢复数据。"""
        from apps.tabdata.native.backfill_service import BackfillService

        result = BackfillService().backfill_table(table.id, force=True)
        if result.get('status') != 'completed':
            raise ValueError(result.get('message') or 'Native table backfill failed')

    def _repair_column_missing(self, table: Table, item: DriftItem) -> None:
        """缺失的 PG 列：重新添加。"""
        field_id = UUID(item.field_id)
        try:
            field_obj = TableField.objects.using(self.db_alias).get(id=field_id)
        except TableField.DoesNotExist:
            raise ValueError(f'Field {field_id} not found')

        partition_id = resolve_schema_partition_id(table)
        with transaction.atomic(using=self.db_alias):
            self._ddl.add_column(
                partition_id, table.id, field_obj.id,
                field_obj.field_type, field_obj.config,
            )

    def _repair_column_orphan(self, table: Table, item: DriftItem) -> None:
        """孤儿 PG 列：DROP（安全操作，已无 ORM 字段引用）。"""
        col_name = item.column_name
        if not col_name:
            raise ValueError(f'DriftItem missing column_name: {item}')

        from apps.tabdata.native.ddl_manager import _UUID_HEX_RE, _SAFE_IDENTIFIER_RE
        if not (_UUID_HEX_RE.match(col_name) or _SAFE_IDENTIFIER_RE.match(col_name)):
            raise ValueError(f'Unsafe column name: {col_name!r}')

        schema = DDLManager.schema_name(resolve_schema_partition_id(table))
        tbl = DDLManager.table_name(table.id)
        qualified = f'"{schema}"."{tbl}"'

        with transaction.atomic(using=self.db_alias):
            with connections[self.db_alias].cursor() as cursor:
                cursor.execute(
                    f'ALTER TABLE {qualified} DROP COLUMN IF EXISTS "{col_name}" CASCADE'
                )

    def _repair_ref_stale(self, item: DriftItem) -> None:
        """清理 stale FieldReference 边。"""
        ref_id = UUID(item.field_id)
        with transaction.atomic(using=self.db_alias):
            FieldReference.objects.using(self.db_alias).filter(id=ref_id).delete()

    def _repair_row_count(self, table: Table, item: DriftItem) -> None:
        """native 行少于 ORM 时，把缺失行回填到 native 表。

        反向情况（native 多于 ORM）标记为 ``auto_fixable=False``，不会进入此路径。
        """
        from apps.tabdata.native.record_io import NativeRecordIO

        partition_id = resolve_schema_partition_id(table)
        schema = DDLManager.schema_name(partition_id)
        tbl = DDLManager.table_name(table.id)
        qualified = f'"{schema}"."{tbl}"'

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(
                f'SELECT "__id" FROM {qualified}'
            )
            native_ids = {str(row[0]) for row in cursor.fetchall()}

        orm_records = list(
            TableRecord.objects.using(self.db_alias)
            .filter(table_id=table.id, is_deleted=False)
        )

        missing = [r for r in orm_records if str(r.id) not in native_ids]
        if not missing:
            return

        record_io = NativeRecordIO(db_alias=self.db_alias)

        active_fields = list(
            TableField.objects.using(self.db_alias)
            .filter(table_id=table.id, is_deleted=False)
        )

        with transaction.atomic(using=self.db_alias):
            for record in missing:
                try:
                    record_io.insert_record(
                        space_id=partition_id,
                        table_id=table.id,
                        record=record,
                        fields=active_fields,
                    )
                except Exception:
                    logger.warning(
                        'IntegrityV2: failed to backfill record %s in table %s',
                        record.id, table.id, exc_info=True,
                    )

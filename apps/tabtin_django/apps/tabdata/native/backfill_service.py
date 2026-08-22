"""
历史数据回填服务

将 TableRecord.data JSONField 中的历史数据回填到原生 PostgreSQL 列表。
使用 ON CONFLICT (__id) DO UPDATE 实现幂等性，支持断点续传。
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.utils.record_data_access import read_data
from .ddl_manager import DDLManager, resolve_schema_partition_id
from .feature_flags import NativeStoragePhase
from .pg_type_map import is_system_field
from .record_io import NativeRecordIO
from .value_converter import python_to_pg

logger = logging.getLogger('tabdata.native.backfill')

# 每批处理的记录数
BACKFILL_CHUNK_SIZE = 500


class BackfillService:
    """
    历史数据回填服务。

    将 JSONField 中的数据迁移到原生列表，支持：
    - 按表回填
    - 按 Space 回填
    - 全量回填
    - 进度查询
    """

    def __init__(self, chunk_size: int = BACKFILL_CHUNK_SIZE):
        self.chunk_size = chunk_size
        self.ddl = DDLManager()

    def backfill_table(
        self,
        table_id: UUID,
        *,
        force: bool = False,
    ) -> Dict[str, Any]:
        """
        回填单张表的历史数据。

        流程：
        1. 确保 schema / native table / 所有活跃字段列存在
        2. 按 created_at 分页遍历 TableRecord
        3. 每 chunk 批量 INSERT（ON CONFLICT DO UPDATE 幂等）
        4. 更新 NativeTableStatus

        Args:
            table_id: 表 ID
            force: 是否强制重新回填（即使已标记完成）

        Returns:
            {
                'table_id': str,
                'processed': int,
                'errors': int,
                'status': 'completed' | 'error',
                'message': str,
            }
        """
        from apps.tabdata.models import Table, TableField, TableRecord, NativeTableStatus

        result = {
            'table_id': str(table_id),
            'processed': 0,
            'errors': 0,
            'status': 'completed',
            'message': '',
        }

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        except Table.DoesNotExist:
            result['status'] = 'error'
            result['message'] = f'表不存在: {table_id}'
            return result

        space_id = resolve_schema_partition_id(table)

        # 检查是否已完成
        if not force:
            status = NativeTableStatus.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                backfill_completed=True,
            ).first()
            if status:
                result['message'] = '已完成回填，跳过（使用 force=True 强制重新回填）'
                result['processed'] = status.backfill_record_count
                return result

        # Step 1: 确保 DDL 就绪
        try:
            self.ddl.ensure_schema(space_id)
            self.ddl.create_native_table(space_id, table_id)
        except Exception as exc:
            result['status'] = 'error'
            result['message'] = f'DDL 创建失败: {exc}'
            return result

        # 同步字段列
        fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        ))
        user_fields = [f for f in fields if not is_system_field(f.field_type)]

        try:
            added, skipped = self.ddl.ensure_columns_synced(
                space_id, table_id, fields,
            )
            logger.info(
                'Backfill DDL ready: table=%s added=%d skipped=%d',
                table_id, added, skipped,
            )
        except Exception as exc:
            result['status'] = 'error'
            result['message'] = f'列同步失败: {exc}'
            return result

        # 更新迁移状态
        native_status, _ = NativeTableStatus.objects.using(TABDATA_DB_ALIAS).update_or_create(
            table_id=table_id,
            defaults={
                'native_table_created': True,
                'columns_synced': True,
            },
        )

        # Step 2: 分页回填记录
        native_io = NativeRecordIO(space_id, table_id)
        total_processed = 0
        total_errors = 0

        # 构建字段映射：field_id (UUID) → field 对象
        field_map = {}
        for f in user_fields:
            field_map[f.id] = f

        records_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        ).order_by('created_at')

        total_records = records_qs.count()
        logger.info('Starting backfill: table=%s total_records=%d', table_id, total_records)

        offset = 0
        while offset < total_records:
            chunk = list(records_qs[offset:offset + self.chunk_size])
            if not chunk:
                break

            batch_rows = []
            for record in chunk:
                try:
                    row = self._build_native_row(record, user_fields)
                    batch_rows.append(row)
                except Exception as exc:
                    total_errors += 1
                    logger.warning(
                        'Backfill row build error: record=%s err=%s',
                        record.id, exc,
                    )

            if batch_rows:
                try:
                    inserted = native_io.bulk_insert_records(batch_rows)
                    total_processed += inserted
                except Exception as exc:
                    total_errors += len(batch_rows)
                    logger.error(
                        'Backfill bulk insert error: table=%s chunk_offset=%d err=%s',
                        table_id, offset, exc,
                    )

            offset += self.chunk_size

            # 更新进度
            native_status.backfill_record_count = total_processed
            native_status.last_backfill_at = timezone.now()
            native_status.save(update_fields=['backfill_record_count', 'last_backfill_at', 'updated_at'])

            logger.info(
                'Backfill progress: table=%s processed=%d/%d errors=%d',
                table_id, total_processed, total_records, total_errors,
            )

        # Step 3: 标记完成
        native_status.backfill_completed = True
        native_status.backfill_record_count = total_processed
        native_status.last_backfill_at = timezone.now()
        native_status.save(update_fields=[
            'backfill_completed', 'backfill_record_count',
            'last_backfill_at', 'updated_at',
        ])

        result['processed'] = total_processed
        result['errors'] = total_errors
        if total_errors > 0:
            result['message'] = f'回填完成，但有 {total_errors} 条错误'
        else:
            result['message'] = f'回填完成，共 {total_processed} 条记录'

        logger.info(
            'Backfill completed: table=%s processed=%d errors=%d',
            table_id, total_processed, total_errors,
        )
        return result

    def backfill_space(
        self,
        space_id: UUID,
        *,
        force: bool = False,
    ) -> Dict[str, Any]:
        """
        回填整个 Space 的所有表。

        Returns:
            {
                'space_id': str,
                'tables': int,
                'total_processed': int,
                'total_errors': int,
                'details': [table_result, ...],
            }
        """
        from apps.tabdata.models import Table

        tables = list(Table.objects.using(TABDATA_DB_ALIAS).filter(
            space_id=space_id,
            is_archived=False,
        ).order_by('created_at'))

        summary = {
            'space_id': str(space_id),
            'tables': len(tables),
            'total_processed': 0,
            'total_errors': 0,
            'details': [],
        }

        for table in tables:
            table_result = self.backfill_table(table.id, force=force)
            summary['total_processed'] += table_result.get('processed', 0)
            summary['total_errors'] += table_result.get('errors', 0)
            summary['details'].append(table_result)

        logger.info(
            'Space backfill completed: space=%s tables=%d processed=%d errors=%d',
            space_id, len(tables),
            summary['total_processed'], summary['total_errors'],
        )
        return summary

    def backfill_all(self, *, force: bool = False) -> Dict[str, Any]:
        """
        回填所有 Space 的所有表。

        Returns:
            {
                'spaces': int,
                'tables': int,
                'total_processed': int,
                'total_errors': int,
            }
        """
        from apps.tabtinspace.models import Project, Workspace

        spaces = list(Workspace.objects.all().order_by('created_at')) + list(
            Project.objects.all().order_by('created_at')
        )

        summary = {
            'spaces': len(spaces),
            'tables': 0,
            'total_processed': 0,
            'total_errors': 0,
        }

        for space in spaces:
            space_result = self.backfill_space(space.id, force=force)
            summary['tables'] += space_result.get('tables', 0)
            summary['total_processed'] += space_result.get('total_processed', 0)
            summary['total_errors'] += space_result.get('total_errors', 0)

        logger.info(
            'Full backfill completed: spaces=%d tables=%d processed=%d errors=%d',
            summary['spaces'], summary['tables'],
            summary['total_processed'], summary['total_errors'],
        )
        return summary

    def get_status(
        self,
        table_id: Optional[UUID] = None,
        space_id: Optional[UUID] = None,
    ) -> List[Dict[str, Any]]:
        """
        查询回填状态。

        Args:
            table_id: 指定表（可选）
            space_id: 指定 Space（可选）

        Returns:
            NativeTableStatus 列表
        """
        from apps.tabdata.models import NativeTableStatus

        qs = NativeTableStatus.objects.using(TABDATA_DB_ALIAS).select_related('table').all()

        if table_id:
            qs = qs.filter(table_id=table_id)
        elif space_id:
            qs = qs.filter(table__space_id=space_id)

        results = []
        for status in qs.order_by('created_at'):
            results.append({
                'table_id': str(status.table_id),
                'table_name': status.table.name if status.table else '(unknown)',
                'native_table_created': status.native_table_created,
                'columns_synced': status.columns_synced,
                'backfill_completed': status.backfill_completed,
                'backfill_record_count': status.backfill_record_count,
                'last_backfill_at': status.last_backfill_at.isoformat() if status.last_backfill_at else None,
                'consistency_errors': status.consistency_errors,
                'created_at': status.created_at.isoformat(),
                'updated_at': status.updated_at.isoformat(),
            })

        return results

    # ──────────────────────────────────
    # 内部辅助
    # ──────────────────────────────────

    @staticmethod
    def _build_native_row(
        record,
        user_fields: list,
    ) -> Dict[str, Any]:
        """
        将 TableRecord 转换为原生表插入行。

        Returns:
            {
                '__id': UUID,
                '__order': float,
                '__version': int,
                '__created_at': datetime,
                '__updated_at': datetime,
                '__created_by': UUID,
                '__updated_by': UUID,
                'field_hex_1': pg_value,
                ...
            }
        """
        row: Dict[str, Any] = {
            '__id': record.id,
            '__order': float(record.order or 0),
            '__version': int(record.version or 1),
            '__created_at': record.created_at,
            '__updated_at': record.updated_at,
            '__created_by': record.created_by_id,
            '__updated_by': record.updated_by_id,
        }

        data = read_data(record)
        for field in user_fields:
            field_id_str = str(field.id)
            field_id_hex = field.id.hex

            # record.data 的 key 可能是 UUID 字符串（带连字符）
            value = data.get(field_id_str)
            if value is None:
                # 也尝试不带连字符的 hex
                value = data.get(field_id_hex)

            if value is not None:
                pg_value = python_to_pg(value, field.field_type, field.config)
                row[field_id_hex] = pg_value
            # None 值不写入行，依赖数据库默认值

        return row

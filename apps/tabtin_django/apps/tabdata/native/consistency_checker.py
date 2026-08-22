"""
数据一致性校验服务

对比 TableRecord.data（JSONField）与原生 PostgreSQL 列表中的数据，
找出不一致的记录、缺失的记录、以及多余的记录。

用于 Phase 2 switch_read 阶段验证双写数据的正确性。
"""

import logging
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from django.db import connections

from apps.tabdata.utils.record_data_access import read_data
from .ddl_manager import DDLManager, resolve_schema_partition_id
from apps.tabdata.constants import TABDATA_DB_ALIAS as DB_ALIAS, FILE_BASED_FIELD_TYPES
from .pg_type_map import is_system_field
from .value_converter import pg_to_python, python_to_pg

logger = logging.getLogger('tabdata.native.consistency')

_JSONB_FIELD_TYPES = FILE_BASED_FIELD_TYPES | frozenset({
    'multi_select', 'link', 'user',
})


class ConsistencyChecker:
    """
    JSONField ↔ 原生列数据一致性校验。

    支持：
    - 采样校验（快速巡检）
    - 全量校验（上线前全面检查）
    """

    def __init__(self, db_alias: str = DB_ALIAS):
        self.db_alias = db_alias

    def check_table(
        self,
        table_id: UUID,
        *,
        sample_size: int = 1000,
        verbose: bool = False,
    ) -> Dict[str, Any]:
        """
        校验单张表的数据一致性。

        Args:
            table_id: 表 ID
            sample_size: 采样数量（0 = 全量）
            verbose: 是否记录每条 mismatch 的详细信息

        Returns:
            {
                'table_id': str,
                'table_name': str,
                'checked': int,          # 检查的记录数
                'mismatches': int,        # 不一致记录数
                'missing_native': int,    # JSON 有但 native 缺失
                'extra_native': int,      # native 有但 JSON 缺失
                'field_mismatches': int,  # 字段值不一致
                'details': [...]          # verbose=True 时的详细信息
            }
        """
        from apps.tabdata.models import Table, TableField, TableRecord

        result = {
            'table_id': str(table_id),
            'table_name': '',
            'checked': 0,
            'mismatches': 0,
            'missing_native': 0,
            'extra_native': 0,
            'field_mismatches': 0,
            'details': [],
        }

        try:
            table = Table.objects.using(DB_ALIAS).get(id=table_id)
        except Table.DoesNotExist:
            result['error'] = f'表不存在: {table_id}'
            return result

        result['table_name'] = table.name
        space_id = resolve_schema_partition_id(table)

        # 加载字段
        fields = list(TableField.objects.using(DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        ))
        user_fields = [f for f in fields if not is_system_field(f.field_type)]
        field_map = {str(f.id): f for f in user_fields}

        # 获取 JSON 端记录
        json_qs = TableRecord.objects.using(DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        ).order_by('created_at')

        if sample_size > 0:
            json_records = list(json_qs[:sample_size])
        else:
            json_records = list(json_qs)

        json_ids = {str(r.id) for r in json_records}
        result['checked'] = len(json_records)

        if not json_records:
            return result

        # 获取 native 端记录
        schema = DDLManager.schema_name(space_id)
        tbl = DDLManager.table_name(table_id)
        qualified = f'"{schema}"."{tbl}"'

        # 构建 field 列名列表
        field_col_names = [f.id.hex for f in user_fields]
        system_cols = [
            '__id', '__order', '__version',
            '__created_at', '__updated_at',
            '__created_by', '__updated_by',
        ]
        all_cols = system_cols + [f'"{c}"' for c in field_col_names]
        select_clause = ', '.join(
            [f'"{c}"' for c in system_cols] + [f'"{c}"' for c in field_col_names]
        )

        # 查询所有采样记录在 native 表中的数据
        record_id_strs = [str(r.id) for r in json_records]
        placeholders = ', '.join(['%s'] * len(record_id_strs))

        try:
            with connections[self.db_alias].cursor() as cursor:
                sql = (
                    f'SELECT {select_clause} FROM {qualified} '
                    f'WHERE "__id" IN ({placeholders})'
                )
                cursor.execute(sql, record_id_strs)
                col_names = [desc[0] for desc in cursor.description]
                native_rows_raw = cursor.fetchall()
        except Exception as exc:
            result['error'] = f'Native 查询失败: {exc}'
            return result

        native_by_id = {}
        for row_tuple in native_rows_raw:
            row_dict = dict(zip(col_names, row_tuple))
            rid = str(row_dict.get('__id', ''))
            native_by_id[rid] = row_dict

        native_ids = set(native_by_id.keys())

        # 检查缺失
        missing_native = json_ids - native_ids
        result['missing_native'] = len(missing_native)
        result['mismatches'] += len(missing_native)

        if verbose and missing_native:
            for rid in list(missing_native)[:50]:
                result['details'].append({
                    'record_id': rid,
                    'type': 'missing_native',
                    'message': 'JSON 中存在但 native 表中缺失',
                })

        # 检查多余（native 中有但 JSON 中没有，在采样范围外不算）
        extra_native = native_ids - json_ids
        result['extra_native'] = len(extra_native)

        # 逐条对比字段值
        for record in json_records:
            rid = str(record.id)
            if rid in missing_native:
                continue

            native_row = native_by_id.get(rid)
            if not native_row:
                continue

            json_data = read_data(record)
            mismatch_fields = []

            for field in user_fields:
                field_id_str = str(field.id)
                field_hex = field.id.hex

                # 从 JSON 取值
                json_value = json_data.get(field_id_str)
                if json_value is None:
                    json_value = json_data.get(field_hex)

                # 从 native 取值
                native_raw = native_row.get(field_hex)
                if native_raw is not None:
                    native_value = pg_to_python(native_raw, field.field_type, field.config)
                else:
                    native_value = None

                # 比较
                if not self._values_equal(json_value, native_value, field.field_type):
                    mismatch_fields.append({
                        'field_id': field_id_str,
                        'field_name': field.name,
                        'json_value': self._safe_repr(json_value),
                        'native_value': self._safe_repr(native_value),
                    })

            if mismatch_fields:
                result['field_mismatches'] += len(mismatch_fields)
                result['mismatches'] += 1

                if verbose:
                    result['details'].append({
                        'record_id': rid,
                        'type': 'field_mismatch',
                        'fields': mismatch_fields[:10],  # 每条记录最多 10 个字段
                    })

        logger.info(
            'Consistency check completed: table=%s checked=%d mismatches=%d '
            'missing_native=%d extra_native=%d field_mismatches=%d',
            table_id, result['checked'], result['mismatches'],
            result['missing_native'], result['extra_native'],
            result['field_mismatches'],
        )

        return result

    def check_space(
        self,
        space_id: UUID,
        *,
        sample_size: int = 1000,
    ) -> Dict[str, Any]:
        """
        校验整个 Space 的数据一致性。

        Returns:
            {
                'space_id': str,
                'tables': int,
                'total_checked': int,
                'total_mismatches': int,
                'details': [table_result, ...],
            }
        """
        from apps.tabdata.models import Table, NativeTableStatus

        tables = list(Table.objects.using(DB_ALIAS).filter(
            space_id=space_id,
            is_archived=False,
        ).order_by('created_at'))

        native_table_ids = set(
            NativeTableStatus.objects.using(DB_ALIAS).filter(
                table_id__in=[t.id for t in tables],
                native_table_created=True,
            ).values_list('table_id', flat=True)
        )

        summary = {
            'space_id': str(space_id),
            'tables': 0,
            'total_checked': 0,
            'total_mismatches': 0,
            'details': [],
        }

        for table in tables:
            if table.id not in native_table_ids:
                continue

            table_result = self.check_table(
                table.id,
                sample_size=sample_size,
            )
            summary['tables'] += 1
            summary['total_checked'] += table_result.get('checked', 0)
            summary['total_mismatches'] += table_result.get('mismatches', 0)
            summary['details'].append(table_result)

        logger.info(
            'Space consistency check: space=%s tables=%d checked=%d mismatches=%d',
            space_id, summary['tables'],
            summary['total_checked'], summary['total_mismatches'],
        )

        return summary

    # ──────────────────────────────────
    # 辅助方法
    # ──────────────────────────────────

    @staticmethod
    def _values_equal(json_val: Any, native_val: Any, field_type: str) -> bool:
        """
        比较 JSON 端和 native 端的值是否语义相等。

        处理类型差异（如 JSON 中 number 可能是 str，native 中是 float）。
        """
        # 都是 None → 相等
        if json_val is None and native_val is None:
            return True

        # 一边 None → 不等
        if json_val is None or native_val is None:
            return False

        # 布尔类型
        if field_type in ('checkbox', 'boolean'):
            return bool(json_val) == bool(native_val)

        # 数字类型
        if field_type in ('number', 'rating', 'currency', 'percent'):
            try:
                jf = float(json_val) if json_val is not None else None
                nf = float(native_val) if native_val is not None else None
                if jf is None and nf is None:
                    return True
                if jf is None or nf is None:
                    return False
                return abs(jf - nf) < 1e-9
            except (TypeError, ValueError):
                return str(json_val) == str(native_val)

        if field_type in _JSONB_FIELD_TYPES:
            import json
            try:
                js = json.dumps(json_val, sort_keys=True, default=str)
                ns = json.dumps(native_val, sort_keys=True, default=str)
                return js == ns
            except (TypeError, ValueError):
                return str(json_val) == str(native_val)

        # 日期类型
        if field_type == 'date':
            try:
                j_str = str(json_val)[:19] if json_val else ''
                n_str = str(native_val)[:19] if native_val else ''
                return j_str == n_str
            except Exception:
                return str(json_val) == str(native_val)

        # 文本类型 fallback
        return str(json_val) == str(native_val)

    @staticmethod
    def _safe_repr(value: Any) -> str:
        """安全的值表示（用于日志/报告）"""
        if value is None:
            return '<None>'
        s = str(value)
        if len(s) > 200:
            return s[:200] + '...'
        return s

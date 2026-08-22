"""TabData 自定义 context builder。

为 Agent 提供当前表格的结构化上下文：表名、字段列表（SQL-ready）、行数。
包含 TTL 缓存以避免每次 iteration 重复查库。
"""

import time
import logging
from typing import Dict, List

logger = logging.getLogger(__name__)

_SUMMARY_TTL = 120  # 2 minutes
_MAX_CACHE_SIZE = 10


class TableContextBuilder:
    """构建 TabData 的 Agent 上下文。

    缓存策略：按 table_id 缓存查询结果，TTL 120 秒，最多 10 条。
    """

    def __init__(self):
        self._cache: Dict[str, tuple[List[str], float]] = {}

    def build(self, state: dict, context: dict) -> List[str]:
        table_id = state.get("current_table_id") or context.get("current_table_id")
        if not table_id:
            return []

        table_id_str = str(table_id)
        view_id = state.get("current_view_id") or context.get("current_view_id")

        cached = self._cache.get(table_id_str)
        if cached:
            lines, ts = cached
            if (time.time() - ts) < _SUMMARY_TTL:
                return list(lines)

        user_id = state.get("user_id")
        organization_id = state.get("organization_id")

        try:
            from apps.services.tools.domains.chat.permission_checker import TablePermissionChecker
            from apps.tabdata.models import TableRecord, TableField
        except Exception as exc:
            logger.warning("[TableContextBuilder] Failed to load table info: %s", exc)
            return [
                "Current table:",
                f"  table_id: {table_id}",
                "  (unable to load details)",
            ]

        table, error = TablePermissionChecker.get_table_with_permission(
            user_id=user_id,
            table_id=table_id,
            organization_id=organization_id,
        )
        if error or not table:
            return [
                "Current table:",
                f"  table_id: {table_id}",
                f"  access_error: {error or 'Unable to get table info'}",
            ]

        fields_qs = TableField.objects.filter(
            table_id=table_id, is_deleted=False,
        ).order_by("order", "created_at")
        field_list = list(fields_qs[:30])
        field_count = fields_qs.count()
        total_rows = TableRecord.objects.filter(table_id=table_id, is_deleted=False).count()
        table_name = getattr(table, "name", "") or "Untitled"

        summary = [
            f'Current table: "{table_name}" ({field_count} fields, {total_rows} rows)',
            "SQL-ready fields (use these names directly in SQL — system auto-resolves):",
        ]
        for f in field_list:
            summary.append(f'  - "{f.name}" ({f.field_type})')
        if field_count > len(field_list):
            summary.append(f"  ... +{field_count - len(field_list)} more (use sql_catalog to see all)")
        summary.append("System fields: __id(UUID), __auto_number, __created_at, __updated_at")
        if view_id:
            summary.append(f"current_view_id: {view_id}")
        summary.append("TIP: No need to call sql_catalog for this table — use the field names above directly.")

        self._cache[table_id_str] = (list(summary), time.time())
        if len(self._cache) > _MAX_CACHE_SIZE:
            oldest_key = min(self._cache, key=lambda k: self._cache[k][1])
            del self._cache[oldest_key]

        return summary

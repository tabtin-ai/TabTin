"""CascadeService 适配器。"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from django.db import connections

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.domain.ports import ICascadeService

logger = logging.getLogger("tabdata.infrastructure.cascade_adapter")


class DjangoCascadeAdapter(ICascadeService):
    """ICascadeService 的 Django 实现。"""

    def propagate_cell_changes(
        self,
        table_id: str,
        changed_field_ids: List[str],
        record_ids: List[str],
    ) -> List[Dict[str, Any]]:
        """委托给 CascadeService.propagate_cell_changes。

        CascadeService 内部已处理 UUID 规范化和引用传播，
        此处仅保证参数为 str 类型后直接委托。

        adapter 层提供更早的事务边界检查，handler 路径若漏开 atomic，
        异常栈在此处即可定位,无需到 CascadeService 主入口才报错。
        """
        if not connections[TABDATA_DB_ALIAS].in_atomic_block:
            raise RuntimeError(
                "DjangoCascadeAdapter.propagate_cell_changes 必须在 "
                "transaction.atomic(using=TABDATA_DB_ALIAS) 上下文内调用 "
                "（关联标题传播必须与记录写入处于同一事务）"
            )

        from apps.tabdata.services.cascade_service import CascadeService

        str_field_ids = [str(fid) for fid in changed_field_ids]
        str_record_ids = [str(rid) for rid in record_ids]
        logger.debug(
            "propagate_cell_changes: table=%s fields=%d records=%d",
            table_id, len(str_field_ids), len(str_record_ids),
        )
        return CascadeService.propagate_cell_changes(
            table_id=str(table_id),
            changed_field_ids=str_field_ids,
            record_ids=str_record_ids,
        )

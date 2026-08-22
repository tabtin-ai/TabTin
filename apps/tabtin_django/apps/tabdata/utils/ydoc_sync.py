"""Y.js / Y.Doc 协同层记录推送（与 collab-live 对齐）。"""
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableField, TableRecord
from apps.tabdata.subscribers._utils import run_after_commit
from apps.tabdata.utils.record_data_access import read_data

logger = logging.getLogger(__name__)

_COLLAB_PUSH_BATCH_SIZE = 200
_UPSERT_RECORD_CHANGE_TYPE = "upsert_record"


def _resolve_record_field_value(record_data: dict, field) -> tuple[bool, Any]:
    """Return whether a field is present plus its value, accepting dashed, hex, and name keys."""
    for candidate in (str(field.id), field.id.hex, getattr(field, "name", None)):
        if candidate and candidate in record_data:
            return True, record_data[candidate]
    return False, None


def sync_records_to_ydoc(
    table_id: UUID,
    records: List[TableRecord],
    fields: Optional[List] = None,
    *,
    deleted_record_ids: Optional[List[str]] = None,
    upsert_record_ids: Optional[List[str]] = None,
    reorder_record_ids: Optional[List[str]] = None,
    rebalance_record_ids: Optional[List[str]] = None,
    source: str = "record_service",
) -> None:
    """
    Fire-and-forget: 将记录变更推送到 Y.js 协同层。

    - records: 新增或更新的记录（从 record.data 中提取字段值）
    - deleted_record_ids: 已删除的记录 ID（用于从 Y.Doc 中移除）
    - upsert_record_ids: 需要显式恢复行存在性的记录 ID（用于 undo delete）
    - reorder_record_ids: DB-first 旧链路已重排的记录 ID；按提交后的 ``order``
      计算前驱，并让 collab-live 原子重算 PositionId 与 legacy 投影
    - rebalance_record_ids: 仅重建 legacy 坐标、相对顺序不变的记录 ID；清除
      在线 Y.Doc 的旧 PositionId，但不触发新的排序分配
    - 分批推送，每批 200 条，失败仅日志不阻断
    """
    try:
        changes: list = []

        if fields is None:
            fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
            )
        upsert_record_id_set = {str(rid) for rid in (upsert_record_ids or [])}
        reorder_record_id_set = {str(rid) for rid in (reorder_record_ids or [])}
        rebalance_record_id_set = {str(rid) for rid in (rebalance_record_ids or [])}
        #  / ：新建行用 __order 前驱 + order.after，避免 order.set 写入 ORM
        # 数字 position 后与 fractional 字符串混排时沉到表头。
        upsert_ids_ordered = [
            str(record.id) for record in records if str(record.id) in upsert_record_id_set
        ]
        anchor_map: Dict[str, Optional[str]] = {}
        if upsert_ids_ordered:
            from apps.tabdata.subscribers.collab_ydoc import CollabYDocSubscriber

            anchor_map = CollabYDocSubscriber._compute_anchor_map(
                table_id, upsert_ids_ordered,
            )

        reorder_ids_ordered = [
            str(record.id) for record in records if str(record.id) in reorder_record_id_set
        ]
        reorder_anchor_map: Dict[str, Optional[str]] = {}
        if reorder_ids_ordered:
            from apps.tabdata.subscribers.collab_ydoc import CollabYDocSubscriber

            # 复用提交后 DB order 的严格前驱计算。多行移动时，后一行的前驱自然
            # 是前一条 moved row，避免每条都插到同一 anchor 后而倒序。
            reorder_anchor_map = CollabYDocSubscriber._compute_anchor_map(
                table_id, reorder_ids_ordered,
            )

        for record in records:
            record_id_str = str(record.id)

            if record_id_str in upsert_record_id_set:
                record_data = read_data(record)
                fields_payload = {}
                for field in fields:
                    exists, value = _resolve_record_field_value(record_data, field)
                    if exists:
                        fields_payload[field.id.hex] = value
                changes.append({
                    "record_id": record_id_str,
                    "type": _UPSERT_RECORD_CHANGE_TYPE,
                    "fields": fields_payload,
                    "order": float(record.order) if record.order is not None else 0.0,
                    "after_record_id": anchor_map.get(record_id_str),
                })
                continue

            if record_id_str in reorder_record_id_set:
                changes.append({
                    "record_id": record_id_str,
                    "type": "reorder_record",
                    "order": float(record.order) if record.order is not None else 0.0,
                    "after_record_id": reorder_anchor_map.get(record_id_str),
                })

            if record_id_str in rebalance_record_id_set:
                changes.append({
                    "record_id": record_id_str,
                    "type": "rebalance_record_order",
                    "order": float(record.order) if record.order is not None else 0.0,
                })

            if not fields:
                continue
            record_data = read_data(record)
            for field in fields:
                exists, value = _resolve_record_field_value(record_data, field)
                if exists:
                    changes.append({
                        "record_id": record_id_str,
                        "field_id_hex": field.id.hex,
                        "value": value,
                    })

        if deleted_record_ids:
            for rid in deleted_record_ids:
                changes.append({
                    "record_id": rid,
                    "type": "delete",
                })

        if not changes:
            return

        # collab-live 在 direct connection 建立时会回源 Django 拉 snapshot。
        # 如果当前仍在事务里，回源请求可能看不到未提交的数据，导致 snapshot 404 / push 500。
        # 因此事务内统一延迟到 commit 后再推送。
        def _push_after_commit() -> None:
            try:
                from apps.tabdata.services.collab_service import CollabService

                for i in range(0, len(changes), _COLLAB_PUSH_BATCH_SIZE):
                    batch = changes[i:i + _COLLAB_PUSH_BATCH_SIZE]
                    try:
                        CollabService.push_cells(
                            table_id=table_id,
                            changes=batch,
                            agent_id=f"system:{source}",
                            editor_type="system",
                        )
                    except Exception as exc:
                        logger.warning(
                            "Y.js sync failed (non-blocking): table=%s source=%s batch=%d/%d err=%s",
                            table_id, source, i // _COLLAB_PUSH_BATCH_SIZE + 1,
                            (len(changes) + _COLLAB_PUSH_BATCH_SIZE - 1) // _COLLAB_PUSH_BATCH_SIZE,
                            exc,
                        )
            except Exception as exc:
                logger.warning("_sync_records_to_ydoc push failed: %s", exc)

        run_after_commit(_push_after_commit)
    except Exception as exc:
        logger.warning("_sync_records_to_ydoc setup failed: %s", exc)


_YDOC_BATCH_SIZE = 2000


def batch_sync_all_records_to_ydoc(
    table_id: UUID,
    *,
    source: str = "batch_sync",
) -> None:
    """
    分批将表的所有未删除记录同步到 Y.js 协同层，无硬上限。

    每批 2000 条，按 pk 有序切片确保分页稳定。
    Best-effort：单批失败仅日志，不影响后续批次。
    """
    _offset = 0
    while True:
        _batch = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id, is_deleted=False,
            ).only('id', 'table_id').order_by('pk')[_offset:_offset + _YDOC_BATCH_SIZE]
        )
        if not _batch:
            break
        try:
            sync_records_to_ydoc(table_id, _batch, source=source)
        except Exception as exc:
            logger.warning(
                "batch_sync_all_records_to_ydoc failed: table=%s source=%s offset=%d err=%s",
                table_id, source, _offset, exc,
            )
        if len(_batch) < _YDOC_BATCH_SIZE:
            break
        _offset += _YDOC_BATCH_SIZE

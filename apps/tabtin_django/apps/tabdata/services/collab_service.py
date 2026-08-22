"""
表格协作服务

为 collab-live Table Database Extension 提供：
- build_snapshot: 构建表格初始 Y.Doc 所需的全量快照
- persist_changes: 将 Y.Doc 增量变更写入 PostgreSQL

调用方：collab-live (通过 X-Live-Secret 认证)
"""
import logging
import math
from typing import Any, Dict, Iterable, List, Optional, Set
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import DatabaseError, connections, transaction
from django.db.models import F
from django.utils import timezone

import uuid as _uuid_mod

from apps.tabdata.api_utils import serialize_view_payload
from apps.tabdata.history_events import emit_record_history_event
from apps.tabdata.models import Table, TableRecord, TableField, TableView, RecordHistory, RecordHistoryItem
from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.native.value_converter import python_to_pg, pg_to_python
from apps.tabdata.request_context import get_current_window_id
from apps.tabdata.constants import COLLAB_SNAPSHOT_MAX_ROWS, SYSTEM_MANAGED_FIELD_TYPES, TABDATA_DB_ALIAS
from apps.tabdata.services.record_service import ORDER_REBALANCE_STEP, next_record_version
from apps.tabdata.services.table_event_service import table_event_service
from apps.tabdata.services.view_version_sync import mark_table_record_delete_version
from apps.tabdata.utils.field_types import validate_field_value
from apps.tabdata.utils.field_validation_rules import validate_with_rules

COLLAB_STRICT_VALIDATE_TYPES = frozenset((
    'number', 'rating', 'date', 'email',
    'select', 'multi_select', 'checkbox', 'link', 'attachment',
    'url', 'phone', 'currency', 'percent', 'duration',
))

logger = logging.getLogger(__name__)
User = get_user_model()

COLLAB_POSITION_ID_KEY = "__position_id"
COLLAB_POSITION_ID_PREFIX = "p1:"
COLLAB_POSITION_KEY_MAX_LENGTH = 1024
_FRACTIONAL_POSITION_DIGITS = frozenset(
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)


def _is_valid_collab_position_id(value: Any) -> bool:
    """Validate the persisted p1 envelope without accepting arbitrary strings."""
    if not isinstance(value, str) or not value.startswith(COLLAB_POSITION_ID_PREFIX):
        return False

    key = value[len(COLLAB_POSITION_ID_PREFIX):]
    if not key or len(key) > COLLAB_POSITION_KEY_MAX_LENGTH:
        return False
    if any(char not in _FRACTIONAL_POSITION_DIGITS for char in key):
        return False

    head = key[0]
    if 'a' <= head <= 'z':
        integer_length = ord(head) - ord('a') + 2
    elif 'A' <= head <= 'Z':
        integer_length = ord('Z') - ord(head) + 2
    else:
        return False
    if len(key) < integer_length:
        return False
    if key == 'A' + ('0' * 26):
        return False
    fraction = key[integer_length:]
    return not fraction.endswith('0')

#: ``_sync_collab_link_cell`` 的哨兵返回值：表示该 link cell 变更被拒绝
#: （如子记录父字段形成环或超深度），调用方应跳过该字段、保留旧值。
_LINK_SYNC_SKIP = object()

#: collab-live 的 op_id 形如 ``collab_<ts>_<rand>``，不是合法 UUID。用固定命名空间
#: 派生确定性 UUID 作为 operation_group_id，使同一 op_id（幂等重试）总映射到同一分组，
#: 让批量操作产生的多条 RecordHistory 能被前端按 operation_group_id 聚合成一条。
_COLLAB_OP_ID_NAMESPACE = _uuid_mod.UUID('6f2b6e2e-6f8b-4b8a-9c2e-6f3a2b1d7e4a')


def _read_collab_position_id(field_values: Dict[str, Any], *, record_id: str) -> tuple[bool, Optional[str]]:
    """Read the reserved collab position value without accepting arbitrary JSON."""
    if COLLAB_POSITION_ID_KEY not in field_values:
        return False, None

    value = field_values[COLLAB_POSITION_ID_KEY]
    if value is None:
        return True, value

    if isinstance(value, str):
        if _is_valid_collab_position_id(value):
            return True, value
        logger.warning(
            "collab-persist: invalid %s protocol value for record=%s, clearing",
            COLLAB_POSITION_ID_KEY,
            record_id,
        )
        return True, None

    logger.warning(
        "collab-persist: invalid %s type for record=%s, ignoring",
        COLLAB_POSITION_ID_KEY,
        record_id,
    )
    return False, None


def _snapshot_position_id(record_data: Any, *, record_id: str) -> Optional[str]:
    """Return the position value accepted by a snapshot, clearing malformed values."""
    if not isinstance(record_data, dict):
        return None

    value = record_data.get(COLLAB_POSITION_ID_KEY)
    if value is None:
        return value

    if isinstance(value, str) and _is_valid_collab_position_id(value):
        return value

    logger.warning(
        "restore_from_snapshot: invalid %s type for record=%s, clearing",
        COLLAB_POSITION_ID_KEY,
        record_id,
    )
    return None


def _snapshot_legacy_order(
    record_data: Any,
    *,
    record_id: str,
    fallback: float,
) -> float:
    """Restore an exact legacy coordinate when the snapshot carries one."""
    if not isinstance(record_data, dict):
        return fallback

    has_order, order = _read_collab_legacy_order(
        record_data,
        record_id=record_id,
    )
    if has_order and order is not None:
        return order
    return fallback


def _read_collab_legacy_order(
    field_values: Dict[str, Any],
    *,
    record_id: str,
) -> tuple[bool, Optional[float]]:
    """Read the stable per-record legacy coordinate written by TabData clients."""
    if "__order" not in field_values:
        return False, None

    value = field_values["__order"]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        logger.warning(
            "collab-persist: invalid __order type for record=%s, ignoring",
            record_id,
        )
        return False, None
    normalized = float(value)
    if not math.isfinite(normalized):
        logger.warning(
            "collab-persist: non-finite __order for record=%s, ignoring",
            record_id,
        )
        return False, None
    return True, normalized


def _collab_validate_field_rules(field: TableField, api_value: Any) -> Optional[str]:
    """协作落库时执行 validation_rules。

    Returns:
        失败原因字符串；通过时返回 None。
    """
    rules = dict(field.validation_rules or {})
    if not rules:
        return None
    is_valid, rule_error = validate_with_rules(rules, api_value)
    if is_valid:
        return None
    return rule_error or '字段验证规则未通过'


def _derive_operation_group_id(op_id: Optional[str]) -> Optional[UUID]:
    """将 collab-live 的 op_id 归一化为 operation_group_id。

    合法 UUID 直接使用；否则用 uuid5 派生确定性 UUID（同一 op_id 总得到同一结果），
    使同一次协作 persist 产生的多条 RecordHistory 仍能共享同一分组 ID。
    """
    if not op_id:
        return None
    try:
        return UUID(str(op_id))
    except (TypeError, ValueError):
        derived = _uuid_mod.uuid5(_COLLAB_OP_ID_NAMESPACE, str(op_id))
        logger.debug(
            "collab-persist: op_id=%r 不是合法 UUID，派生 operation_group_id=%s 用于分组",
            op_id, derived,
        )
        return derived


def _link_cell_to_linked_ids(api_value: Any) -> List[str]:
    """从 Y.Doc link cell 值中提取目标记录 ID 列表。

    link cell 的稳定表征是单值 ``{id,title}`` 或多值 ``[{id,title}]``，空为 None。
    """
    if isinstance(api_value, list):
        return [
            str(item['id'])
            for item in api_value
            if isinstance(item, dict) and item.get('id')
        ]
    if isinstance(api_value, dict) and api_value.get('id'):
        return [str(api_value['id'])]
    return []


def _canonical_record_id(value: Any) -> Optional[str]:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError):
        return None


def _normalize_row_order_ids(row_order: Iterable[str] | None) -> List[str]:
    seen: Set[str] = set()
    normalized: List[str] = []
    for raw_id in row_order or []:
        record_id = _canonical_record_id(raw_id)
        if not record_id or record_id in seen:
            continue
        seen.add(record_id)
        normalized.append(record_id)
    return normalized


def _record_order_value(record: TableRecord) -> float:
    try:
        return float(record.order or 0)
    except (TypeError, ValueError):
        return 0.0


def _record_order_key(record: TableRecord) -> tuple[float, str, str]:
    order_value = _record_order_value(record)
    created_at = getattr(record, 'created_at', None)
    created_key = created_at.isoformat() if created_at else ''
    return (order_value, created_key, str(record.id))


def _find_reordered_record_ids(
    previous_order: List[str],
    next_order: List[str],
) -> List[str]:
    """Return the smallest moved-row set using the preserved LIS."""
    target_index = {record_id: index for index, record_id in enumerate(next_order)}
    sequence = [
        (current_index, target_index[record_id])
        for current_index, record_id in enumerate(previous_order)
        if record_id in target_index
    ]
    tails: List[int] = []
    previous = [-1] * len(sequence)
    for sequence_index, (_current_index, next_index) in enumerate(sequence):
        low = 0
        high = len(tails)
        while low < high:
            middle = (low + high) // 2
            if sequence[tails[middle]][1] < next_index:
                low = middle + 1
            else:
                high = middle
        if low > 0:
            previous[sequence_index] = tails[low - 1]
        if low == len(tails):
            tails.append(sequence_index)
        else:
            tails[low] = sequence_index

    kept_current_indices: Set[int] = set()
    cursor = tails[-1] if tails else -1
    while cursor >= 0:
        kept_current_indices.add(sequence[cursor][0])
        cursor = previous[cursor]
    kept_ids = {
        record_id
        for index, record_id in enumerate(previous_order)
        if index in kept_current_indices
    }
    return [record_id for record_id in next_order if record_id not in kept_ids]


def _row_order_reorders_existing_records(
    row_order: List[str],
    existing_records: Dict[str, TableRecord],
    deleted_record_ids: Set[str],
) -> bool:
    """Return true only when existing, non-deleted rows changed relative order."""
    row_order_existing = [
        record_id for record_id in row_order
        if record_id in existing_records and record_id not in deleted_record_ids
    ]
    current_existing_order = sorted(
        row_order_existing,
        key=lambda record_id: _record_order_key(existing_records[record_id]),
    )
    if row_order_existing != current_existing_order:
        return True

    # If a new row is inserted between two existing rows with no strict numeric
    # order gap (for example legacy duplicate __order values), assigning only
    # the new row an order would place it outside the intended visual slot.
    # Treat it as a row-order rewrite so all involved rows get fresh spacing.
    index = 0
    while index < len(row_order):
        record_id = row_order[index]
        if record_id in existing_records or record_id in deleted_record_ids:
            index += 1
            continue

        group_start = index
        while (
            index < len(row_order)
            and row_order[index] not in existing_records
            and row_order[index] not in deleted_record_ids
        ):
            index += 1

        left_record = None
        for left_index in range(group_start - 1, -1, -1):
            left_id = row_order[left_index]
            if left_id in existing_records and left_id not in deleted_record_ids:
                left_record = existing_records[left_id]
                break

        right_record = None
        for right_index in range(index, len(row_order)):
            right_id = row_order[right_index]
            if right_id in existing_records and right_id not in deleted_record_ids:
                right_record = existing_records[right_id]
                break

        if (
            left_record is not None
            and right_record is not None
            and _record_order_value(right_record) <= _record_order_value(left_record)
        ):
            return True

    return False


def _collect_row_order_ghost_ids(
    row_order: List[str],
    existing_records: Dict[str, TableRecord],
    new_record_ids: Set[str],
    deleted_record_ids: Set[str],
) -> List[str]:
    """找出 row_order 中既非活跃 ORM、亦非本批新建/删除的幽灵锚点 ID。

    典型来源：ORM 已软删但 native / Y.Doc 仍保留该行。这类 ID 若作为新行邻居，
    会导致顺序解析失去锚点并静默回退到 ORDER_REBALANCE_STEP(1024)。
    """
    ghosts: List[str] = []
    seen: Set[str] = set()
    for record_id in row_order:
        if (
            record_id in existing_records
            or record_id in new_record_ids
            or record_id in deleted_record_ids
            or record_id in seen
        ):
            continue
        seen.add(record_id)
        ghosts.append(record_id)
    return ghosts


def _resolve_new_record_orders_from_row_order(
    row_order: List[str],
    existing_records: Dict[str, TableRecord],
    new_record_ids: Set[str],
    deleted_record_ids: Set[str],
    *,
    anchor_order_hints: Optional[Dict[str, float]] = None,
) -> Dict[str, float]:
    """Assign orders to new rows from their position in row_order without moving old rows.

    ``anchor_order_hints`` 用于 ORM/native 分叉场景：软删或仅 native 残留行的 order
    可作为只读锚点，避免新行因邻居不可见而静默落到 1024。调用方必须先记录
    DATA INTEGRITY 诊断，不得把 hints 当成「数据已干净」。
    """
    if not row_order or not new_record_ids:
        return {}

    order_values: Dict[str, float] = {}
    for record_id, record in existing_records.items():
        if record_id in deleted_record_ids:
            continue
        try:
            order_values[record_id] = float(record.order or 0)
        except (TypeError, ValueError):
            order_values[record_id] = 0.0

    if anchor_order_hints:
        for record_id, order_value in anchor_order_hints.items():
            if (
                record_id in order_values
                or record_id in deleted_record_ids
                or record_id in new_record_ids
            ):
                continue
            try:
                order_values[record_id] = float(order_value)
            except (TypeError, ValueError):
                continue

    resolved: Dict[str, float] = {}
    index = 0
    while index < len(row_order):
        record_id = row_order[index]
        if record_id not in new_record_ids:
            index += 1
            continue

        group_start = index
        group: List[str] = []
        while index < len(row_order) and row_order[index] in new_record_ids:
            group.append(row_order[index])
            index += 1

        left_order: Optional[float] = None
        for left_index in range(group_start - 1, -1, -1):
            left_id = row_order[left_index]
            if left_id in order_values:
                left_order = order_values[left_id]
                break

        right_order: Optional[float] = None
        for right_index in range(index, len(row_order)):
            right_id = row_order[right_index]
            if right_id in order_values:
                right_order = order_values[right_id]
                break

        if left_order is not None and right_order is not None and right_order > left_order:
            step = (right_order - left_order) / (len(group) + 1)
            first_order = left_order + step
        elif left_order is not None:
            step = ORDER_REBALANCE_STEP
            first_order = left_order + step
        elif right_order is not None:
            step = ORDER_REBALANCE_STEP
            first_order = right_order - (step * len(group))
        else:
            step = ORDER_REBALANCE_STEP
            first_order = step
            if anchor_order_hints is not None:
                logger.error(
                    "[CollabPersist] DATA INTEGRITY: 新行无法解析邻居锚点，"
                    "回退默认 order=%s；row_order 可能含 ORM/native 分叉幽灵锚点。"
                    " new_ids=%s",
                    ORDER_REBALANCE_STEP,
                    group[:10],
                )

        for group_offset, new_id in enumerate(group):
            order_value = first_order + (step * group_offset)
            resolved[new_id] = order_value
            order_values[new_id] = order_value

    return resolved


class CollabService:
    """表格协作 — 快照 / 持久化"""

    @staticmethod
    def _sync_collab_link_cell(
        *,
        table_id: UUID,
        field: TableField,
        record: TableRecord,
        record_id_str: str,
        api_value: Any,
    ) -> Any:
        """把协作 link cell 变更同步到 LinkRecord，返回按真源重建的 cell 值。

        关系真源是 ``LinkRecord``，cell 仅是展示缓存。Y.Doc-first 的拖拽 / link
        编辑落库时，仅写 JSONB/native 不会改变 ``LinkRecord``，导致 tree_data 与
        关联值仍按旧关系、UI 回弹。这里复用 ``LinkFieldService.set_link_cell``
        统一更新关系，并对「子记录父字段」自引用做环 / 深度守卫（对齐 REST
        ``SubRecordService.move_record`` 的不变量）。

        Returns:
            重建后的 cell 值（``{id,title}`` / ``[{id,title}]`` / None）；
            若变更被拒绝（成环 / 超深度），返回 :data:`_LINK_SYNC_SKIP`。
        """
        from apps.tabdata.services.link_field_service import LinkFieldService

        linked_ids = _link_cell_to_linked_ids(api_value)
        # 环 / 深度不变量已收敛到 LinkFieldService.set_link_cell
        # （SubRecordService.validate_parent_assignment）；此处捕获 ValueError → SKIP。
        try:
            return LinkFieldService.set_link_cell(
                field=field,
                record=record,
                new_linked_ids=linked_ids,
            )
        except ValueError as exc:
            logger.warning(
                "collab-persist: link cell 同步失败 record=%s field=%s err=%s",
                record_id_str, field.id, exc,
            )
            return _LINK_SYNC_SKIP

    @staticmethod
    def table_changes_to_apply_ops(changes: list, owned_fields: Optional[list] = None) -> list:
        """Convert table cell changes into business-neutral primitive ops."""
        owned = set(owned_fields or [])
        grouped: Dict[str, Dict[str, Any]] = {}
        ops: List[Dict[str, Any]] = []

        for change in changes:
            record_id = change.get("record_id")
            if not record_id:
                continue
            if change.get("type") == "delete":
                ops.append({
                    "op": "map.delete",
                    "path": ["records"],
                    "key": record_id,
                })
                ops.append({
                    "op": "map.delete",
                    "path": ["rowOrderMap"],
                    "key": record_id,
                })
                continue

            if change.get("type") == "upsert_record":
                fields = change.get("fields") if isinstance(change.get("fields"), dict) else {}
                filtered_fields = {
                    field_hex: value
                    for field_hex, value in fields.items()
                    if not owned or field_hex in owned
                }
                # The patch is also the record-existence primitive. Keep it
                # when there are no user cells so undo/import can restore an
                # empty row before the atomic order mutation runs.
                ops.append({
                    "op": "map.patch",
                    "path": ["records", record_id],
                    "values": filtered_fields,
                })
                # ：优先 order.after（锚点口径 ），避免数字 position 与
                # fractional 字符串混排时新行沉到表头。
                if "after_record_id" in change:
                    ops.append({
                        "op": "order.after",
                        "path": ["rowOrderMap"],
                        "key": record_id,
                        "after_key": change.get("after_record_id"),
                    })
                elif isinstance(change.get("order"), (int, float)):
                    ops.append({
                        "op": "order.set",
                        "path": ["rowOrderMap"],
                        "positions": {record_id: change["order"]},
                    })
                continue

            if change.get("type") == "reorder_record":
                order_value = change.get("order")
                if (
                    not isinstance(order_value, (int, float))
                    or isinstance(order_value, bool)
                    or not math.isfinite(float(order_value))
                    or "after_record_id" not in change
                ):
                    continue
                ops.append({
                    "op": "map.patch",
                    "path": ["records", record_id],
                    "values": {
                        COLLAB_POSITION_ID_KEY: None,
                        "__order": float(order_value),
                    },
                })
                ops.append({
                    "op": "order.after",
                    "path": ["rowOrderMap"],
                    "key": record_id,
                    "after_key": change.get("after_record_id"),
                })
                continue

            if change.get("type") == "rebalance_record_order":
                order_value = change.get("order")
                if (
                    not isinstance(order_value, (int, float))
                    or isinstance(order_value, bool)
                    or not math.isfinite(float(order_value))
                ):
                    continue
                ops.append({
                    "op": "map.patch",
                    "path": ["records", record_id],
                    "values": {
                        COLLAB_POSITION_ID_KEY: None,
                        "__order": float(order_value),
                    },
                })
                continue

            field_hex = change.get("field_id_hex")
            if not field_hex:
                continue
            if owned and field_hex not in owned:
                continue

            item = grouped.setdefault(record_id, {"fields": {}})
            item["fields"][field_hex] = change.get("value")
            if "after_record_id" in change:
                item["after_record_id"] = change.get("after_record_id")

        for record_id, payload in grouped.items():
            ops.append({
                "op": "map.patch",
                "path": ["records", record_id],
                "values": payload["fields"],
            })
            if "after_record_id" in payload:
                ops.append({
                    "op": "order.after",
                    "path": ["rowOrderMap"],
                    "key": record_id,
                    "after_key": payload["after_record_id"],
                })
        return ops

    # ================================================================
    # collab-snapshot: 构建全量快照
    # ================================================================

    @staticmethod
    def build_snapshot(
        table_id: UUID,
        *,
        include_deleted_fields: bool = False,
        user=None,
        share=None,
        enforce_field_visibility: bool = False,
    ) -> Dict[str, Any]:
        """
        构建表格全量快照，供 collab-live 初始化 Y.Doc / 版本历史存储。

        Args:
            include_deleted_fields: 为 True 时把软删字段定义与单元格值一并写入
                ``fields`` / ``records``（标记 ``is_deleted: true``）。版本历史
                需要自包含快照；协作 Y.Doc 初始化仍默认 False，避免
                把已删列投影进在线 schema。
            user / share: 可选访问者上下文。当 ``enforce_field_visibility=True``
                （或显式传入 user/share）时，仅允许「可见字段 == 全量活动字段」
                的访问者拿到全量快照；否则抛
                ``FieldVisibilityCollabRestrictedError``（ P0）。
                InternalServiceAuth 的房间初始化默认不强制（房间准入已在
                collab_auth / share collab-token 挡下受限角色）。

        返回格式:
        {
            "table_id": str,
            "table_name": str,
            "table_version": int,
            "fields": [
                {"id": str(uuid), "name": str, "field_type": str, "config": dict,
                 "order": int, "is_deleted": bool},
                ...
            ],
            "records": {
                "record-uuid": {"field_id_hex": value, ...},
                ...
            },
            "row_order": ["record-uuid-1", "record-uuid-2", ...]
        }
        """
        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id, is_archived=False).first()
        if not table:
            raise ValueError(f"Table {table_id} not found or archived")

        # ：带访问者上下文时禁止下发含隐藏字段的全量 Y.Doc
        if enforce_field_visibility or user is not None or share is not None:
            from apps.tabdata.services.field_visibility import (
                FieldVisibilityCollabRestrictedError,
                evaluate_collab_access,
            )

            decision = evaluate_collab_access(user, table, share=share)
            if not decision.get("allowed"):
                raise FieldVisibilityCollabRestrictedError(decision)

        all_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(table=table)
            .order_by('order', 'created_at')
        )
        active_fields = [f for f in all_fields if not f.is_deleted]
        # 版本历史：含软删字段定义；协作初始化：仅活跃字段
        fields_for_defs = all_fields if include_deleted_fields else active_fields
        # native 读写始终以活跃列为准；软删列若仍物理存在，再额外投影到 records
        fields_for_read = list(active_fields)
        if include_deleted_fields:
            for f in all_fields:
                if f.is_deleted and f not in fields_for_read:
                    fields_for_read.append(f)

        field_defs = []
        for f in fields_for_defs:
            field_defs.append({
                "id": str(f.id),
                "id_hex": f.id.hex,
                "name": f.name,
                "field_type": f.field_type,
                "config": f.config or {},
                "default_value": f.default_value,
                "order": f.order,
                "is_deleted": bool(f.is_deleted),
            })

        views = list(table.views.using(TABDATA_DB_ALIAS).all().order_by('order', 'created_at'))
        view_defs = [serialize_view_payload(view) for view in views]

        ddl = DDLManager()
        partition_id = resolve_schema_partition_id(table)
        if not ddl.native_table_exists(partition_id, table.id):
            logger.warning(
                "collab-snapshot: native table missing, backfilling before snapshot table=%s space=%s",
                table.id, partition_id,
            )
            from apps.tabdata.native.backfill_service import BackfillService

            result = BackfillService().backfill_table(table.id, force=True)
            if result.get("status") != "completed":
                message = result.get("message") or "native table backfill failed"
                raise ValueError(
                    f"collab-snapshot: native table missing and backfill failed "
                    f"table={table.id}: {message}"
                )
        # DDL 只同步活跃列；软删列按  保留至 TTL，ensure 时忽略即可
        ddl.ensure_columns_synced(partition_id, table.id, active_fields)

        # 原生列读取所有记录
        native_io = NativeRecordIO(
            space_id=partition_id,
            table_id=table.id,
        )

        from apps.tabdata.native.query_builder import NativeQueryBuilder

        # 版本历史需要把软删列的 cell 一并投影进 records（ 列仍在）
        qb = NativeQueryBuilder(
            space_id=partition_id,
            table_id=table.id,
            fields=fields_for_read,
        )

        rows, total = native_io.read_records(
            qb,
            order_by=('"__order" ASC, "__created_at" ASC, "__id" ASC', []),
            limit=COLLAB_SNAPSHOT_MAX_ROWS,
            offset=0,
        )

        row_ids = [row.get("__id") for row in rows if row.get("__id")]
        position_ids_by_record: Dict[str, str] = {}
        if row_ids:
            position_ids_by_record = {
                str(record_id): position_id
                for record_id, position_id in TableRecord.objects.using(TABDATA_DB_ALIAS)
                .filter(
                    table=table,
                    id__in=row_ids,
                    is_deleted=False,
                    position_id__isnull=False,
                )
                .values_list("id", "position_id")
            }

        from apps.tabdata.native.pg_type_map import SYSTEM_COLUMN_FIELD_TYPES
        # 系统时间字段（created_time / last_modified_time）的值存于 native 系统列
        # （__created_at / __updated_at），不在用户 hex 列。若仍按 hex 读会恒为空，
        # 导致协作快照投影缺失创建/修改时间——看板/grid 显示空、且新建时「闪一下又消失」。
        # 这里按系统列读出、以 datetime 口径转 ISO，回填到该字段 hex cell，与 REST 序列化对齐。
        snapshot_system_time_columns = {
            ftype: col
            for ftype, col in SYSTEM_COLUMN_FIELD_TYPES.items()
            if ftype in ('created_time', 'last_modified_time')
        }

        # 构建 records map 和 row_order
        records: Dict[str, Dict[str, Any]] = {}
        row_order: List[str] = []

        for row in rows:
            record_id = str(row.get("__id", ""))
            if not record_id:
                continue

            row_order.append(record_id)

            # 提取字段值（使用 field_id_hex 作为 key，保持与前端 Y.Map 一致）
            field_values: Dict[str, Any] = {}
            for f in fields_for_read:
                hex_key = f.id.hex
                system_time_col = snapshot_system_time_columns.get(f.field_type)
                if system_time_col is not None:
                    raw_value = row.get(system_time_col)
                    if raw_value is not None:
                        field_values[hex_key] = pg_to_python(raw_value, 'date', f.config)
                    continue
                raw_value = row.get(hex_key)
                if raw_value is not None:
                    # 转换为 Python 原生类型（前端可直接用）
                    api_value = pg_to_python(raw_value, f.field_type, f.config)
                    field_values[hex_key] = api_value

            # 包含系统字段
            field_values["__order"] = row.get("__order", 0)
            field_values["__version"] = row.get("__version", 0)
            position_id = position_ids_by_record.get(record_id)
            if _is_valid_collab_position_id(position_id):
                field_values[COLLAB_POSITION_ID_KEY] = position_id
            elif position_id is not None:
                logger.warning(
                    "collab-snapshot: invalid %s for record=%s, omitting",
                    COLLAB_POSITION_ID_KEY,
                    record_id,
                )

            records[record_id] = field_values

        is_truncated = total > len(records)
        if is_truncated:
            logger.warning(
                "collab-snapshot: table=%s 记录数(%d)超过快照上限(%d)，"
                "客户端将缺少尾部数据，需分页加载补全",
                table_id, total, len(records),
            )

        logger.info(
            "collab-snapshot: table=%s fields=%d (active=%d deleted_included=%s) records=%d total=%d",
            table_id, len(fields_for_defs), len(active_fields),
            include_deleted_fields, len(records), total,
        )

        return {
            "table_id": str(table.id),
            "table_name": table.name,
            "table_version": table.record_version_seq,
            "schema_version": getattr(table, 'schema_version', 0),
            "total_records": total,
            "is_truncated": is_truncated,
            "fields": field_defs,
            "views": view_defs,
            "records": records,
            "row_order": row_order,
        }

    # ================================================================
    # collab-persist: 增量持久化
    # ================================================================

    @staticmethod
    def _delete_active_record(
        *,
        table: Table,
        record_id: UUID,
        tombstone_version: int,
        deleted_at: Any,
        deleted_by: Optional[str],
        native_io: NativeRecordIO,
    ) -> bool:
        """建立 ORM tombstone 后，无条件清理 native 投影。"""
        orm_updates: Dict[str, Any] = {
            "is_deleted": True,
            "deleted_at": deleted_at,
            "version": tombstone_version,
            "updated_at": deleted_at,
            # 无法解析删除者时必须清空旧编辑者，避免后续把上一位编辑者误报为删除者。
            "updated_by_id": deleted_by or None,
        }

        tombstone_created = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            id=record_id,
            table=table,
            is_deleted=False,
        ).update(**orm_updates)
        if not tombstone_created:
            return False

        native_io.delete_record(
            record_id=record_id,
            version=0,
            updated_by=deleted_by,
        )
        return True

    @staticmethod
    def persist_changes(
        table_id: UUID,
        *,
        changed_records: Dict[str, Dict[str, Any]],
        new_records: Optional[Dict[str, Dict[str, Any]]] = None,
        deleted_record_ids: Optional[List[str]] = None,
        row_order: Optional[List[str]] = None,
        collab_views: Optional[Dict[str, Any]] = None,
        op_id: Optional[str] = None,
        source: str = "collab_persist",
        editor_type: str = "user",
        editor_id: str = "",
        record_editor_ids: Optional[Dict[str, str]] = None,
        collab_fields: Optional[list] = None,
        record_lifecycle_revalidation_ids: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        将 Y.Doc 增量变更写入 PostgreSQL。

        Args:
            table_id: 表格 ID
            changed_records: 已存在记录的变更 {record_id: {field_id_hex: value, ...}}
            new_records: 新增记录 {record_id: {field_id_hex: value, "__order": float}}
            deleted_record_ids: 删除的记录 ID 列表
            row_order: 行顺序（可选，全量）
            collab_views: Y.Doc 里的视图 SSoT {view_id: view_payload}
            op_id: 操作 ID（幂等去重）
            source: 来源标识
            editor_type: 编辑者类型
            editor_id: 编辑者 ID
            record_editor_ids: changed_records 中每条记录对应的认证编辑者 ID
            collab_fields: DC-012 — collab-live 检测到的 schema 变更（字段定义列表），
                    作为 Y.Doc meta.fields 快照持久化到 DB schema，并返回 DB 权威 fields。
                    命名为 collab_fields 避免与函数内部 DB 查询的 fields 变量遮蔽。
            record_lifecycle_revalidation_ids: 历史纠偏候选。候选生命周期无法确认时
                    必须拒绝按普通新记录创建，并返回未确认 ID 供 collab-live 重试。

        Returns:
            {"persisted": int, "deleted": int, "created": int, "version": int, "fields"?: list}
        """
        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id, is_archived=False).first()
        if not table:
            raise ValueError(f"Table {table_id} not found")

        changed_records = changed_records or {}
        new_records = new_records or {}
        deleted_record_ids = deleted_record_ids or []
        record_editor_ids = record_editor_ids or {}
        requested_lifecycle_revalidation_ids = {
            canonical_id
            for canonical_id in (
                _canonical_record_id(record_id)
                for record_id in (record_lifecycle_revalidation_ids or [])
            )
            if canonical_id
        }

        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(table=table, is_deleted=False)
        )
        field_map_hex = {f.id.hex: f for f in fields}
        field_map_uuid = {str(f.id): f for f in fields}

        def _resolve_field(field_key: str) -> Optional[TableField]:
            raw = str(field_key or '').strip()
            if not raw:
                return None
            field = field_map_hex.get(raw.replace('-', ''))
            if field:
                return field
            return field_map_uuid.get(raw)

        def _emit_history(
            *,
            record: TableRecord,
            action: str,
            field_changes: Dict[str, Any],
            user: Optional[Any],
            operation_group_id: Optional[UUID],
            push_to_stack: bool,
            editor_type: str = editor_type,
        ) -> None:
            emit_record_history_event(
                record=record,
                action=action,
                field_changes=field_changes,
                user=user,
                window_id=get_current_window_id(),
                operation_group_id=operation_group_id,
                push_to_stack=push_to_stack,
                editor_type=editor_type,
                sender=CollabService,
            )

        normalized_row_order = _normalize_row_order_ids(row_order)
        has_row_order = row_order is not None and len(normalized_row_order) > 0

        native_io = NativeRecordIO(
            space_id=resolve_schema_partition_id(table),
            table_id=table.id,
        )

        editor_actor_id: Optional[str] = None
        if editor_type == "share":
            from apps.services.common.public_share.collab_token import parse_share_guest_id

            _, share_user_id = parse_share_guest_id(editor_id)
            if share_user_id:
                try:
                    editor_actor_id = str(UUID(str(share_user_id)))
                except (TypeError, ValueError):
                    editor_actor_id = None
        elif editor_id:
            try:
                editor_actor_id = str(UUID(str(editor_id)))
            except (TypeError, ValueError):
                editor_actor_id = None

        editor_user = None
        if editor_actor_id:
            editor_user = User.objects.db_manager('default').filter(id=editor_actor_id).first()
        push_history_to_stack = bool(editor_user)

        normalized_record_editor_ids: Dict[str, str] = {}
        for raw_record_id, raw_editor_id in record_editor_ids.items():
            try:
                normalized_record_editor_ids[str(UUID(str(raw_record_id)))] = str(
                    UUID(str(raw_editor_id))
                )
            except (TypeError, ValueError):
                continue
        record_editor_users = {
            str(user.id): user
            for user in User.objects.db_manager('default').filter(
                id__in=set(normalized_record_editor_ids.values())
            )
        }

        operation_group_id = _derive_operation_group_id(op_id)

        persisted_count = 0
        created_count = 0
        deleted_count = 0

        all_affected_record_ids: List[str] = []
        row_order_changed_ids: List[str] = []
        link_update_events: List[Any] = []
        cross_table_ws: Dict[str, Set[str]] = {}
        # 普通字段编辑后需要传播 link title
        cascade_updated_record_ids: List[str] = []
        cascade_changed_field_ids: Set[str] = set()
        # 协作 create/update 拒绝或重建后的权威 cell，供 collab-live 回写 Y.Doc
        record_cell_corrections: Dict[str, Dict[str, Any]] = {}
        # delete-wins：迟到修改被 tombstone 舍弃时，把删除者定向告知原修改者。
        discarded_record_updates: List[Dict[str, str]] = []
        # delete-wins：Y.Doc 中残留的“新增”若已对应 ORM tombstone，不得隐式复活。
        # 返回原始 Y.Doc key，供 collab-live 在 ACK 后清理三层行投影。
        discarded_new_record_ids: List[str] = []
        # Repair candidates are fail-closed: an unknown lifecycle must never
        # be reinterpreted as an ordinary create.
        unconfirmed_record_lifecycle_ids: List[str] = []

        preload_ids: set[UUID] = set()
        for rid_str in changed_records.keys():
            try:
                preload_ids.add(UUID(rid_str))
            except (TypeError, ValueError):
                continue
        for rid_str in new_records.keys():
            try:
                preload_ids.add(UUID(rid_str))
            except (TypeError, ValueError):
                continue
        for rid_str in deleted_record_ids:
            try:
                preload_ids.add(UUID(rid_str))
            except (TypeError, ValueError):
                continue
        if normalized_row_order:
            for rid_str in normalized_row_order:
                try:
                    preload_ids.add(UUID(rid_str))
                except (TypeError, ValueError):
                    continue

        existing_records: Dict[str, TableRecord] = {
            str(record.id): record
            for record in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table=table,
                id__in=list(preload_ids),
                is_deleted=False,
            )
        }

        new_record_lifecycle_ids: List[UUID] = []
        for record_id in new_records.keys():
            try:
                new_record_lifecycle_ids.append(UUID(str(record_id)))
            except (TypeError, ValueError):
                continue
        lifecycle_queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            id__in=new_record_lifecycle_ids,
        )
        # 生产协作入口已先锁 Table；restore 链路则先锁 TableRecord 再更新 Table。
        # 使用 NOWAIT 获取本批生命周期行：无竞争时把分类固定到事务提交；若 restore
        # 已持行锁，则立即让本次 store 失败并释放 Table 锁，由既有重试在 restore
        # 提交后重新分类。绝不能在这里等待，否则会形成 Table ↔ TableRecord 死锁。
        if connections[TABDATA_DB_ALIAS].in_atomic_block:
            lifecycle_queryset = lifecycle_queryset.select_for_update(nowait=True)
        new_record_lifecycle = {
            str(record.id): record
            for record in lifecycle_queryset.order_by("id")
        }

        duplicate_new_record_ids: List[str] = []
        for record_id in new_records.keys():
            canonical_record_id = _canonical_record_id(record_id)
            lifecycle_record = new_record_lifecycle.get(canonical_record_id)
            is_revalidation_candidate = (
                canonical_record_id in requested_lifecycle_revalidation_ids
            )
            if lifecycle_record is None:
                if is_revalidation_candidate:
                    unconfirmed_record_lifecycle_ids.append(record_id)
                continue
            if lifecycle_record.table_id != table.id:
                if is_revalidation_candidate:
                    unconfirmed_record_lifecycle_ids.append(record_id)
                continue
            if lifecycle_record.is_deleted:
                discarded_new_record_ids.append(record_id)
            else:
                duplicate_new_record_ids.append(record_id)
        if duplicate_new_record_ids:
            logger.info(
                "collab-persist: %d new record(s) already exist in ORM; skipping duplicate create "
                "for table=%s ids=%s",
                len(duplicate_new_record_ids),
                table_id,
                duplicate_new_record_ids[:10],
            )
        if discarded_new_record_ids:
            logger.warning(
                "collab-persist: discarded %d replayed new record(s) that already have "
                "tombstones for table=%s ids=%s",
                len(discarded_new_record_ids),
                table_id,
                discarded_new_record_ids[:10],
            )
        if unconfirmed_record_lifecycle_ids:
            logger.error(
                "collab-persist: refused to create %d lifecycle revalidation candidate(s) "
                "whose ORM lifecycle could not be confirmed for table=%s ids=%s",
                len(unconfirmed_record_lifecycle_ids),
                table_id,
                unconfirmed_record_lifecycle_ids[:10],
            )
        skipped_new_record_ids = (
            set(duplicate_new_record_ids)
            | set(discarded_new_record_ids)
            | set(unconfirmed_record_lifecycle_ids)
        )
        if skipped_new_record_ids:
            new_records = {
                record_id: values
                for record_id, values in new_records.items()
                if record_id not in skipped_new_record_ids
            }

        views_changed = False
        fields_changed = False
        total_ops = len(changed_records) + len(new_records) + len(deleted_record_ids)
        if total_ops == 0 and not has_row_order and collab_views is None and collab_fields is None:
            result = {
                "persisted": 0,
                "deleted": 0,
                "created": 0,
                "version": table.record_version_seq,
            }
            if discarded_new_record_ids:
                result["discarded_new_record_ids"] = discarded_new_record_ids
            if unconfirmed_record_lifecycle_ids:
                result["unconfirmed_record_lifecycle_ids"] = (
                    unconfirmed_record_lifecycle_ids
                )
            return result

        # 版本号必须在锁住本次涉及的活跃记录后分配，避免等待并发写时
        # tombstone/update 使用低于已覆盖变更的版本。
        version_count = total_ops if total_ops > 0 else 1
        new_version = int(table.record_version_seq or 0)
        now = timezone.now()

        # FAR-016: 防御性告警——如果 changed_records 含 native 已存在但 ORM 缺失的
        # record_id，说明上游写入路径（如 Agent SQL）漏建了 ORM 行，下游 cell 编辑
        # 会被静默 skip。第一次告警让运维能及时发现修复，避免数据丢失累积。
        if changed_records:
            missing_ids = [
                rid for rid in changed_records.keys()
                if rid not in existing_records
            ]
            if missing_ids:
                # 只对真实存在于 native 的孤儿 ORM 缺失 record 报警
                from apps.tabdata.native.ddl_manager import DDLManager
                native_fqn = DDLManager.qualified_table_name(
                    resolve_schema_partition_id(table), table.id
                )
                try:
                    with connections[TABDATA_DB_ALIAS].cursor() as cur:
                        placeholders = ','.join(['%s'] * len(missing_ids))
                        cur.execute(
                            f'SELECT "__id"::text FROM {native_fqn} '
                            f'WHERE "__id"::text IN ({placeholders})',
                            missing_ids,
                        )
                        native_existing = {row[0] for row in cur.fetchall()}
                except Exception:
                    native_existing = set()
                orphan_ids = [rid for rid in missing_ids if rid in native_existing]
                if orphan_ids:
                    logger.error(
                        "[CollabPersist] DATA INTEGRITY: %d record(s) 在 native 表存在但 "
                        "TableRecord ORM 缺失，cell 编辑将被静默丢弃 → "
                        "table=%s orphan_ids=%s. 该现象通常由 Agent SQL INSERT 未同步建 ORM "
                        "行造成，参考 agent_sql.py:_create_django_records_for_insert.",
                        len(orphan_ids), table_id, orphan_ids[:10],
                    )

        canonical_new_record_ids = {
            canonical_id
            for canonical_id in (_canonical_record_id(record_id) for record_id in new_records.keys())
            if canonical_id
        }
        canonical_deleted_record_ids = {
            canonical_id
            for canonical_id in (_canonical_record_id(record_id) for record_id in deleted_record_ids)
            if canonical_id
        }
        precise_order_changed_record_ids: Set[str] = set()
        explicit_position_changed_record_ids: Set[str] = set()
        for raw_record_id, field_values in changed_records.items():
            canonical_id = _canonical_record_id(raw_record_id)
            if not canonical_id or canonical_id not in existing_records:
                continue
            has_position_id, _position_id = _read_collab_position_id(
                field_values,
                record_id=canonical_id,
            )
            if has_position_id:
                explicit_position_changed_record_ids.add(canonical_id)
            has_legacy_order, legacy_order = _read_collab_legacy_order(
                field_values,
                record_id=canonical_id,
            )
            if (
                has_legacy_order
                and legacy_order is not None
                and _record_order_value(existing_records[canonical_id]) != legacy_order
            ):
                precise_order_changed_record_ids.add(canonical_id)
        for raw_record_id, field_values in new_records.items():
            canonical_id = _canonical_record_id(raw_record_id)
            if not canonical_id:
                continue
            has_legacy_order, _legacy_order = _read_collab_legacy_order(
                field_values,
                record_id=canonical_id,
            )
            if has_legacy_order:
                precise_order_changed_record_ids.add(canonical_id)

        row_order_existing = [
            record_id for record_id in normalized_row_order
            if record_id in existing_records and record_id not in canonical_deleted_record_ids
        ]
        current_existing_order = sorted(
            row_order_existing,
            key=lambda record_id: _record_order_key(existing_records[record_id]),
        )
        row_order_moved_existing_ids = set(_find_reordered_record_ids(
            current_existing_order,
            row_order_existing,
        ))
        row_order_reorders_existing = (
            has_row_order
            and not precise_order_changed_record_ids
            and _row_order_reorders_existing_records(
                normalized_row_order,
                existing_records,
                canonical_deleted_record_ids,
            )
        )
        anchor_order_hints: Dict[str, float] = {}
        if has_row_order and canonical_new_record_ids and not row_order_reorders_existing:
            ghost_ids = _collect_row_order_ghost_ids(
                normalized_row_order,
                existing_records,
                canonical_new_record_ids,
                canonical_deleted_record_ids,
            )
            if ghost_ids:
                soft_deleted_ids: List[UUID] = []
                for rid in ghost_ids:
                    try:
                        soft_deleted_ids.append(UUID(rid))
                    except (TypeError, ValueError):
                        continue
                soft_deleted = {
                    str(record.id): record
                    for record in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                        table=table,
                        id__in=soft_deleted_ids,
                        is_deleted=True,
                    )
                } if soft_deleted_ids else {}
                for ghost_id in ghost_ids:
                    soft = soft_deleted.get(ghost_id)
                    if soft is not None:
                        try:
                            anchor_order_hints[ghost_id] = float(soft.order or 0)
                        except (TypeError, ValueError):
                            anchor_order_hints[ghost_id] = 0.0

                still_missing = [rid for rid in ghost_ids if rid not in anchor_order_hints]
                if still_missing:
                    try:
                        native_fqn = DDLManager.qualified_table_name(
                            resolve_schema_partition_id(table), table.id,
                        )
                        with connections[TABDATA_DB_ALIAS].cursor() as cur:
                            placeholders = ','.join(['%s'] * len(still_missing))
                            cur.execute(
                                f'SELECT "__id"::text, "__order" FROM {native_fqn} '
                                f'WHERE "__id"::text IN ({placeholders})',
                                still_missing,
                            )
                            for native_id, native_order in cur.fetchall():
                                try:
                                    anchor_order_hints[str(native_id)] = float(native_order or 0)
                                except (TypeError, ValueError):
                                    continue
                    except Exception:
                        logger.exception(
                            "[CollabPersist] DATA INTEGRITY: 读取 native 幽灵锚点 order 失败 table=%s",
                            table_id,
                        )

                logger.error(
                    "[CollabPersist] DATA INTEGRITY: row_order 含 %d 个 ORM 不可见幽灵锚点 "
                    "(软删或仅 native 残留)。将用只读 order hint 定位新行，"
                    "但表数据仍需授权清理。 table=%s ghost_ids=%s hinted=%s",
                    len(ghost_ids),
                    table_id,
                    ghost_ids[:10],
                    list(anchor_order_hints.keys())[:10],
                )

        row_order_new_record_orders = (
            {}
            if row_order_reorders_existing
            else _resolve_new_record_orders_from_row_order(
                normalized_row_order,
                existing_records,
                canonical_new_record_ids,
                canonical_deleted_record_ids,
                anchor_order_hints=anchor_order_hints or None,
            )
        )

        from apps.tabdata.domain.value_objects import RecordCommandContext
        from apps.tabdata.handlers import RecordHandlerFactory
        from apps.tabdata.services.link_field_service import LinkFieldService

        delete_handler = RecordHandlerFactory.delete_handler(user=editor_user)
        delete_context = RecordCommandContext(
            table_id=table_id,
            user_id=editor_actor_id,
            record_ids=[
                UUID(record_id)
                for record_id in canonical_deleted_record_ids
            ],
            operation_group_id=operation_group_id,
        )

        with transaction.atomic(using=TABDATA_DB_ALIAS):
            if collab_views is not None:
                views_changed = CollabService._persist_collab_views(
                    table=table,
                    collab_views=collab_views,
                    editor_user=editor_user,
                )
            if collab_fields is not None:
                fields_changed = CollabService._persist_collab_fields(
                    table=table,
                    collab_fields=collab_fields,
                    editor_user=editor_user,
                )
                if fields_changed:
                    # Same persist payload can contain schema changes plus cell writes
                    # into the newly-created fields. Refresh the resolver cache before
                    # processing records, otherwise those cells are treated as unknown.
                    fields = list(
                        TableField.objects.using(TABDATA_DB_ALIAS).filter(
                            table=table,
                            is_deleted=False,
                        )
                    )
                    field_map_hex = {f.id.hex: f for f in fields}
                    field_map_uuid = {str(f.id): f for f in fields}

            # changed_records 的快照在事务外预加载，可能已经落后于并发删除。
            # 进入写事务后一次性锁住仍活跃的记录：删除若先提交，这里看不到它；
            # 更新若先拿锁，后续删除会等待并最终成为该生命周期的最后状态。
            changed_record_uuids: List[UUID] = []
            for changed_record_id in changed_records:
                try:
                    changed_record_uuids.append(UUID(changed_record_id))
                except (TypeError, ValueError):
                    continue
            deleted_record_uuids: List[UUID] = []
            for deleted_record_id in deleted_record_ids:
                try:
                    deleted_record_uuids.append(UUID(deleted_record_id))
                except (TypeError, ValueError):
                    continue
            lifecycle_record_uuids = sorted(
                set(changed_record_uuids + deleted_record_uuids),
                key=str,
            )
            locked_lifecycle_records: Dict[str, TableRecord] = {
                str(record.id): record
                for record in TableRecord.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .filter(
                    table=table,
                    id__in=lifecycle_record_uuids,
                    is_deleted=False,
                )
                .order_by("id")
            }
            locked_changed_records = {
                str(record_id): locked_lifecycle_records[str(record_id)]
                for record_id in changed_record_uuids
                if str(record_id) in locked_lifecycle_records
            }

            current_version_floor = max(
                (int(record.version or 0) for record in locked_lifecycle_records.values()),
                default=0,
            )
            new_version = next_record_version(table_id, version_count)
            required_version = current_version_floor + version_count
            if new_version < required_version:
                new_version = next_record_version(
                    table_id,
                    required_version - new_version,
                )
            now = timezone.now()
            missing_changed_record_ids = [
                record_id
                for record_id in changed_record_uuids
                if str(record_id) not in locked_changed_records
            ]
            deleted_changed_records: Dict[str, TableRecord] = {
                str(record.id): record
                for record in TableRecord.objects.using(TABDATA_DB_ALIAS)
                .select_related("updated_by")
                .filter(
                    table=table,
                    id__in=missing_changed_record_ids,
                    is_deleted=True,
                )
            }

            # ── 1. 更新已存在记录 ──
            for record_id_str, field_values in changed_records.items():
                try:
                    record_uuid = UUID(record_id_str)
                except ValueError:
                    logger.warning("collab-persist: 无效 record_id=%s, 跳过", record_id_str)
                    continue

                record_obj = locked_changed_records.get(record_id_str)
                if not record_obj:
                    # tombstone 已经赢得生命周期竞态；迟到修改舍弃，并定向提示修改者。
                    tombstone = deleted_changed_records.get(record_id_str)
                    target_editor_id = normalized_record_editor_ids.get(str(record_uuid))
                    if tombstone is not None and target_editor_id:
                        deleted_by = tombstone.updated_by
                        deleted_by_name = (
                            deleted_by.get_display_name()
                            if deleted_by is not None
                            else ""
                        )
                        deleted_at = tombstone.deleted_at or tombstone.updated_at
                        discarded_record_updates.append({
                            "event_id": (
                                f"{table_id}:{record_id_str}:"
                                f"{deleted_at.isoformat()}:{target_editor_id}"
                            ),
                            "record_id": record_id_str,
                            "target_editor_id": target_editor_id,
                            "deleted_by_id": (
                                str(tombstone.updated_by_id)
                                if tombstone.updated_by_id
                                else ""
                            ),
                            "deleted_by_name": deleted_by_name,
                        })
                    continue
                existing_records[record_id_str] = record_obj

                old_data = dict(record_obj.__dict__.get('data') or {})
                next_data = dict(old_data)
                pg_field_values: Dict[str, Any] = {}
                field_changes: Dict[str, Dict[str, Any]] = {}
                has_position_id, position_id = _read_collab_position_id(
                    field_values,
                    record_id=record_id_str,
                )
                position_id_changed = (
                    has_position_id and record_obj.position_id != position_id
                )
                has_legacy_order, legacy_order = _read_collab_legacy_order(
                    field_values,
                    record_id=record_id_str,
                )
                old_legacy_order = _record_order_value(record_obj)
                legacy_order_changed = (
                    has_legacy_order
                    and legacy_order is not None
                    and old_legacy_order != legacy_order
                )
                if legacy_order_changed:
                    field_changes["_order"] = {
                        "old": old_legacy_order,
                        "new": legacy_order,
                    }

                for hex_key, api_value in field_values.items():
                    raw_key = str(hex_key)
                    if raw_key.startswith("__"):
                        continue
                    field = _resolve_field(raw_key)
                    if field and field.field_type not in SYSTEM_MANAGED_FIELD_TYPES:
                        if (field.default_value or {}).get('mode') == 'last_modified_time':
                            continue
                        rule_error = _collab_validate_field_rules(field, api_value)
                        if rule_error:
                            logger.warning(
                                "collab-persist: 字段验证规则失败 record=%s field=%s(%s) err=%s, 跳过该字段",
                                record_id_str, field.name, field.field_type, rule_error,
                            )
                            continue
                        if api_value is not None and field.field_type in COLLAB_STRICT_VALIDATE_TYPES:
                            if not validate_field_value(field.field_type, api_value, field.config):
                                logger.warning(
                                    "collab-persist: 字段值类型验证失败 record=%s field=%s(%s) value_type=%s, 跳过该字段",
                                    record_id_str, field.name, field.field_type,
                                    type(api_value).__name__,
                                )
                                continue
                        # Link 字段：cell 只是展示缓存，关系真源是 LinkRecord。Y.Doc-first
                        # 拖拽/编辑经协作落库时必须把 cell 变更同步到 LinkRecord，否则
                        # tree_data / 关联值仍按旧关系，UI 会回弹。set_link_cell 返回按
                        # 目标记录主字段重建的 {id,title}，用它覆盖原始 api_value 再写
                        # native/ORM，保证三处一致。
                        if field.field_type == 'link':
                            rebuilt = CollabService._sync_collab_link_cell(
                                table_id=table_id,
                                field=field,
                                record=record_obj,
                                record_id_str=record_id_str,
                                api_value=api_value,
                            )
                            if rebuilt is _LINK_SYNC_SKIP:
                                # 客户端 Y.Doc 可能仍持有非法父链；回写旧值（或清空）纠偏
                                data_key = field.id.hex
                                old_link_value = (
                                    old_data[data_key]
                                    if data_key in old_data
                                    else old_data.get(str(field.id))
                                )
                                record_cell_corrections.setdefault(record_id_str, {})[
                                    field.id.hex
                                ] = old_link_value
                                continue
                            if rebuilt != api_value:
                                record_cell_corrections.setdefault(record_id_str, {})[
                                    field.id.hex
                                ] = rebuilt
                            api_value = rebuilt
                        pg_field_values[field.id.hex] = python_to_pg(
                            api_value, field.field_type, field.config
                        )
                        data_key = field.id.hex
                        old_value = (
                            old_data[data_key]
                            if data_key in old_data
                            else old_data.get(str(field.id))
                        )
                        if old_value != api_value:
                            next_data[data_key] = api_value
                            # 清理 dashed-uuid 旧表征，避免 hex/dashed 双键并存：
                            # create 路径按 dashed 写、collab 按 hex 写，二者并存时
                            # serialize_record 读 record.data 去重可能命中陈旧值
                            # （link/树父子关系会因此回弹）。统一收敛到 hex。
                            next_data.pop(str(field.id), None)
                            field_changes[data_key] = {"old": old_value, "new": api_value}

                from apps.tabdata.utils.default_values import apply_record_defaults
                before_defaults = dict(next_data)
                apply_record_defaults(
                    next_data,
                    fields,
                    is_create=False,
                    actor_id=str(editor_actor_id) if editor_actor_id else None,
                )
                for default_field in fields:
                    if (default_field.default_value or {}).get('mode') != 'last_modified_time':
                        continue
                    key = default_field.id.hex
                    value = next_data.get(key)
                    pg_field_values[key] = python_to_pg(value, default_field.field_type, default_field.config)
                    if before_defaults.get(key) != value:
                        field_changes[key] = {'old': before_defaults.get(key), 'new': value}
                        record_cell_corrections.setdefault(record_id_str, {})[key] = value

                if not pg_field_values and not position_id_changed and not legacy_order_changed:
                    continue

                orm_updates = {
                    "data": next_data,
                    "version": new_version,
                    "updated_at": now,
                }
                if position_id_changed:
                    orm_updates["position_id"] = position_id
                if legacy_order_changed:
                    orm_updates["order"] = legacy_order
                if editor_actor_id:
                    orm_updates["updated_by_id"] = editor_actor_id
                updated_active_row = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id=record_uuid,
                    table=table,
                    is_deleted=False,
                ).update(**orm_updates)
                if not updated_active_row:
                    continue

                native_system_updates = {
                    "__version": new_version,
                    "__updated_at": now,
                    "__updated_by": editor_actor_id,
                }
                if legacy_order_changed:
                    native_system_updates["__order"] = legacy_order
                native_io.update_record(
                    record_uuid,
                    field_values=pg_field_values,
                    system_updates=native_system_updates,
                )

                record_obj.__dict__['data'] = next_data
                record_obj.version = new_version
                record_obj.updated_at = now
                if position_id_changed:
                    record_obj.position_id = position_id
                if legacy_order_changed:
                    record_obj.order = legacy_order
                if editor_actor_id:
                    record_obj.updated_by_id = editor_actor_id

                persisted_count += 1
                all_affected_record_ids.append(record_id_str)

                if field_changes:
                    cascade_updated_record_ids.append(record_id_str)
                    attachment_field_changed = False
                    for changed_key in field_changes:
                        changed_field = _resolve_field(changed_key)
                        if changed_field:
                            cascade_changed_field_ids.add(str(changed_field.id))
                            if changed_field.field_type == 'attachment':
                                attachment_field_changed = True
                    if attachment_field_changed:
                        try:
                            from apps.tabdata.services.attachment_service import AttachmentService

                            AttachmentService(user=editor_user).sync_record_attachments(record_obj)
                        except Exception as exc:
                            logger.warning(
                                "collab-persist: update 后 sync_record_attachments 失败 table=%s record=%s err=%s",
                                table_id, record_id_str, exc,
                            )
                    _emit_history(
                        record=record_obj,
                        action="update",
                        field_changes=field_changes,
                        user=editor_user,
                        operation_group_id=operation_group_id,
                        push_to_stack=push_history_to_stack,
                    )

            # ── 1b. 字段变更后的 link title 级联──
            # Electron 常规编辑经 collab persist 落库；若不在此处传播，A 表关联
            # 标签会一直显示 B 的旧 title（JSONB 反范化缓存）。
            if cascade_updated_record_ids and cascade_changed_field_ids:
                for rid in cascade_updated_record_ids:
                    rec = existing_records.get(rid)
                    if not rec:
                        continue
                    try:
                        title_affected = LinkFieldService.propagate_title_change(rec, '')
                        for item in title_affected or []:
                            tid = item.get('table_id')
                            arid = item.get('record_id')
                            if tid and arid:
                                cross_table_ws.setdefault(str(tid), set()).add(str(arid))
                    except Exception as exc:
                        logger.warning(
                            "collab-persist: link title 传播失败 table=%s record=%s err=%s",
                            table_id, rid, exc,
                        )
                try:
                    delete_handler._handle_cascade_compute(
                        table_id,
                        list(cascade_changed_field_ids),
                        cascade_updated_record_ids,
                        cross_table_ws,
                        cascade_source='handler',
                    )
                except Exception as exc:
                    logger.warning(
                        "collab-persist: cascade 失败 table=%s err=%s",
                        table_id, exc,
                    )

            # ── 2. 创建新记录 ──
            for record_id_str, field_values in new_records.items():
                try:
                    record_uuid = UUID(record_id_str)
                except ValueError:
                    logger.warning("collab-persist: 无效 new record_id=%s, 跳过", record_id_str)
                    continue

                canonical_record_id = str(record_uuid)
                has_legacy_order, explicit_legacy_order = _read_collab_legacy_order(
                    field_values,
                    record_id=record_id_str,
                )
                if has_legacy_order and explicit_legacy_order is not None:
                    order_val = explicit_legacy_order
                elif canonical_record_id in row_order_new_record_orders:
                    order_val = row_order_new_record_orders[canonical_record_id]
                else:
                    order_val = 0.0

                normalized_data: Dict[str, Any] = {}
                pg_field_values: Dict[str, Any] = {}
                has_position_id, position_id = _read_collab_position_id(
                    field_values,
                    record_id=record_id_str,
                )
                for hex_key, api_value in field_values.items():
                    raw_key = str(hex_key)
                    if raw_key.startswith("__"):
                        continue
                    field = _resolve_field(raw_key)
                    if field and field.field_type not in SYSTEM_MANAGED_FIELD_TYPES:
                        if (field.default_value or {}).get('mode') == 'last_modified_time':
                            continue
                        rule_error = _collab_validate_field_rules(field, api_value)
                        if rule_error:
                            logger.warning(
                                "collab-persist: 新记录字段验证规则失败 record=%s field=%s(%s) err=%s, 跳过该字段",
                                record_id_str, field.name, field.field_type, rule_error,
                            )
                            continue
                        if api_value is not None and field.field_type in COLLAB_STRICT_VALIDATE_TYPES:
                            if not validate_field_value(field.field_type, api_value, field.config):
                                logger.warning(
                                    "collab-persist: 新记录字段值类型验证失败 record=%s field=%s(%s) value_type=%s, 跳过该字段",
                                    record_id_str, field.name, field.field_type,
                                    type(api_value).__name__,
                                )
                                continue
                        normalized_data[field.id.hex] = api_value
                        pg_field_values[field.id.hex] = python_to_pg(
                            api_value, field.field_type, field.config
                        )

                from apps.tabdata.utils.default_values import apply_record_defaults
                input_keys = set(normalized_data)
                apply_record_defaults(
                    normalized_data,
                    fields,
                    is_create=True,
                    actor_id=str(editor_actor_id) if editor_actor_id else None,
                )
                create_cell_corrections: Dict[str, Any] = {}
                for default_field in fields:
                    key = default_field.id.hex
                    if key in normalized_data and key not in input_keys:
                        value = normalized_data[key]
                        pg_field_values[key] = python_to_pg(value, default_field.field_type, default_field.config)
                        create_cell_corrections[key] = value

                # 创建 ORM 记录（先落库，再同步 link → LinkRecord；与 update 路径对齐）
                record_obj = TableRecord(
                    id=record_uuid,
                    table=table,
                    order=order_val,
                    version=new_version,
                    data=normalized_data,
                    position_id=position_id if has_position_id else None,
                    created_by_id=editor_actor_id,
                    updated_by_id=editor_actor_id,
                )
                record_obj._skip_record_history = True
                record_obj.save(using=TABDATA_DB_ALIAS)
                if hasattr(record_obj, '_skip_record_history'):
                    delattr(record_obj, '_skip_record_history')
                existing_records[record_id_str] = record_obj

                # Link 字段：cell 仅是展示缓存，关系真源是 LinkRecord。
                # 协作 create 原先只写 JSONB/native，导致子记录父链既无深度守卫也无 LinkRecord。
                for hex_key, api_value in list(normalized_data.items()):
                    field = _resolve_field(hex_key)
                    if not field or field.field_type != 'link':
                        continue
                    rebuilt = CollabService._sync_collab_link_cell(
                        table_id=table_id,
                        field=field,
                        record=record_obj,
                        record_id_str=canonical_record_id,
                        api_value=api_value,
                    )
                    if rebuilt is _LINK_SYNC_SKIP:
                        normalized_data.pop(field.id.hex, None)
                        pg_field_values.pop(field.id.hex, None)
                        create_cell_corrections[field.id.hex] = None
                        continue
                    normalized_data[field.id.hex] = rebuilt
                    pg_field_values[field.id.hex] = python_to_pg(
                        rebuilt, field.field_type, field.config
                    )
                    if rebuilt != api_value:
                        create_cell_corrections[field.id.hex] = rebuilt

                if create_cell_corrections:
                    TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                        id=record_uuid,
                        table=table,
                    ).update(data=normalized_data)
                    record_obj.__dict__['data'] = normalized_data
                    record_cell_corrections[canonical_record_id] = create_cell_corrections

                from apps.tabdata.subscribers._utils import refresh_table_row_count, notify_record_changed_for_rag
                refresh_table_row_count(table.id)
                notify_record_changed_for_rag(table.id, record_uuid)

                native_io.insert_record(
                    record_uuid,
                    field_values=pg_field_values,
                    system_values={
                        "__order": order_val,
                        "__version": new_version,
                        "__created_at": now,
                        "__updated_at": now,
                        "__created_by": editor_actor_id,
                        "__updated_by": editor_actor_id,
                    },
                )
                created_count += 1
                all_affected_record_ids.append(record_id_str)

                # 草稿先上传得到的 orphan AttachmentReference：创建后按 cell 认领。
                try:
                    from apps.tabdata.services.attachment_service import AttachmentService

                    AttachmentService(user=editor_user).sync_record_attachments(record_obj)
                except Exception as exc:
                    logger.warning(
                        "collab-persist: create 后 sync_record_attachments 失败 table=%s record=%s err=%s",
                        table_id, record_id_str, exc,
                    )

                _emit_history(
                    record=record_obj,
                    action="create",
                    field_changes={"data": normalized_data},
                    user=editor_user,
                    operation_group_id=operation_group_id,
                    push_to_stack=push_history_to_stack,
                )

            # ── 3. 删除记录 ──
            all_link_affected: List[Dict[str, Any]] = []
            deleted_record_uuids: List[UUID] = []
            for record_id_str in deleted_record_ids:
                try:
                    record_uuid = UUID(record_id_str)
                except ValueError:
                    continue

                record_obj = existing_records.get(record_id_str)
                if not record_obj:
                    record_obj = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                        id=record_uuid,
                        table=table,
                        is_deleted=False,
                    ).first()
                if not record_obj:
                    continue

                record_deleter_id = (
                    normalized_record_editor_ids.get(str(record_uuid))
                    or editor_actor_id
                )
                record_deleter = record_editor_users.get(record_deleter_id) or (
                    editor_user if record_deleter_id == editor_actor_id else None
                )
                deleted = CollabService._delete_active_record(
                    table=table,
                    record_id=record_uuid,
                    tombstone_version=new_version,
                    deleted_at=now,
                    deleted_by=record_deleter_id,
                    native_io=native_io,
                )
                if not deleted:
                    # 另一删除已经先建立 tombstone；本次按幂等成功语义静默跳过，
                    # 不重复发历史和清理事件。
                    continue

                record_obj.is_deleted = True
                record_obj.deleted_at = now
                record_obj.version = new_version
                record_obj.updated_at = now
                record_obj.updated_by_id = record_deleter_id

                deleted_count += 1
                all_affected_record_ids.append(record_id_str)
                deleted_record_uuids.append(record_uuid)
                link_affected = LinkFieldService.cleanup_record_links(record_obj)
                all_link_affected.extend(link_affected or [])

                _emit_history(
                    record=record_obj,
                    action="delete",
                    field_changes={"_deleted": {"old": False, "new": True}},
                    user=record_deleter,
                    operation_group_id=operation_group_id,
                    push_to_stack=bool(record_deleter),
                )

            if deleted_record_uuids:
                delete_handler._attachment_svc.cleanup_records_attachments_batch(deleted_record_uuids)
                mark_table_record_delete_version(
                    table_id=table_id,
                    version=new_version,
                    db_alias=TABDATA_DB_ALIAS,
                )

            link_event_affected = [
                item for item in all_link_affected
                if str(item.get('record_id')) not in canonical_deleted_record_ids
            ]
            if link_event_affected:
                link_update_events = delete_handler._build_link_affected_update_events(
                    link_event_affected,
                    delete_context,
                )
                delete_handler._handle_cascade_after_delete(
                    link_event_affected,
                    cross_table_ws,
                )

            # ── 4. 行顺序持久化 ──
            if has_row_order and normalized_row_order and row_order_reorders_existing:
                # 根据 Y.Doc rowOrder 位置计算 __order 值
                # 使用等差序列确保顺序，步长 1000 避免频繁重排
                order_updates = []
                for idx, rid_str in enumerate(normalized_row_order):
                    try:
                        rid_uuid = UUID(rid_str)
                    except ValueError:
                        continue
                    order_val = (idx + 1) * ORDER_REBALANCE_STEP
                    order_updates.append((rid_uuid, order_val))

                if order_updates:
                    # 先过滤出需要更新的记录，收集历史信息
                    pending_native_rows: list = []
                    pending_orm_objs: list = []
                    history_entries: list = []
                    cleared_position_ids = False
                    for rid_uuid, order_val in order_updates:
                        rid_str = str(rid_uuid)
                        record_obj = existing_records.get(rid_str)
                        if not record_obj:
                            record_obj = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                                id=rid_uuid,
                                table=table,
                                is_deleted=False,
                            ).first()
                            if record_obj:
                                existing_records[rid_str] = record_obj
                        if not record_obj or record_obj.is_deleted:
                            continue

                        old_order = float(record_obj.order or 0)
                        order_changed = old_order != float(order_val)
                        should_clear_position_id = (
                            rid_str in row_order_moved_existing_ids
                            and rid_str not in explicit_position_changed_record_ids
                            and record_obj.position_id is not None
                        )
                        if not order_changed and not should_clear_position_id:
                            continue

                        if order_changed:
                            pending_native_rows.append({
                                '__id': rid_uuid,
                                '__order': order_val,
                                '__version': new_version,
                                '__updated_at': now,
                                '__updated_by': editor_actor_id,
                            })

                        record_obj.order = float(order_val)
                        if should_clear_position_id:
                            record_obj.position_id = None
                            cleared_position_ids = True
                        record_obj.version = new_version
                        record_obj.updated_at = now
                        if editor_actor_id:
                            record_obj.updated_by_id = editor_actor_id
                        pending_orm_objs.append(record_obj)

                        row_order_changed_ids.append(rid_str)
                        if order_changed:
                            history_entries.append((record_obj, old_order, float(order_val)))

                    # 批量原生 SQL（CASE WHEN）
                    if pending_native_rows:
                        native_io.bulk_update_records(pending_native_rows)

                    # 批量 ORM 更新
                    if pending_orm_objs:
                        update_fields = ['order', 'version', 'updated_at']
                        if cleared_position_ids:
                            update_fields.append('position_id')
                        if editor_actor_id:
                            update_fields.append('updated_by_id')
                        TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                            pending_orm_objs, update_fields, batch_size=500
                        )

                    # 逐条发射历史事件（历史需要逐条记录）
                    for record_obj, old_order, new_order in history_entries:
                        _emit_history(
                            record=record_obj,
                            action="update",
                            field_changes={"_order": {"old": old_order, "new": new_order}},
                            user=editor_user,
                            operation_group_id=operation_group_id,
                            push_to_stack=push_history_to_stack,
                        )
                    logger.info(
                        "collab-persist: table=%s row_order updated (%d records)",
                        table_id,
                        len(row_order_changed_ids),
                    )
            elif has_row_order and normalized_row_order:
                logger.info(
                    "collab-persist: table=%s row_order did not reorder existing rows; "
                    "skipping full order rewrite",
                    table_id,
                )

        latest_version = Table.objects.using(TABDATA_DB_ALIAS).only(
            'record_version_seq',
        ).get(id=table_id).record_version_seq

        # ── 5. 发布 WS 事件（兼容旧客户端） ──
        if row_order_changed_ids:
            all_affected_record_ids.extend(row_order_changed_ids)

        if all_affected_record_ids:
            record_ids = list(dict.fromkeys(all_affected_record_ids))
            action = "update_record"
            if row_order_changed_ids and persisted_count == 0 and created_count == 0 and deleted_count == 0:
                action = "reorder_records"
            elif created_count > 0 and persisted_count == 0 and deleted_count == 0 and not row_order_changed_ids:
                action = "create_record"
            elif deleted_count > 0 and persisted_count == 0 and created_count == 0 and not row_order_changed_ids:
                action = "delete_record"

            table_event_service.publish_table_update(
                table_id=str(table_id),
                record_ids=record_ids,
                action=action,
                latest_version=latest_version,
                metadata={
                    "op_id": op_id or "",
                    "source": source,
                    "row_order_changed": bool(row_order_changed_ids),
                },
            )

        for update_event in link_update_events:
            delete_handler._event_bus.publish(update_event)
        delete_handler._publish_cross_table_ws(cross_table_ws)

        logger.info(
            "collab-persist: table=%s persisted=%d created=%d deleted=%d version=%d op_id=%s fields_sync=%s views_sync=%s",
            table_id, persisted_count, created_count, deleted_count, latest_version, op_id,
            "yes" if fields_changed else "no",
            "yes" if views_changed else "no",
        )

        result = {
            "persisted": persisted_count,
            "created": created_count,
            "deleted": deleted_count,
            "version": latest_version,
        }

        if record_cell_corrections:
            result["record_cell_corrections"] = record_cell_corrections
        if discarded_record_updates:
            result["discarded_record_updates"] = discarded_record_updates
        if discarded_new_record_ids:
            result["discarded_new_record_ids"] = discarded_new_record_ids
        if unconfirmed_record_lifecycle_ids:
            result["unconfirmed_record_lifecycle_ids"] = unconfirmed_record_lifecycle_ids

        # 系统时间字段（created_time / last_modified_time）值存系统列、不在 Y.Doc 用户 cell。
        # 本次 persist 落库后把创建/修改时间按字段 hex 回写给 collab-live（onStoreSuccess
        # 写进 Y.Doc records），使协作投影即时携带该值、避免「闪一下又消失」。
        # created_time 仅新建写入；last_modified_time 新建与更新都刷新。
        system_time_fields = [
            f for f in fields
            if f.field_type in ('created_time', 'last_modified_time')
        ]
        if system_time_fields:
            now_iso = now.isoformat()
            affected = set(all_affected_record_ids)
            record_system_cells: Dict[str, Dict[str, str]] = {}
            for rid in set(new_records.keys()) & affected:
                record_system_cells[rid] = {
                    f.id.hex: now_iso for f in system_time_fields
                }
            for rid in set(changed_records.keys()) & affected:
                modified_cells = {
                    f.id.hex: now_iso
                    for f in system_time_fields
                    if f.field_type == 'last_modified_time'
                }
                if modified_cells:
                    record_system_cells.setdefault(rid, {}).update(modified_cells)
            if record_system_cells:
                result["record_system_cells"] = record_system_cells

        # DC-012: collab-live 检测到 schema 变更时，返回 DB 端实际 fields
        # 供 collab-live onStoreSuccess 同步 Y.Doc meta.fields 为权威值
        if collab_fields is not None:
            db_fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS)
                .filter(table=table, is_deleted=False)
                .order_by('order', 'created_at')
            )
            result["fields"] = [
                {
                    "id": str(f.id),
                    "id_hex": f.id.hex,
                    "name": f.name,
                    "field_type": f.field_type,
                    "config": f.config or {},
                    "order": f.order,
                }
                for f in db_fields
            ]

        if collab_views is not None:
            db_views = list(
                TableView.objects.using(TABDATA_DB_ALIAS)
                .filter(table=table)
                .order_by('order', 'created_at')
            )
            result["views"] = [serialize_view_payload(view) for view in db_views]

        return result

    @staticmethod
    def _persist_collab_views(
        *,
        table: Table,
        collab_views: Dict[str, Any],
        editor_user: Optional[Any],
    ) -> bool:
        existing = {
            str(view.id): view
            for view in TableView.objects.using(TABDATA_DB_ALIAS).filter(table=table)
        }
        changed = False

        for view_id, raw_payload in (collab_views or {}).items():
            if not isinstance(raw_payload, dict):
                continue
            try:
                view_uuid = UUID(str(view_id))
            except (TypeError, ValueError):
                logger.warning("collab-persist: invalid view_id=%s, skipping", view_id)
                continue

            payload = raw_payload
            current = existing.get(str(view_uuid))
            updates: Dict[str, Any] = {}
            if isinstance(payload.get("name"), str) and payload.get("name"):
                updates["name"] = payload["name"]
            if isinstance(payload.get("view_type"), str) and payload.get("view_type"):
                updates["view_type"] = payload["view_type"]
            if isinstance(payload.get("description"), str):
                updates["description"] = payload["description"]
            incoming_rev = payload.get("config_rev")
            has_integer_config_rev = (
                isinstance(incoming_rev, int) and not isinstance(incoming_rev, bool)
            )
            current_rev = getattr(current, "config_rev", 0) or 0 if current else 0
            # 老客户端没有 config_rev 时维持既有兼容行为；显式携带版本的快照则必须
            # 整体门禁配置维度，不能只保住版本数字却把旧 config/groups 落回 PG。
            accepts_config_snapshot = (
                not has_integer_config_rev or incoming_rev >= current_rev
            )
            if accepts_config_snapshot:
                if "filter" in payload:
                    updates["filter"] = payload.get("filter")
                for list_field in (
                    "filters",
                    "sorts",
                    "groups",
                    "visible_fields",
                    "field_order",
                ):
                    if isinstance(payload.get(list_field), list):
                        updates[list_field] = payload[list_field]
                for dict_field in ("column_meta", "config"):
                    if isinstance(payload.get(dict_field), dict):
                        updates[dict_field] = payload[dict_field]
            # config_rev 单调递增：只接受不低于当前值的版本，避免旧 Y.Doc 快照回退。
            if has_integer_config_rev:
                updates["config_rev"] = max(current_rev, incoming_rev)
            for bool_field in ("is_shared", "is_locked"):
                if isinstance(payload.get(bool_field), bool):
                    updates[bool_field] = payload[bool_field]
            if "order" in payload:
                try:
                    updates["order"] = int(payload.get("order") or 0)
                except (TypeError, ValueError):
                    pass

            # 看板 group_by_field 仅对 kanban 有意义；落库前从 non-kanban 剥掉，
            # 避免 Y.Doc 脏配置把看板分列写进表格视图。
            effective_view_type = (
                updates.get("view_type")
                or (getattr(current, "view_type", None) if current else None)
                or payload.get("view_type")
            )
            if effective_view_type != "kanban" and isinstance(updates.get("config"), dict):
                if "group_by_field" in updates["config"]:
                    cleaned_config = dict(updates["config"])
                    cleaned_config.pop("group_by_field", None)
                    updates["config"] = cleaned_config

            if current:
                dirty_fields = []
                for field_name, value in updates.items():
                    if getattr(current, field_name) != value:
                        setattr(current, field_name, value)
                        dirty_fields.append(field_name)
                if dirty_fields:
                    dirty_fields.append("updated_at")
                    current.save(using=TABDATA_DB_ALIAS, update_fields=dirty_fields)
                    changed = True
            else:
                if "name" not in updates or "view_type" not in updates:
                    logger.warning(
                        "collab-persist: incomplete new view payload view_id=%s, skipping",
                        view_id,
                    )
                    continue
                TableView.objects.using(TABDATA_DB_ALIAS).create(
                    id=view_uuid,
                    table=table,
                    created_by=editor_user,
                    **updates,
                )
                changed = True

        # 视图删除只走 REST。Y.Doc 快照可能滞后于 REST 新建，
        # 按「DB 有、Y.Doc 无」删除会把刚创建的视图清掉。字段 persist 已按
        # 同一理由禁止删除。
        return changed

    @staticmethod
    def _persist_collab_fields(
        *,
        table: Table,
        collab_fields: list,
        editor_user: Optional[Any],
    ) -> bool:
        """将 Y.Doc meta.fields 的「新增 / 元数据更新」持久化到 PostgreSQL。

        删字段**不**走这条路径：Y.Doc meta 可能滞后于 REST 删除/撤销恢复
        （客户端先 ``deleteFieldForRuntime``，或 undo 已恢复 DB 字段但 meta 仍缺）。
        若按「DB 有、Y.Doc 无」调用 ``delete_field``，会把刚恢复的字段再软删掉，
        并污染 undo 栈。字段删除只允许 REST ``TableService.delete_field``。
        """
        from apps.tabdata.services.table_service import TableService

        if not isinstance(collab_fields, list):
            return False

        structural_types = {'link'}
        service = TableService(user=editor_user) if editor_user else TableService()
        existing_rows = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(table=table)
        )
        existing_active = {
            str(field.id): field
            for field in existing_rows
            if not field.is_deleted
        }
        soft_deleted_ids = {
            str(field.id)
            for field in existing_rows
            if field.is_deleted
        }
        changed = False
        needs_schema_version_increment = False
        service_managed_schema_change = False

        for raw in collab_fields:
            if not isinstance(raw, dict):
                continue
            field_id = str(raw.get('id') or '')
            if not field_id:
                continue

            name = raw.get('name')
            field_type = raw.get('field_type')
            config = raw.get('config') if isinstance(raw.get('config'), dict) else {}
            default_value = raw.get('default_value')

            current = existing_active.get(field_id)
            if current:
                dirty_fields: List[str] = []
                if isinstance(name, str) and name and name != current.name:
                    current.name = name
                    dirty_fields.append('name')
                config_changed = config != (current.config or {})
                default_supplied = (
                    'default_value' in raw and default_value != current.default_value
                )
                configuration_change = None
                if config_changed or default_supplied:
                    from apps.tabdata.services.field_configuration_service import (
                        CONFIG_UNSET,
                        DEFAULT_VALUE_UNSET,
                        apply_field_configuration_change,
                    )
                    configuration_change = apply_field_configuration_change(
                        current,
                        config=config if config_changed else CONFIG_UNSET,
                        default_value=(
                            default_value if default_supplied else DEFAULT_VALUE_UNSET
                        ),
                    )
                if configuration_change and configuration_change.config_changed:
                    dirty_fields.append('config')
                if configuration_change and configuration_change.default_changed:
                    dirty_fields.append('default_value')
                order_val = raw.get('order')
                if isinstance(order_val, int) and order_val != current.order:
                    current.order = order_val
                    dirty_fields.append('order')
                if dirty_fields:
                    dirty_fields.append('updated_at')
                    current.save(using=TABDATA_DB_ALIAS, update_fields=dirty_fields)
                    changed = True
                    needs_schema_version_increment = True
                elif configuration_change and configuration_change.native_type_changed:
                    changed = True
                    needs_schema_version_increment = True
                continue

            # 软删同 ID：禁止 create_field（会撞 pkey）；复活只走 undo restore_field。
            if field_id in soft_deleted_ids:
                logger.info(
                    "collab-persist: skip recreating soft-deleted field id=%s table=%s",
                    field_id,
                    table.id,
                )
                continue

            if not isinstance(name, str) or not name:
                continue
            if not isinstance(field_type, str) or not field_type:
                continue
            if field_type in structural_types:
                logger.warning(
                    "collab-persist: skip creating structural field type=%s id=%s",
                    field_type,
                    field_id,
                )
                continue
            try:
                field_uuid = UUID(field_id)
            except (TypeError, ValueError):
                logger.warning("collab-persist: invalid field_id=%s, skipping", field_id)
                continue

            try:
                created = service.create_field(
                    table_id=table.id,
                    name=name,
                    field_type=field_type,
                    options=config,
                    default_value=default_value,
                    field_id=field_uuid,
                    skip_permission_check=True,
                )
            except ValueError as exc:
                # 同名不同类型等业务冲突：跳过该字段，避免整批 persist 失败
                logger.warning(
                    "collab-persist: create_field rejected id=%s name=%s table=%s err=%s",
                    field_id,
                    name,
                    table.id,
                    exc,
                )
                continue
            if not created:
                continue
            # create_field 对同名同类型幂等：可能返回已有字段（REST 已建 / 竞态），
            # Y.Doc id 与 DB id 不一致时只复用，不记作本次新建。
            if str(created.id) != field_id:
                logger.info(
                    "collab-persist: reuse existing field by name table=%s name=%s "
                    "existing_id=%s ydoc_id=%s",
                    table.id,
                    name,
                    created.id,
                    field_id,
                )
                existing_active[str(created.id)] = created
                continue
            existing_active[field_id] = created
            changed = True
            service_managed_schema_change = True

        if changed and needs_schema_version_increment and not service_managed_schema_change:
            service._increment_schema_version(table.id)

        return changed

    # ================================================================
    # 版本恢复: 从快照数据还原表格
    # ================================================================

    @staticmethod
    def restore_from_snapshot(table_id: UUID, snapshot_data: Dict[str, Any], *, user=None) -> Dict[str, Any]:
        """
        从 collab 快照数据恢复表格内容。

        snapshot_data 结构与 build_snapshot 返回一致:
        {
            "records": {record_id: {field_id_hex: value}},
            "row_order": [record_id, ...],
            "fields": [{id, id_hex, name, field_type, ...}],
            ...
        }

        恢复逻辑：
        1. 删除所有现有记录
        2. 根据快照重建所有记录
        3. 恢复行顺序
        """
        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id, is_archived=False).first()
        if not table:
            raise ValueError(f"Table {table_id} not found")

        snapshot_records = snapshot_data.get("records", {})
        raw_row_order = snapshot_data.get("row_order", [])

        is_truncated = snapshot_data.get("is_truncated", False)
        total_records = snapshot_data.get("total_records", len(snapshot_records))
        if is_truncated or total_records > len(snapshot_records):
            from apps.tabdata.exceptions import TruncatedSnapshotError
            raise TruncatedSnapshotError(
                f"restore_from_snapshot: 拒绝恢复截断快照 table={table_id}，"
                f"快照仅包含 {len(snapshot_records)}/{total_records} 条记录。"
                f"恢复截断快照会导致被截断的记录被永久删除。"
                f"请使用包含全部记录的完整快照进行恢复。"
            )

        def _is_valid_uuid(val) -> bool:
            try:
                UUID(str(val))
                return True
            except (ValueError, AttributeError, TypeError):
                return False

        valid_snapshot_records = {}
        for rid, rdata in snapshot_records.items():
            if _is_valid_uuid(rid):
                valid_snapshot_records[rid] = rdata
            else:
                logger.warning("restore_from_snapshot: 跳过非法 record id %r", rid)
        snapshot_records = valid_snapshot_records

        row_order = [rid for rid in raw_row_order if _is_valid_uuid(rid)]

        snapshot_fields_def = snapshot_data.get("fields", [])
        snapshot_field_hex_set: set = set()
        snapshot_field_info: Dict[str, Dict] = {}
        skipped_fields: List[str] = []
        for fdef in snapshot_fields_def:
            fhex = fdef.get("id_hex") or str(fdef.get("id", "")).replace("-", "")
            if fhex:
                snapshot_field_hex_set.add(fhex)
                snapshot_field_info[fhex] = fdef

        native_io = NativeRecordIO(space_id=resolve_schema_partition_id(table), table_id=table.id)

        with transaction.atomic(using=TABDATA_DB_ALIAS):
            # ── 0. 同步字段结构：以快照 fields 定义为准恢复/删除字段 ──
            if snapshot_field_hex_set:
                all_db_fields = list(
                    TableField.objects.using(TABDATA_DB_ALIAS).filter(table=table)
                )
                all_field_map_hex = {f.id.hex: f for f in all_db_fields}

                undelete_ids: List = []
                soft_delete_ids: List = []

                for fhex in snapshot_field_hex_set:
                    db_field = all_field_map_hex.get(fhex)
                    if db_field and db_field.is_deleted:
                        undelete_ids.append(db_field.id)
                        logger.info(
                            "restore_from_snapshot: table=%s restoring deleted field %s (%s)",
                            table_id, db_field.name, fhex,
                        )
                    elif not db_field:
                        finfo = snapshot_field_info.get(fhex, {})
                        logger.warning(
                            "restore_from_snapshot: table=%s 快照字段 %s (type=%s, hex=%s) "
                            "已被物理删除，跳过该字段数据",
                            table_id, finfo.get('name', fhex), finfo.get('field_type', '?'), fhex,
                        )
                        skipped_fields.append(fhex)
                        continue

                for f in all_db_fields:
                    if not f.is_deleted and f.id.hex not in snapshot_field_hex_set:
                        soft_delete_ids.append(f.id)
                        logger.info(
                            "restore_from_snapshot: table=%s soft-deleting field %s (%s) "
                            "not present in snapshot",
                            table_id, f.name, f.id.hex,
                        )

                if undelete_ids:
                    TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        id__in=undelete_ids
                    ).update(is_deleted=False)

                if soft_delete_ids:
                    TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        id__in=soft_delete_ids
                    ).update(is_deleted=True)

            fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS).filter(table=table, is_deleted=False)
            )
            field_map_hex = {f.id.hex: f for f in fields}

            existing_ids = set(
                TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table=table, is_deleted=False)
                .select_for_update()
                .values_list("id", flat=True)
            )
            existing_id_strs = {str(rid) for rid in existing_ids}

            snapshot_ids = set(snapshot_records.keys())
            to_delete = existing_id_strs - snapshot_ids
            to_create = snapshot_ids - existing_id_strs
            to_update = snapshot_ids & existing_id_strs

            # DV-006: 捕获旧状态，供 restore 后写入 RecordHistory
            old_record_state: Dict[str, Dict[str, Any]] = {}
            ids_needing_old_state = to_delete | to_update
            if ids_needing_old_state:
                for rec in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    table=table,
                    id__in=[UUID(r) if isinstance(r, str) else r for r in ids_needing_old_state],
                ).only('id', 'data', 'order', 'is_deleted'):
                    old_record_state[str(rec.id)] = {
                        'data': dict(rec.data or {}),
                        'order': float(rec.order or 0),
                        'is_deleted': bool(rec.is_deleted),
                    }

            # QTA-28: 快照恢复为数据安全操作，仅记录配额超限警告，不阻断恢复。
            # 恢复是"还原到曾经合法的状态"，不应因配额限制阻止用户恢复数据。
            _quota_exceeded_on_restore = False
            if to_create:
                try:
                    from apps.users.membership.services.quota_service import QuotaService
                    from apps.users.membership.exceptions import QuotaExceededError

                    _wt_id = str(table.organization_id) if table.organization_id else None

                    net_new = len(to_create) - len(to_delete)
                    if net_new > 0:
                        current_count = len(existing_id_strs)
                        QuotaService().check_quota(
                            quota_type="max_records_per_table",
                            increment=net_new,
                            current_usage=current_count,
                            organization_id=_wt_id,
                            actor=user,
                        )
                except QuotaExceededError as qe:
                    _quota_exceeded_on_restore = True
                    logger.warning(
                        "快照恢复后记录数将超出配额（不阻断恢复）: table=%s net_new=%d detail=%s",
                        table_id, len(to_create) - len(to_delete), qe,
                    )
                except Exception as e:
                    logger.warning("快照恢复记录数配额预检异常: %s", e)

            version = next_record_version(table.id, max(len(to_create) + len(to_update) + len(to_delete), 1))

            if to_delete:
                TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    table=table, id__in=list(to_delete)
                ).update(is_deleted=True, version=version)
                for del_rid in to_delete:
                    del_uuid = UUID(del_rid) if isinstance(del_rid, str) else del_rid
                    # version=0: restore 需无条件删除原生行，跳过乐观锁
                    native_io.delete_record(record_id=del_uuid, version=0)
                mark_table_record_delete_version(
                    table_id=table_id,
                    version=version,
                    db_alias=TABDATA_DB_ALIAS,
                )

            row_order_index = {rid: idx for idx, rid in enumerate(row_order)}

            for rid in to_create:
                record_data = snapshot_records[rid]
                idx = row_order_index.get(rid)
                fallback_order = (idx + 1) * 1000.0 if idx is not None else 0.0
                order_val = _snapshot_legacy_order(
                    record_data,
                    record_id=str(rid),
                    fallback=fallback_order,
                )
                position_id = _snapshot_position_id(record_data, record_id=str(rid))

                field_values = {}
                orm_data = {}
                for field_hex, value in record_data.items():
                    if field_hex.startswith("__"):
                        continue
                    field = field_map_hex.get(field_hex.replace("-", ""))
                    if field:
                        field_values[field.id.hex] = python_to_pg(value, field.field_type, field.config)
                        orm_data[field.id.hex] = value
                    else:
                        logger.warning(
                            "restore_from_snapshot: table=%s record=%s field_hex=%s "
                            "not in active fields, value discarded",
                            table_id, rid, field_hex,
                        )

                TableRecord.objects.using(TABDATA_DB_ALIAS).create(
                    id=rid,
                    table=table,
                    order=order_val,
                    version=version,
                    is_deleted=False,
                    data=orm_data,
                    position_id=position_id,
                )

                record_uuid = UUID(rid) if isinstance(rid, str) else rid
                native_io.insert_record(
                    record_id=record_uuid,
                    field_values=field_values,
                    system_values={"__order": order_val, "__version": version},
                )

            for rid in to_update:
                record_data = snapshot_records[rid]
                idx = row_order_index.get(rid)
                fallback_order = (idx + 1) * 1000.0 if idx is not None else 0.0
                order_val = _snapshot_legacy_order(
                    record_data,
                    record_id=str(rid),
                    fallback=fallback_order,
                )
                position_id = _snapshot_position_id(record_data, record_id=str(rid))

                field_values = {}
                orm_data = {}
                for field_hex, value in record_data.items():
                    if field_hex.startswith("__"):
                        continue
                    normalized_key = field_hex.replace("-", "")
                    orm_data[normalized_key] = value
                    field = field_map_hex.get(normalized_key)
                    if field:
                        field_values[field.id.hex] = python_to_pg(value, field.field_type, field.config)
                    else:
                        logger.warning(
                            "restore_from_snapshot: table=%s record=%s field_hex=%s "
                            "not in active fields, native value skipped",
                            table_id, rid, field_hex,
                        )

                TableRecord.objects.using(TABDATA_DB_ALIAS).filter(id=rid).update(
                    order=order_val,
                    version=version,
                    is_deleted=False,
                    data=orm_data,
                    position_id=position_id,
                )

                system_updates = {"__order": order_val, "__version": version}
                record_uuid = UUID(rid) if isinstance(rid, str) else rid
                native_io.update_record(
                    record_id=record_uuid,
                    field_values=field_values,
                    system_updates=system_updates,
                )

            # DV-006: 写入 RecordHistory 标记 restore 节点，
            # 使 reconstruct_table_at_history 能跨越 restore 边界正确反向回放
            restore_group_id = _uuid_mod.uuid4()
            restore_histories: List[RecordHistory] = []

            from datetime import timedelta
            from apps.tabdata.tasks.history_tasks import resolve_history_ttl_for_table
            restore_ttl = resolve_history_ttl_for_table(table)
            restore_expired_at = timezone.now() + timedelta(seconds=restore_ttl)

            for rid_str in to_delete:
                old = old_record_state.get(rid_str, {})
                old_data = old.get('data', {})
                fc: Dict[str, Any] = {"_deleted": {"old": False, "new": True}}
                for fk, fv in old_data.items():
                    # VH-018: 统一标准化为 hex 格式（去连字符）
                    nk = str(fk).replace("-", "")
                    if not nk.startswith('_'):
                        fc[nk] = {"old": fv, "new": None}
                rid_uuid = UUID(rid_str) if isinstance(rid_str, str) else rid_str
                restore_histories.append(RecordHistory(
                    record_id=rid_uuid,
                    action="restore",
                    field_changes=fc,
                    operation_group_id=restore_group_id,
                    expired_at=restore_expired_at,
                    user=user,
                    editor_type="system",
                ))

            for rid_str in to_create:
                snap_data = snapshot_records[rid_str]
                fc = {"_deleted": {"old": True, "new": False}}
                for fh, fv in snap_data.items():
                    if fh.startswith("__"):
                        continue
                    fc[fh.replace("-", "")] = {"old": None, "new": fv}
                rid_uuid = UUID(rid_str) if isinstance(rid_str, str) else rid_str
                restore_histories.append(RecordHistory(
                    record_id=rid_uuid,
                    action="restore",
                    field_changes=fc,
                    operation_group_id=restore_group_id,
                    expired_at=restore_expired_at,
                    user=user,
                    editor_type="system",
                ))

            for rid_str in to_update:
                old = old_record_state.get(rid_str, {})
                old_data = old.get('data', {})
                old_order = old.get('order', 0.0)
                snap_data = snapshot_records[rid_str]
                new_data: Dict[str, Any] = {}
                for fh, fv in snap_data.items():
                    if fh.startswith("__"):
                        continue
                    new_data[fh.replace("-", "")] = fv
                upd_idx = row_order_index.get(rid_str)
                new_order = (upd_idx + 1) * 1000.0 if upd_idx is not None else 0.0
                fc = {}
                # VH-018: 统一标准化 old_data 键为 hex 格式（去连字符），
                # 与 new_data 和 to_create 分支保持一致
                normalized_old: Dict[str, Any] = {}
                for k, v in old_data.items():
                    nk = str(k).replace("-", "")
                    if not nk.startswith('_'):
                        normalized_old[nk] = v
                for k in set(normalized_old.keys()) | set(new_data.keys()):
                    if str(k).startswith('_'):
                        continue
                    ov = normalized_old.get(k)
                    nv = new_data.get(k)
                    if ov != nv:
                        fc[k] = {"old": ov, "new": nv}
                if old_order != new_order:
                    fc["_order"] = {"old": old_order, "new": new_order}
                if not fc:
                    continue
                rid_uuid = UUID(rid_str) if isinstance(rid_str, str) else rid_str
                restore_histories.append(RecordHistory(
                    record_id=rid_uuid,
                    action="restore",
                    field_changes=fc,
                    operation_group_id=restore_group_id,
                    expired_at=restore_expired_at,
                    user=user,
                    editor_type="system",
                ))

            if restore_histories:
                try:
                    RecordHistory.objects.using(TABDATA_DB_ALIAS).bulk_create(restore_histories)
                    restore_items: List[RecordHistoryItem] = []
                    for rh in restore_histories:
                        for fk, fv in (rh.field_changes or {}).items():
                            if isinstance(fv, dict) and ('old' in fv or 'new' in fv):
                                restore_items.append(RecordHistoryItem(
                                    history=rh,
                                    record_id=rh.record_id,
                                    field_key=str(fk),
                                    before=fv.get('old'),
                                    after=fv.get('new'),
                                ))
                    if restore_items:
                        RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).bulk_create(
                            restore_items, batch_size=5000,
                        )
                except Exception as hist_exc:
                    logger.warning(
                        "restore_from_snapshot: RecordHistory 写入失败 table=%s: %s",
                        table_id, hist_exc,
                    )

            # SR-005: 恢复操作可能隐式改变有效字段集，递增 schema_version
            # 使客户端 field map 缓存失效，触发重新拉取字段元数据
            Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
                schema_version=F('schema_version') + 1,
            )

        # 刷新 table 以获取递增后的 schema_version（供 WS 通知使用）
        table.refresh_from_db(using=TABDATA_DB_ALIAS, fields=['schema_version'])

        restored_records = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(table=table, is_deleted=False)
            .order_by("order", "created_at", "id")
        )
        latest_version = None
        if restored_records:
            from apps.tabdata.services.view_version_sync import encode_monotonic_version_token
            latest_version = encode_monotonic_version_token(
                max(int(getattr(r, "version", 0) or 0) for r in restored_records)
            )
        serialized_records = None
        try:
            from apps.tabdata.utils.record_serializers import serialize_records
            serialized_records = serialize_records(
                restored_records,
                field_key_type="id",
            )
        except Exception as exc:
            logger.warning(
                "restore_from_snapshot: restored records serialize failed for table %s: %s",
                table_id,
                exc,
            )

        # ── WS 广播通知协同用户刷新 ──
        try:
            table_event_service.publish_table_update(
                table_id=str(table_id),
                action="snapshot_restored",
                record_ids=[str(r.id) for r in restored_records],
                metadata={
                    "created": len(to_create),
                    "updated": len(to_update),
                    "deleted": len(to_delete),
                    "total": len(restored_records),
                    "schema_version": table.schema_version,
                },
                records=serialized_records,
                latest_version=latest_version,
            )
        except Exception as exc:
            logger.warning("restore_from_snapshot: WS broadcast failed for table %s: %s", table_id, exc)

        if skipped_fields:
            logger.warning(
                "restore_from_snapshot: table=%s 共跳过 %d 个已物理删除的字段: %s",
                table_id, len(skipped_fields), skipped_fields,
            )

        logger.info(
            "Table %s restored: created=%d, updated=%d, deleted=%d, skipped_fields=%d",
            table_id, len(to_create), len(to_update), len(to_delete), len(skipped_fields),
        )
        result = {
            "created": len(to_create),
            "updated": len(to_update),
            "deleted": len(to_delete),
            "skipped_fields": skipped_fields,
        }
        if _quota_exceeded_on_restore:
            result["quota_warning"] = (
                "恢复成功，但当前记录数已超出会员配额上限，"
                "部分功能可能受限，建议升级会员。"
            )
        return result

    # ================================================================
    # Agent push: 通过 collab-live 推送单元格变更
    # ================================================================

    @staticmethod
    def apply_ops(
        *,
        module: str,
        document_name: str,
        op_id: str,
        ops: list,
        timeout: int = 10,
        origin_id: str = "",
        editor_type: str = "",
        editor_id: str = "",
        editor_name: str = "",
        agent_run_id: str = "",
        system_policy: str = "",
        require_store_success: bool = False,
        record_lifecycle_revalidation_ids: list[str] | None = None,
    ) -> dict:
        """
        统一 Y.Doc-first command 入口。

        collab 模式下，后端/Agent/API 的领域状态写入应先转成 ops 进入
        collab-live，再由 persist/outbox 写回 DB 和副作用系统。该方法不做
        legacy delta 兜底；collab-live 未实现具体模块 handler 时会显式返回
        not_implemented，调用方据此决定是否进行资源级 fallback。
        """
        from apps.collab.apply_ops import CollabApplyOpsService

        return CollabApplyOpsService.apply_ops(
            module=module,
            document_name=document_name,
            op_id=op_id,
            ops=ops,
            timeout=timeout,
            origin_id=origin_id,
            editor_type=editor_type,
            editor_id=editor_id,
            editor_name=editor_name,
            agent_run_id=agent_run_id,
            system_policy=system_policy,
            require_store_success=require_store_success,
            record_lifecycle_revalidation_ids=record_lifecycle_revalidation_ids,
        )

    @staticmethod
    def apply_table_ops(
        *,
        table_id: UUID,
        op_id: str,
        ops: list,
        timeout: int = 10,
        origin_id: str = "",
        editor_type: str = "",
        editor_id: str = "",
        editor_name: str = "",
        agent_run_id: str = "",
        system_policy: str = "",
        require_store_success: bool = False,
        record_lifecycle_revalidation_ids: list[str] | None = None,
    ) -> dict:
        """Y.Doc-first table command helper used by collab-mode writers."""
        return CollabService.apply_ops(
            module="table",
            document_name=f"table:{table_id}",
            op_id=op_id,
            ops=ops,
            timeout=timeout,
            origin_id=origin_id,
            editor_type=editor_type,
            editor_id=editor_id,
            editor_name=editor_name,
            agent_run_id=agent_run_id,
            system_policy=system_policy,
            require_store_success=require_store_success,
            record_lifecycle_revalidation_ids=record_lifecycle_revalidation_ids,
        )

    @staticmethod
    def push_cells(
        table_id: UUID,
        changes: list,
        agent_id: str = "",
        owned_fields: list = None,
        editor_type: str = "agent",
        origin_id: str = "",
    ) -> dict:
        """
        推送单元格变更到 collab-live（走 Y.js CRDT 链路）。

        Args:
            table_id: 表格 ID
            changes: [{"record_id": str, "field_id_hex": str, "value": any}, ...]
            agent_id: 编辑者标识
            owned_fields: Agent 声明的 owned_fields（字段级隔离）
            editor_type: "user" | "agent" | "system"，影响 persist 权限校验路径
            origin_id: 编辑发起者标识(user_id)，前端据此跳过自己的 Y.Doc 推送

        Returns:
            {"applied": int, "total": int}
        """
        from apps.services.common.platform_context import get_current_run_id

        ops = CollabService.table_changes_to_apply_ops(changes, owned_fields)
        if not ops:
            return {"applied": 0, "total": len(changes)}

        current_run_id = get_current_run_id() or ""
        result = CollabService.apply_table_ops(
            table_id=table_id,
            op_id=current_run_id or str(_uuid_mod.uuid4()),
            ops=ops,
            timeout=10,
            origin_id=origin_id,
            editor_type=editor_type,
            editor_id=agent_id,
            editor_name=agent_id,
            agent_run_id=current_run_id,
            system_policy="trusted_internal" if editor_type == "system" else "",
        )
        if "error" in result or result.get("status") == "error":
            return {
                "applied": 0,
                "total": len(changes),
                "error": result.get("error") or result.get("message") or result.get("code"),
            }
        data = result.get("data") if isinstance(result, dict) else None
        if isinstance(data, dict):
            return {
                "applied": data.get("applied", 0),
                "total": len(changes),
                "data": data,
            }
        return result

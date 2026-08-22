"""
Canonical Replay Write Path

统一 undo / redo / restore 操作的记录状态回放逻辑，保证：
  ORM ⟷ Native 列 ⟷ History ⟷ Table Event ⟷ YDoc
五条链路在每次回放中保持一致。

所有 caller 只需调用 ``replay_record_state()``，无需手动维护双写或事件发布。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Optional
from uuid import UUID

from django.db import DatabaseError

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableField, TableRecord
from apps.tabdata.native.pg_type_map import is_system_field
from apps.tabdata.utils.record_data_access import read_data

if TYPE_CHECKING:
    from apps.tabdata.services.record_service import RecordService

logger = logging.getLogger("tabdata.replay")


UNDO_DB_HISTORY_SOURCE = "undo_db_history"
REDO_DB_HISTORY_SOURCE = "redo_db_history"


# ── 返回值 ─────────────────────────────

@dataclass
class ReplayResult:
    record: TableRecord
    changed: bool
    action: str  # 'create' | 'update' | 'delete' | 'noop'
    field_changes: Dict[str, Any] = field(default_factory=dict)
    native_synced: bool = False


@dataclass
class ReplayBatchContext:
    """整表 restore 等批处理上下文。

    保留逐行 ORM / native / history 写入，但抑制逐行 YDoc push、WS 发布与
    ``row_count`` 刷新；字段与表对象由 caller 预加载后复用。
    """

    table: Any = None
    fields: Optional[List[TableField]] = None
    suppress_ydoc: bool = False
    suppress_ws: bool = False
    suppress_row_count: bool = False


# ── 内部工具 ─────────────────────────────

def _resolve_replay_action(*, old_is_deleted: bool, next_is_deleted: bool) -> str:
    if old_is_deleted and not next_is_deleted:
        return "create"
    if not old_is_deleted and next_is_deleted:
        return "delete"
    return "update"


def _is_restore_source(source: str) -> bool:
    """判断 source 是否属于 restore 操作（用于写入 RecordHistory 时标记 action="restore"）。"""
    return "restore" in source


def _requires_native_sync_rollback(source: str) -> bool:
    """这些回放路径必须把 native DB 失败交给 caller 的事务边界处理。"""
    return source in {UNDO_DB_HISTORY_SOURCE, REDO_DB_HISTORY_SOURCE}


def _compute_field_changes(
    old_data: Dict[str, Any],
    next_data: Dict[str, Any],
    old_is_deleted: bool,
    next_is_deleted: bool,
    old_order: float,
    next_order: float,
) -> Dict[str, Dict[str, Any]]:
    """计算字段级 diff（含 _deleted / _order 伪字段）。"""
    changes: Dict[str, Dict[str, Any]] = {}

    all_keys = set(old_data.keys()) | set(next_data.keys())
    for key in all_keys:
        old_val = old_data.get(key)
        new_val = next_data.get(key)
        if old_val != new_val:
            changes[key] = {"old": old_val, "new": new_val}

    if old_is_deleted != next_is_deleted:
        changes["_deleted"] = {"old": old_is_deleted, "new": next_is_deleted}

    if old_order != next_order:
        changes["_order"] = {"old": old_order, "new": next_order}

    return changes


def _field_aliases(field: TableField) -> List[str]:
    """Return all record-data keys that may refer to a field, in priority order."""
    aliases = [str(field.id), field.id.hex]
    api_name = getattr(field, "api_name", None)
    if api_name:
        aliases.append(str(api_name))
    name = getattr(field, "name", None)
    if name:
        aliases.append(str(name))
    return aliases


def _lookup_field_value(data: Dict[str, Any], field: TableField) -> tuple[bool, Any]:
    for alias in _field_aliases(field):
        if alias in data:
            return True, data.get(alias)
    return False, None


def _build_native_field_values(
    data: Dict[str, Any],
    fields: List[TableField],
    *,
    include_absent: bool = False,
) -> Dict[str, Any]:
    """将 ORM data → native 列值映射（hex field_id → pg value）。"""
    from apps.tabdata.native.value_converter import python_to_pg

    pg_values: Dict[str, Any] = {}
    for f in fields:
        if is_system_field(f.field_type):
            continue
        found, value = _lookup_field_value(data, f)
        if not found and not include_absent:
            continue
        pg_values[f.id.hex] = python_to_pg(value, f.field_type, f.config)
    return pg_values


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val) if val is not None else default
    except (TypeError, ValueError):
        return default


# ── 主函数 ─────────────────────────────

def finalize_restore_batch_side_effects(
    *,
    table_id: UUID,
    changed_results: List[ReplayResult],
    user_id: Optional[str] = None,
) -> None:
    """整表 restore 结束后刷新一次 row_count，并按 action 聚合发布 WS。

    YDoc 权威同步仍由 API 层 ``_resync_collab_after_history_restore`` 负责，
    此处不再逐行 / 批量推 YDoc。
    """
    from apps.tabdata.subscribers._utils import refresh_table_row_count
    from apps.tabdata.utils.ws_notify import publish_table_record_event

    refresh_table_row_count(table_id)

    by_action: Dict[str, List[TableRecord]] = {
        "create": [],
        "update": [],
        "delete": [],
    }
    for result in changed_results:
        if not result.changed or result.action not in by_action:
            continue
        by_action[result.action].append(result.record)

    action_to_event = {
        "create": "create_record",
        "update": "update_record",
        "delete": "delete_record",
    }
    for action, records in by_action.items():
        if not records:
            continue
        try:
            publish_table_record_event(
                table_id=table_id,
                record_ids=[str(record.id) for record in records],
                action=action_to_event[action],
                records=records,
                user_id=user_id,
            )
        except Exception as evt_exc:
            logger.warning(
                "[Replay] batched table event failed: action=%s err=%s",
                action,
                evt_exc,
            )


def replay_record_state(
    service: RecordService,
    *,
    record: TableRecord,
    next_data: Dict[str, Any],
    next_is_deleted: bool,
    next_order: float,
    emit_history: bool,
    operation_group_id: Optional[UUID] = None,
    push_history_to_stack: bool = False,
    window_id: Optional[str] = None,
    source: str = "replay",
    user=None,
    version_override: Optional[int] = None,
    editor_type: str = "user",
    force_native_sync: bool = False,
    batch: Optional[ReplayBatchContext] = None,
) -> ReplayResult:
    """
    将 record 回放到 (next_data, next_is_deleted, next_order) 描述的目标状态。

    覆盖链路：ORM ← → Native ← → History ← → Event ← → YDoc

    RLS 豁免：此函数不执行行级安全检查。Undo/Redo 操作始终允许，
    确保用户能撤销自己的操作，即使当前 RLS 策略限制了写入。

    Args:
        service: RecordService 实例（用于事件发布和 YDoc 同步）
        record: 目标记录（必须已 attach 到 session）
        next_data: 目标 data dict
        next_is_deleted: 目标删除状态
        next_order: 目标排序值
        emit_history: 是否创建 RecordHistory
        operation_group_id: 操作组 ID（用于批量还原归组）
        push_history_to_stack: 是否推入 undo 栈
        window_id: 窗口 ID（history 归属）
        source: 来源标识（日志/调试）
        user: 操作用户（覆盖 service.user）
        version_override: 预分配的版本号；为 None 时自动调用 next_record_version。
                          批量场景下由 caller 预分配以减少 DB round-trip。
        batch: 批处理上下文；整表 restore 时应抑制逐行 WS/YDoc/row_count。
    """
    from apps.tabdata.services.record_service import next_record_version
    from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc
    from apps.tabdata.native.record_io import NativeRecordIO
    from apps.tabdata.models import RecordHistory, RecordHistoryItem

    op_user = user or service.user
    batch = batch or ReplayBatchContext()

    def _resolve_table_and_fields() -> tuple[Any, List[TableField]]:
        table = batch.table if batch.table is not None else record.table
        if batch.fields is not None:
            return table, batch.fields
        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=record.table_id, is_deleted=False,
            )
        )
        return table, fields

    # ── 1. 状态比较 ──────────────────
    old_data = dict(read_data(record))
    old_is_deleted = bool(record.is_deleted)
    old_order = _safe_float(record.order, 0.0)
    old_version = int(record.version or 0)

    field_changes = _compute_field_changes(
        old_data, next_data,
        old_is_deleted, next_is_deleted,
        old_order, next_order,
    )

    if not field_changes:
        native_synced = False
        if force_native_sync:
            try:
                from apps.tabdata.native.record_io import NativeRecordIO
                from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

                table, fields = _resolve_table_and_fields()
                pg_values = _build_native_field_values(
                    next_data,
                    fields,
                    include_absent=True,
                )
                if pg_values:
                    native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
                    native_synced = native_io.update_record(
                        record_id=record.id,
                        field_values=pg_values,
                    )
            except Exception as exc:
                logger.warning(
                    "[Replay] force native sync failed: record=%s source=%s err=%s",
                    record.id,
                    source,
                    exc,
                )
                if _is_restore_source(source):
                    raise
        return ReplayResult(
            record=record,
            changed=False,
            action="noop",
            native_synced=native_synced,
        )

    action = _resolve_replay_action(
        old_is_deleted=old_is_deleted,
        next_is_deleted=next_is_deleted,
    )

    # ── 2. ORM 更新 ──────────────────
    record.__dict__["data"] = next_data
    record.is_deleted = next_is_deleted
    record.order = next_order
    record.version = (
        version_override
        if version_override is not None
        else next_record_version(record.table_id)
    )
    if op_user:
        record.updated_by = op_user

    update_fields = ["data", "is_deleted", "order", "version", "updated_at"]
    if op_user:
        update_fields.append("updated_by")

    record._skip_record_history = True
    try:
        record.save(update_fields=update_fields)
        from apps.tabdata.subscribers._utils import refresh_table_row_count, notify_record_changed_for_rag
        if 'is_deleted' in update_fields and not batch.suppress_row_count:
            refresh_table_row_count(record.table_id)
        notify_record_changed_for_rag(record.table_id, record.id)
    finally:
        if hasattr(record, "_skip_record_history"):
            delattr(record, "_skip_record_history")

    # ── 3. Native 同步 ──────────────────
    table, fields = _resolve_table_and_fields()

    # P1 修复（Review §3）：native sync 失败必须分类:
    # - restore 路径：失败必须**抛出**触发事务回滚，否则 ORM 说"已恢复"
    #   但 native PG 表未同步 → C2 P0 bug 镜像
    # - delete 路径：失败同样必须回滚，否则 ORM/native/Y.Doc 会在删除态分叉
    # - 表级 DB history undo/redo：会污染事务的 DB 异常必须抛出
    # - 其他 update 路径：保留旧 best-effort 行为（与 W0-2 audit 兼容）
    is_restore_path = _is_restore_source(source)
    is_delete_path = action == "delete"
    is_db_history_path = _requires_native_sync_rollback(source)

    try:
        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
        native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)

        if action == "delete":
            # restore 是强制状态对齐：native __version 可能已与 ORM 分叉
            # （增量导入等），必须与 collab restore_from_snapshot 一样用
            # version=0 跳过乐观锁；undo/redo 仍用 old_version 防并发误删。
            # Refs:  /
            delete_version = 0 if is_restore_path else old_version
            native_io.delete_record(
                record_id=record.id,
                version=delete_version,
                updated_by=op_user.id if op_user else None,
            )
        elif action == "create":
            pg_values = _build_native_field_values(next_data, fields)
            native_io.insert_record(
                record_id=record.id,
                field_values=pg_values,
                system_values={
                    "__order": next_order,
                    "__version": record.version,
                    "__created_by": str(op_user.id) if op_user else None,
                    "__updated_by": str(op_user.id) if op_user else None,
                },
            )
        else:
            data_only_changes = {
                k: v["new"]
                for k, v in field_changes.items()
                if not k.startswith("_")
            }
            if data_only_changes or force_native_sync:
                native_source_data = (
                    next_data
                    if force_native_sync
                    else {k: v for k, v in next_data.items() if k in data_only_changes}
                )
                pg_values = _build_native_field_values(
                    native_source_data,
                    fields,
                    include_absent=force_native_sync,
                )
                if pg_values:
                    native_io.update_record(
                        record_id=record.id,
                        field_values=pg_values,
                    )
    except Exception as exc:
        logger.warning(
            "[Replay] native sync failed: record=%s action=%s source=%s err=%s",
            record.id, action, source, exc,
        )
        if is_restore_path or is_delete_path or (
            is_db_history_path and isinstance(exc, DatabaseError)
        ):
            # 这些回放必须事务回滚，避免 ORM/native/history 三者继续分叉。
            raise

    if action == "delete":
        from apps.tabdata.services.view_version_sync import mark_table_record_delete_version

        mark_table_record_delete_version(
            table_id=record.table_id,
            version=record.version,
            db_alias=TABDATA_DB_ALIAS,
        )

    # ── 4. History 事件 ──────────────────
    if emit_history:
        try:
            from datetime import timedelta
            from django.utils import timezone as _tz
            from apps.tabdata.tasks.history_tasks import resolve_history_ttl_for_record

            ttl = resolve_history_ttl_for_record(record)
            history_action = "restore" if _is_restore_source(source) else action
            history = RecordHistory.objects.using(TABDATA_DB_ALIAS).create(
                record=record,
                action=history_action,
                field_changes=field_changes,
                user=op_user,
                window_id=window_id,
                operation_group_id=operation_group_id,
                expired_at=_tz.now() + timedelta(seconds=ttl),
                editor_type=editor_type,
            )
            items = [
                RecordHistoryItem(
                    history=history,
                    record=record,
                    field_key=str(k),
                    before=v.get("old"),
                    after=v.get("new"),
                    user=op_user,
                )
                for k, v in field_changes.items()
                if isinstance(v, dict)
            ]
            if items:
                RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).bulk_create(items)

            if push_history_to_stack:
                try:
                    from apps.tabdata.services.undo_redo_stack_service import UndoRedoStackService
                    stack_svc = UndoRedoStackService()
                    op = stack_svc.build_operation_from_history(history, is_undone=False)
                    uid = str(op_user.id) if op_user else None
                    if uid:
                        stack_svc.push_undo_operation(
                            user_id=uid,
                            table_id=str(record.table_id),
                            window_id=window_id or "",
                            operation=op,
                            clear_redo=True,
                        )
                except Exception as stack_exc:
                    logger.warning("[Replay] push to undo stack failed: %s", stack_exc)
        except Exception as hist_exc:
            logger.error("[Replay] emit history failed: %s", hist_exc, exc_info=True)

    # ── 5. Table Event ──────────────────
    if not batch.suppress_ws:
        try:
            from apps.tabdata.utils.ws_notify import publish_table_record_event

            event_action = {
                "create": "create_record",
                "delete": "delete_record",
                "update": "update_record",
            }.get(action, "update_record")

            publish_table_record_event(
                table_id=record.table_id,
                record_ids=[str(record.id)],
                action=event_action,
                records=[record],
                user_id=str(op_user.id) if op_user and hasattr(op_user, 'id') else None,
            )
        except Exception as evt_exc:
            logger.warning("[Replay] table event failed: %s", evt_exc)

    # ── 6. YDoc 同步 ──────────────────
    if not batch.suppress_ydoc:
        try:
            deleted_ids = [str(record.id)] if next_is_deleted else None
            sync_records = [] if next_is_deleted else [record]
            upsert_ids = [str(record.id)] if action == "create" and not next_is_deleted else None
            sync_records_to_ydoc(
                record.table_id,
                sync_records,
                fields,
                deleted_record_ids=deleted_ids,
                upsert_record_ids=upsert_ids,
                source=source,
            )
        except Exception as ydoc_exc:
            logger.warning("[Replay] ydoc sync failed: %s", ydoc_exc)

    return ReplayResult(
        record=record,
        changed=True,
        action=action,
        field_changes=field_changes,
    )

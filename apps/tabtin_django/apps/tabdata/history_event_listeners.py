"""
TabData 历史事件监听器

行为约定：
- 跳过系统托管字段的历史项
- Select 字段选项最小化存储（仅保留变更涉及的选项值）
- per-table 字段类型缓存（避免 N+1 查询）
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import replace
from datetime import timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

from django.db import transaction
from django.dispatch import receiver
from django.utils import timezone

from apps.tabdata.constants import SYSTEM_MANAGED_FIELD_TYPES, TABDATA_DB_ALIAS
from apps.tabdata.history_events import RecordHistoryEvent, record_history_event
from apps.tabdata.models import RecordHistory, RecordHistoryItem, TableField

logger = logging.getLogger(__name__)

# 系统自动维护字段不是用户主动编辑，不进入用户可见变更历史。
NON_USER_HISTORY_FIELD_TYPES: Set[str] = set(SYSTEM_MANAGED_FIELD_TYPES)

# ── 字段类型缓存（per-table, 30 秒 TTL） ──
_field_type_cache: Dict[str, Tuple[float, Dict[str, str]]] = {}
_field_type_cache_lock = threading.Lock()
_FIELD_TYPE_CACHE_TTL = 30.0  # seconds


def invalidate_field_type_cache(table_id: str | None = None) -> None:
    """清除字段类型缓存。table_id=None 时清除全部。"""
    with _field_type_cache_lock:
        if table_id:
            _field_type_cache.pop(str(table_id), None)
        else:
            _field_type_cache.clear()


def _push_history_to_undo_stack(history: RecordHistory) -> None:
    """
    将新写入的历史记录压入 Undo 栈（并清空 Redo 栈）。
    """
    try:
        if not history or not history.user_id:
            return

        from apps.tabdata.services.undo_redo_stack_service import UndoRedoStackService

        stack_service = UndoRedoStackService()
        operation = stack_service.build_operation_from_history(history, is_undone=False)
        stack_service.push_undo_operation(
            user_id=str(history.user_id),
            table_id=str(history.record.table_id),
            window_id=history.window_id,
            operation=operation,
            clear_redo=True,
        )
    except Exception as exc:
        logger.warning("写入 Undo 栈失败: %s", exc)


def _batch_push_histories_to_undo_stack(
    histories: List[RecordHistory],
    events: List['RecordHistoryEvent'],
) -> None:
    """批量压入 Undo 栈。

    将 N 次 ``push_undo_operation``（每次 cache.get + deepcopy + cache.set）
    合并为按 (user_id, table_id, window_id) 分组后 1 次
    ``push_undo_operations``，从 O(n²) 降至 O(n)。

    Review P1-2 修复：复用 ``UndoRedoStackService.build_operation_from_history``
    保证 user 载荷（包含 ``name`` 等展示字段）与单条路径完全对齐，
    避免前端 Undo UI 在批量场景下显示残缺。

    为避免触发 ``history.record`` 的 lazy FK 加载（stub 模式下根本没有
    完整 ORM record），通过 ``_table_id_overrides`` 把 table_id 注入到
    单调用 service 实例，让 ``build_operation_from_history`` 优先读它。
    """
    from collections import defaultdict

    from apps.tabdata.services.undo_redo_stack_service import UndoRedoStackService

    grouped: dict[tuple, list] = defaultdict(list)
    stack_service = UndoRedoStackService()

    for history, event in zip(histories, events):
        if not event.push_to_stack:
            continue
        if not history or not history.user_id:
            continue
        try:
            table_id_str = str(event.record.table_id)
            operation = _build_operation_from_history_safe(
                stack_service, history, table_id_str,
            )
            key = (str(history.user_id), table_id_str, history.window_id)
            grouped[key].append(operation)
        except Exception as exc:
            logger.warning("build undo operation 失败: %s", exc)

    for (user_id, table_id, window_id), ops in grouped.items():
        try:
            stack_service.push_undo_operations(
                user_id=user_id,
                table_id=table_id,
                window_id=window_id,
                operations=ops,
                clear_redo=True,
            )
        except Exception as exc:
            logger.warning("批量写入 Undo 栈失败: count=%d err=%s", len(ops), exc)


def _build_operation_from_history_safe(
    stack_service: Any,
    history: RecordHistory,
    table_id_str: str,
) -> Dict[str, Any]:
    """安全调用 ``build_operation_from_history``，避免触发 ``history.record`` lazy FK。

    ``build_operation_from_history`` 内部访问 ``history.record.table_id``——
    若 stub 路径下 history 是从 bulk_create 返回的 in-memory 实例，
    ``record`` 属性会触发 DB 查询。为绕过此开销，临时打补丁让 history
    暴露一个无 DB 的 record stub。
    """
    original_record = history.__dict__.get('record')
    try:
        if 'record' not in history.__dict__ or original_record is None:
            class _RecordView:
                __slots__ = ('table_id',)

                def __init__(self, tid: str) -> None:
                    self.table_id = tid

            history.__dict__['record'] = _RecordView(table_id_str)
        return stack_service.build_operation_from_history(history, is_undone=False)
    finally:
        if original_record is None:
            history.__dict__.pop('record', None)
        else:
            history.__dict__['record'] = original_record


def _flatten_create_data(field_changes: Dict[str, Any]) -> List[Tuple[str, Any, Any]]:
    """
    兼容 create 事件中 `field_changes={'data': {...}}` 的旧结构。
    """
    payload = field_changes.get("data")
    if not isinstance(payload, dict):
        return []
    return [(str(field_key), None, value) for field_key, value in payload.items()]


def _load_field_type_map(record: Any) -> Dict[str, str]:
    """
    加载字段 ID/名称 → 字段类型映射，用于判断系统托管字段和选项最小化。

    使用 per-table 内存缓存（30s TTL），避免批量操作时的 N+1 查询。
    """
    table_id = getattr(record, "table_id", None)
    if not table_id:
        return {}

    cache_key = str(table_id)
    now = time.monotonic()

    # 查缓存
    with _field_type_cache_lock:
        cached = _field_type_cache.get(cache_key)
        if cached:
            ts, mapping = cached
            if now - ts < _FIELD_TYPE_CACHE_TTL:
                return mapping

    # 缓存 miss → 查库
    try:
        fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id, is_deleted=False
        ).only("id", "name", "field_type")
        mapping: Dict[str, str] = {}
        for f in fields:
            mapping[str(f.id)] = f.field_type
            mapping[f.name] = f.field_type

        with _field_type_cache_lock:
            _field_type_cache[cache_key] = (now, mapping)
        return mapping
    except Exception:
        return {}


def _is_non_user_history_field(field_key: str, field_type_map: Dict[str, str]) -> bool:
    """判断字段是否为系统维护字段（不产生用户侧历史条目）。"""
    field_type = field_type_map.get(field_key, "")
    return field_type in NON_USER_HISTORY_FIELD_TYPES


#: B-2 / Wave 1.1：以 ``_`` 前缀的 ``field_changes`` 键为约定的「来源/批次/元数据」标记，
#: **不**进入 ``RecordHistoryItem``——一方面避免污染字段级历史明细（被 UI / fallback
#: 误当成"字段变更"），另一方面与 ``_fallback_restore_via_record_history`` 中
#: `_deleted` / `_order` 等元数据键的"跳过回放"路径对齐。
#:
#: 当前已用：``_import_source``（B-2 fast_mode / default 标识）。
#: 未来约定：所有以 ``_`` 开头且**不**是 ``_deleted`` / ``_order`` 的标量都视为元数据。
_METADATA_FIELD_KEY_PREFIXES = ("_import_source",)


def _is_metadata_field_key(key: str) -> bool:
    """判断 field_key 是否为约定的"元数据"标记，不参与 RHItem 写入。"""
    return key in _METADATA_FIELD_KEY_PREFIXES


def _build_history_items(
    event: RecordHistoryEvent,
    field_type_map: Optional[Dict[str, str]] = None,
) -> List[Tuple[str, Any, Any]]:
    """
    将聚合 field_changes 转换为字段级明细项。

    字段级明细规则：
    - 跳过系统托管字段
    - 跳过 before == after 的无变化项
    - 跳过元数据键（``_import_source`` 等，由 :func:`_is_metadata_field_key` 判定）
    """
    if not isinstance(event.field_changes, dict):
        return []

    ftm = field_type_map or {}

    items: List[Tuple[str, Any, Any]] = []
    create_items = _flatten_create_data(event.field_changes)
    if create_items:
        # 过滤系统托管字段
        items.extend(
            (k, b, a) for k, b, a in create_items
            if not _is_non_user_history_field(k, ftm) and not _is_metadata_field_key(k)
        )

    for field_key, value in event.field_changes.items():
        key = str(field_key)

        # create 旧结构已在上方展开，不重复写入 data 本体
        if key == "data" and create_items:
            continue

        # 跳过系统托管字段
        if _is_non_user_history_field(key, ftm):
            continue

        # B-2：跳过元数据键（_import_source 等），不进字段级历史明细
        if _is_metadata_field_key(key):
            continue

        before = None
        after = None
        if isinstance(value, dict) and ("old" in value or "new" in value):
            before = value.get("old")
            after = value.get("new")
            if before == after:
                continue
        else:
            # 兼容批次/元数据类扩展字段
            after = value

        items.append((key, before, after))

    return items


def _with_filtered_update_changes(
    event: RecordHistoryEvent,
    items_payload: List[Tuple[str, Any, Any]],
) -> RecordHistoryEvent:
    """让 update 的聚合 ``field_changes`` 与已过滤的字段明细保持一致。

    ``RecordHistoryItem`` 是用户可见历史与 undo 的主数据；若仍把系统字段或
    ``before == after`` 的原始 payload 留在 ``field_changes``，旧客户端/缺 item
    的兼容路径会把这些噪声重新展示出来。
    """
    if event.action != "update":
        return event
    return replace(
        event,
        field_changes={
            field_key: {"old": before, "new": after}
            for field_key, before, after in items_payload
        },
    )


_DEDUP_WINDOW_SECONDS = 5


def _try_merge_with_recent_history(
    event: RecordHistoryEvent,
) -> Optional[RecordHistory]:
    """
    尝试与同一用户、同一记录、同一 action 的最近历史记录合并。

    仅在 update 操作且两次修改涉及相同字段时合并：
    保留首次修改的 before 值，使用最新的 after 值。
    """
    if event.action != "update" or not event.user:
        return None

    record_id = getattr(event.record, "id", None)
    user_id = getattr(event.user, "id", None)
    if not record_id or not user_id:
        return None

    new_field_keys = {
        str(k) for k in event.field_changes
        if k != "data" and isinstance(event.field_changes.get(k), dict)
        and ("old" in event.field_changes[k] or "new" in event.field_changes[k])
    }
    if not new_field_keys:
        return None

    window_id = event.window_id
    cutoff = timezone.now() - timedelta(seconds=_DEDUP_WINDOW_SECONDS)
    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            qs = (
                RecordHistory.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .filter(
                    record_id=record_id,
                    user_id=user_id,
                    action="update",
                    created_at__gte=cutoff,
                )
            )
            if window_id:
                qs = qs.filter(window_id=window_id)
            else:
                qs = qs.filter(window_id__isnull=True)
            recent = qs.order_by("-created_at").first()

            if recent is None:
                return None

            existing_changes = recent.field_changes or {}
            existing_field_keys = {
                str(k) for k in existing_changes
                if k != "data" and isinstance(existing_changes.get(k), dict)
                and ("old" in existing_changes[k] or "new" in existing_changes[k])
            }

            if not new_field_keys.issubset(existing_field_keys):
                return None

            merged_changes = dict(existing_changes)
            for key in new_field_keys:
                old_entry = existing_changes.get(key, {})
                new_entry = event.field_changes[key]
                merged_changes[key] = {
                    "old": old_entry.get("old") if isinstance(old_entry, dict) else None,
                    "new": new_entry.get("new") if isinstance(new_entry, dict) else None,
                }

            recent.field_changes = merged_changes
            recent.save(using=TABDATA_DB_ALIAS, update_fields=["field_changes"])

            RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).filter(
                history=recent,
                field_key__in=new_field_keys,
            ).delete()

            items_to_create = []
            for key in new_field_keys:
                entry = merged_changes.get(key, {})
                items_to_create.append(
                    RecordHistoryItem(
                        history=recent,
                        record=event.record,
                        field_key=key,
                        before=entry.get("old") if isinstance(entry, dict) else None,
                        after=entry.get("new") if isinstance(entry, dict) else None,
                        user=event.user,
                    )
                )
            if items_to_create:
                RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).bulk_create(items_to_create)

            return recent
    except Exception:
        return None


@receiver(record_history_event)
def handle_record_history_event(sender, event: RecordHistoryEvent, **kwargs):
    """
    接收历史事件并持久化。

    持久化行为：
    - 加载字段类型信息
    - 跳过系统托管字段的历史项
    - 同一用户对同一记录 5 秒内的连续 update 合并为一条历史记录
    """
    if not event or not event.record:
        return None

    field_type_map = _load_field_type_map(event.record)
    items_payload = _build_history_items(event, field_type_map=field_type_map)
    if event.action == "update" and not items_payload:
        return None
    event = _with_filtered_update_changes(event, items_payload)

    merged = _try_merge_with_recent_history(event)
    if merged is not None:
        if event.push_to_stack:
            _push_history_to_undo_stack(merged)
        return merged

    from apps.tabdata.tasks.history_tasks import resolve_history_ttl_for_record

    ttl = resolve_history_ttl_for_record(event.record)
    # ★ B-6 / Wave 1.1：RH 头 + RHItem 必须原子，否则 RHItem 失败会留下
    # "history 头无 items" 的孤儿数据；与 _try_merge_with_recent_history 路径
    # （L205）的事务边界对齐。`_push_history_to_undo_stack` 是 Redis/cache
    # 操作，移到 atomic 块外，避免 Redis 写失败牵连 PG 事务回滚。
    with transaction.atomic(using=TABDATA_DB_ALIAS):
        history = RecordHistory.objects.using(TABDATA_DB_ALIAS).create(
            record=event.record,
            action=event.action,
            field_changes=event.field_changes or {},
            user=event.user,
            window_id=event.window_id,
            operation_group_id=event.operation_group_id,
            editor_type=event.editor_type,
            agent_run_id=getattr(event, "agent_run_id", "") or "",
            session_id=getattr(event, "session_id", "") or "",
            expired_at=timezone.now() + timedelta(seconds=ttl),
        )

        if items_payload:
            objs = [
                RecordHistoryItem(
                    history=history,
                    record=event.record,
                    field_key=field_key,
                    before=before,
                    after=after,
                    user=event.user,
                )
                for field_key, before, after in items_payload
            ]
            _BULK_BATCH_SIZE = 5000
            for i in range(0, len(objs), _BULK_BATCH_SIZE):
                RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).bulk_create(objs[i : i + _BULK_BATCH_SIZE])

    if event.push_to_stack:
        _push_history_to_undo_stack(history)

    return history


def batch_write_record_histories(
    events: List[RecordHistoryEvent],
) -> List[RecordHistory]:
    """
    批量写入历史记录。

    将 N 次 RecordHistory.create() + N 次 RecordHistoryItem.bulk_create()
    合并为 1 次 RecordHistory.bulk_create() + 1 次 RecordHistoryItem.bulk_create()，
    大幅减少事务持锁时间和数据库 round-trip。

    适用场景：bulk_create_records / bulk_delete_records 等批量操作。
    不走 _try_merge_with_recent_history 合并路径（仅 update 需要合并）。
    """
    if not events:
        return []

    prepared: List[Tuple[RecordHistoryEvent, List[Tuple[str, Any, Any]]]] = []
    for event in events:
        field_type_map = _load_field_type_map(event.record)
        items_payload = _build_history_items(event, field_type_map=field_type_map)
        if event.action == "update" and not items_payload:
            continue
        prepared.append((_with_filtered_update_changes(event, items_payload), items_payload))

    if not prepared:
        return []

    events = [event for event, _items_payload in prepared]

    from apps.tabdata.tasks.history_tasks import resolve_history_ttl_for_record

    now = timezone.now()
    # 批量操作通常来自同一张表，用首条事件的记录解析 TTL 避免重复查询
    ttl = resolve_history_ttl_for_record(events[0].record)
    expired_at = now + timedelta(seconds=ttl)

    histories = [
        RecordHistory(
            record_id=event.record.id,
            action=event.action,
            field_changes=event.field_changes or {},
            user=event.user,
            window_id=event.window_id,
            operation_group_id=event.operation_group_id,
            editor_type=event.editor_type,
            agent_run_id=getattr(event, "agent_run_id", "") or "",
            session_id=getattr(event, "session_id", "") or "",
            expired_at=expired_at,
        )
        for event in events
    ]

    _BULK_BATCH_SIZE = 5000
    created_histories: List[RecordHistory] = []

    # ★ B-6 / Wave 1.1：批量路径同样需要原子保护，且 _push_history_to_undo_stack
    # （Redis/cache 写）必须移到 atomic 块外。
    with transaction.atomic(using=TABDATA_DB_ALIAS):
        for i in range(0, len(histories), _BULK_BATCH_SIZE):
            created_histories.extend(
                RecordHistory.objects.using(TABDATA_DB_ALIAS).bulk_create(
                    histories[i : i + _BULK_BATCH_SIZE]
                )
            )

        all_items: List[RecordHistoryItem] = []
        for history, (event, items_payload) in zip(created_histories, prepared):
            for field_key, before, after in items_payload:
                all_items.append(
                    RecordHistoryItem(
                        history=history,
                        record_id=event.record.id,
                        field_key=field_key,
                        before=before,
                        after=after,
                        user=event.user,
                    )
                )

        if all_items:
            for i in range(0, len(all_items), _BULK_BATCH_SIZE):
                RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).bulk_create(
                    all_items[i : i + _BULK_BATCH_SIZE]
                )

    _batch_push_histories_to_undo_stack(created_histories, events)

    return created_histories

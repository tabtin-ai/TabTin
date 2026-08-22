"""
CollabYDocSubscriber — Y.js 协同文档同步
提取自 record_service._sync_records_to_ydoc
after_commit 模式 (priority=200)。

A4-L1: per-table 80ms 合并窗口 —— 多个 cell 变更在窗口内合并为单次 Y.Doc 推送,
大幅减少 Agent 批量操作时其他成员前端 CPU。
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from threading import Lock, Timer
from typing import Dict, List, Optional
from uuid import UUID

from django.conf import settings

from apps.tabdata.domain.events import (
    ALL_RECORD_EVENTS, DomainEventBase,
    RecordCreated, RecordDeleted, RecordUpdated,
    RecordsBatchCreated, RecordsBatchDeleted, RecordsBatchUpdated,
)
from apps.tabdata.domain.ports import IEventSubscriber
from apps.tabdata.subscribers._utils import run_after_commit

logger = logging.getLogger(__name__)
_COLLAB_PUSH_BATCH_SIZE = 200

# ── 退避状态管理（per-table, 进程内存，重启自动重置） ──

_failure_state_lock = Lock()
_failure_counts: dict[str, int] = defaultdict(int)
_consecutive_successes: dict[str, int] = defaultdict(int)
_last_failure_time: dict[str, float] = defaultdict(float)
_degraded_tables: set[str] = set()

_MAX_CONSECUTIVE_FAILURES = 5
_BACKOFF_BASE_SECONDS = 2.0
_BACKOFF_MAX_SECONDS = 60.0
_RECOVERY_SUCCESSES_REQUIRED = 2

_STALE_ENTRY_TTL = 600.0  # 10 min
_EVICT_INTERVAL = 60.0    # 每 60s 最多做一次驱逐
_last_evict_time: float = 0.0

# ── A4-L1: 合并窗口默认值(ms) ──
_DEFAULT_MERGE_WINDOW_MS = 80
_MERGE_WINDOW_FLUSH_THRESHOLD = 500


def _get_merge_window_ms() -> int:
    return int(getattr(settings, "TABDATA_YDOC_MERGE_WINDOW_MS", _DEFAULT_MERGE_WINDOW_MS))


def _get_origin_id() -> str:
    """从请求上下文提取当前操作者标识，供前端 originId 跳过。

    优先级:
    1. orchestration thread user_id → 前端 origin_id == userId 时 suppress
       (避免"自己编辑闪烁")
    3. tabdata window_id → 同上,window-level suppress
    4. 空串 → 前端 fallback 渲染(无明确归因)
    """
    try:
        from apps.services.common.thread_context import get_current_user_id
        uid = get_current_user_id()
        if uid:
            return str(uid)
    except Exception:
        pass
    try:
        from apps.tabdata.request_context import get_current_window_id
        wid = get_current_window_id()
        if wid:
            return wid
    except Exception:
        pass
    return ""


# ── A4-L1: per-table 合并窗口管理器 ──

class _MergeWindowManager:
    """
    将多个 push_cells 调用合并为单次推送。

    线程安全：所有操作在 _lock 下执行。
    每个 table 独立窗口；窗口到期或 buffer 超阈值时 flush。
    """

    def __init__(self) -> None:
        self._lock = Lock()
        self._buffers: Dict[str, list] = {}
        self._table_ids: Dict[str, UUID] = {}
        self._origins: Dict[str, str] = {}
        self._timers: Dict[str, Timer] = {}

    def add(
        self,
        table_key: str,
        table_id: UUID,
        changes: list,
        origin_id: str = "",
    ) -> None:
        """累积 changes 到 per-table 合并窗口。

        80ms 窗口内同表多个不同用户 origin 交错时降级为空串，避免任一
        origin 独占 stateless event payload 并导致协作者被错误归因。
        """
        window_ms = _get_merge_window_ms()
        flush_now = False

        with self._lock:
            if table_key not in self._buffers:
                self._buffers[table_key] = []
            self._buffers[table_key].extend(changes)
            self._table_ids[table_key] = table_id
            if origin_id:
                existing = self._origins.get(table_key)
                if existing and existing != origin_id:
                    # 多 origin 混合 → 降级为空串(无 suppress / 无 hint)
                    self._origins[table_key] = ""
                elif not existing:
                    self._origins[table_key] = origin_id
                # 同 origin 继续保留(无变化)

            buf_size = len(self._buffers[table_key])

            if window_ms <= 0 or buf_size >= _MERGE_WINDOW_FLUSH_THRESHOLD:
                flush_now = True
                self._cancel_timer_locked(table_key)
            elif table_key not in self._timers:
                t = Timer(window_ms / 1000.0, self._on_timer, args=(table_key,))
                t.daemon = True
                t.start()
                self._timers[table_key] = t

        if flush_now:
            self._flush(table_key)

    def _on_timer(self, table_key: str) -> None:
        with self._lock:
            self._timers.pop(table_key, None)
        self._flush(table_key)

    def _flush(self, table_key: str) -> None:
        with self._lock:
            changes = self._buffers.pop(table_key, [])
            table_id = self._table_ids.pop(table_key, None)
            origin_id = self._origins.pop(table_key, "")
            self._cancel_timer_locked(table_key)

        if not changes or table_id is None:
            return

        if _should_skip_push(table_key):
            return

        try:
            from apps.tabdata.services.collab_service import CollabService

            batch_failed = False
            for i in range(0, len(changes), _COLLAB_PUSH_BATCH_SIZE):
                batch = changes[i:i + _COLLAB_PUSH_BATCH_SIZE]
                try:
                    CollabService.push_cells(
                        table_id=table_id,
                        changes=batch,
                        agent_id="system:event_subscriber",
                        editor_type="system",
                        origin_id=origin_id,
                    )
                except Exception as exc:
                    batch_failed = True
                    logger.warning(
                        "[CollabYDocSubscriber] push failed (non-blocking): "
                        "table=%s batch=%d err=%s",
                        table_id, i // _COLLAB_PUSH_BATCH_SIZE + 1, exc,
                    )
                    break

            if batch_failed:
                _record_failure(table_key)
            else:
                _record_success(table_key)
        except Exception as exc:
            logger.warning("[CollabYDocSubscriber] push setup failed: %s", exc)
            _record_failure(table_key)

    def flush_all(self) -> None:
        with self._lock:
            keys = list(self._buffers.keys())
        for key in keys:
            self._flush(key)

    def _cancel_timer_locked(self, table_key: str) -> None:
        timer = self._timers.pop(table_key, None)
        if timer is not None:
            timer.cancel()

    def pending_count(self, table_key: str) -> int:
        with self._lock:
            return len(self._buffers.get(table_key, []))


_merge_window_mgr = _MergeWindowManager()


class CollabYDocSubscriber(IEventSubscriber):

    def handles(self) -> List[type]:
        return list(ALL_RECORD_EVENTS)

    def priority(self) -> int:
        return 200

    def handle(self, event: DomainEventBase) -> None:
        skip = getattr(event, "skip_flags", None) or {}
        if skip.get("ydoc_sync"):
            return

        try:
            table_id = event.table_id
            record_payloads = self._extract_record_payloads(event)
            deleted_ids = self._extract_deleted_ids(event)

            if not record_payloads and not deleted_ids:
                return

            created_ids = self._extract_created_ids(event)
            origin_id = _get_origin_id()
            self._sync_to_ydoc(
                table_id, record_payloads, deleted_ids, origin_id,
                created_ids=created_ids,
            )
        except Exception:
            logger.error(
                "[CollabYDocSubscriber] failed: event=%s",
                type(event).__name__, exc_info=True,
            )

    def _sync_to_ydoc(
        self,
        table_id: UUID,
        record_payloads: List[tuple],
        deleted_ids: List[str],
        origin_id: str = "",
        created_ids: Optional[List[str]] = None,
    ) -> None:
        """W2.perf-fix2 三视角 Review L30 修复:从 event payload 直接构造 changes,
        不再做 ``TableRecord.objects.filter(id__in=...)`` 反查。

        ``record_payloads`` 为 ``(record_id_str, payload_data)`` 列表;``payload_data``
        是已 normalize 的 ``Dict[field_id_str, value]``(对齐 W0-2 audit §3.4
        DomainEvent payload 契约)。

        对于域事件 payload 不含 after data(罕见旧路径)的情况,退化为 DB 查询
        以保证向后兼容。
        """
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import TableField

        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id, is_deleted=False,
            )
        )
        field_hex_map = {str(f.id): f.id.hex for f in fields}

        # 锚点口径：为新出现的记录（create / restore）算出 __order 前驱，
        # 随 cell change 附带 after_record_id，让 collab-live 把它插到前驱之后，
        # 协作行序跟随 __order，而不再一律 maxPos+1 沉底。
        anchor_map = self._compute_anchor_map(table_id, created_ids or [])

        def _build_change(rid_str: str, field_hex: str, value) -> dict:
            change = {
                "record_id": rid_str,
                "field_id_hex": field_hex,
                "value": value,
            }
            if rid_str in anchor_map:
                change["after_record_id"] = anchor_map[rid_str]
            return change

        changes: list = []
        ids_needing_db_lookup: List[str] = []

        for rid_str, payload_data in record_payloads:
            if payload_data is None:
                ids_needing_db_lookup.append(rid_str)
                continue
            for field_id_str, field_hex in field_hex_map.items():
                if field_id_str in payload_data:
                    value = payload_data[field_id_str]
                    changes.append(_build_change(rid_str, field_hex, value))
                elif field_hex in payload_data:
                    value = payload_data.get(field_hex)
                    changes.append(_build_change(rid_str, field_hex, value))

        # Fallback:仅有少数旧路径 event 不带 after,此时退化为 DB 反查
        if ids_needing_db_lookup:
            from apps.tabdata.models import TableRecord
            from apps.tabdata.utils.record_data_access import read_data
            for record in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=ids_needing_db_lookup,
            ):
                record_data = read_data(record)
                record_id_str = str(record.id)
                for field_id_str, field_hex in field_hex_map.items():
                    if field_id_str in record_data:
                        value = record_data[field_id_str]
                        changes.append(_build_change(record_id_str, field_hex, value))
                    elif field_hex in record_data:
                        value = record_data.get(field_hex)
                        changes.append(_build_change(record_id_str, field_hex, value))

        for rid in deleted_ids:
            changes.append({"record_id": rid, "type": "delete"})

        if not changes:
            return

        captured_origin = origin_id

        def _push_after_commit() -> None:
            table_key = str(table_id)
            _merge_window_mgr.add(
                table_key=table_key,
                table_id=table_id,
                changes=changes,
                origin_id=captured_origin,
            )

        run_after_commit(_push_after_commit)

    @staticmethod
    def _extract_record_payloads(event: DomainEventBase) -> List[tuple]:
        """提取 ``(record_id_str, after_or_data_dict|None)`` 列表。

        优先从 event payload 直接取 after/data,跳过 DB 反查(L30 优化)。
        若 payload 缺 after 字段(旧路径),返回 ``(rid, None)`` 让上游 fallback 查库。
        """
        if isinstance(event, (RecordDeleted, RecordsBatchDeleted)):
            return []

        # 单条事件
        if isinstance(event, RecordCreated):
            return [(str(event.record_id), event.after or event.data or {})]
        if isinstance(event, RecordUpdated):
            return [(str(event.record_id), event.after or {})]
        # 批量事件
        if isinstance(event, RecordsBatchCreated):
            payloads = []
            for p in event.records:
                data = getattr(p, 'after', None) or getattr(p, 'data', None) or {}
                payloads.append((str(p.record_id), data))
            return payloads
        if isinstance(event, RecordsBatchUpdated):
            payloads = []
            for p in event.records:
                # after 是 patch 后完整 data;若 ChangeLog 等 caller 未填,fallback 查库
                after = getattr(p, 'after', None)
                payloads.append((str(p.record_id), after if after else None))
            return payloads

        # 兜底:hasattr 探测以兼容未知子类
        if hasattr(event, "record_id") and event.record_id is not None:
            return [(str(event.record_id), None)]
        if hasattr(event, "records"):
            return [(str(p.record_id), None) for p in event.records]
        return []

    @staticmethod
    def _extract_created_ids(event: DomainEventBase) -> List[str]:
        """提取新建记录事件的 record_id。

        这些记录在协作 Y.Doc 中尚不存在，collab-live 新建它们时需要 anchor 定位，
        否则一律 maxPos+1 沉底。update 事件的记录已在 Y.Doc 中，不需要 anchor。
        """
        if isinstance(event, RecordCreated):
            return [str(event.record_id)]
        if isinstance(event, RecordsBatchCreated):
            return [str(p.record_id) for p in event.records]
        return []

    @staticmethod
    def _compute_anchor_map(
        table_id: UUID, created_ids: List[str],
    ) -> Dict[str, Optional[str]]:
        """为每个新出现的记录算出 __order 前驱（anchor）。

        anchor = 同表内 ``order`` 严格小于本记录、且 order 最大的那条记录；
        无前驱（本记录是全局最前）时为 ``None`` —— collab-live 据此插到最前。
        子记录场景下 anchor 即父记录（新子记录 order 介于父与父的后继之间）。
        """
        if not created_ids:
            return {}

        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import TableRecord

        created = {
            str(r.id): r
            for r in TableRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(id__in=created_ids, is_deleted=False)
            .only("id", "order")
        }

        anchor_map: Dict[str, Optional[str]] = {}
        for cid in created_ids:
            rec = created.get(cid)
            if rec is None or rec.order is None:
                anchor_map[cid] = None
                continue
            prev = (
                TableRecord.objects.using(TABDATA_DB_ALIAS)
                .filter(table_id=table_id, is_deleted=False, order__lt=rec.order)
                .exclude(id=rec.id)
                .order_by("-order", "-created_at", "-id")
                .only("id")
                .first()
            )
            anchor_map[cid] = str(prev.id) if prev else None
        return anchor_map

    @staticmethod
    def _extract_record_ids(event: DomainEventBase) -> List[str]:  # 向后兼容
        return [rid for rid, _ in CollabYDocSubscriber._extract_record_payloads(event)]

    @staticmethod
    def _extract_deleted_ids(event: DomainEventBase) -> List[str]:
        if isinstance(event, RecordDeleted):
            return [str(event.record_id)]
        if isinstance(event, RecordsBatchDeleted):
            return [str(p.record_id) for p in event.records]
        return []


# ── 退避逻辑辅助函数 ──


def _maybe_evict_stale() -> None:
    """低频清理过期且非降级的计数器条目，需在 _failure_state_lock 内调用。"""
    global _last_evict_time
    now = time.monotonic()
    if now - _last_evict_time < _EVICT_INTERVAL:
        return
    _last_evict_time = now

    stale_keys = [
        k for k, t in list(_last_failure_time.items())
        if k not in _degraded_tables and now - t > _STALE_ENTRY_TTL
    ]
    for k in stale_keys:
        _failure_counts.pop(k, None)
        _consecutive_successes.pop(k, None)
        _last_failure_time.pop(k, None)


def _should_skip_push(table_key: str) -> bool:
    """在退避窗口内时跳过推送。"""
    with _failure_state_lock:
        count = _failure_counts.get(table_key, 0)
        if count < _MAX_CONSECUTIVE_FAILURES:
            return False
        elapsed = time.monotonic() - _last_failure_time.get(table_key, 0.0)
        backoff = min(
            _BACKOFF_BASE_SECONDS * (2 ** (count - _MAX_CONSECUTIVE_FAILURES)),
            _BACKOFF_MAX_SECONDS,
        )
        if elapsed < backoff:
            logger.debug(
                "[CollabYDocSubscriber] skipping push for table=%s "
                "(backoff %.1fs, elapsed %.1fs)",
                table_key, backoff, elapsed,
            )
            return True
        return False


def _record_failure(table_key: str) -> None:
    """记录一次推送失败，必要时触发降级通知。"""
    should_notify = False
    with _failure_state_lock:
        _failure_counts[table_key] += 1
        _consecutive_successes[table_key] = 0
        _last_failure_time[table_key] = time.monotonic()
        count = _failure_counts[table_key]
        if count >= _MAX_CONSECUTIVE_FAILURES and table_key not in _degraded_tables:
            _degraded_tables.add(table_key)
            should_notify = True
        _maybe_evict_stale()

    if should_notify:
        logger.warning(
            "[CollabYDocSubscriber] table=%s entered degraded state "
            "after %d consecutive failures",
            table_key, count,
        )
        _notify_collab_status(table_key, degraded=True)


def _record_success(table_key: str) -> None:
    """记录一次推送成功，满足防抖条件后恢复。"""
    should_notify = False
    with _failure_state_lock:
        if table_key not in _degraded_tables:
            _failure_counts.pop(table_key, None)
            _consecutive_successes.pop(table_key, None)
            _last_failure_time.pop(table_key, None)
            _maybe_evict_stale()
            return

        _consecutive_successes[table_key] += 1
        successes = _consecutive_successes[table_key]
        if successes < _RECOVERY_SUCCESSES_REQUIRED:
            _maybe_evict_stale()
            return

        _failure_counts.pop(table_key, None)
        _consecutive_successes.pop(table_key, None)
        _last_failure_time.pop(table_key, None)
        _degraded_tables.discard(table_key)
        should_notify = True
        _maybe_evict_stale()

    if should_notify:
        logger.info(
            "[CollabYDocSubscriber] table=%s restored from degraded state "
            "after %d consecutive successes",
            table_key, _RECOVERY_SUCCESSES_REQUIRED,
        )
        _notify_collab_status(table_key, degraded=False)


def _notify_collab_status(table_key: str, *, degraded: bool) -> None:
    """通过 WS 事件通知前端协作状态变化。"""
    try:
        from apps.tabdata.services.table_event_service import table_event_service

        action = "collab.degraded" if degraded else "collab.restored"
        table_event_service.publish_table_update(
            table_key,
            action=action,
            metadata={"reason": "ydoc_push_backoff"},
        )
    except Exception:
        logger.warning(
            "[CollabYDocSubscriber] failed to notify collab status "
            "for table=%s degraded=%s",
            table_key, degraded, exc_info=True,
        )

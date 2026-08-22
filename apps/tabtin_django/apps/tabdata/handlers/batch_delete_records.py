"""BatchDeleteRecordsHandler — 批量记录删除编排。

数据流：版本批量分配 → 事务内逐条（Link 清理 + 物理删除 ORM + 原生列）→
汇总关联标题刷新 → 合并为 RecordsBatchDeleted 事件发布 + 跨表 WS。

#4805：每条删除包在 savepoint 内，单条清理失败不影响其余记录提交。
#9698：ORM tombstone 是记录生命周期的权威状态；显式删除原生投影时只按 ID
#清理，不再把投影内部版本漂移暴露为用户侧删除冲突。
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict, List, Set, Tuple
from uuid import UUID

from apps.tabdata.domain.aggregates import RecordAggregate
from apps.tabdata.handlers._base import RecordHandlerBase

if TYPE_CHECKING:
    from apps.tabdata.domain.events import RecordDeleted
    from apps.tabdata.domain.value_objects import RecordCommandContext

logger = logging.getLogger(__name__)


class _RecordGoneDuringDelete(Exception):
    """锁定后记录仍被删除时触发当前 savepoint 回滚。"""


class BatchDeleteRecordsHandler(RecordHandlerBase):
    """编排批量记录删除。逐条清理 Link 并物理删除后统一发布事件。"""

    def handle(self, context: RecordCommandContext) -> Tuple[int, List[str], List[UUID], List[UUID]]:
        """批量物理删除记录并发布 RecordsBatchDeleted 事件。

        Returns:
            (deleted_count, errors, deleted_record_ids, failed_record_ids)
        """
        if not context.record_ids:
            return 0, ["批量删除记录不能为空"], [], []

        self._prepare_native_io(context.table_id)

        delete_events: List[RecordDeleted] = []
        errors: List[str] = []
        all_link_affected: List[Dict[str, Any]] = []
        link_update_events: List[Any] = []
        cross_table_ws: Dict[str, Set[str]] = {}
        deleted_record_ids: List[UUID] = []
        failed_record_ids: List[UUID] = []
        successful_delete_versions: List[int] = []

        def _persist() -> None:
            nonlocal link_update_events
            self._repo.lock_table(context.table_id)
            normalized_ids: List[UUID] = []
            for record_id in context.record_ids:
                try:
                    normalized_ids.append(UUID(str(record_id)))
                except (TypeError, ValueError):
                    continue
            locked_records = {
                snapshot.id: snapshot
                for snapshot in self._repo.get_by_ids_for_update(normalized_ids)
            }
            # Repository 以 id 排序拿齐锁后再分配版本，防止交叠批次锁序不一，
            # 同时确保 tombstone 版本晚于等待期间已经提交的更新。
            count = len(context.record_ids)
            current_version_floor = max(
                (snapshot.version for snapshot in locked_records.values()),
                default=0,
            )
            version_start, _ = self._allocate_versions_after(
                context.table_id,
                current_version_floor,
                count=count,
            )

            for i, record_id in enumerate(context.record_ids):
                try:
                    normalized_id = UUID(str(record_id))
                    existing = locked_records.get(normalized_id)
                    if existing is None:
                        errors.append(f"第{i + 1}条: 记录不存在")
                        failed_record_ids.append(normalized_id)
                        continue

                    version = version_start + i
                    event = RecordAggregate.delete(
                        existing=existing,
                        user_id=context.user_id,
                        version=version,
                        skip_flags=context.skip_flags,
                        operation_group_id=str(context.operation_group_id) if context.operation_group_id else None,
                    )

                    def _per_record():
                        # Link 和附件清理都依赖仍存在的记录/引用，必须先于物理删除，
                        # 并留在单记录 savepoint 内以保持失败回滚语义。
                        link_affected = self._link_svc.cleanup_record_links(existing)
                        self._attachment_svc.cleanup_record_attachments(existing.id)
                        if not self._repo.delete(existing.id):
                            raise _RecordGoneDuringDelete
                        self._native_io.delete_record(
                            record_id=existing.id,
                            version=0,
                            updated_by=context.user_id,
                        )
                        return link_affected

                    try:
                        link_affected = self._uow.with_savepoint(_per_record)
                    except _RecordGoneDuringDelete:
                        errors.append(f"第{i + 1}条: 记录不存在")
                        failed_record_ids.append(normalized_id)
                        continue
                    all_link_affected.extend(link_affected or [])
                    deleted_record_ids.append(existing.id)
                    delete_events.append(event)
                    successful_delete_versions.append(version)
                except Exception as exc:
                    errors.append(f"第{i + 1}条: {exc}")
                    failed_record_ids.append(UUID(str(record_id)))
                    logger.warning(
                        "batch_delete failed record=%s err=%s", record_id, exc,
                    )

            if successful_delete_versions:
                self._repo.mark_delete_version(
                    context.table_id,
                    max(successful_delete_versions),
                )
            link_update_events = self._build_link_affected_update_events(
                all_link_affected, context,
            )
            self._handle_cascade_after_delete(all_link_affected, cross_table_ws)

        self._uow.with_transaction(_persist)

        if delete_events:
            batch_event = RecordAggregate.batch_deleted_event(
                table_id=context.table_id,
                events=delete_events,
                user_id=context.user_id,
                skip_flags=context.skip_flags,
                operation_group_id=str(context.operation_group_id) if context.operation_group_id else None,
            )
            if self._should_publish_event(context):
                self._event_bus.publish(batch_event)
                for update_event in link_update_events:
                    self._event_bus.publish(update_event)

        self._publish_cross_table_ws(cross_table_ws)
        return len(delete_events), errors, deleted_record_ids, failed_record_ids

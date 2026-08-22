"""DeleteRecordHandler — 单条记录删除编排。

数据流：获取现有记录 → 版本分配 → 聚合根生成删除事件 → 事务内（Link 清理
→ 物理删除 ORM + 原生列 + 对侧关联标题刷新）→ 事件发布 + 跨表 WS。
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict, List, Set

from apps.tabdata.domain.aggregates import RecordAggregate
from apps.tabdata.exceptions import RecordVersionConflictError
from apps.tabdata.handlers._base import RecordHandlerBase

if TYPE_CHECKING:
    from apps.tabdata.domain.value_objects import RecordCommandContext

logger = logging.getLogger(__name__)


class _RecordGoneDuringDelete(Exception):
    """锁定后记录仍被删除时触发事务回滚。"""


class DeleteRecordHandler(RecordHandlerBase):
    """编排单条记录删除。handle() 不超过 40 行。"""

    def handle(self, context: RecordCommandContext) -> bool:
        """不可恢复地删除一条记录并发布 RecordDeleted 事件。

        Returns:
            True 删除成功；False 记录不存在。
        """
        existing = self._repo.get_by_id(context.record_id)
        if existing is None:
            return False

        self._prepare_native_io(existing.table_id)

        link_affected: List[Dict[str, Any]] = []
        link_update_events: List[Any] = []
        cross_table_ws: Dict[str, Set[str]] = {}
        event = None
        deleted = False

        def _persist() -> None:
            nonlocal link_affected, link_update_events, event, deleted
            self._repo.lock_table(existing.table_id)
            locked_existing = self._repo.get_by_id_for_update(existing.id)
            if locked_existing is None:
                return

            if (
                context.expected_version is not None
                and locked_existing.version != context.expected_version
            ):
                raise RecordVersionConflictError(
                    locked_existing.id,
                    expected_version=context.expected_version,
                )

            # 等待并确认当前生命周期后再分配版本，确保 tombstone 严格晚于
            # 它所覆盖的最后一次更新。
            new_version, _ = self._allocate_versions_after(
                locked_existing.table_id,
                locked_existing.version,
            )
            event = RecordAggregate.delete(
                existing=locked_existing,
                user_id=context.user_id,
                version=new_version,
                skip_flags=context.skip_flags,
                operation_group_id=(
                    str(context.operation_group_id)
                    if context.operation_group_id else None
                ),
            )
            # Link 适配器需要从 DB 重新加载 ORM 记录，并在级联删除前收集对侧关系。
            # 附件引用同样会随记录级联删除，必须在物理删除前完成计量清理；
            # 后续失败由外层事务整体回滚。
            link_affected = self._link_svc.cleanup_record_links(locked_existing)
            self._attachment_svc.cleanup_record_attachments(locked_existing.id)
            deleted = self._repo.delete(locked_existing.id)
            if not deleted:
                event = None
                raise _RecordGoneDuringDelete
            self._native_io.delete_record(
                record_id=locked_existing.id,
                version=0,
                updated_by=context.user_id,
            )
            self._repo.mark_delete_version(locked_existing.table_id, new_version)
            link_update_events = self._build_link_affected_update_events(
                link_affected, context,
            )
            self._handle_cascade_after_delete(link_affected, cross_table_ws)

        try:
            self._uow.with_transaction(_persist)
        except _RecordGoneDuringDelete:
            link_affected = []

        if event is not None and self._should_publish_event(context):
            self._event_bus.publish(event)
            for update_event in link_update_events:
                self._event_bus.publish(update_event)
        self._publish_cross_table_ws(cross_table_ws)

        return deleted

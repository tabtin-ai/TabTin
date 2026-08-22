"""CreateRecordHandler — 单条记录创建编排。

数据流：事务内 Table 闸门 → 获取字段 → 版本分配 → 聚合根创建 →
持久化（ORM + 原生列 + 附件同步）→ 事件发布。
权限 / RLS / 配额检查由 API 层在构建 RecordCommandContext 之前完成。
"""
from __future__ import annotations

import copy
from dataclasses import replace
from typing import TYPE_CHECKING, Optional, Tuple

from apps.tabdata.domain.aggregates import RecordAggregate
from apps.tabdata.handlers._base import RecordHandlerBase
from apps.tabdata.native.value_converter import build_native_field_values

if TYPE_CHECKING:
    from apps.tabdata.domain.value_objects import RecordCommandContext, RecordSnapshot


class CreateRecordHandler(RecordHandlerBase):
    """编排单条记录创建。"""

    def handle(self, context: RecordCommandContext) -> Tuple[RecordSnapshot, Optional[str]]:
        """创建一条记录并发布 RecordCreated 事件。

        Returns:
            (snapshot, None) 成功时返回记录快照；
            (snapshot, error_msg) 失败时返回错误信息。
        """
        self._prepare_native_io(context.table_id)
        snapshot: Optional[RecordSnapshot] = None
        result_event = None

        def _persist() -> None:
            nonlocal snapshot, result_event

            self._repo.lock_table(context.table_id)
            # Table 闸门后刷新 schema，避免等待字段转换后仍按旧类型写 native 列。
            locked_fields = self._field_repo.get_fields(context.table_id)
            version = self._repo.next_version(context.table_id)
            snapshot, event = RecordAggregate.create_new(
                table_id=context.table_id,
                data=context.data or {},
                fields=locked_fields,
                user_id=context.user_id,
                version=version,
                skip_flags=context.skip_flags,
                order_value=context.resolved_order_value,
                operation_group_id=(
                    str(context.operation_group_id)
                    if context.operation_group_id else None
                ),
            )

            if getattr(context, 'select_choice_values', None):
                self._field_repo.merge_select_choices(
                    context.table_id,
                    context.select_choice_values,
                )

            self._repo.insert(snapshot)
            patch = snapshot.clone_data()
            self._apply_link_fields(patch, snapshot, locked_fields)
            if patch != snapshot.formatted_data:
                snapshot.formatted_data = patch
                self._repo.update_one(
                    record_id=snapshot.id,
                    data=snapshot.formatted_data,
                    version=snapshot.version,
                    updated_by=snapshot.updated_by,
                )

            native_field_values = build_native_field_values(
                snapshot.formatted_data,
                locked_fields,
            )
            self._native_io.insert_record(
                record_id=snapshot.id,
                field_values=native_field_values,
                system_values=self._build_system_values(snapshot),
            )
            self._attachment_svc.sync_record_attachments(snapshot)
            after = copy.deepcopy(snapshot.formatted_data)
            result_event = replace(event, data=after, after=after)

        self._uow.with_transaction(_persist)

        if result_event is not None and self._should_publish_event(context):
            self._event_bus.publish(result_event)

        assert snapshot is not None
        return snapshot, None

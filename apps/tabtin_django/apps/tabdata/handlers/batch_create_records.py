"""BatchCreateRecordsHandler — 批量记录创建编排。

数据流：事务内 Table 闸门 → 获取字段 → 版本批量分配 → 逐条聚合根创建 → 批量持久化
（ORM + 原生列 + 附件同步）→ 合并为 RecordsBatchCreated 事件发布。
"""
from __future__ import annotations

import copy
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Dict, List, Tuple
from uuid import UUID

from apps.tabdata.domain.aggregates import RecordAggregate
from apps.tabdata.handlers._base import RecordHandlerBase
from apps.tabdata.native.value_converter import python_to_pg

if TYPE_CHECKING:
    from apps.tabdata.domain.events import RecordCreated
    from apps.tabdata.domain.value_objects import (
        FieldSchema,
        RecordCommandContext,
        RecordSnapshot,
    )


class BatchCreateRecordsHandler(RecordHandlerBase):
    """编排批量记录创建。"""

    def handle(
        self, context: RecordCommandContext,
    ) -> Tuple[List[RecordSnapshot], List[str]]:
        """批量创建记录并发布 RecordsBatchCreated 事件。

        Returns:
            (snapshots, errors) — 成功创建的快照列表 + 逐条错误信息。
        """
        if not context.records_data:
            return [], ["批量创建记录不能为空"]

        self._prepare_native_io(context.table_id)

        pairs: List[Tuple[RecordSnapshot, RecordCreated]] = []
        errors: List[str] = []
        snapshots: List[RecordSnapshot] = []

        def _persist() -> None:
            self._repo.lock_table(context.table_id)
            # Table 闸门后刷新 schema，避免等待字段转换后仍按旧类型写 native 列。
            locked_fields = self._field_repo.get_fields(context.table_id)

            count = len(context.records_data)
            max_version = self._repo.next_version(context.table_id, count=count)
            version_start = max_version - count + 1
            for i, record_data in enumerate(context.records_data):
                try:
                    order_val = (
                        context.resolved_order_values[i]
                        if (
                            context.resolved_order_values
                            and i < len(context.resolved_order_values)
                        )
                        else None
                    )
                    client_rid = (
                        context.client_record_ids_list[i]
                        if (
                            context.client_record_ids_list
                            and i < len(context.client_record_ids_list)
                        )
                        else None
                    )
                    snapshot, event = RecordAggregate.create_new(
                        table_id=context.table_id,
                        data=record_data,
                        fields=locked_fields,
                        user_id=context.user_id,
                        version=version_start + i,
                        skip_flags=context.skip_flags,
                        order_value=order_val,
                        record_id=client_rid,
                        operation_group_id=(
                            str(context.operation_group_id)
                            if context.operation_group_id else None
                        ),
                    )
                    pairs.append((snapshot, event))
                except Exception as exc:
                    errors.append(f"第{i + 1}条: {exc}")

            if not pairs:
                return

            if getattr(context, 'select_choice_values', None):
                self._field_repo.merge_select_choices(
                    context.table_id,
                    context.select_choice_values,
                )

            snapshots.extend(snapshot for snapshot, _event in pairs)
            field_map: Dict[str, FieldSchema] = {}
            for field in locked_fields:
                field_map[str(field.id)] = field
                field_map[field.id.hex] = field

            self._repo.insert_many(snapshots)

            # LinkFieldService needs the source records to exist.  Keep this
            # ordering aligned with CreateRecordHandler so bulk-created links
            # write LinkRecord, rebuild the source title, and sync the peer.
            updated_snapshots: List[RecordSnapshot] = []
            updated_pairs: List[Tuple[RecordSnapshot, RecordCreated]] = []
            for snapshot, event in pairs:
                patch = snapshot.clone_data()
                self._apply_link_fields(patch, snapshot, locked_fields)
                if patch != snapshot.formatted_data:
                    snapshot.formatted_data = patch
                    updated_snapshots.append(snapshot)
                after = copy.deepcopy(snapshot.formatted_data)
                updated_pairs.append((snapshot, replace(event, data=after, after=after)))

            if updated_snapshots:
                self._repo.update_many([
                    {
                        'record_id': snapshot.id,
                        'data': snapshot.formatted_data,
                        'version': snapshot.version,
                        'updated_by': snapshot.updated_by,
                    }
                    for snapshot in updated_snapshots
                ])

            native_rows: List[Dict[str, Any]] = []
            for snapshot in snapshots:
                row: Dict[str, Any] = {'__id': snapshot.id}
                sys_vals = self._build_system_values(snapshot)
                for sys_key, sys_val in sys_vals.items():
                    if isinstance(sys_val, UUID):
                        sys_val = str(sys_val)
                    row[sys_key] = sys_val
                for fid_str, value in snapshot.formatted_data.items():
                    field = field_map.get(fid_str)
                    if field is None:
                        continue
                    row[field.id.hex] = python_to_pg(
                        value, field.field_type, getattr(field, 'config', None),
                    )
                native_rows.append(row)

            if native_rows:
                self._native_io.bulk_insert_records(native_rows)
            for snapshot in snapshots:
                self._attachment_svc.sync_record_attachments(snapshot)
            pairs[:] = updated_pairs

        self._uow.with_transaction(_persist)

        if pairs and self._should_publish_event(context):
            batch_event = RecordAggregate.batch_created_event(
                table_id=context.table_id,
                snapshots_and_events=pairs,
                user_id=context.user_id,
                skip_flags=context.skip_flags,
                operation_group_id=str(context.operation_group_id) if context.operation_group_id else None,
            )
            self._event_bus.publish(batch_event)

        return snapshots, errors

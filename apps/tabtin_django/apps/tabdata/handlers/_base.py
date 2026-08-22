"""Handler 基类 — 提供共享构造函数与通用工具方法。

所有 Record Handler 继承此基类，通过构造函数注入 Port 依赖。
基类提供 Phase 1 事务内操作的通用编排工具（Link 处理、
Link Title 传播、删除后关联刷新）以及跨表 WS 通知的占位实现。
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set
from uuid import UUID, uuid4

from django.db import transaction
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS

if TYPE_CHECKING:
    from apps.tabdata.domain.ports import (
        IAttachmentService,
        ICascadeService,
        IEventBus,
        IFieldRepository,
        ILinkService,
        INativeRecordIO,
        IRecordRepository,
        IUnitOfWork,
    )
    from apps.tabdata.domain.value_objects import (
        FieldSchema,
        RecordCommandContext,
        RecordSnapshot,
    )

logger = logging.getLogger(__name__)


# ── B-4 / Wave 1.1：跳过副作用的统一枚举（文档化 caller 意图） ──
# 任何新增枚举值都需在本表登记并补到 ``RecordHandlerBase.should_skip`` 的
# docstring，否则视为非法。Handler 检查 should_skip 时必须使用这里的常量。

#: 跳过 **所有** 副作用：DomainEvent 不发布 → RH / CL / cascade / WS 全部跳过。
#: 注意：若 caller 希望跳过 RH/CL 但仍要副作用（违反 C5 链路保证），W0-2 audit
#: §3.5 已警示这是 Charter §3.1 的最坏破口（"CL 写、RH 不写"），禁止使用；如
#: 必须保留只跳一类副作用的场景，应该走更细粒度的 skip 而非 ``all_side_effects``。
SKIP_ALL_SIDE_EFFECTS = "all_side_effects"

#: 跳过 Undo 栈推入（_push_history_to_undo_stack）。RH 仍写。
SKIP_UNDO_STACK = "skip_undo_stack"

#: ``RecordCommandContext`` 当前承认的全部 skip flag 名（用于守门 + 测试断言）。
#: 后续若新增 ``skip_rh`` / ``skip_cl`` 等细粒度枚举，必须同步加进此 frozenset。
KNOWN_SKIP_FLAGS: frozenset[str] = frozenset({
    SKIP_ALL_SIDE_EFFECTS,
    SKIP_UNDO_STACK,
})


class RecordHandlerBase:
    """所有 Record Handler 的共享基类。通过构造函数注入 Port 依赖。"""

    def __init__(
        self,
        record_repository: IRecordRepository,
        native_io: INativeRecordIO,
        unit_of_work: IUnitOfWork,
        event_bus: IEventBus,
        field_repository: IFieldRepository,
        link_service: ILinkService,
        cascade_service: ICascadeService,
        attachment_service: IAttachmentService,
    ) -> None:
        self._repo = record_repository
        self._native_io = native_io
        self._uow = unit_of_work
        self._event_bus = event_bus
        self._field_repo = field_repository
        self._link_svc = link_service
        self._cascade_svc = cascade_service
        self._attachment_svc = attachment_service

    # ── B-4 / Wave 1.1：副作用守门（DomainEvent publish 与否） ────────────────

    @staticmethod
    def should_skip(context: RecordCommandContext, skip_type: str) -> bool:
        """统一的"是否跳过此类副作用"判定（B-4 / Wave 1.1）。

        所有 Handler 必须通过本方法判定 skip flag 而非内联读 ``context.skip_flags``，
        理由：
        1. **可观测性**：访问未登记的 skip flag 时打 warning，给"魔法字符串
           笔误"留下排查痕迹（W0-2 audit §3.6 提议的 dev 模式守门）。
        2. **演进单点**：未来若需要把 ``all_side_effects`` 拆为细粒度
           （``ws_notification`` / ``ydoc_sync`` / ``undo_stack``）只需改本方法 +
           ``KNOWN_SKIP_FLAGS``，无需扫描所有 Handler。
        3. **语义对齐**：``RecordCommandContext.should_skip('all_side_effects')``
           本身是一个特殊"祖宗 flag"——一旦 True，所有具名 flag 隐式为 True。
           本方法继承该语义。

        :param context: Handler 的 :class:`RecordCommandContext` 输入
        :param skip_type: 要查询的 skip flag 名；必须在 :data:`KNOWN_SKIP_FLAGS`
            中登记，否则返回 ``False`` 并打 warning（不抛异常以保持向后兼容）。

        承认的枚举值（与 :data:`KNOWN_SKIP_FLAGS` 同步）：

        - ``"all_side_effects"`` —— 跳过 DomainEvent publish，RH / CL / cascade /
          WS 全部跳过。**SubRecordService 是当前唯一合法 caller**（B-3 已修复
          为标准路径），其余 caller 必须显式细分。
        - ``"skip_undo_stack"`` —— 跳过 Undo 栈推入，RH 仍写。供 reorder /
          import default 路径使用。

        :returns: True 表示应跳过该类副作用。
        """
        if skip_type not in KNOWN_SKIP_FLAGS:
            logger.warning(
                "RecordHandlerBase.should_skip received unknown skip_type=%r; "
                "treating as False. Allowed: %s",
                skip_type, sorted(KNOWN_SKIP_FLAGS),
            )
            return False
        return context.should_skip(skip_type)

    def _should_publish_event(self, context: RecordCommandContext) -> bool:
        """副作用守门的常用便捷形式：等价于 ``not should_skip(SKIP_ALL_SIDE_EFFECTS)``。

        所有 Handler 在调用 ``self._event_bus.publish(...)`` 前都应该先调用本
        方法判定，避免在每个 Handler 中重复 ``if not context.should_skip(...)``
        的内联逻辑。
        """
        return not self.should_skip(context, SKIP_ALL_SIDE_EFFECTS)

    # ── Native IO 辅助 ─────────────────────────────────────────

    def _prepare_native_io(self, table_id: UUID) -> None:
        """为目标表配置 NativeRecordIOAdapter（延迟初始化场景）。

        通过 Table model 查找 space_id，然后调用 adapter.configure()。
        若 adapter 已就绪且 table 未变，configure 内部短路，无额外开销。
        """
        if hasattr(self._native_io, 'configure'):
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            from apps.tabdata.models import Table
            from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
            table = Table.objects.using(TABDATA_DB_ALIAS).only(
                'space_id', 'organization_id',
            ).get(id=table_id)
            self._native_io.configure(space_id=resolve_schema_partition_id(table), table_id=table_id)

    def _allocate_versions_after(
        self,
        table_id: UUID,
        current_version_floor: int,
        *,
        count: int = 1,
    ) -> tuple[int, int]:
        """在持有记录锁后分配严格高于当前行版本的一段版本号。

        正常情况下 table.record_version_seq 已不小于所有记录版本，一次分配
        即可。若历史漂移使序列落后，则原子补齐差额，保证返回区间
        ``[start, end]`` 的每个版本都大于 ``current_version_floor``。
        """
        count = max(int(count), 1)
        floor = max(int(current_version_floor or 0), 0)
        end = self._repo.next_version(table_id, count=count)
        required_end = floor + count
        if end < required_end:
            end = self._repo.next_version(table_id, count=required_end - end)
        return end - count + 1, end

    @staticmethod
    def _build_system_values(snapshot: RecordSnapshot) -> Dict[str, Any]:
        """从 RecordSnapshot 构建原生列存储的系统字段值。"""
        return {
            '__version': snapshot.version,
            '__created_at': snapshot.created_at,
            '__updated_at': snapshot.updated_at,
            '__created_by': snapshot.created_by,
            '__updated_by': snapshot.updated_by,
            '__order': snapshot.order_value,
        }

    # ── Link 字段处理 ──────────────────────────────────────────

    def _apply_link_fields(
        self,
        patch: Dict[str, Any],
        existing: RecordSnapshot,
        fields: List[FieldSchema],
    ) -> List[str]:
        """处理 patch 中的 Link 字段值。事务内调用。

        对每个 Link 字段调用 ``set_link_cell``，将原始输入替换为
        计算后的 cell_value。返回被处理的 Link 字段 ID 列表，
        以便后续刷新受影响的关联字段标题。

        RecordService._format_record_data 会把输入 key 归一成 ``field.id.hex``，
        因此这里必须同时识别 dashed UUID / hex / 字段名；否则 set_link_cell
        被跳过，LinkField.format 填的 ``title: ""`` 会原样落库，网格用
        ``title || id`` 就会显示裸 UUID。
        """
        link_field_ids_updated: List[str] = []
        for field in fields:
            if field.field_type != 'link':
                continue
            fid_str = str(field.id)
            fid_hex = field.id.hex
            key_used: Optional[str] = None
            input_value: Any = None
            for candidate in (fid_str, fid_hex, field.name):
                if candidate in patch:
                    key_used = candidate
                    input_value = patch[candidate]
                    break
            if key_used is None:
                continue

            linked_ids = self._extract_linked_ids(input_value)
            cell_value = self._link_svc.set_link_cell(field, existing, linked_ids)
            # 统一写 dashed UUID，并清掉 hex/name 旧键，避免双键并存时
            # serialize 命中带空 title 的陈旧值。
            patch[fid_str] = cell_value
            for alt in (fid_hex, field.name):
                if alt != fid_str and alt in patch:
                    del patch[alt]
            link_field_ids_updated.append(fid_str)
        return link_field_ids_updated

    @staticmethod
    def _extract_linked_ids(input_value: Any) -> List[str]:
        """从各种输入格式中提取 Link 目标记录 ID 列表。"""
        if input_value is None:
            return []
        if isinstance(input_value, list):
            ids: List[str] = []
            for item in input_value:
                if isinstance(item, dict) and 'id' in item:
                    ids.append(str(item['id']))
                elif isinstance(item, str):
                    ids.append(item)
            return ids
        if isinstance(input_value, dict) and 'id' in input_value:
            return [str(input_value['id'])]
        if isinstance(input_value, str):
            return [input_value]
        return []

    # ── 关联标题传播 ──────────────────────────────────────────

    def _handle_cascade_compute(
        self,
        table_id: UUID,
        changed_field_ids: List[str],
        record_ids: List[str],
        cross_table_ws: Dict[str, Set[str]],
        *,
        cascade_source: str = 'handler',
        change_type: str = 'update',
    ) -> None:
        """通过 Reference Graph 传播关联字段标题刷新。

        事务内调用。级联结果中涉及的跨表变更收集到 *cross_table_ws*,
        由 Handler 在事务提交后统一发送 WS 通知。

        本方法用 ``with transaction.atomic(savepoint=True)`` 隔离传播失败，确保：

        1. cascade 内 DB 异常 → savepoint rollback,PG 事务恢复健康状态(避免
           ``InFailedSqlTransaction`` 污染 → 整批 1000 行 batch_update rollback)
        2. cascade 内 Python 异常 → 同 savepoint rollback + 异常被 try 吞 → 仅
           写 warning,主事务继续 commit
        3. 主记录写入不因派生标题刷新失败而整体回滚

        """
        if not changed_field_ids:
            return
        table_id_str = str(table_id)

        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS, savepoint=True):
                cascade_results = self._cascade_svc.propagate_cell_changes(
                    table_id=table_id_str,
                    changed_field_ids=changed_field_ids,
                    record_ids=record_ids,
                )
                for cw in cascade_results:
                    tid = cw.get('table_id')
                    rids = cw.get('record_ids', [])
                    if tid and str(tid) != table_id_str and rids:
                        cross_table_ws.setdefault(str(tid), set()).update(rids)
        except Exception as exc:
            logger.warning("关联标题传播失败 table=%s err=%s", table_id, exc)

    # ── Link Title 传播 ──────────────────────────────────────

    def _handle_link_title_propagation(
        self,
        snapshot: RecordSnapshot,
        changed_field_ids: Set[str],
        fields: List[FieldSchema],
        cross_table_ws: Dict[str, Set[str]],
    ) -> None:
        """Phase 1: 字段变化时传播 Link Title 缓存更新。事务内调用。

        展示字段可能是主字段，也可能是 config.lookupFieldId 指向的非主字段。
        ``propagate_title_change`` 会按当前关联值重建 cell，无 incoming
        LinkRecord 时快速空返回，因此任意字段变更都可安全调用。
        """
        if not changed_field_ids:
            return
        primary_field = next((f for f in fields if f.is_primary), None)
        new_title = ''
        if primary_field:
            new_title = str(snapshot.formatted_data.get(str(primary_field.id)) or '')
        try:
            affected = self._link_svc.propagate_title_change(snapshot, new_title)
            for item in affected or []:
                tid = item.get('table_id')
                rid = item.get('record_id')
                if tid:
                    cross_table_ws.setdefault(str(tid), set()).add(str(rid))
        except Exception as exc:
            logger.warning(
                "Link Title 传播失败 table=%s record=%s err=%s",
                snapshot.table_id, snapshot.id, exc,
            )

    # ── 删除后的关联标题传播 ──────────────────────────────────

    def _handle_cascade_after_delete(
        self,
        link_affected: List[Dict[str, Any]],
        cross_table_ws: Dict[str, Set[str]],
    ) -> None:
        """Phase 1: 删除后刷新受影响对侧表的 Link 标题。

        按表分组受影响记录，获取对侧表的 Link 字段作为变化源，
        批量刷新关联标题。合并后的跨表通知收集到 *cross_table_ws*。
        """
        if not link_affected:
            return

        affected_by_table: Dict[str, List[str]] = {}
        for item in link_affected:
            tid, rid = item.get('table_id'), item.get('record_id')
            if tid and rid:
                affected_by_table.setdefault(str(tid), []).append(str(rid))

        for tid, rids in affected_by_table.items():
            cross_table_ws.setdefault(tid, set()).update(rids)
            try:
                affected_fields = self._field_repo.get_fields(UUID(tid))
                link_field_ids = [
                    str(f.id) for f in affected_fields if f.field_type == 'link'
                ]
                if link_field_ids:
                    self._handle_cascade_compute(
                        UUID(tid), link_field_ids, rids, cross_table_ws,
                        cascade_source='handler',
                        change_type='delete',
                    )
            except Exception as exc:
                logger.warning("删除后关联标题传播失败 table=%s err=%s", tid, exc)

    def _build_link_affected_update_events(
        self,
        link_affected: List[Dict[str, Any]],
        context: RecordCommandContext,
    ) -> List[Any]:
        """把 Link 清理产生的派生 cell 变化事件化。

        删除父记录时,``cleanup_record_links`` 已经清理 LinkRecord 并写入
        子记录 cell。这里负责补齐记录版本和领域事件,让 Y.Doc / delta /
        Realtime 能看到"父字段被清空"这个子记录更新。
        """
        actionable = [
            item for item in link_affected
            if item.get('table_id') and item.get('record_id') and item.get('field_id')
        ]
        if not actionable:
            return []

        from apps.tabdata.domain.events import RecordUpdatedPayload, RecordsBatchUpdated
        from apps.tabdata.domain.value_objects import FieldChange
        from apps.tabdata.models import Table, TableRecord
        from apps.tabdata.native.record_io import NativeRecordIO

        grouped: Dict[str, Dict[str, Dict[str, Any]]] = {}
        for item in actionable:
            table_id = str(item['table_id'])
            record_id = str(item['record_id'])
            field_id = str(item['field_id'])
            by_record = grouped.setdefault(table_id, {})
            entry = by_record.setdefault(record_id, {
                'before_data': dict(item.get('before_data') or {}),
                'after_data': dict(item.get('after_data') or {}),
                'changes': {},
            })
            entry['before_data'].setdefault(field_id, item.get('old_value'))
            entry['after_data'][field_id] = item.get('value')
            old_value = (
                entry['changes'][field_id].old
                if field_id in entry['changes']
                else item.get('old_value')
            )
            entry['changes'][field_id] = FieldChange(
                old=old_value,
                new=item.get('value'),
            )

        events: List[Any] = []
        now = timezone.now()
        updated_by = context.user_id
        for table_id_str, updates_by_record in grouped.items():
            record_ids = list(updates_by_record.keys())
            if not record_ids:
                continue

            table_uuid = UUID(table_id_str)
            max_version = self._repo.next_version(table_uuid, count=len(record_ids))
            version_start = max_version - len(record_ids) + 1
            version_by_record = {
                record_id: version_start + index
                for index, record_id in enumerate(record_ids)
            }

            orm_records = list(
                TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=[UUID(rid) for rid in record_ids],
                    is_deleted=False,
                )
            )
            record_map = {str(record.id): record for record in orm_records}
            records_to_update = []
            processed_record_ids = []
            payloads = []
            for record_id in record_ids:
                record = record_map.get(record_id)
                if record is None:
                    continue
                version = version_by_record[record_id]
                record.version = version
                record.updated_at = now
                update_fields = ['version', 'updated_at']
                if updated_by:
                    record.updated_by_id = updated_by
                    update_fields.append('updated_by_id')
                record._skip_record_history = True
                records_to_update.append((record, update_fields))
                processed_record_ids.append(record_id)

                entry = updates_by_record[record_id]
                payloads.append(RecordUpdatedPayload(
                    record_id=record.id,
                    before=dict(entry['before_data']),
                    after=dict(entry['after_data']),
                    changes=dict(entry['changes']),
                ))

            if not payloads:
                continue

            # 版本推进不改变业务字段,但必须写入 ORM/native,否则 delta token
            # 和协作版本会漏掉这批派生更新。
            for record, update_fields in records_to_update:
                try:
                    record.save(using=TABDATA_DB_ALIAS, update_fields=update_fields)
                finally:
                    if hasattr(record, '_skip_record_history'):
                        delattr(record, '_skip_record_history')

            try:
                from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
                table = Table.objects.using(TABDATA_DB_ALIAS).only(
                    'id', 'space_id', 'organization_id',
                ).get(id=table_uuid)
                native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
                for record_id in processed_record_ids:
                    version = version_by_record[record_id]
                    system_updates: Dict[str, Any] = {
                        '__version': version,
                        '__updated_at': now,
                    }
                    try:
                        if updated_by:
                            system_updates['__updated_by'] = UUID(str(updated_by))
                    except (TypeError, ValueError):
                        pass
                    native_io.update_record(
                        record_id=UUID(record_id),
                        system_updates=system_updates,
                    )
            except Exception as exc:
                logger.warning(
                    "Link 派生更新 native version 同步失败 table=%s err=%s",
                    table_id_str, exc,
                )

            try:
                from apps.tabdata.services.record_service import _invalidate_table_collab_version
                max_processed_version = max(
                    version_by_record[record_id] for record_id in processed_record_ids
                )
                _invalidate_table_collab_version(table_uuid, max_processed_version)
            except Exception as exc:
                logger.debug(
                    "Link 派生更新 collab version 失效通知跳过 table=%s err=%s",
                    table_id_str, exc,
                )

            events.append(RecordsBatchUpdated(
                event_id=uuid4().hex,
                table_id=table_uuid,
                occurred_at=now,
                triggered_by=context.user_id,
                records=tuple(payloads),
                count=len(payloads),
                skip_flags=context.skip_flags,
                operation_group_id=str(context.operation_group_id) if context.operation_group_id else None,
            ))

        return events

    # ── 跨表 WS 通知 ────────────────────────────────────────

    @staticmethod
    def _publish_cross_table_ws(cross_table_ws: Dict[str, Set[str]]) -> None:
        """发布跨表 WS 通知。事务外调用。

        Phase 1 关联标题传播产生的跨表变更，通知前端刷新对应表的视图。
        """
        if not cross_table_ws:
            return

        from apps.tabdata.subscribers._utils import run_after_commit

        for table_id_str, record_id_set in cross_table_ws.items():
            rids = list(record_id_set)

            def _notify(tid: str = table_id_str, ids: list = rids) -> None:
                try:
                    from apps.tabdata.services.table_event_service import table_event_service
                    table_event_service.publish_table_update(
                        table_id=tid,
                        record_ids=ids,
                        action="records_updated",
                        metadata={"source": "cascade"},
                    )
                except Exception as exc:
                    logger.warning(
                        "Cross-table WS notification failed: table=%s err=%s",
                        tid, exc,
                    )

            run_after_commit(_notify)

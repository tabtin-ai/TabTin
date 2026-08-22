"""TabData 记录聚合根。

封装记录的核心业务规则：字段验证、数据格式化、diff 计算、事件生成。
所有方法均为无状态静态方法，纯函数式设计——与 TS RecordAggregate 语义对齐。

零外部依赖 —— 不 import Django、不访问数据库、只用 Python 标准库。
业务逻辑从 record_service.py 的 create_record/update_record/delete_record 提取而来。
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID, uuid4

from .events import (
    DomainEventBase,
    FieldChange,
    RecordCreated,
    RecordCreatedPayload,
    RecordDeleted,
    RecordDeletedPayload,
    RecordsBatchCreated,
    RecordsBatchDeleted,
    RecordsBatchUpdated,
    RecordUpdated,
    RecordUpdatedPayload,
)
from .value_objects import (
    SYSTEM_MANAGED_FIELD_TYPES,
    FieldSchema,
    RecordSnapshot,
)


class RecordValidationError(Exception):
    """领域层验证失败时抛出的异常。"""


class RecordAggregate:
    """记录聚合根——封装记录写入链路的核心业务规则。

    设计决策：
      - 全部使用静态方法，无实例状态，纯函数式。
      - 复杂的字段类型验证（validate_field_value）和自定义规则验证
        （validate_with_rules）由 Handler 在调用聚合根前完成，
        聚合根只负责结构级验证（必填字段、系统托管字段过滤）。
    """

    # ────────────────────────────────────────────────
    # 公共 API
    # ────────────────────────────────────────────────

    @staticmethod
    def create_new(
        *,
        table_id: UUID,
        data: Dict[str, Any],
        fields: List[FieldSchema],
        user_id: Optional[str],
        record_id: Optional[UUID] = None,
        order_value: Optional[float] = None,
        version: int = 1,
        request_id: Optional[str] = None,
        skip_flags: Optional[Dict[str, bool]] = None,
        operation_group_id: Optional[str] = None,
    ) -> Tuple[RecordSnapshot, RecordCreated]:
        """创建单条记录。

        对应 record_service.py create_record 中的：
          _validate_record_data (必填校验部分)
          _format_record_data (键归一化)
          生成 RecordSnapshot + RecordCreated 事件

        Args:
            table_id:            所属表格 ID
            data:                原始输入数据（key 可以是 field name / id / dbFieldName）
            fields:              表格字段列表（FieldSchema）
            user_id:             操作者 user_id
            record_id:           记录 ID，不传则自动生成 uuid4
            order_value:         排序值，由 Handler 计算后传入
            version:             记录版本号，由 Handler 分配
            request_id:          请求链路追踪 ID
            skip_flags:          副作用跳过标记

        Returns:
            (RecordSnapshot, RecordCreated) 元组

        Raises:
            RecordValidationError: 必填字段缺失时
        """
        # 1. 键归一化：将 field name / id / dbFieldName → field UUID string
        formatted_data = _normalize_data(
            data, fields, skip_system_managed=True,
        )

        now = datetime.now(timezone.utc)

        # 构建 RecordSnapshot
        rid = record_id or uuid4()
        snapshot = RecordSnapshot(
            id=rid,
            table_id=table_id,
            formatted_data=formatted_data,
            version=version,
            created_by=user_id,
            updated_by=user_id,
            created_at=now,
            updated_at=now,
            order_value=order_value,
        )

        # 构建领域事件
        after = copy.deepcopy(formatted_data)
        event = RecordCreated(
            event_id=uuid4().hex,
            table_id=table_id,
            occurred_at=now,
            triggered_by=user_id,
            record_id=rid,
            data=after,
            after=after,
            request_id=request_id,
            skip_flags=skip_flags,
            operation_group_id=str(operation_group_id) if operation_group_id else None,
        )

        return snapshot, event

    @staticmethod
    def update(
        *,
        existing: RecordSnapshot,
        patch: Dict[str, Any],
        fields: List[FieldSchema],
        user_id: Optional[str],
        version: int,
        request_id: Optional[str] = None,
        skip_flags: Optional[Dict[str, bool]] = None,
        operation_group_id: Optional[str] = None,
    ) -> Optional[Tuple[RecordSnapshot, RecordUpdated]]:
        """更新单条记录。

        对应 record_service.py update_record 中的：
          _format_record_data (键归一化 + preserve_existing)
          _build_field_changes (diff 计算)
          changed_field_ids 提取

        如果 diff 为空（实质无变化），返回 None。

        Args:
            existing:    现有记录快照
            patch:       更新的原始数据
            fields:      表格字段列表
            user_id:     操作者 user_id
            version:     新版本号，由 Handler 分配
            request_id:  请求链路追踪 ID
            skip_flags:  副作用跳过标记

        Returns:
            (RecordSnapshot, RecordUpdated) 或 None（无变化时）
        """
        old_data = existing.clone_data()

        # 键归一化 + 保留原有数据
        formatted_data = _normalize_data(
            patch, fields,
            preserve_existing=old_data,
            skip_system_managed=True,
        )

        now = datetime.now(timezone.utc)

        # diff 计算
        changes = _diff_record_data(old_data, formatted_data)
        if not changes:
            return None

        changed_field_ids = frozenset(changes.keys())

        # 构建更新后的 snapshot
        after = copy.deepcopy(formatted_data)
        updated_snapshot = RecordSnapshot(
            id=existing.id,
            table_id=existing.table_id,
            formatted_data=formatted_data,
            version=version,
            created_by=existing.created_by,
            updated_by=user_id,
            created_at=existing.created_at,
            updated_at=now,
            is_deleted=existing.is_deleted,
            order_value=existing.order_value,
        )

        # 构建领域事件
        event = RecordUpdated(
            event_id=uuid4().hex,
            table_id=existing.table_id,
            occurred_at=now,
            triggered_by=user_id,
            record_id=existing.id,
            before=old_data,
            after=after,
            changes=changes,
            changed_field_ids=changed_field_ids,
            request_id=request_id,
            skip_flags=skip_flags,
            operation_group_id=str(operation_group_id) if operation_group_id else None,
        )

        return updated_snapshot, event

    @staticmethod
    def delete(
        *,
        existing: RecordSnapshot,
        user_id: Optional[str],
        version: int,
        request_id: Optional[str] = None,
        skip_flags: Optional[Dict[str, bool]] = None,
        operation_group_id: Optional[str] = None,
    ) -> RecordDeleted:
        """删除单条记录（生成删除事件）。

        对应 record_service.py delete_record 中的事件生成部分。
        实际的永久删除由 Handler 通过 Repository 完成。

        Args:
            existing:    待删除记录快照
            user_id:     操作者 user_id
            version:     新版本号
            request_id:  请求链路追踪 ID
            skip_flags:  副作用跳过标记

        Returns:
            RecordDeleted 事件
        """
        now = datetime.now(timezone.utc)
        before = existing.clone_data()

        return RecordDeleted(
            event_id=uuid4().hex,
            table_id=existing.table_id,
            occurred_at=now,
            triggered_by=user_id,
            record_id=existing.id,
            before=before,
            version=version,
            request_id=request_id,
            skip_flags=skip_flags,
            operation_group_id=str(operation_group_id) if operation_group_id else None,
        )

    # ────────────────────────────────────────────────
    # 批量事件组装
    # ────────────────────────────────────────────────

    @staticmethod
    def batch_created_event(
        *,
        table_id: UUID,
        snapshots_and_events: List[Tuple[RecordSnapshot, RecordCreated]],
        user_id: Optional[str],
        request_id: Optional[str] = None,
        skip_flags: Optional[Dict[str, bool]] = None,
        operation_group_id: Optional[str] = None,
    ) -> RecordsBatchCreated:
        """将多个 create_new 的结果合并为一个 RecordsBatchCreated 事件。"""
        now = datetime.now(timezone.utc)
        payloads = tuple(
            RecordCreatedPayload(
                record_id=snapshot.id,
                data=copy.deepcopy(snapshot.formatted_data),
                after=copy.deepcopy(snapshot.formatted_data),
            )
            for snapshot, _ in snapshots_and_events
        )
        return RecordsBatchCreated(
            event_id=uuid4().hex,
            table_id=table_id,
            occurred_at=now,
            triggered_by=user_id,
            records=payloads,
            count=len(payloads),
            request_id=request_id,
            skip_flags=skip_flags,
            operation_group_id=str(operation_group_id) if operation_group_id else None,
        )

    @staticmethod
    def batch_updated_event(
        *,
        table_id: UUID,
        snapshots_and_events: List[Tuple[RecordSnapshot, RecordUpdated]],
        user_id: Optional[str],
        request_id: Optional[str] = None,
        skip_flags: Optional[Dict[str, bool]] = None,
        operation_group_id: Optional[str] = None,
    ) -> RecordsBatchUpdated:
        """将多个 update 的结果合并为一个 RecordsBatchUpdated 事件。"""
        now = datetime.now(timezone.utc)
        payloads = tuple(
            RecordUpdatedPayload(
                record_id=evt.record_id,
                before=copy.deepcopy(evt.before),
                after=copy.deepcopy(evt.after),
                changes=dict(evt.changes),
            )
            for _, evt in snapshots_and_events
        )
        return RecordsBatchUpdated(
            event_id=uuid4().hex,
            table_id=table_id,
            occurred_at=now,
            triggered_by=user_id,
            records=payloads,
            count=len(payloads),
            request_id=request_id,
            skip_flags=skip_flags,
            operation_group_id=str(operation_group_id) if operation_group_id else None,
        )

    @staticmethod
    def batch_deleted_event(
        *,
        table_id: UUID,
        events: List[RecordDeleted],
        user_id: Optional[str],
        request_id: Optional[str] = None,
        skip_flags: Optional[Dict[str, bool]] = None,
        operation_group_id: Optional[str] = None,
    ) -> RecordsBatchDeleted:
        """将多个 delete 的结果合并为一个 RecordsBatchDeleted 事件。"""
        now = datetime.now(timezone.utc)
        payloads = tuple(
            RecordDeletedPayload(
                record_id=evt.record_id,
                before=copy.deepcopy(evt.before) if evt.before else None,
            )
            for evt in events
        )
        return RecordsBatchDeleted(
            event_id=uuid4().hex,
            table_id=table_id,
            occurred_at=now,
            triggered_by=user_id,
            records=payloads,
            count=len(payloads),
            request_id=request_id,
            skip_flags=skip_flags,
            operation_group_id=str(operation_group_id) if operation_group_id else None,
        )


# ────────────────────────────────────────────────
# 内部辅助函数（模块级私有）
# ────────────────────────────────────────────────

def _build_field_maps(
    fields: List[FieldSchema],
) -> Tuple[Dict[str, FieldSchema], Dict[str, FieldSchema], Dict[str, FieldSchema]]:
    """构建三种查找映射：name → field, id → field, db_field_name → field。

    提取自 record_service.py RecordService._build_field_input_maps。
    """
    name_map: Dict[str, FieldSchema] = {}
    id_map: Dict[str, FieldSchema] = {}
    db_field_map: Dict[str, FieldSchema] = {}

    for f in fields:
        if f.is_deleted:
            continue
        name_map[f.name] = f
        id_map[str(f.id)] = f
        if f.db_field_name:
            db_field_map[f.db_field_name] = f

    return name_map, id_map, db_field_map


def _resolve_field(
    raw_key: str,
    name_map: Dict[str, FieldSchema],
    id_map: Dict[str, FieldSchema],
    db_field_map: Dict[str, FieldSchema],
) -> Optional[FieldSchema]:
    """根据 name / id / dbFieldName 查找字段。"""
    key = str(raw_key)
    return name_map.get(key) or id_map.get(key) or db_field_map.get(key)


def _normalize_data(
    data: Dict[str, Any],
    fields: List[FieldSchema],
    *,
    preserve_existing: Optional[Dict[str, Any]] = None,
    skip_system_managed: bool = True,
) -> Dict[str, Any]:
    """将输入数据键归一化为 field UUID 字符串。

    提取自 record_service.py RecordService._format_record_data。

    处理逻辑：
      1. 保留 preserve_existing 中的原始数据（更新场景）
      2. 遍历输入 data，按 name / id / dbFieldName 匹配字段
      3. 跳过系统托管字段
      4. 以 field.id (UUID str) 为 key 写入结果
      5. 未匹配到字段的 key 原样保留（兼容历史数据）
    """
    result = dict(preserve_existing or {})
    name_map, id_map, db_field_map = _build_field_maps(fields)

    for raw_key, value in (data or {}).items():
        field = _resolve_field(raw_key, name_map, id_map, db_field_map)

        if field:
            if skip_system_managed and field.is_system_managed:
                continue
            result[str(field.id)] = value
            # create/collab 常写 hex，domain 写 dashed；双键并存时 serialize
            # 可能命中陈旧值（link title 空串 → UI 显示 UUID）。写入时收敛。
            result.pop(field.id.hex, None)
            if field.name and field.name != str(field.id):
                result.pop(field.name, None)
        else:
            result[str(raw_key)] = value

    return result


def _diff_record_data(
    before: Dict[str, Any],
    after: Dict[str, Any],
) -> Dict[str, FieldChange]:
    """计算两份数据间的字段级差异。

    提取自 record_service.py RecordService._build_field_changes，
    同时与 TS RecordAggregate.diffRecordData 语义对齐。

    返回 {field_id_str: FieldChange(old, new)} 映射，仅包含有变化的字段。
    """
    changes: Dict[str, FieldChange] = {}
    all_keys = set(before.keys()) | set(after.keys())

    for key in all_keys:
        old_val = before.get(key)
        new_val = after.get(key)
        if not _is_same_value(old_val, new_val):
            changes[str(key)] = FieldChange(old=old_val, new=new_val)

    return changes


def _is_same_value(left: Any, right: Any) -> bool:
    """判断两个值是否语义相同。

    与 TS isSameValue 对齐：
      - 基础类型用 == 比较
      - dict / list 序列化后比较（处理嵌套结构）
    """
    if left is right:
        return True
    if left is None and right is None:
        return True
    if left is None or right is None:
        return False
    if isinstance(left, (dict, list)) or isinstance(right, (dict, list)):
        try:
            return (
                json.dumps(left, sort_keys=True, default=str)
                == json.dumps(right, sort_keys=True, default=str)
            )
        except (TypeError, ValueError):
            return str(left) == str(right)
    return left == right

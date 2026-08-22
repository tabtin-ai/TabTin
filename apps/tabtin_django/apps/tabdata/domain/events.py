"""TabData 领域事件契约。

所有领域事件为不可变 dataclass，语义与 TypeScript table-kernel 对齐（见 BLUEPRINT §2.4）。
零外部依赖 —— 不 import Django、不访问数据库、只用 Python 标准库。

对齐映射：
  Python RecordCreated        ↔ TS RecordCreatedEvent  (record.created)
  Python RecordUpdated        ↔ TS RecordUpdatedEvent  (record.updated)
  Python RecordDeleted        ↔ TS RecordDeletedEvent  (record.deleted)
  Python RecordsBatchCreated  ↔ TS RecordsBatchCreatedEvent (records.batch_created)
  Python RecordsBatchUpdated  ↔ TS RecordsBatchUpdatedEvent (records.batch_updated)
  Python RecordsBatchDeleted  ↔ TS RecordsBatchDeletedEvent (records.batch_deleted)

不可变性约定：
  所有事件 dataclass 标记 frozen=True，字段引用不可替换。
  Dict/tuple 等容器字段虽然内部可变，但发布后的事件**视为只读**——
  Subscriber 不得修改事件载荷，EventBus 实现可选择在 publish 时深拷贝。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from .value_objects import FieldChange


# ── 基础事件 ──

@dataclass(frozen=True)
class DomainEventBase:
    """所有领域事件的基类。

    与 TS DomainEventBase 的差异（均为 Python 扩展）：
      - triggered_by: 触发者 user_id，用于审计追踪（TS 无）
      - request_id:   请求链路追踪 ID（TS 无）
      - skip_flags:   Subscriber 级跳过标记，见 BLUEPRINT §3.9（TS 无）
    TS 的 aggregateVersion 由 Python 侧 RecordSnapshot.version 携带，不放在事件基类。
    """
    event_id: str
    table_id: UUID
    occurred_at: datetime
    triggered_by: Optional[str]
    request_id: Optional[str] = field(default=None, kw_only=True)
    skip_flags: Optional[Dict[str, bool]] = field(default=None, kw_only=True)
    operation_group_id: Optional[str] = field(default=None, kw_only=True)


# ── 单条记录事件 ──

@dataclass(frozen=True)
class RecordCreated(DomainEventBase):
    """单条记录创建。

    data 和 after 内容相同，保持两个字段以对齐 table-kernel。
    """
    record_id: UUID = field(kw_only=True)
    data: Dict[str, Any] = field(kw_only=True)
    after: Dict[str, Any] = field(kw_only=True)


@dataclass(frozen=True)
class RecordUpdated(DomainEventBase):
    """单条记录更新。

    changed_field_ids 为 Python 扩展字段（TS 无此字段，可从 changes.keys() 推导）。
    """
    record_id: UUID = field(kw_only=True)
    before: Dict[str, Any] = field(kw_only=True)
    after: Dict[str, Any] = field(kw_only=True)
    changes: Dict[str, FieldChange] = field(kw_only=True)
    changed_field_ids: frozenset[str] = field(default_factory=frozenset, kw_only=True)


@dataclass(frozen=True)
class RecordDeleted(DomainEventBase):
    """单条记录删除。

    before: 删除前快照，可能为 None。
    version: 删除后分配的版本号（对应 TS 的 aggregateVersion）。
    """
    record_id: UUID = field(kw_only=True)
    before: Optional[Dict[str, Any]] = field(default=None, kw_only=True)
    version: Optional[int] = field(default=None, kw_only=True)


# ── 批量事件载荷（结构化子项，非平行数组）──

@dataclass(frozen=True)
class RecordCreatedPayload:
    """RecordsBatchCreated 中每条记录的载荷。"""
    record_id: UUID
    data: Dict[str, Any]
    after: Dict[str, Any]


@dataclass(frozen=True)
class RecordUpdatedPayload:
    """RecordsBatchUpdated 中每条记录的载荷。"""
    record_id: UUID
    before: Dict[str, Any]
    after: Dict[str, Any]
    changes: Dict[str, FieldChange]


@dataclass(frozen=True)
class RecordDeletedPayload:
    """RecordsBatchDeleted 中每条记录的载荷。"""
    record_id: UUID
    before: Optional[Dict[str, Any]]


# ── 批量记录事件 ──

@dataclass(frozen=True)
class RecordsBatchCreated(DomainEventBase):
    """批量创建。Handler 只发布 1 个此事件，不发 N 个 RecordCreated。"""
    records: tuple[RecordCreatedPayload, ...] = field(default_factory=tuple, kw_only=True)
    count: int = field(default=0, kw_only=True)


@dataclass(frozen=True)
class RecordsBatchUpdated(DomainEventBase):
    """批量更新。"""
    records: tuple[RecordUpdatedPayload, ...] = field(default_factory=tuple, kw_only=True)
    count: int = field(default=0, kw_only=True)


@dataclass(frozen=True)
class RecordsBatchDeleted(DomainEventBase):
    """批量删除。使用结构化数组而非平行数组（与 TS 一致）。"""
    records: tuple[RecordDeletedPayload, ...] = field(default_factory=tuple, kw_only=True)
    count: int = field(default=0, kw_only=True)


# 所有领域事件类型的联合，便于类型检查
ALL_RECORD_EVENT_TYPES: tuple[type, ...] = (
    RecordCreated,
    RecordUpdated,
    RecordDeleted,
    RecordsBatchCreated,
    RecordsBatchUpdated,
    RecordsBatchDeleted,
)

ALL_RECORD_EVENTS = ALL_RECORD_EVENT_TYPES

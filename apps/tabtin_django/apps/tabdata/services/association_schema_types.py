"""
关联结构变更命令与影响预览类型。

AssociationSchemaGateway.plan / execute 的唯一输入输出契约。
本期只定义结构；API 适配与完整 Impact 字段填充在后续 PR。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional
from uuid import UUID


class AssociationCommandKind(str, Enum):
    """关联结构变更命令种类。"""

    CREATE_LINK = "create_link"
    UPDATE_LINK = "update_link"
    DELETE_LINK = "delete_link"
    # 边级写入（供后续 dual-write / 切读使用；本期骨架可测锁序）
    SET_EDGES = "set_edges"


@dataclass(frozen=True)
class AssociationCommand:
    """关联结构变更命令。

    Attributes:
        kind: 命令种类
        organization_id: 租户边界
        host_table_id / foreign_table_id: 表边界（create/update 必需）
        host_field_id / symmetric_field_id: 字段边界
        relation_id: 已有关系（update/delete/set_edges）
        host_relationship: 宿主侧基数
        is_one_way: 单/双向
        edges: set_edges 时的目标边列表
          每项 ``{host_record_id, foreign_record_id, host_order?, foreign_order?}``
        metadata: 扩展载荷
        idempotency_key: 可选幂等键（后续 PR 落库）
        expected_fingerprint: 执行时校验的 plan fingerprint
    """

    kind: AssociationCommandKind
    organization_id: UUID
    host_table_id: Optional[UUID] = None
    foreign_table_id: Optional[UUID] = None
    host_field_id: Optional[UUID] = None
    symmetric_field_id: Optional[UUID] = None
    relation_id: Optional[UUID] = None
    host_relationship: str = "ManyOne"
    is_one_way: bool = False
    edges: tuple[dict[str, Any], ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)
    idempotency_key: Optional[str] = None
    expected_fingerprint: Optional[str] = None


@dataclass(frozen=True)
class ImpactBlocker:
    """阻止执行的条件。"""

    code: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ImpactPlan:
    """结构变更影响预览。

    fingerprint 在 execute 时校验，避免预览后数据已变化。
    """

    command_kind: AssociationCommandKind
    fingerprint: str
    can_execute: bool
    blockers: tuple[ImpactBlocker, ...] = ()
    will_delete_symmetric_field: bool = False
    truncated_link_count: int = 0
    affected_view_ids: tuple[str, ...] = ()
    estimated_recompute_rows: int = 0
    sync_mode: str = "sync"  # sync | async
    undo_supported: bool = False
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ExecuteResult:
    """结构变更执行结果。"""

    success: bool
    relation_id: Optional[UUID] = None
    host_field_id: Optional[UUID] = None
    symmetric_field_id: Optional[UUID] = None
    edges_created: int = 0
    edges_deleted: int = 0
    edges_updated: int = 0
    fingerprint: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    details: dict[str, Any] = field(default_factory=dict)

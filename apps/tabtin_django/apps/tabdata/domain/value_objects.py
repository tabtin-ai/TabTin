"""TabData 领域值对象。

零外部依赖 —— 不 import Django、不访问数据库、只用 Python 标准库。
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Set
from uuid import UUID


# ── 字段类型分类常量 ──
# 从 apps.tabdata.constants 提取到领域层，保证聚合根可以在零依赖下使用。

SYSTEM_MANAGED_FIELD_TYPES: frozenset[str] = frozenset({
    'created_by', 'last_modified_by',
    'created_time', 'last_modified_time',
})

@dataclass(frozen=True)
class FieldChange:
    """单字段变更的 old → new 快照。与 TypeScript RecordValueChange 语义对齐。"""
    old: Any
    new: Any


@dataclass
class FieldSchema:
    """字段元数据的纯 Python 表示。

    由基础设施层从 TableField ORM 模型转换而来，贯穿 Handler → Aggregate 的全链路。
    """
    id: UUID
    name: str
    field_type: str
    config: Dict[str, Any]
    is_primary: bool = False
    default_value: Optional[Dict[str, Any]] = None
    is_deleted: bool = False
    db_field_name: Optional[str] = None
    validation_rules: Optional[Dict[str, Any]] = None

    @property
    def is_system_managed(self) -> bool:
        return self.field_type in SYSTEM_MANAGED_FIELD_TYPES

@dataclass
class RecordSnapshot:
    """记录的完整快照——贯穿 Handler、Repository、EventBus 的统一数据载体。"""
    id: UUID
    table_id: UUID
    formatted_data: Dict[str, Any]
    version: int
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    is_deleted: bool = False
    order_value: Optional[float] = None

    def clone_data(self) -> Dict[str, Any]:
        """返回 formatted_data 的深拷贝，防止外部修改影响快照。"""
        return copy.deepcopy(self.formatted_data)


@dataclass
class RecordCommandContext:
    """Handler 的统一输入。不同操作使用不同字段子集。

    字段说明见 BLUEPRINT §3.0 和 §3.9（skip_flags）。
    """
    table_id: UUID
    user_id: Optional[str] = None
    record_id: Optional[UUID] = None                        # update / delete
    data: Optional[Dict[str, Any]] = None                   # create / update
    raw_data: Optional[Dict[str, Any]] = None               # update 未格式化请求值
    records_data: Optional[List[Dict[str, Any]]] = None     # batch_create / batch_update
    record_ids: Optional[List[UUID]] = None                 # batch_delete
    order_context: Optional[Dict[str, Any]] = None          # 排序插入上下文
    field_key_type: str = 'name'                            # name / id / dbFieldName
    operation_group_id: Optional[UUID] = None
    skip_flags: Optional[Dict[str, bool]] = None
    expected_version: Optional[int] = None                  # update / delete 乐观锁（可选）
    select_choice_values: Optional[Dict[str, List[str]]] = None  # CAS 成功后持久化

    # step2 Facade 预计算值 —— 由 Facade 传递给 Handler 使用
    resolved_order_value: Optional[float] = None                     # create 单条排序值
    resolved_order_values: Optional[List[float]] = None              # batch_create 排序值列表
    client_record_ids_list: Optional[List[Any]] = None               # batch_create 客户端指定 ID

    def should_skip(self, flag_name: str) -> bool:
        """检查是否应跳过某类副作用。"""
        if not self.skip_flags:
            return False
        if self.skip_flags.get('all_side_effects'):
            return True
        return bool(self.skip_flags.get(flag_name))

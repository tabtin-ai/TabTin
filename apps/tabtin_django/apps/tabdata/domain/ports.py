"""TabData 端口接口定义。

所有端口为 Python ABC，定义领域层与基础设施层的契约边界。
零外部依赖 —— 不 import Django、不访问数据库、只用 Python 标准库。

端口实现映射见 BLUEPRINT §3.10。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, List, Optional, TypeVar
from uuid import UUID

from .events import DomainEventBase
from .value_objects import FieldSchema, RecordSnapshot

T = TypeVar('T')


# ── 3.1 IRecordRepository ──

class IRecordRepository(ABC):
    """记录持久化端口。所有写操作在事务内调用。"""

    @abstractmethod
    def insert(self, record: RecordSnapshot) -> None:
        """持久化单条记录。"""

    @abstractmethod
    def insert_many(self, records: List[RecordSnapshot]) -> None:
        """批量持久化记录。"""

    @abstractmethod
    def update_one(
        self,
        record_id: UUID,
        data: Dict[str, Any],
        version: int,
        updated_by: Optional[str] = None,
    ) -> bool:
        """仅更新活跃记录的字段数据，命中返回 True，tombstone 返回 False。"""

    @abstractmethod
    def update_many(self, updates: List[Dict[str, Any]]) -> None:
        """批量更新记录。每个 dict 包含 record_id, data, version。"""

    @abstractmethod
    def delete(self, record_id: UUID) -> bool:
        """原子物理删除记录；记录不存在时返回 False。"""

    @abstractmethod
    def delete_many(self, record_ids: List[UUID]) -> None:
        """批量物理删除。"""

    @abstractmethod
    def mark_delete_version(self, table_id: UUID, version: int) -> None:
        """推进表级物理删除水位，供增量同步判断是否需要全量刷新。"""

    @abstractmethod
    def get_by_id(self, record_id: UUID) -> Optional[RecordSnapshot]:
        """读取单条记录快照。"""

    @abstractmethod
    def get_by_ids(self, record_ids: List[UUID]) -> List[RecordSnapshot]:
        """批量读取记录快照。"""

    @abstractmethod
    def lock_table(self, table_id: UUID) -> None:
        """在当前事务内锁定记录所属 Table，作为跨 Record/Field 写入的全域闸门。"""

    @abstractmethod
    def get_by_id_for_update(self, record_id: UUID) -> Optional[RecordSnapshot]:
        """在当前事务内锁定并读取一条活跃记录。"""

    @abstractmethod
    def get_by_ids_for_update(self, record_ids: List[UUID]) -> List[RecordSnapshot]:
        """在当前事务内一次锁定并读取多条活跃记录。"""

    @abstractmethod
    def next_version(self, table_id: UUID, count: int = 1) -> int:
        """原子递增 Table.record_version_seq，返回分配给本次变更的最大版本号。

        当 *count* > 1 时，调用方可倒推每条记录的版本号为
        ``[返回值 - count + 1, 返回值]``。
        """


# ── 3.2 INativeRecordIO ──

class INativeRecordIO(ABC):
    """PostgreSQL 原生列存储端口。包装现有 native/record_io.py。"""

    @abstractmethod
    def insert_record(self, record_id: UUID, field_values: Dict, system_values: Dict) -> None:
        """写入单条记录到原生列存储。"""

    @abstractmethod
    def bulk_insert_records(self, records: List[Dict]) -> None:
        """批量写入记录到原生列存储。"""

    @abstractmethod
    def update_record(self, record_id: UUID, field_values: Dict, system_values: Dict) -> None:
        """更新原生列存储中的记录。"""

    @abstractmethod
    def bulk_update_records(self, updates: List[Dict]) -> None:
        """批量更新原生列存储中的记录。"""

    @abstractmethod
    def delete_record(self, record_id: UUID, version: int, updated_by: Optional[str]) -> None:
        """永久删除原生列存储中的记录。"""

    @abstractmethod
    def bulk_delete_records(
        self,
        record_ids: List[UUID],
        updated_by: Optional[str] = None,
        versions: Optional[Dict[UUID, int]] = None,
    ) -> None:
        """批量永久删除原生列存储中的记录。"""


# ── 3.3 IUnitOfWork ──

class IUnitOfWork(ABC):
    """事务管理端口。使用 TABDATA_DB_ALIAS（PostgreSQL）。"""

    @abstractmethod
    def with_transaction(self, work: Callable[[], T]) -> T:
        """在数据库事务中执行 work。事务提交后返回结果；异常时自动回滚。"""

    @abstractmethod
    def with_savepoint(self, work: Callable[[], T]) -> T:
        """在当前事务内创建 savepoint 执行 work。

        用于批量操作中的"部分成功"语义——单条失败回滚到 savepoint，不影响整个事务。
        """


# ── 3.4 IEventBus ──

class IEventBus(ABC):
    """领域事件总线端口。"""

    @abstractmethod
    def publish(self, event: DomainEventBase) -> None:
        """发布单个领域事件到所有已注册的订阅者。"""

    @abstractmethod
    def publish_many(self, events: List[DomainEventBase]) -> None:
        """按顺序发布多个领域事件。"""

    @abstractmethod
    def register(self, subscriber: IEventSubscriber) -> None:
        """注册一个事件订阅者。EventBus 根据 subscriber.handles() 分发事件。"""


# ── 3.5 IFieldRepository ──

class IFieldRepository(ABC):
    """字段元数据端口。"""

    @abstractmethod
    def get_fields(self, table_id: UUID) -> List[FieldSchema]:
        """加载表的所有未删除字段元数据，返回纯 Python FieldSchema 列表。"""

    @abstractmethod
    def get_field_by_id(self, field_id: UUID) -> Optional[FieldSchema]:
        """加载单个字段元数据。"""

    @abstractmethod
    def merge_select_choices(
        self,
        table_id: UUID,
        values_by_field_id: Dict[str, List[str]],
    ) -> None:
        """把记录写入携带的新选项合并进 select/multi_select 字段配置。"""


# ── 3.6 ILinkService ──

class ILinkService(ABC):
    """Link 字段关联操作端口。在事务内调用。"""

    @abstractmethod
    def set_link_cell(
        self, field: FieldSchema, record: RecordSnapshot, linked_ids: List[str],
    ) -> Any:
        """设置 Link 字段的关联值。返回格式化后的 cell value。"""

    @abstractmethod
    def cleanup_record_links(self, record: RecordSnapshot) -> List[Dict[str, Any]]:
        """清理记录的所有 Link 关系（删除 LinkRecord + 更新对侧 JSONB）。

        返回受影响记录的字段级 payload，至少包含 table_id / record_id。
        """

    @abstractmethod
    def propagate_title_change(
        self, record: RecordSnapshot, new_title: str,
    ) -> List[Dict[str, str]]:
        """主字段变化时传播 Link Title 缓存更新。

        返回受影响的 [{table_id, record_id}] 列表。
        """


# ── 3.7 ICascadeService ──

class ICascadeService(ABC):
    """关联字段标题传播端口，在事务内调用。"""

    @abstractmethod
    def propagate_cell_changes(
        self,
        table_id: str,
        changed_field_ids: List[str],
        record_ids: List[str],
    ) -> List[Dict[str, Any]]:
        """通过关联引用图传播 Link 标题刷新。

        返回跨表受影响的 [{table_id, record_ids}] 列表。
        """

# ── 3.8 IAttachmentService ──

class IAttachmentService(ABC):
    """附件引用同步端口。在事务内调用，仅写 DB 引用关系，不做 OSS 网络调用。"""

    @abstractmethod
    def sync_record_attachments(self, record: RecordSnapshot) -> None:
        """同步记录中的附件引用关系。"""

    @abstractmethod
    def cleanup_record_attachments(self, record_id: UUID) -> None:
        """记录软删除后批量清理其所有活跃附件引用。"""

    @abstractmethod
    def cleanup_records_attachments_batch(self, record_ids: List[UUID]) -> None:
        """批量记录软删除后一次性清理所有活跃附件引用。

        相比逐条调用 cleanup_record_attachments，将 O(N*M) 次查询降为 O(1) 批量查询。
        """

    @abstractmethod
    def cleanup_field_attachments(self, table_id: UUID, field_id: UUID) -> None:
        """字段删除时批量清理该字段所有活跃附件引用。"""


# ── 4.4 IEventSubscriber ──

class IEventSubscriber(ABC):
    """事件订阅者接口。

    EventBus 按 priority() 升序执行。单个 Subscriber 抛异常不中断后续 Subscriber。
    """

    @abstractmethod
    def handles(self) -> List[type]:
        """返回此订阅者处理的事件类型列表。"""

    @abstractmethod
    def handle(self, event: DomainEventBase) -> None:
        """处理单个事件。"""

    def priority(self) -> int:
        """执行优先级（数字越小越先执行）。默认 100。"""
        return 100

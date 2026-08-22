"""
TabData 事件订阅者 — Phase 2 事务外副作用处理。

所有 Subscriber 实现 IEventSubscriber 接口，通过 EventBus 按优先级分发。
"""

from apps.tabdata.subscribers.record_history import RecordHistorySubscriber
from apps.tabdata.subscribers.row_count import RowCountSubscriber
from apps.tabdata.subscribers.realtime import RealtimeSubscriber
from apps.tabdata.subscribers.change_log import ChangeLogSubscriber
from apps.tabdata.subscribers.collab_ydoc import CollabYDocSubscriber
from apps.tabdata.subscribers.scheduler import SchedulerSubscriber
from apps.tabdata.subscribers.rag_index import RAGIndexSubscriber

__all__ = [
    "RecordHistorySubscriber",
    "RowCountSubscriber",
    "RealtimeSubscriber",
    "ChangeLogSubscriber",
    "CollabYDocSubscriber",
    "SchedulerSubscriber",
    "RAGIndexSubscriber",
]

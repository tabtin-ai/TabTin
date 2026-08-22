"""
TabData 基础设施层 — Port 接口的 Django 实现。

提供 get_event_bus() 全局单例，首次调用时按优先级自动注册所有 8 个 Subscriber。
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from apps.tabdata.infrastructure.event_bus import InProcessEventBus

logger = logging.getLogger(__name__)

__all__ = ["get_event_bus", "InProcessEventBus"]

_event_bus_lock = threading.Lock()
_event_bus_instance: Optional[InProcessEventBus] = None


def get_event_bus() -> InProcessEventBus:
    """返回全局单例 InProcessEventBus。

    首次调用时按 BLUEPRINT §4.7 优先级顺序注册所有 Subscriber：
      10  RecordHistorySubscriber
      20  RowCountSubscriber
      50  RealtimeSubscriber
     100  ChangeLogSubscriber
     200  CollabYDocSubscriber, SchedulerSubscriber, RAGIndexSubscriber
    """
    global _event_bus_instance
    if _event_bus_instance is not None:
        return _event_bus_instance

    with _event_bus_lock:
        if _event_bus_instance is not None:
            return _event_bus_instance

        bus = InProcessEventBus()
        _register_all_subscribers(bus)
        _event_bus_instance = bus
        logger.debug("[TabData] EventBus initialized with all subscribers")
        return _event_bus_instance


def _reset_event_bus() -> None:
    """重置单例（仅用于测试）。下次调用 get_event_bus() 时会重新创建并注册。"""
    global _event_bus_instance
    with _event_bus_lock:
        _event_bus_instance = None


def _register_all_subscribers(bus: InProcessEventBus) -> None:
    """按优先级顺序注册所有 Subscriber。

    注册顺序与最终执行顺序无关（EventBus 内部按 priority() 排序），
    但为可读性仍按优先级升序排列。
    """
    from apps.tabdata.subscribers.record_history import RecordHistorySubscriber
    from apps.tabdata.subscribers.row_count import RowCountSubscriber
    from apps.tabdata.subscribers.realtime import RealtimeSubscriber
    from apps.tabdata.subscribers.change_log import ChangeLogSubscriber
    from apps.tabdata.subscribers.collab_ydoc import CollabYDocSubscriber
    from apps.tabdata.subscribers.scheduler import SchedulerSubscriber
    from apps.tabdata.subscribers.rag_index import RAGIndexSubscriber
    from apps.tabdata.subscribers.user_assignment_notify import UserAssignmentNotifySubscriber

    subscribers = [
        RecordHistorySubscriber(),     # priority=10
        RowCountSubscriber(),          # priority=20
        RealtimeSubscriber(),          # priority=50
        ChangeLogSubscriber(),         # priority=100
        CollabYDocSubscriber(),        # priority=200
        SchedulerSubscriber(),         # priority=200
        RAGIndexSubscriber(),          # priority=200
        UserAssignmentNotifySubscriber(),  # priority=210
    ]

    for sub in subscribers:
        bus.register(sub)

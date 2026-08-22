"""
InProcessEventBus — 进程内同步事件总线

实现 BLUEPRINT §3.4 IEventBus 接口。
按 subscriber.priority() 升序分发事件，单个 Subscriber 异常不中断其他 Subscriber。
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Dict, List, Set, Type

from apps.tabdata.domain.events import DomainEventBase
from apps.tabdata.domain.ports import IEventBus, IEventSubscriber

logger = logging.getLogger(__name__)


class InProcessEventBus(IEventBus):
    """进程内同步事件总线。"""

    def __init__(self) -> None:
        self._subscribers: List[IEventSubscriber] = []
        self._event_map: Dict[Type[DomainEventBase], List[IEventSubscriber]] = defaultdict(list)
        self._sorted = False

    def register(self, subscriber: IEventSubscriber) -> None:
        self._subscribers.append(subscriber)
        for event_type in subscriber.handles():
            self._event_map[event_type].append(subscriber)
        self._sorted = False

    def publish(self, event: DomainEventBase) -> None:
        self._ensure_sorted()
        subscribers = self._event_map.get(type(event), [])
        if not subscribers:
            return

        skip_flags = getattr(event, "skip_flags", None) or {}
        if skip_flags.get("all_side_effects"):
            return

        t0 = time.monotonic()
        for sub in subscribers:
            try:
                sub.handle(event)
            except Exception:
                logger.error(
                    "[EventBus] subscriber %s failed for %s (event_id=%s)",
                    type(sub).__name__,
                    type(event).__name__,
                    event.event_id,
                    exc_info=True,
                )
        elapsed_ms = (time.monotonic() - t0) * 1000
        if elapsed_ms > 200:
            logger.warning(
                "[EventBus] slow dispatch: %s took %.1fms (%d subscribers)",
                type(event).__name__, elapsed_ms, len(subscribers),
            )

    def publish_many(self, events: List[DomainEventBase]) -> None:
        for event in events:
            self.publish(event)

    def _ensure_sorted(self) -> None:
        """按 priority 升序对每个事件类型的订阅者列表排序。"""
        if self._sorted:
            return
        for event_type in self._event_map:
            self._event_map[event_type].sort(key=lambda s: s.priority())
        self._sorted = True

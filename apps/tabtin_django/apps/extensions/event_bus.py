"""通用事件总线

将 EventBridge 的设计泛化为通用事件总线，支持多事件源和多消费者。

事件源：Extension（email.received）、TabData（record.created）等
消费者：Agenda Tracker trigger、Table Automation、Agent wake、Webhook 出站通知

事件通过 Celery 异步分发，不阻塞事件源。
"""

from __future__ import annotations

import contextvars
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Set

from apps.extensions.public_api import public_api

logger = logging.getLogger(__name__)

_recursion_depth: contextvars.ContextVar[int] = contextvars.ContextVar(
    "_eventbus_recursion_depth", default=0,
)


def _is_broker_connection_error(exc: BaseException) -> bool:
    from apps.maintenance.celery_utils import is_broker_connection_error
    return is_broker_connection_error(exc)


# ---------------------------------------------------------------------------
# 事件数据结构
# ---------------------------------------------------------------------------

@public_api("标准化事件对象")
@dataclass
class Event:
    """标准化事件对象。"""

    source: str                   # 事件来源（extension_id 或 "tabdata"）
    event_type: str               # 如 "email.received", "record.created"
    organization_id: str
    space_id: Optional[str] = None
    payload: Dict[str, Any] = field(default_factory=dict)
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    connection_id: Optional[str] = None  # 关联的 ExtensionConnection.id


# ---------------------------------------------------------------------------
# 消费者协议
# ---------------------------------------------------------------------------

@public_api("事件消费者注册信息")
@dataclass
class ConsumerRegistration:
    """事件消费者注册信息。"""

    consumer_id: str
    handler: Callable[[Event], Any]
    event_types: Optional[Set[str]] = None  # None = 订阅所有事件
    exclude_prefixes: Optional[List[str]] = None  # 排除的事件类型前缀
    description: str = ""


# ---------------------------------------------------------------------------
# EventBus
# ---------------------------------------------------------------------------

@public_api("全局事件总线")
class EventBus:
    """全局事件总线（单例）。

    用法：
        # 注册消费者（生产环境 Tracker 触发见 consumers.register_builtin_consumers，
        # consumer_id 定义为 extensions.constants.GOAL_EXTENSION_TRIGGER_CONSUMER_ID）
        EventBus.register_consumer(ConsumerRegistration(
            consumer_id="…",
            handler=handler_callable,
            event_types={"email.received", "record.created"},
        ))

        # 发布事件（异步）
        EventBus.emit(Event(
            source="tabmail",
            event_type="email.received",
            organization_id="ws_123",
            payload={"subject": "Hello", "from": "alice@example.com"},
        ))
    """

    _consumers: Dict[str, ConsumerRegistration] = {}

    # ------------------------------------------------------------------
    # 消费者注册
    # ------------------------------------------------------------------

    @public_api("注册事件消费者")
    @classmethod
    def register_consumer(cls, registration: ConsumerRegistration) -> None:
        if registration.consumer_id in cls._consumers:
            logger.warning(
                "[EventBus] 覆盖消费者: %s", registration.consumer_id
            )
        cls._consumers[registration.consumer_id] = registration
        logger.info(
            "[EventBus] 注册消费者: %s (events=%s)",
            registration.consumer_id,
            registration.event_types or "ALL",
        )

    @classmethod
    def unregister_consumer(cls, consumer_id: str) -> None:
        cls._consumers.pop(consumer_id, None)

    # ------------------------------------------------------------------
    # 事件发布
    # ------------------------------------------------------------------

    @public_api("发布事件（异步分发）")
    @classmethod
    def emit(cls, event: Event) -> None:
        """发布事件，通过 Celery 异步分发给所有匹配的消费者。

        在非 async 上下文中调用此方法是安全的。
        """
        if cls._is_reentrant():
            logger.debug(
                "[EventBus] 跳过重入事件: %s/%s",
                event.source,
                event.event_type,
            )
            return

        try:
            from apps.extensions.tasks import dispatch_event

            dispatch_event.delay(
                event_id=event.event_id,
                source=event.source,
                event_type=event.event_type,
                organization_id=event.organization_id,
                space_id=event.space_id,
                payload=event.payload,
                timestamp=event.timestamp,
                connection_id=event.connection_id,
            )
            logger.info(
                "[EventBus] 事件已入队: %s/%s organization=%s",
                event.source,
                event.event_type,
                event.organization_id,
            )
        except Exception as exc:
            is_broker_conn_err = _is_broker_connection_error(exc)
            if is_broker_conn_err:
                logger.warning(
                    "[EventBus] Celery broker 不可达，回退同步分发: %s/%s (%s)",
                    event.source,
                    event.event_type,
                    exc,
                )
            else:
                logger.error(
                    "[EventBus] Celery 入队失败，回退同步分发: %s/%s",
                    event.source,
                    event.event_type,
                    exc_info=True,
                )
            try:
                cls._dispatch_to_consumers(event)
            except Exception:
                logger.error(
                    "[EventBus] 同步降级分发也失败，事件丢失: %s/%s event_id=%s",
                    event.source,
                    event.event_type,
                    event.event_id,
                    exc_info=True,
                )

    @classmethod
    def emit_sync(cls, event: Event) -> Dict[str, Any]:
        """同步分发事件（用于测试或需要立即结果的场景）。

        返回每个消费者的处理结果。
        """
        if cls._is_reentrant():
            logger.debug(
                "[EventBus] 跳过重入同步事件: %s/%s",
                event.source,
                event.event_type,
            )
            return {}
        return cls._dispatch_to_consumers(event)

    # ------------------------------------------------------------------
    # 内部分发
    # ------------------------------------------------------------------

    @classmethod
    def _dispatch_to_consumers(cls, event: Event) -> Dict[str, Any]:
        """将事件分发到所有匹配的消费者，返回各消费者的结果。"""
        results: Dict[str, Any] = {}

        for consumer_id, reg in cls._consumers.items():
            if reg.event_types and event.event_type not in reg.event_types:
                continue
            if reg.exclude_prefixes and any(
                event.event_type.startswith(p) for p in reg.exclude_prefixes
            ):
                continue

            try:
                depth = _recursion_depth.get()
                _recursion_depth.set(depth + 1)
                result = reg.handler(event)
                results[consumer_id] = {"ok": True, "result": str(result) if result else None}
            except Exception as exc:
                logger.error(
                    "[EventBus] 消费者 %s 处理事件 %s 失败: %s",
                    consumer_id,
                    event.event_type,
                    exc,
                    exc_info=True,
                )
                results[consumer_id] = {"ok": False, "error": str(exc)}
            finally:
                _recursion_depth.set(max(_recursion_depth.get() - 1, 0))

        return results

    @classmethod
    def _get_matching_consumers(cls, event_type: str) -> List[ConsumerRegistration]:
        result = []
        for reg in cls._consumers.values():
            if reg.event_types is not None and event_type not in reg.event_types:
                continue
            if reg.exclude_prefixes and any(
                event_type.startswith(p) for p in reg.exclude_prefixes
            ):
                continue
            result.append(reg)
        return result

    @classmethod
    def _is_reentrant(cls) -> bool:
        return _recursion_depth.get() > 0

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    @classmethod
    def list_consumers(cls) -> List[Dict[str, Any]]:
        return [
            {
                "consumer_id": reg.consumer_id,
                "event_types": list(reg.event_types) if reg.event_types else None,
                "exclude_prefixes": reg.exclude_prefixes or None,
                "description": reg.description,
            }
            for reg in cls._consumers.values()
        ]

    # ------------------------------------------------------------------
    # 测试
    # ------------------------------------------------------------------

    @classmethod
    def _reset(cls) -> None:
        cls._consumers = {}

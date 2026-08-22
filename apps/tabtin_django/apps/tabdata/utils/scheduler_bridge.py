"""TabData 写入链路 → EventBus 桥接。

2026-05-28 收编：原 ``trigger_scheduler_automations`` 走 Celery
``apps.tracker.tasks.process_table_event`` → ``on_table_record_event``
（ScheduledJob.table_automation 子系统）。该子系统已整体下线并入
Tracker.trigger_type='table_event'，本模块不再调任何 Tracker 域代码，
直接把 ``tabdata.record.*`` 事件 emit 到 EventBus；下游 Tracker /
Extension consumer 走各自的 EventBus 订阅链路消费。

文件名 ``scheduler_bridge.py`` 是历史命名遗留——为减少 import 改动面
本期不改名，但语义已是"emit 到 EventBus"，与 scheduler 解耦。
"""
from __future__ import annotations

import hashlib
import logging
from typing import Iterable, Optional

from apps.tabdata.subscribers._utils import run_after_commit

logger = logging.getLogger(__name__)


def _stable_event_id(*, table_id: str, record_id: str, event_type: str) -> str:
    """确定性 event_id（基于 table_id + record_id + event_type sha256）。

    用于 EventBus 的 dedup —— 同一条 record 同一类型事件多路径触发只算一次。
    """
    return hashlib.sha256(
        f"{table_id}:{record_id}:{event_type}".encode()
    ).hexdigest()[:24]


def emit_record_event_to_eventbus(
    *,
    table_id: str,
    space_id: str,
    event_type: str,
    record_id: str,
    changed_field_ids: Optional[Iterable[str]] = None,
    organization_id: str = "",
) -> None:
    """把单条 record 事件 emit 到 EventBus（``tabdata.record.{event_type}``）。

    同步入队（``EventBus.emit`` 内部走 Celery ``dispatch_event`` 异步分发），
    调用者不会被 LLM-level 时间阻塞。
    """
    try:
        from apps.extensions.event_bus import Event, EventBus

        EventBus.emit(Event(
            source="tabdata",
            event_type=f"tabdata.record.{event_type}",
            organization_id=organization_id,
            space_id=space_id,
            event_id=_stable_event_id(
                table_id=table_id, record_id=record_id, event_type=event_type,
            ),
            payload={
                "table_id": table_id,
                "record_id": record_id,
                "event_type": event_type,
                "changed_field_ids": list(changed_field_ids) if changed_field_ids else None,
            },
        ))
    except Exception:
        logger.debug(
            "[tabdata.eventbus] emit record event failed: table=%s event=%s record=%s",
            table_id, event_type, record_id, exc_info=True,
        )


def trigger_scheduler_automations(
    record,
    event_type: str,
    changed_field_ids: set = None,
) -> None:
    """RecordService 调用入口：在事务提交后把 record 事件 emit 到 EventBus。

    历史命名 ``trigger_scheduler_automations`` 保留以减少 caller 改动面；
    实际语义已经是"emit 到 EventBus"——下游 Tracker.trigger_type='table_event'
    via apps/extensions/consumers.py 的 _on_event_for_tracker 消费。
    """
    def _dispatch() -> None:
        try:
            table = record.table if hasattr(record, "table") else None
            if not table or not table.space_id:
                return
            space_id = str(table.space_id)
            organization_id = str(table.organization_id) if table.organization_id else ""
            emit_record_event_to_eventbus(
                table_id=str(record.table_id),
                space_id=space_id,
                event_type=event_type,
                record_id=str(record.id),
                changed_field_ids=changed_field_ids,
                organization_id=organization_id,
            )
        except Exception:
            logger.debug(
                "[tabdata.eventbus] trigger_scheduler_automations failed: table=%s event=%s",
                getattr(record, "table_id", "?"),
                event_type,
                exc_info=True,
            )

    run_after_commit(_dispatch)

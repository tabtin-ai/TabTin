"""内置事件消费者

在 EventBus 中注册标准消费者，将 Extension 事件路由到
Tracker 触发、Agent wake 等下游系统。

2026-05-28 收编：ScheduledJob.table_automation 子系统整体下线，
``_on_event_for_scheduler`` consumer 已删除——所有事件触发归位
Tracker（``_on_event_for_tracker``）。
"""

from __future__ import annotations

import logging
from typing import Any

# 历史命名遗留：常量名 GOAL_EXTENSION_TRIGGER_CONSUMER_ID 和它的字符串值
# "agenda_goal_trigger" 都是 EventBus consumer 注册表里的稳定标识，重命名会
# 影响其它模块对 consumer 的引用与历史日志聚合，本期不改名。
from apps.extensions.constants import GOAL_EXTENSION_TRIGGER_CONSUMER_ID
from apps.extensions.event_bus import ConsumerRegistration, Event, EventBus

logger = logging.getLogger(__name__)


_TABLE_RECORD_PREFIX = ["tabdata.record."]

_SOURCE_LABELS = {
    "tabdoc": "TabDoc", "tabslide": "TabSlide",
    "tabdata": "TabData", "tabvideo": "TabVideo", "tabcode": "TabCode",
    "tabsite": "TabSite",
}
_ACTION_LABELS = {
    "created": "创建", "updated": "更新", "archived": "归档",
    "trashed": "移入回收站", "restored": "恢复", "deleted": "删除",
    "saved": "保存",
}


def _event_type_to_label(event_type: str) -> str:
    """将 tabdoc.resource.created 映射为 '文档创建' 等人类可读标签。"""
    parts = event_type.split(".")
    if len(parts) >= 3:
        source_label = _SOURCE_LABELS.get(parts[0], parts[0])
        action_label = _ACTION_LABELS.get(parts[-1], parts[-1])
        return f"{source_label} {action_label}"
    return event_type


def _build_readable_trigger_context(event: "Event") -> dict:
    """构建含人类可读字段的 trigger_context。"""
    payload = event.payload or {}
    return {
        "source": event.source,
        "event_key": event.event_type,
        "event_type": event.event_type,
        "event_id": event.event_id,
        "payload": payload,
        "source_label": _SOURCE_LABELS.get(event.source, event.source),
        "event_label": _event_type_to_label(event.event_type),
        "resource_title": payload.get("title", ""),
        "resource_id": payload.get("resource_id", ""),
    }


def _matches_extension_event_config(cfg: dict, event: "Event") -> bool:
    """判断 extension_event Tracker 配置是否匹配当前 EventBus 事件。

    CLI ``tabtin tracker new --on <event_key>`` 写入的是
    ``trigger_config.event_key``；历史后端 consumer 曾只看 ``event_type``，
    导致带 event_key 的 Tracker 实际没有参与匹配，退化成同 organization 下泛触发。
    """
    cfg_event_key = (cfg.get("event_key") or "").strip()
    if cfg_event_key:
        return cfg_event_key == event.event_type

    # 兼容旧数据：早期路径可能写 event_type/source。
    cfg_event_type = (cfg.get("event_type") or "").strip()
    if cfg_event_type and cfg_event_type != event.event_type:
        return False

    cfg_source = (cfg.get("source") or "").strip()
    if cfg_source and cfg_source != event.source:
        return False

    return bool(cfg_event_type or cfg_source)


def register_builtin_consumers() -> None:
    """注册所有内置消费者。在 ExtensionsConfig.ready() 中调用。"""

    EventBus.register_consumer(ConsumerRegistration(
        consumer_id=GOAL_EXTENSION_TRIGGER_CONSUMER_ID,
        handler=_on_event_for_tracker,
        description="将 Extension 事件路由到 Tracker 触发器",
    ))

    EventBus.register_consumer(ConsumerRegistration(
        consumer_id="ws_notification",
        handler=_on_event_for_ws,
        exclude_prefixes=_TABLE_RECORD_PREFIX,
        description="将 Extension 事件推送到 WebSocket（排除 tabdata.record.*）",
    ))

    try:
        from apps.extensions.contrib.notification_center import notification_center_consumer

        EventBus.register_consumer(ConsumerRegistration(
            consumer_id="notification_center",
            handler=notification_center_consumer,
            exclude_prefixes=["notification."],
            description="通知中心：将事件按规则转化为用户通知（排除自身事件防循环）",
        ))
    except Exception:
        logger.warning("[consumers] 注册通知中心消费者失败", exc_info=True)

    logger.info("[consumers] 内置事件消费者已注册")


def _on_event_for_tracker(event: Event) -> Any:
    """将 Extension 事件路由到匹配的 Tracker 触发（extension_event + table_event）。"""
    try:
        from apps.tracker.models import Tracker
        from apps.tracker.services.tracker_executor import start_tracker_run
        from apps.tracker.services.condition_evaluator import evaluate_conditions
        from apps.tracker.services.tracker_notification import notify_trigger_filtered
        from django.core.cache import cache

        if event.event_type and event.event_type.startswith("tabdata.record."):
            from apps.tracker.services.tracker_trigger_service import trigger_by_table_event
            table_id = (event.payload or {}).get("table_id", "")
            if table_id:
                trigger_by_table_event(
                    organization_id=event.organization_id or "",
                    space_id=event.space_id,
                    table_id=table_id,
                    event_type=event.event_type,
                    record_data=event.payload,
                    event_id=event.event_id,
                )

        payload = event.payload or {}
        is_truncated = payload.get("_truncated", False)
        if is_truncated:
            logger.warning(
                "[tracker_extension_consumer] 收到截断事件 %s/%s (原始 %d bytes)，"
                "条件评估可能不完整，仅保留关键路由字段",
                event.source, event.event_type,
                payload.get("_original_size", 0),
            )

        # TGE-012: organization_id 为空时跳过 extension_event 匹配，防止无范围查询全库
        if not event.organization_id:
            logger.warning(
                "[tracker_extension_consumer] 事件 %s/%s 缺少 organization_id，跳过 extension_event Tracker 匹配",
                event.source, event.event_type,
            )
            return 0

        qs = Tracker.objects.filter(
            trigger_type="extension_event",
            status="active",
            organization=event.organization_id,
        )
        if event.space_id:
            qs = qs.filter(workspace_id=event.space_id)

        dispatched = 0
        for tracker in qs.only("id", "trigger_config", "organization_id", "workspace_id")[:500]:
            cfg = tracker.trigger_config or {}
            if not _matches_extension_event_config(cfg, event):
                continue

            cfg_conditions = cfg.get("conditions")
            if is_truncated and cfg_conditions:
                logger.warning(
                    "[tracker_extension_consumer] 截断事件跳过条件评估，直接触发 Tracker %s "
                    "(避免因字段缺失导致 Tracker 永不触发)",
                    tracker.id,
                )
            elif cfg_conditions and not evaluate_conditions(cfg_conditions, payload):
                notify_trigger_filtered(
                    organization_id=event.organization_id or str(tracker.organization_id or ""),
                    tracker_id=str(tracker.id),
                    event_type=event.event_type,
                    event_label=_event_type_to_label(event.event_type),
                    space_id=event.space_id or (str(tracker.workspace_id) if tracker.workspace_id else None),
                )
                continue

            # Module C 收尾：dedup key 前缀 ``ext_goal:`` → ``ext_tracker:``（TTL 300s，
            # 重命名后存量 dedup cache key 自然过期；最坏 300s 内同事件可能跨进程重复
            # 触发一次，但 Tracker 级 single active run 兜底，无功能影响）。
            dedup_key = f"ext_tracker:{tracker.id}:{event.event_id}"
            if not cache.add(dedup_key, "1", timeout=300):
                continue

            # Tracker 模块收敛阶段 B：extension_event 也走 storm guard，
            # 与 webhook / table_event / tracker_completed 三条入口对齐，避免
            # 上游 app 频繁推事件时 Tracker 被无限触发（charter §6.3）。
            from apps.tracker.services.tracker_trigger_service import apply_storm_guard

            decision = apply_storm_guard(
                tracker,
                event_label=_event_type_to_label(event.event_type),
                space_id=event.space_id or (str(tracker.workspace_id) if tracker.workspace_id else None),
            )
            if not decision.allowed:
                logger.info(
                    "[storm_guard] extension_event Tracker 拒绝触发: tracker=%s event=%s reason=%s",
                    tracker.id, event.event_type, decision.reason,
                )
                cache.delete(dedup_key)
                continue

            try:
                start_tracker_run(
                    tracker_id=str(tracker.id),
                    trigger_type="extension_event",
                    trigger_context=_build_readable_trigger_context(event),
                )
                dispatched += 1
            except Exception:
                logger.warning(
                    "[tracker_extension_consumer] 启动 Tracker 失败: tracker=%s",
                    tracker.id,
                    exc_info=True,
                )

        if dispatched:
            logger.info(
                "[tracker_extension_consumer] 事件 %s 触发 %d 个 Tracker",
                event.event_type,
                dispatched,
            )
        return dispatched

    except Exception:
        logger.warning(
            "[tracker_extension_consumer] 处理事件失败: %s",
            event.event_type,
            exc_info=True,
        )
        return 0


def _on_event_for_ws(event: Event) -> Any:
    """将 Extension 事件推送到 WebSocket，通知前端。"""
    try:
        from apps.services.common.ws.bus import publish_ws_event

        topic = f"extension.events.{event.organization_id}"
        envelope = {
            "type": f"extension.{event.event_type}",
            "source": event.source,
            "event_id": event.event_id,
            "organization_id": event.organization_id,
            "space_id": event.space_id,
            "payload": {
                **(event.payload or {}),
                "space_id": event.space_id,
            },
            "timestamp": event.timestamp,
        }
        publish_ws_event(topic, envelope)
        return True

    except Exception:
        logger.warning(
            "[ws_consumer] WS 推送失败: %s", event.event_type, exc_info=True
        )
        return False

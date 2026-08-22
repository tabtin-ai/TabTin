"""Extension 框架 Celery 异步任务"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any, Dict, List, Optional

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)

EVENT_LOG_RETENTION_DAYS = 30
MAX_EVENT_PAYLOAD_BYTES = 64 * 1024  # 64KB

# EP-11 + INT-36: payload 截断时保留的关键路由字段，供消费者做降级处理
_PAYLOAD_TRUNCATE_PRESERVED_KEYS = (
    "event_id", "event_type", "table_id", "record_ids",
    "action", "space_id", "organization_id",
    "resource_id", "resource_type", "title",
    "document_id", "editor_type", "editor_id",
    "latest_version", "history_id", "is_snapshot",
    "message_id", "thread_id", "identity_user_id",
    "handling_space_id", "execution_agent_id",
    "from_address", "subject", "preview", "account_email",
)

EXTENSIONS_BEAT_SCHEDULE = {
    "extensions-cleanup-event-logs": {
        "task": "extensions.cleanup_event_logs",
        "schedule": 86400.0,  # 每天一次
    },
}


@shared_task(
    name="extensions.dispatch_event",
    ignore_result=True,
    soft_time_limit=60,
    time_limit=120,
)
def dispatch_event(
    *,
    event_id: str,
    source: str,
    event_type: str,
    organization_id: str,
    space_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    timestamp: Optional[str] = None,
    connection_id: Optional[str] = None,
) -> None:
    """异步分发事件到所有匹配的消费者和 webhook 订阅。"""
    import json as _json
    from apps.extensions.event_bus import Event, EventBus
    from apps.extensions.models import ExtensionEventLog

    if payload:
        try:
            payload_size = len(_json.dumps(payload, ensure_ascii=False))
        except (TypeError, ValueError):
            payload_size = 0
        if payload_size > MAX_EVENT_PAYLOAD_BYTES:
            logger.warning(
                "[dispatch_event] payload 超过上限 (%d > %d bytes)，截断 event_data 存储",
                payload_size, MAX_EVENT_PAYLOAD_BYTES,
            )
            # EP-11 fix: 保留关键路由/标识字段，使消费者可区分截断事件并做降级处理
            preserved = {"_truncated": True, "_original_size": payload_size}
            for _pk in _PAYLOAD_TRUNCATE_PRESERVED_KEYS:
                if _pk in payload:
                    preserved[_pk] = payload[_pk]
            payload = preserved

    event = Event(
        source=source,
        event_type=event_type,
        organization_id=organization_id,
        space_id=space_id,
        payload=payload or {},
        event_id=event_id,
        timestamp=timestamp or timezone.now().isoformat(),
        connection_id=connection_id,
    )

    try:
        event_log, created = ExtensionEventLog.objects.get_or_create(
            id=event_id,
            defaults={
                "extension_id": source,
                "connection_id": connection_id,
                "organization_id": organization_id,
                "space_id": space_id,
                "event_type": event_type,
                "event_data": payload or {},
                "status": "pending",
            },
        )
    except Exception:
        logger.warning("[dispatch_event] 事件日志写入失败", exc_info=True)
        event_log, created = None, False

    if not created and event_log and event_log.status != "pending":
        logger.info("[dispatch_event] 事件已处理，跳过: %s (status=%s)", event_id, event_log.status)
        return

    final_status = "consumed"
    error_message = None
    consumer_results = {}

    try:
        consumer_results = EventBus._dispatch_to_consumers(event)

        has_failure = any(
            not r.get("ok", False) for r in consumer_results.values()
            if isinstance(r, dict)
        )
        if has_failure:
            final_status = "failed"
            error_message = "; ".join(
                f"{cid}: {r.get('error', 'unknown')}"
                for cid, r in consumer_results.items()
                if isinstance(r, dict) and not r.get("ok", False)
            )
    except Exception as exc:
        final_status = "failed"
        error_message = f"consumer dispatch error: {exc}"
        logger.error("[dispatch_event] consumer 分发异常", exc_info=True)

    try:
        _dispatch_to_webhooks(event)
    except Exception:
        logger.error("[dispatch_event] webhook 分发异常", exc_info=True)

    if event_log:
        try:
            ExtensionEventLog.objects.filter(pk=event_log.pk).update(
                status=final_status,
                consumer_results=consumer_results,
                error_message=error_message,
                processed_at=timezone.now(),
            )
        except Exception:
            logger.warning("[dispatch_event] 事件日志更新失败", exc_info=True)


def _dispatch_to_webhooks(event) -> None:
    """将事件推送到匹配的 webhook 订阅。"""
    import uuid as _uuid

    from apps.extensions.delivery import build_payload
    from apps.extensions.models import ExtensionWebhookSubscription

    subscriptions = ExtensionWebhookSubscription.objects.filter(
        organization_id=event.organization_id,
        is_active=True,
    )

    for sub in subscriptions:
        if not sub.matches_event(event.event_type):
            continue

        delivery_id = str(_uuid.uuid4())
        payload = build_payload(
            event_type=event.event_type,
            source=event.source,
            organization_id=event.organization_id,
            data=event.payload,
            space_id=event.space_id,
            event_id=event.event_id,
        )

        try:
            deliver_webhook_to_sub.delay(
                subscription_id=str(sub.pk),
                event_type=event.event_type,
                payload=payload,
                delivery_id=delivery_id,
            )
        except Exception:
            logger.error(
                "[dispatch_event] Webhook 投递子任务提交失败: sub=%s",
                sub.pk,
                exc_info=True,
            )


# ---------------------------------------------------------------------------
# Webhook 投递子任务（每个订阅独立执行，互不阻塞）
# ---------------------------------------------------------------------------

@shared_task(
    bind=True,
    name="extensions.deliver_webhook_to_sub",
    ignore_result=True,
    soft_time_limit=30,
    time_limit=60,
    max_retries=10,
)
def deliver_webhook_to_sub(
    self,
    *,
    subscription_id: str,
    event_type: str,
    payload: Dict[str, Any],
    delivery_id: Optional[str] = None,
) -> None:
    """向单个 WebhookSubscription 投递事件，失败通过 Celery retry 指数退避重试。"""
    from apps.extensions.delivery import (
        WebhookRetryableError,
        deliver_webhook_once,
        record_delivery_failure,
        record_delivery_success,
    )
    from apps.extensions.models import ExtensionWebhookSubscription

    try:
        sub = ExtensionWebhookSubscription.objects.get(pk=subscription_id, is_active=True)
    except ExtensionWebhookSubscription.DoesNotExist:
        logger.info("[deliver_webhook_to_sub] 订阅不存在或已停用: %s", subscription_id)
        return

    effective_max_retries = min(sub.max_retries, self.max_retries)

    try:
        result = deliver_webhook_once(
            url=sub.url,
            payload=payload,
            event_type=event_type,
            secret=sub.secret,
            delivery_id=delivery_id,
        )
        if result["ok"]:
            record_delivery_success(sub)
        else:
            record_delivery_failure(sub)
    except WebhookRetryableError as exc:
        attempt = self.request.retries
        if attempt < effective_max_retries:
            backoff = min(2 ** (attempt + 1), 30)
            logger.warning(
                "[deliver_webhook_to_sub] 可重试失败 (attempt %d/%d): sub=%s error=%s",
                attempt + 1, effective_max_retries + 1, subscription_id, exc,
            )
            raise self.retry(countdown=backoff, max_retries=effective_max_retries, exc=exc)
        record_delivery_failure(sub)
        logger.error(
            "[deliver_webhook_to_sub] 最终失败 (已重试 %d 次): sub=%s error=%s",
            attempt, subscription_id, exc,
        )
    except Exception:
        record_delivery_failure(sub)
        logger.error(
            "[deliver_webhook_to_sub] 投递异常: sub=%s", subscription_id, exc_info=True
        )


# ---------------------------------------------------------------------------
# 通知投递子任务（每个用户独立执行，互不阻塞）
# ---------------------------------------------------------------------------

@shared_task(
    name="extensions.deliver_notification_for_user",
    ignore_result=True,
    soft_time_limit=30,
    time_limit=60,
)
def deliver_notification_for_user(
    *,
    user_id: str,
    title: str,
    body: str,
    organization_id: str,
    metadata: Dict[str, Any],
) -> None:
    """向单个用户创建并推送通知。从 notification_center_consumer 拆出，避免 N 个用户串行阻塞。"""
    from apps.services.notification.services.notification_service import NotificationService

    try:
        NotificationService.notify(
            user_id=user_id,
            type="extension_event",
            title=title,
            body=body,
            organization_id=organization_id,
            metadata=metadata,
        )
    except Exception:
        logger.error(
            "[deliver_notification_for_user] 通知创建失败: user=%s organization=%s",
            user_id, organization_id, exc_info=True,
        )


# ---------------------------------------------------------------------------
# EventLog 定时清理
# ---------------------------------------------------------------------------

EVENT_LOG_CLEANUP_BATCH_SIZE = 2000


@shared_task(name="extensions.cleanup_event_logs", ignore_result=True, time_limit=60, soft_time_limit=50)
def cleanup_event_logs() -> None:
    """分批清理超过保留期的事件日志，避免大事务锁表。"""
    from apps.extensions.models import ExtensionEventLog

    cutoff = timezone.now() - timedelta(days=EVENT_LOG_RETENTION_DAYS)
    total_deleted = 0
    while True:
        batch_ids = list(
            ExtensionEventLog.objects.filter(created_at__lt=cutoff)
            .values_list("id", flat=True)[:EVENT_LOG_CLEANUP_BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted_count, _ = ExtensionEventLog.objects.filter(id__in=batch_ids).delete()
        total_deleted += deleted_count
    if total_deleted:
        logger.info("[cleanup_event_logs] 已清理 %d 条过期事件日志", total_deleted)

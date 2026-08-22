"""
Webhook 异步投递 Celery 任务
"""
import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(
    bind=True,
    name='tabdata.deliver_webhook_event',
    max_retries=4,
    acks_late=True,
    rate_limit='30/m',
    time_limit=120,
    soft_time_limit=100,
)
def deliver_webhook_event(
    self,
    space_id: str,
    event_type: str,
    table_id: str = None,
    data: dict = None,
):
    """
    异步投递 webhook 事件到所有匹配的订阅。

    DATA-12: 拆为每个 webhook 独立子任务（deliver_single_webhook），
    避免串行阻塞超出 time_limit。
    DATA-13: Celery 层重试增至 4 次 + 指数退避。
    """
    from apps.tabdata.services.webhook_service import WebhookDeliveryService

    try:
        webhooks = WebhookDeliveryService.find_matching_webhooks(
            space_id=space_id,
            event_type=event_type,
            table_id=table_id,
        )
        if not webhooks:
            return {'status': 'no_match', 'count': 0}

        payload = WebhookDeliveryService.build_payload(
            event_type, space_id, table_id, data or {},
        )

        for wh in webhooks:
            deliver_single_webhook.delay(str(wh.id), payload)

        logger.info(
            'Webhook 事件已分发: space=%s event=%s table=%s 子任务=%d',
            space_id, event_type, table_id, len(webhooks),
        )
        return {'status': 'dispatched', 'count': len(webhooks)}
    except Exception as exc:
        logger.exception(
            'Webhook 投递异常: space=%s event=%s error=%s',
            space_id, event_type, exc,
        )
        backoff = min(30 * (2 ** self.request.retries), 600)
        raise self.retry(exc=exc, countdown=backoff)


@shared_task(
    bind=True,
    name='tabdata.deliver_single_webhook',
    max_retries=5,
    acks_late=True,
    time_limit=60,
    soft_time_limit=50,
    queue='heavy',
)
def deliver_single_webhook(self, webhook_id: str, payload: dict):
    """
    投递单个 webhook，独立重试。

    DATA-12: 每个 webhook 独立任务，单次超时不影响其他 webhook。
    DATA-13: 5 次重试 + 指数退避；最终失败写入死信日志，不再静默丢失。
    """
    from apps.tabdata.services.webhook_service import WebhookDeliveryService

    try:
        success = WebhookDeliveryService.deliver(webhook_id, payload)
        if not success:
            logger.warning('Webhook %s 投递失败（应用层重试已耗尽）', webhook_id)
        return {'webhook_id': webhook_id, 'success': success}
    except Exception as exc:
        if self.request.retries < self.max_retries:
            logger.warning(
                'Webhook %s 投递异常（第 %d 次），将重试: %s',
                webhook_id, self.request.retries + 1, exc,
            )
            backoff = min(30 * (2 ** self.request.retries), 600)
            raise self.retry(exc=exc, countdown=backoff)
        else:
            _record_dead_letter(webhook_id, payload, str(exc))
            logger.error(
                'Webhook %s 最终投递失败（已达 %d 次重试），已写入死信日志: %s',
                webhook_id, self.max_retries, exc,
            )
            return {'webhook_id': webhook_id, 'success': False, 'dead_letter': True}


def _record_dead_letter(webhook_id: str, payload: dict, error: str):
    """将最终失败的 webhook 事件写入死信日志。

    优先写 DB（WebhookDeliveryFailure），DB 不可用时降级写 logger.critical。
    """
    try:
        from apps.tabdata.models_webhook import WebhookDeliveryFailure
        from apps.tabdata.constants import TABDATA_DB_ALIAS

        WebhookDeliveryFailure.objects.using(TABDATA_DB_ALIAS).create(
            webhook_id=webhook_id,
            event_type=payload.get('event', ''),
            space_id=payload.get('space_id', ''),
            payload=payload,
            error=error[:2000],
        )
    except Exception:
        logger.critical(
            '死信写入 DB 失败，降级到日志: webhook=%s event=%s error=%s',
            webhook_id, payload.get('event', ''), error[:500],
        )


@shared_task(
    name='tabdata.deliver_webhook_test',
    max_retries=0,
    acks_late=True,
    time_limit=60,
    soft_time_limit=50,
)
def deliver_webhook_test(webhook_id: str, payload: dict):
    """
    测试 webhook 投递（不重试）。

    由管理 API 的 test 端点调用。
    """
    from apps.tabdata.services.webhook_service import WebhookDeliveryService

    success = WebhookDeliveryService.deliver(webhook_id, payload)
    return {'webhook_id': webhook_id, 'success': success}

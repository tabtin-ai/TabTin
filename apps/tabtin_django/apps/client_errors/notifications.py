"""
客户端错误监控 - Webhook 告警通知

当新建错误分组或已解决的错误重新打开时，向配置的 Webhook URL 发送通知。
通过环境变量 CLIENT_ERROR_WEBHOOK_URL 配置，为空则禁用。
"""

from __future__ import annotations

import logging

import requests
from celery import shared_task
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)

_WEBHOOK_TIMEOUT = 10  # 秒


@shared_task(bind=True, max_retries=2, default_retry_delay=30, ignore_result=True, time_limit=60, soft_time_limit=50)
def send_error_webhook(self, group_id: int, event_type: str) -> dict | None:
    """
    异步发送错误告警 Webhook。

    Args:
        group_id: ClientErrorGroup 主键
        event_type: "new_group" 或 "reopened"
    """
    webhook_url = getattr(settings, "CLIENT_ERROR_WEBHOOK_URL", "")
    if not webhook_url:
        return None

    from .models import ClientErrorGroup

    try:
        group = ClientErrorGroup.objects.using("postgresql").get(pk=group_id)
    except ClientErrorGroup.DoesNotExist:
        logger.warning(
            "[ClientErrors] Webhook 跳过: 分组 #%d 不存在", group_id,
        )
        return None

    payload = {
        "event_type": event_type,
        "group": {
            "id": group.pk,
            "title": group.title,
            "level": group.level,
            "fingerprint": group.fingerprint,
            "event_count": group.event_count,
            "first_seen": group.first_seen.isoformat() if group.first_seen else None,
            "last_seen": group.last_seen.isoformat() if group.last_seen else None,
            "sample_app_version": group.sample_app_version,
        },
        "timestamp": timezone.now().isoformat(),
    }

    try:
        resp = requests.post(
            webhook_url,
            json=payload,
            timeout=_WEBHOOK_TIMEOUT,
            headers={"Content-Type": "application/json"},
        )
        resp.raise_for_status()
        logger.info(
            "[ClientErrors] Webhook 发送成功: event_type=%s, group=#%d, status=%d",
            event_type, group_id, resp.status_code,
        )
        return {"status": resp.status_code, "group_id": group_id, "event_type": event_type}
    except requests.RequestException as exc:
        logger.warning(
            "[ClientErrors] Webhook 发送失败: event_type=%s, group=#%d, error=%s",
            event_type, group_id, exc,
        )
        try:
            self.retry(exc=exc)
        except self.MaxRetriesExceededError:
            logger.error(
                "[ClientErrors] Webhook 达到最大重试次数: event_type=%s, group=#%d",
                event_type, group_id,
            )
            return None

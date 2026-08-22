"""通用 Webhook 投递服务

从 TableWebhook (tabdata/webhook_service.py) 和 NotificationService (scheduler)
中提炼的公共投递能力：HMAC 签名、指数退避重试、投递日志、失败停用。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, Optional
import httpx

from apps.services.common.url_security import (
    pinned_ssl_context,
    resolve_and_validate,
    validate_url_ssrf,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 10
AUTO_DISABLE_THRESHOLD = 10
USER_AGENT = "TabTin-Extension/1.0"


def validate_webhook_url(url: str) -> Optional[str]:
    """校验 Webhook URL 安全性，返回错误信息，None 表示通过。"""
    return validate_url_ssrf(url)


def compute_signature(secret: str, body: str) -> str:
    """HMAC-SHA256 签名。"""
    return hmac.new(
        secret.encode("utf-8"),
        body.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def build_headers(
    event_type: str,
    signature: Optional[str] = None,
    delivery_id: Optional[str] = None,
) -> Dict[str, str]:
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": USER_AGENT,
        "X-TabTin-Event": event_type,
        "X-TabTin-Delivery": delivery_id or str(uuid.uuid4()),
    }
    if signature:
        headers["X-TabTin-Signature"] = f"sha256={signature}"
    return headers


def build_payload(
    event_type: str,
    source: str,
    organization_id: str,
    data: Dict[str, Any],
    *,
    space_id: Optional[str] = None,
    event_id: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "event": event_type,
        "source": source,
        "event_id": event_id or str(uuid.uuid4()),
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "organization_id": organization_id,
        "space_id": space_id,
        "data": data,
    }


def _is_retryable_status(status_code: int) -> bool:
    return status_code >= 500 or status_code == 429


class WebhookRetryableError(Exception):
    """可重试的 Webhook 投递错误（5xx、429、网络异常）。"""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


def deliver_webhook_once(
    url: str,
    payload: Dict[str, Any],
    *,
    event_type: str,
    secret: str = "",
    timeout: int = DEFAULT_TIMEOUT,
    delivery_id: Optional[str] = None,
) -> Dict[str, Any]:
    """单次 Webhook 投递尝试。成功返回 ok=True，可重试失败抛 WebhookRetryableError，不可重试返回 ok=False。"""

    try:
        resolved = resolve_and_validate(url)
    except ValueError as exc:
        error_msg = str(exc)
        if "无法解析主机" in error_msg:
            raise WebhookRetryableError(f"DNS 解析失败: {error_msg}") from exc
        return {
            "ok": False,
            "status_code": None,
            "error": f"SSRF 安全校验失败: {error_msg}",
            "retryable": False,
            "delivery_id": delivery_id or str(uuid.uuid4()),
        }

    if not delivery_id:
        delivery_id = str(uuid.uuid4())
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    signature = compute_signature(secret, body) if secret else None
    headers = build_headers(event_type, signature=signature, delivery_id=delivery_id)
    headers["Host"] = resolved.original_host

    verify = pinned_ssl_context() if resolved.scheme == "https" else True

    try:
        with httpx.Client(timeout=timeout, max_redirects=0, verify=verify) as client:
            resp = client.post(resolved.pinned_url, content=body, headers=headers)
    except Exception as exc:
        raise WebhookRetryableError(str(exc)) from exc

    if 200 <= resp.status_code < 300:
        return {
            "ok": True,
            "status_code": resp.status_code,
            "error": None,
            "retryable": False,
            "delivery_id": delivery_id,
        }

    error_msg = f"HTTP {resp.status_code}: {resp.text[:200]}"
    if _is_retryable_status(resp.status_code):
        raise WebhookRetryableError(error_msg, status_code=resp.status_code)

    return {
        "ok": False,
        "status_code": resp.status_code,
        "error": error_msg,
        "retryable": False,
        "delivery_id": delivery_id,
    }


def record_delivery_success(subscription) -> None:
    """记录投递成功统计。"""
    from django.db.models import F
    from django.utils import timezone as tz

    type(subscription).objects.filter(pk=subscription.pk).update(
        total_deliveries=F("total_deliveries") + 1,
        consecutive_failures=0,
        last_triggered_at=tz.now(),
    )


def record_delivery_failure(subscription) -> None:
    """记录投递失败统计，超阈值自动停用（原子条件更新避免竞态）。"""
    from django.db.models import F
    from django.utils import timezone as tz

    model = type(subscription)
    model.objects.filter(pk=subscription.pk).update(
        total_deliveries=F("total_deliveries") + 1,
        failed_deliveries=F("failed_deliveries") + 1,
        consecutive_failures=F("consecutive_failures") + 1,
        last_triggered_at=tz.now(),
    )

    disabled_count = model.objects.filter(
        pk=subscription.pk,
        consecutive_failures__gte=AUTO_DISABLE_THRESHOLD,
        is_active=True,
    ).update(is_active=False)

    if disabled_count:
        subscription.refresh_from_db()
        logger.warning(
            "[WebhookDelivery] 连续失败 %d 次，自动停用订阅: %s",
            subscription.consecutive_failures,
            subscription.url,
        )

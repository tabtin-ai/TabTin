"""LLM 运行态任务：渠道健康探测。"""

from __future__ import annotations

import logging
from typing import Optional

from celery import shared_task
from django.utils import timezone

from ..models import LLMProvider
from ..services.capability_guard import provider_supports_llm_capability
from ..services.runtime import probe_provider_health

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=1, default_retry_delay=30, ignore_result=True, time_limit=300, soft_time_limit=280)
def probe_llm_providers(
    self,
    scope: Optional[str] = None,
    organization_id: Optional[str] = None,
    limit: int = 200,
) -> dict:
    """定时探测渠道健康状态。"""
    now = timezone.now()
    normalized_limit = max(1, min(limit, 500))

    query = LLMProvider.objects.filter(
        health_check_enabled=True,
    ).order_by("-priority", "-updated_at")

    if scope:
        query = query.filter(scope=scope)
    if organization_id:
        query = query.filter(organization_id=organization_id)

    providers = list(query[:normalized_limit])

    checked = 0
    skipped = 0
    succeeded = 0
    failed = 0
    errors = []

    for provider in providers:
        if not provider_supports_llm_capability(provider.name):
            skipped += 1
            continue
        if provider.health_last_checked_at:
            delta = (now - provider.health_last_checked_at).total_seconds()
            if delta < int(provider.health_check_interval_sec or 60):
                skipped += 1
                continue

        result = probe_provider_health(provider, check_type="periodic")
        if result.get("skipped"):
            skipped += 1
            continue
        checked += 1
        if result.get("success"):
            succeeded += 1
        else:
            failed += 1
            errors.append(
                {
                    "provider_id": result.get("provider_id"),
                    "provider_name": result.get("provider_name"),
                    "error": result.get("error") or "probe failed",
                }
            )

    summary = {
        "total": len(providers),
        "checked": checked,
        "skipped": skipped,
        "succeeded": succeeded,
        "failed": failed,
        "errors": errors[:20],
        "timestamp": now.isoformat(),
    }

    if failed > 0:
        logger.warning("[LLM Runtime] provider probe with failures: %s", summary)
    else:
        logger.info("[LLM Runtime] provider probe completed: %s", summary)

    return summary


LLM_RUNTIME_BEAT_SCHEDULE = {
    "llm-provider-health-probe": {
        "task": "apps.services.llm.tasks.runtime_tasks.probe_llm_providers",
        "schedule": 60.0,
        "options": {"expires": 50},
    },
}

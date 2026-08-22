"""TabChat Celery 任务。

⚠️ 文件名必须是 `tasks.py`——Celery autodiscover 只 import 每个 app 的 `tasks.py`。
"""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


TABCHAT_BEAT_SCHEDULE = {
    "tabchat-im-outbox-sweep": {
        "task": "tabchat.deliver_im_outbox_sweep",
        "schedule": 30.0,
        "kwargs": {"limit": 100},
        "options": {"queue": "realtime_delivery", "expires": 25},
    },
    "tabchat-agent-mention-sweep": {
        "task": "tabchat.dispatch_agent_mention_sweep",
        "schedule": 60.0,
        "kwargs": {"limit": 100},
        "options": {"queue": "tracker_agent", "expires": 55},
    },
}


@shared_task(
    name="tabchat.deliver_im_outbox",
    ignore_result=True,
    queue="realtime_delivery",
    time_limit=30,
    soft_time_limit=25,
)
def deliver_im_outbox(outbox_id: str) -> int:
    from apps.tabchat.services.im_outbox_service import IMOutboxService

    claimed = IMOutboxService.claim(outbox_id)
    if claimed is None:
        return 0
    record, claim_token = claimed
    return int(IMOutboxService.deliver_claimed(record, claim_token))


@shared_task(
    name="tabchat.deliver_im_outbox_sweep",
    ignore_result=True,
    queue="realtime_delivery",
    time_limit=55,
    soft_time_limit=50,
)
def deliver_im_outbox_sweep(limit: int = 100) -> int:
    from apps.tabchat.services.im_outbox_service import IMOutboxService

    IMOutboxService.recover_expired_leases()
    delivered = 0
    for _ in range(max(1, min(limit, 500))):
        claimed = IMOutboxService.claim()
        if claimed is None:
            break
        record, claim_token = claimed
        delivered += int(IMOutboxService.deliver_claimed(record, claim_token))
    return delivered


@shared_task(
    name="tabchat.retry_dead_im_outbox",
    ignore_result=True,
    queue="realtime_delivery",
)
def retry_dead_im_outbox(outbox_id: str) -> int:
    from apps.tabchat.services.im_outbox_service import IMOutboxService

    return int(IMOutboxService.retry_dead(outbox_id))


@shared_task(
    name="tabchat.dispatch_agent_mention",
    bind=True,
    max_retries=1,
    default_retry_delay=5,
    ignore_result=True,
    queue="tracker_agent",
    time_limit=360,
    soft_time_limit=330,
)
def dispatch_agent_mention(self, job_id: str):
    """领取一个幂等 AgentMentionJob 并写回唯一回复。"""
    import uuid
    from datetime import timedelta

    from django.db import transaction
    from django.utils import timezone

    from apps.services.common.db_router import postgres_app_db_alias
    from apps.tabchat.models import AgentMentionJob
    from apps.tabchat.services.ai_mention_service import AgentMentionInterrupted
    from apps.tabchat.services.ai_mention_service import dispatch_agent_mention as _run

    claim_token = uuid.uuid4()
    now = timezone.now()
    try:
        with transaction.atomic(using=postgres_app_db_alias()):
            job = (
                AgentMentionJob.objects
                .select_for_update()
                .filter(id=job_id)
                .first()
            )
            if job is None or job.status not in {
                AgentMentionJob.Status.PENDING,
                AgentMentionJob.Status.RUNNING,
            }:
                return
            if (
                job.status == AgentMentionJob.Status.RUNNING
                and job.lease_expires_at
                and job.lease_expires_at > now
            ):
                return
            job.status = AgentMentionJob.Status.RUNNING
            job.claim_token = claim_token
            job.lease_expires_at = now + timedelta(minutes=10)
            job.started_at = job.started_at or now
            job.attempts += 1
            job.last_error = ""
            job.save(
                update_fields=[
                    "status",
                    "claim_token",
                    "lease_expires_at",
                    "started_at",
                    "attempts",
                    "last_error",
                    "updated_at",
                ]
            )

        result = _run(job)
        if result is None:
            raise RuntimeError("Agent mention did not produce a final message")
        metadata = {
            **(result.metadata or {}),
            "message_ref": str(job.id),
            "agent_session_ref": str(job.session_id or job.id),
            "source_message_ref": job.source_message_ref or str(job.source_message_id or ""),
        }
        updated = AgentMentionJob.objects.filter(
            id=job_id,
            status=AgentMentionJob.Status.RUNNING,
            claim_token=claim_token,
        ).update(
            status=AgentMentionJob.Status.SUCCEEDED,
            final_content=result.content,
            final_message_type=result.message_type,
            final_metadata=metadata,
            completed_at=timezone.now(),
            claim_token=None,
            lease_expires_at=None,
            last_error="",
        )
        if updated:
            job.final_content = result.content
            job.final_message_type = result.message_type
            job.final_metadata = metadata
    except AgentMentionInterrupted as exc:
        cancelled = AgentMentionJob.objects.filter(
            id=job_id,
            status=AgentMentionJob.Status.RUNNING,
            claim_token=claim_token,
        ).update(
            status=AgentMentionJob.Status.CANCELLED,
            completed_at=timezone.now(),
            claim_token=None,
            lease_expires_at=None,
            last_error=str(exc)[:2000],
        )
        if cancelled:
            from apps.tabchat.services.agent_message_projection import (
                publish_agent_message_error,
            )

            publish_agent_message_error(job)
    except Exception as exc:
        logger.exception(
            "[tabchat.ai] task failed job=%s", job_id
        )
        AgentMentionJob.objects.filter(
            id=job_id,
            status=AgentMentionJob.Status.RUNNING,
            claim_token=claim_token,
        ).update(
            status=AgentMentionJob.Status.PENDING,
            claim_token=None,
            lease_expires_at=None,
            last_error=str(exc)[:2000],
        )
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        failed = AgentMentionJob.objects.filter(id=job_id).exclude(
            status=AgentMentionJob.Status.SUCCEEDED,
        ).update(
            status=AgentMentionJob.Status.FAILED,
            completed_at=timezone.now(),
            last_error=str(exc)[:2000],
        )
        if failed:
            failed_job = AgentMentionJob.objects.filter(id=job_id).first()
            if failed_job is not None:
                from apps.tabchat.services.agent_message_projection import (
                    publish_agent_message_error,
                )
                from apps.tabchat.services.ai_mention_service import (
                    notify_terminal_mention_error,
                )

                publish_agent_message_error(failed_job)
                notify_terminal_mention_error(failed_job)


def _enqueue_agent_message_reference(job_id: str) -> None:
    from django.conf import settings

    if getattr(settings, "RUNNING_TESTS", False):
        return
    try:
        deliver_agent_message_reference.apply_async(
            args=[job_id],
            queue="realtime_delivery",
        )
    except Exception:
        # Agent 正文与成功状态已经持久化；桥接调度失败不能反向改写结果。
        logger.exception(
            "[tabchat.ai] reference enqueue failed job=%s",
            job_id,
        )


@shared_task(
    name="tabchat.deliver_agent_message_reference",
    bind=True,
    max_retries=5,
    ignore_result=True,
    queue="realtime_delivery",
    acks_late=True,
    reject_on_worker_lost=True,
    time_limit=30,
    soft_time_limit=25,
)
def deliver_agent_message_reference(self, job_id: str) -> int:
    from apps.tabchat.services.agent_message_reference import (
        PermanentAgentMessageReferenceError,
        TransientAgentMessageReferenceError,
    )
    from apps.tabchat.services.agent_message_reference import (
        deliver_agent_message_reference as _deliver,
    )

    try:
        return int(_deliver(job_id))
    except PermanentAgentMessageReferenceError as exc:
        logger.warning(
            "[tabchat.ai] reference delivery rejected job=%s error=%s",
            job_id,
            exc,
        )
        return 0
    except TransientAgentMessageReferenceError as exc:
        if self.request.retries >= self.max_retries:
            logger.error(
                "[tabchat.ai] reference delivery exhausted job=%s error=%s",
                job_id,
                exc,
            )
            raise
        countdown = min(300, 5 * (2 ** self.request.retries))
        raise self.retry(exc=exc, countdown=countdown)


@shared_task(
    name="tabchat.dispatch_agent_mention_sweep",
    ignore_result=True,
    queue="tracker_agent",
    time_limit=55,
    soft_time_limit=50,
)
def dispatch_agent_mention_sweep(limit: int = 100) -> int:
    """重新唤醒漏 enqueue 或 Lease 已过期的 AgentMentionJob。"""
    from django.db.models import Q
    from django.utils import timezone

    from apps.tabchat.models import AgentMentionJob

    now = timezone.now()
    job_ids = list(
        AgentMentionJob.objects.filter(
            Q(status=AgentMentionJob.Status.PENDING)
            | Q(
                status=AgentMentionJob.Status.RUNNING,
                lease_expires_at__lt=now,
            )
        )
        .order_by("created_at")
        .values_list("id", flat=True)[:max(1, min(limit, 500))]
    )
    enqueued = 0
    for job_id in job_ids:
        try:
            dispatch_agent_mention.apply_async(
                args=[str(job_id)],
                queue="tracker_agent",
            )
            enqueued += 1
        except Exception:
            logger.exception(
                "[tabchat.ai] sweep enqueue failed job=%s",
                job_id,
            )
    return enqueued

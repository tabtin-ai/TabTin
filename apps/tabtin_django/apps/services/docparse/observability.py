from __future__ import annotations

from collections import Counter
from datetime import timedelta
from typing import Any

from django.db.models import Avg, Count, F, Q
from django.utils import timezone

from apps.services.docparse.models import DocumentImportJob


def job_log_extra(
    *,
    job: DocumentImportJob | None = None,
    job_id: str = "",
    parsed_document_id: str = "",
    file_record_id: str = "",
    page_number: int | None = None,
    worker_id: str = "",
    task_id: str = "",
    parser_mode: str = "",
    fallback_reason: str = "",
    elapsed_ms: int | None = None,
    peak_rss: int | None = None,
) -> dict[str, Any]:
    if job is not None:
        job_id = str(job.id)
        parsed_document_id = str(job.parsed_document_id or parsed_document_id or "")
        file_record_id = str(job.file_record_id or file_record_id or "")
        worker_id = job.worker_id or worker_id
        task_id = job.celery_task_id or task_id
    return {
        "job_id": job_id,
        "parsed_document_id": parsed_document_id,
        "file_record_id": file_record_id,
        "page_number": page_number,
        "worker_id": worker_id,
        "task_id": task_id,
        "parser_mode": parser_mode,
        "fallback_reason": fallback_reason,
        "elapsed_ms": elapsed_ms,
        "peak_rss": peak_rss,
    }


def get_import_job_metrics_snapshot(*, stuck_after_seconds: int = 900) -> dict[str, Any]:
    now = timezone.now()
    stuck_before = now - timedelta(seconds=stuck_after_seconds)
    status_rows = (
        DocumentImportJob.objects
        .values("status")
        .annotate(count=Count("id"))
    )
    status_counts = {row["status"]: row["count"] for row in status_rows}
    active_qs = DocumentImportJob.objects.filter(status__in=DocumentImportJob.ACTIVE_STATUSES)
    terminal_qs = DocumentImportJob.objects.exclude(status__in=DocumentImportJob.ACTIVE_STATUSES)
    retry_counts = Counter(
        DocumentImportJob.objects
        .exclude(retry_count=0)
        .values_list("status", flat=True)
    )
    duration = terminal_qs.exclude(started_at=None).exclude(completed_at=None).aggregate(
        avg_seconds=Avg(F("completed_at") - F("started_at")),
    )["avg_seconds"]
    avg_duration_seconds = duration.total_seconds() if duration else 0
    queued_wait = active_qs.filter(status=DocumentImportJob.Status.QUEUED).aggregate(
        avg_seconds=Avg(now - F("created_at")),
    )["avg_seconds"]
    avg_queue_wait_seconds = queued_wait.total_seconds() if queued_wait else 0
    return {
        "total": sum(status_counts.values()),
        "status_counts": status_counts,
        "active": active_qs.count(),
        "stuck": active_qs.filter(
            Q(heartbeat_at__lt=stuck_before) | Q(lease_expires_at__lt=now),
        ).count(),
        "failed_pages": DocumentImportJob.objects.aggregate(total=Count("id", filter=Q(failed_pages__gt=0)))["total"],
        "retry_by_status": dict(retry_counts),
        "avg_duration_seconds": avg_duration_seconds,
        "avg_queue_wait_seconds": avg_queue_wait_seconds,
    }


__all__ = ["get_import_job_metrics_snapshot", "job_log_extra"]

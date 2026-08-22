from __future__ import annotations

import hashlib
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from django.db import transaction
from django.db.models import CharField, OuterRef, QuerySet, Exists
from django.db.models.functions import Cast
from django.utils import timezone

from apps.maintenance.models import OpsRuntimeActionLog, OpsRuntimeResolution
from apps.rag.models import EmbeddingTask

RAG_RUNTIME_SOURCE = "rag_embedding_task"
RAG_TERMINAL_STATUSES = ("failed", "cancelled", "terminal_failed")
RAG_RESOLUTION_STATUSES = ("resolved", "archived", "ignored")

TASK_NAME_BY_TYPE = {
    "table": "rag.index_table_task",
    "batch": "rag.index_table_records_task",
    "record": "rag.embed_record_task",
    "document": "rag.index_document_task",
    "skill": "rag.index_single_skill",
    "mail": "rag.index_mail_embedding",
}

SCENE_KEY_BY_TYPE = {
    "table": "rag_index_table",
    "batch": "rag_index_table",
    "record": "rag_index_record",
    "document": "rag_index_document",
    "skill": "rag_index_skill",
    "mail": "rag_index_mail",
}

_SPACE_RE = re.compile(r"\s+")
_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)


@dataclass(frozen=True)
class RagTerminalFilters:
    scene_key: str = ""
    task_name: str = ""
    error_signature: str = ""
    created_before: datetime | None = None
    limit: int = 100


def _terminal_resolution_exists():
    return (
        OpsRuntimeResolution.objects.filter(
            source=RAG_RUNTIME_SOURCE,
            status__in=RAG_RESOLUTION_STATUSES,
            target_id=Cast(OuterRef("id"), output_field=CharField()),
        )
    )


def unresolved_rag_terminal_queryset() -> QuerySet[EmbeddingTask]:
    return (
        EmbeddingTask.objects
        .filter(status__in=RAG_TERMINAL_STATUSES)
        .annotate(_runtime_resolved=Exists(_terminal_resolution_exists()))
        .filter(_runtime_resolved=False)
    )


def task_name_for_embedding_task(task: EmbeddingTask | dict[str, Any]) -> str:
    task_type = str(getattr(task, "task_type", "") if not isinstance(task, dict) else task.get("task_type") or "")
    return TASK_NAME_BY_TYPE.get(task_type, f"rag.{task_type or 'unknown'}")


def scene_key_for_embedding_task(task: EmbeddingTask | dict[str, Any]) -> str:
    task_type = str(getattr(task, "task_type", "") if not isinstance(task, dict) else task.get("task_type") or "")
    return SCENE_KEY_BY_TYPE.get(task_type, "rag_unknown")


def error_signature_for_message(message: str) -> str:
    cleaned = _UUID_RE.sub("<uuid>", str(message or ""))
    cleaned = _SPACE_RE.sub(" ", cleaned).strip()
    if not cleaned:
        return "empty_error"
    prefix = cleaned[:180]
    digest = hashlib.sha1(cleaned.encode("utf-8")).hexdigest()[:10]
    return f"{prefix}#{digest}"


def _apply_filters(qs: QuerySet[EmbeddingTask], filters: RagTerminalFilters) -> QuerySet[EmbeddingTask]:
    if filters.created_before:
        qs = qs.filter(created_at__lt=filters.created_before)
    if filters.task_name:
        matching_types = [task_type for task_type, name in TASK_NAME_BY_TYPE.items() if name == filters.task_name]
        if not matching_types:
            return qs.none()
        qs = qs.filter(task_type__in=matching_types)
    if filters.scene_key:
        matching_types = [task_type for task_type, scene_key in SCENE_KEY_BY_TYPE.items() if scene_key == filters.scene_key]
        if not matching_types:
            return qs.none()
        qs = qs.filter(task_type__in=matching_types)
    return qs


def _materialize_filtered_tasks(filters: RagTerminalFilters) -> list[EmbeddingTask]:
    limit = max(1, min(int(filters.limit or 100), 10_000))
    qs = _apply_filters(unresolved_rag_terminal_queryset(), filters).order_by("created_at")
    candidates = list(qs.only("id", "task_type", "status", "error_message", "created_at")[:limit])
    if filters.error_signature:
        candidates = [
            task for task in candidates
            if filters.error_signature in error_signature_for_message(task.error_message)
        ]
    return candidates


def build_rag_terminal_failed_report(filters: RagTerminalFilters) -> dict[str, Any]:
    tasks = _materialize_filtered_tasks(filters)
    by_task_name = Counter(task_name_for_embedding_task(task) for task in tasks)
    by_scene_key = Counter(scene_key_for_embedding_task(task) for task in tasks)
    by_error_signature = Counter(error_signature_for_message(task.error_message) for task in tasks)
    by_status = Counter(task.status for task in tasks)
    created_values = [task.created_at for task in tasks if task.created_at]
    total = len(tasks)
    return {
        "total_count": total,
        "by_task_name": dict(by_task_name),
        "by_scene_key": dict(by_scene_key),
        "by_error_signature": dict(by_error_signature.most_common(20)),
        "by_status": dict(by_status),
        "oldest_created_at": min(created_values).isoformat() if created_values else None,
        "newest_created_at": max(created_values).isoformat() if created_values else None,
        "sample_ids": [str(task.id) for task in tasks[:20]],
        "recommended_action": (
            "run ops_rag_terminal_failed_resolve with --dry-run=false after confirming ticket/reason"
            if total else "no_action"
        ),
    }


def resolve_rag_terminal_failed(
    *,
    filters: RagTerminalFilters,
    ticket_id: str,
    reason: str,
    dry_run: bool = True,
) -> dict[str, Any]:
    if not ticket_id.strip():
        raise ValueError("ticket_id_required")
    if not reason.strip():
        raise ValueError("reason_required")
    if not filters.error_signature.strip():
        raise ValueError("error_signature_required")
    if filters.created_before is None:
        raise ValueError("created_before_required")

    tasks = _materialize_filtered_tasks(filters)
    now = timezone.now()
    result = {
        "dry_run": dry_run,
        "matched_count": len(tasks),
        "resolved_count": 0,
        "sample_ids": [str(task.id) for task in tasks[:20]],
    }
    if dry_run or not tasks:
        return result

    with transaction.atomic():
        for task in tasks:
            target_id = str(task.id)
            OpsRuntimeResolution.objects.update_or_create(
                source=RAG_RUNTIME_SOURCE,
                target_id=target_id,
                defaults={
                    "target_type": "rag_embedding_task",
                    "status": "archived",
                    "reason": reason,
                    "ticket_id": ticket_id,
                    "resolved_by": "management_command",
                    "resolved_at": now,
                },
            )
            OpsRuntimeActionLog.objects.create(
                action_type="cleanup",
                target_type="rag_embedding_task",
                target_id=target_id,
                source=RAG_RUNTIME_SOURCE,
                queue="rag_indexing",
                task_name=task_name_for_embedding_task(task),
                before_status=task.status,
                after_status="archived",
                ticket_id=ticket_id,
                operator_id="management_command",
                operator_name="manage.py ops_rag_terminal_failed_resolve",
                request_payload_sanitized={
                    "scene_key": filters.scene_key,
                    "task_name": filters.task_name,
                    "error_signature": filters.error_signature,
                    "created_before": filters.created_before.isoformat(),
                    "limit": filters.limit,
                    "reason": reason,
                },
                result="ok",
            )
        result["resolved_count"] = len(tasks)
    return result

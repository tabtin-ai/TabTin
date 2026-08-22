"""Checkpoint composite summary orchestration.

一个 checkpoint 只调度一个 composite 任务。历史 intent / decision 任务名保留为
兼容入口，但都转发到同一个持久化去重执行器。
"""

from __future__ import annotations

from copy import deepcopy
import logging

from celery import shared_task
from django.db import close_old_connections

from apps.services.agent_engine.services.checkpoint_summary_execution import (
    CheckpointSummaryExecutionError,
    execute_checkpoint_summary,
)


logger = logging.getLogger(__name__)


def should_generate_decision_summary(
    checkpoint_context: dict,
    diff_summary: dict | None = None,
) -> bool:
    """保留旧 helper 的兼容语义；PR4 dispatcher 不再用复杂度拆分执行。"""
    impact = checkpoint_context.get("impact") or {}
    files = impact.get("files") or []
    if impact.get("files_total_count", len(files)) >= 3:
        return True

    insertions = int((diff_summary or {}).get("insertions") or 0)
    deletions = int((diff_summary or {}).get("deletions") or 0)
    if not insertions and not deletions:
        for file_change in files:
            if isinstance(file_change, dict):
                insertions += int(file_change.get("insertions") or 0)
                deletions += int(file_change.get("deletions") or 0)
    return insertions + deletions >= 30 or bool(impact.get("resources"))


def _publish_decision_summary_event(
    event_name: str,
    space_checkpoint_id: str,
    anchor_session_id: str,
    anchor_message_id: str,
    decision_summary: dict,
) -> None:
    """Best-effort 推送到 session topic；持久化结果不依赖 WS 成功。"""
    if not anchor_session_id:
        return
    try:
        from apps.services.common.agent_protocol.namespace import (
            session_event_type,
            session_topic,
        )
        from apps.services.common.ws.bus import publish_ws_event
        from apps.services.common.ws.protocol import build_envelope, new_event_id

        envelope = build_envelope(
            session_event_type(event_name),
            new_event_id(),
            {
                "checkpoint_id": space_checkpoint_id,
                "session_id": anchor_session_id,
                "message_id": anchor_message_id or "",
                "decision_summary": decision_summary,
            },
            session_id=anchor_session_id,
        )
        publish_ws_event(session_topic(anchor_session_id), envelope)
    except Exception:
        logger.debug(
            "[CheckpointSummary] WS push failed: cp=%s event=%s",
            space_checkpoint_id[:8],
            event_name,
            exc_info=True,
        )


def _push_decision_summary_ready(
    space_checkpoint_id: str,
    anchor_session_id: str,
    anchor_message_id: str,
    decision_summary: dict,
) -> None:
    _publish_decision_summary_event(
        "decision_summary_ready",
        space_checkpoint_id,
        anchor_session_id,
        anchor_message_id,
        decision_summary,
    )


def _push_decision_summary_failed(
    space_checkpoint_id: str,
    anchor_session_id: str,
    anchor_message_id: str,
    decision_summary: dict,
) -> None:
    _publish_decision_summary_event(
        "decision_summary_failed",
        space_checkpoint_id,
        anchor_session_id,
        anchor_message_id,
        decision_summary,
    )


def _update_decision_status(space_checkpoint_id: str, target_status: str) -> bool:
    """在行锁内只做非终态到 pending/failed 的状态转换。"""
    from django.db import transaction

    from apps.collab.models import SpaceCheckpoint
    from apps.services.common.db_router import postgres_app_db_alias

    database_alias = postgres_app_db_alias()
    with transaction.atomic(using=database_alias):
        checkpoint = (
            SpaceCheckpoint.objects.using(database_alias)
            .select_for_update()
            .filter(id=space_checkpoint_id)
            .first()
        )
        if checkpoint is None:
            return False
        metadata = deepcopy(checkpoint.metadata or {})
        context = metadata.get("checkpoint_context")
        if not isinstance(context, dict):
            return False
        decision_summary = dict(context.get("decision_summary") or {})
        current_status = decision_summary.get("status")
        if current_status in {"ready", "failed"}:
            return False
        if target_status == "pending" and current_status == "pending":
            return False
        decision_summary["status"] = target_status
        context["decision_summary"] = decision_summary
        metadata["checkpoint_context"] = context
        checkpoint.metadata = metadata
        checkpoint.save(using=database_alias, update_fields=["metadata"])

    event_name = f"decision_summary_{target_status}"
    _publish_decision_summary_event(
        event_name,
        space_checkpoint_id,
        str(checkpoint.anchor_session_id or ""),
        str(checkpoint.anchor_message_id or ""),
        decision_summary,
    )
    return True


def _mark_decision_summary_pending(space_checkpoint_id: str) -> bool:
    return _update_decision_status(space_checkpoint_id, "pending")


def _mark_decision_summary_failed(space_checkpoint_id: str) -> bool:
    return _update_decision_status(space_checkpoint_id, "failed")


def _execute_checkpoint_summary_once(space_checkpoint_id: str):
    result = execute_checkpoint_summary(space_checkpoint_id)
    if result.status == "completed" and result.decision_summary is not None:
        _push_decision_summary_ready(
            space_checkpoint_id=result.checkpoint_id,
            anchor_session_id=result.anchor_session_id,
            anchor_message_id=result.anchor_message_id,
            decision_summary=result.decision_summary,
        )
    return result


def _run_checkpoint_summary_task(task, space_checkpoint_id: str):
    close_old_connections()
    try:
        result = _execute_checkpoint_summary_once(space_checkpoint_id)
        if result.status == "in_progress":
            try:
                return task.retry(
                    countdown=max(1, result.retry_after_seconds),
                )
            except task.MaxRetriesExceededError:
                return result
        return result
    except CheckpointSummaryExecutionError as exc:
        logger.warning(
            "[CheckpointSummary] execution failed: cp=%s code=%s",
            space_checkpoint_id,
            exc.error_code,
            exc_info=True,
        )
        try:
            raise task.retry(exc=exc)
        except task.MaxRetriesExceededError:
            _mark_decision_summary_failed(space_checkpoint_id)
            return None
    finally:
        close_old_connections()


_COMPOSITE_TASK_OPTIONS = {
    "bind": True,
    "ignore_result": True,
    "time_limit": 30,
    "soft_time_limit": 25,
    "max_retries": 2,
    "default_retry_delay": 5,
}


@shared_task(**_COMPOSITE_TASK_OPTIONS)
def generate_checkpoint_summary(self, space_checkpoint_id: str):
    """PR4 主入口：执行一次 composite checkpoint summary。"""
    return _run_checkpoint_summary_task(self, space_checkpoint_id)


@shared_task(**_COMPOSITE_TASK_OPTIONS)
def generate_checkpoint_intent_summary(self, space_checkpoint_id: str):
    """历史兼容入口；不再单独调用 intent scene。"""
    return _run_checkpoint_summary_task(self, space_checkpoint_id)


@shared_task(**_COMPOSITE_TASK_OPTIONS)
def generate_checkpoint_decision_summary(self, space_checkpoint_id: str):
    """历史兼容入口；不再单独调用 decision scene。"""
    return _run_checkpoint_summary_task(self, space_checkpoint_id)


def maybe_dispatch_checkpoint_summaries(
    cp_id: str,
    checkpoint_context: dict | None,
    diff_summary: dict | None = None,
    log_prefix: str = "",
) -> None:
    """一个 checkpoint 只派发一个 composite orchestration task。"""
    del diff_summary  # 兼容旧调用签名；PR4 对所有有效 checkpoint 统一生成。
    if not checkpoint_context or not str(
        checkpoint_context.get("user_prompt") or ""
    ).strip():
        return

    try:
        _mark_decision_summary_pending(cp_id)
    except Exception:
        logger.debug(
            "%sFailed to mark checkpoint summary as pending",
            log_prefix,
            exc_info=True,
        )

    try:
        generate_checkpoint_summary.apply_async(
            args=[cp_id],
            task_id=f"checkpoint-summary-{cp_id}",
            countdown=2,
        )
    except Exception:
        logger.debug(
            "%sFailed to dispatch checkpoint composite summary task",
            log_prefix,
            exc_info=True,
        )


__all__ = [
    "generate_checkpoint_decision_summary",
    "generate_checkpoint_intent_summary",
    "generate_checkpoint_summary",
    "maybe_dispatch_checkpoint_summaries",
    "should_generate_decision_summary",
]

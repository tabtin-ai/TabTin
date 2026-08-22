"""Checkpoint composite AI execution with durable business dedup."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
import json
from dataclasses import dataclass
from typing import Any, Callable


EXECUTION_KEY = "checkpoint_summary"
EXECUTION_VERSION = "v1"
CANONICAL_SCENE_KEY = "checkpoint_decision_summary"


class CheckpointSummaryExecutionError(Exception):
    def __init__(self, error_code: str, message: str):
        super().__init__(message)
        self.error_code = error_code


@dataclass(frozen=True)
class CheckpointSummaryClaim:
    status: str
    checkpoint_id: str
    invocation_id: str
    organization_id: str = ""
    user_id: str = ""
    checkpoint_context: dict[str, Any] | None = None
    agent_run_id: str = ""
    ambiguous_previous_attempt: bool = False
    retry_after_seconds: int = 0


@dataclass(frozen=True)
class CompositeCheckpointSummary:
    intent_summary: str
    decision_summary: dict[str, Any]
    unresolved_items: tuple[str, ...]


@dataclass(frozen=True)
class CheckpointSummaryExecutionResult:
    status: str
    checkpoint_id: str
    invocation_id: str
    decision_summary: dict[str, Any] | None = None
    anchor_session_id: str = ""
    anchor_message_id: str = ""


def build_checkpoint_summary_invocation_id(checkpoint_id: str) -> str:
    normalized_id = str(checkpoint_id or "").strip()
    if not normalized_id:
        raise ValueError("checkpoint_id 不能为空")
    return f"checkpoint:{normalized_id}:summary:{EXECUTION_VERSION}"


def parse_composite_checkpoint_summary(content: str) -> CompositeCheckpointSummary:
    try:
        payload = json.loads(str(content or ""))
    except (TypeError, json.JSONDecodeError) as exc:
        raise CheckpointSummaryExecutionError(
            "CHECKPOINT_SUMMARY_INVALID_RESULT",
            "Checkpoint composite 结果不是合法 JSON",
        ) from exc

    if not isinstance(payload, dict):
        raise CheckpointSummaryExecutionError(
            "CHECKPOINT_SUMMARY_INVALID_RESULT",
            "Checkpoint composite 结果必须是对象",
        )

    intent_summary = payload.get("intent_summary")
    decision_summary = payload.get("decision_summary")
    unresolved_items = payload.get("unresolved_items")
    if not isinstance(intent_summary, str) or not intent_summary.strip():
        raise CheckpointSummaryExecutionError(
            "CHECKPOINT_SUMMARY_INVALID_RESULT",
            "Checkpoint composite 缺少 intent_summary",
        )
    if not isinstance(decision_summary, dict):
        raise CheckpointSummaryExecutionError(
            "CHECKPOINT_SUMMARY_INVALID_RESULT",
            "Checkpoint composite 缺少 decision_summary",
        )
    outcome = decision_summary.get("outcome")
    key_decisions = decision_summary.get("key_decisions")
    if not isinstance(outcome, str) or not outcome.strip():
        raise CheckpointSummaryExecutionError(
            "CHECKPOINT_SUMMARY_INVALID_RESULT",
            "Checkpoint decision_summary 缺少 outcome",
        )
    if not isinstance(key_decisions, list) or any(
        not isinstance(item, str) for item in key_decisions
    ):
        raise CheckpointSummaryExecutionError(
            "CHECKPOINT_SUMMARY_INVALID_RESULT",
            "Checkpoint decision_summary.key_decisions 必须是字符串数组",
        )
    if not isinstance(unresolved_items, list) or any(
        not isinstance(item, str) for item in unresolved_items
    ):
        raise CheckpointSummaryExecutionError(
            "CHECKPOINT_SUMMARY_INVALID_RESULT",
            "Checkpoint unresolved_items 必须是字符串数组",
        )

    normalized_decision = {
        "outcome": outcome.strip()[:100],
        "key_decisions": [item.strip()[:100] for item in key_decisions[:5] if item.strip()],
    }
    return CompositeCheckpointSummary(
        intent_summary=intent_summary.strip()[:50],
        decision_summary=normalized_decision,
        unresolved_items=tuple(
            item.strip()[:100] for item in unresolved_items[:5] if item.strip()
        ),
    )


def _build_prompt_variables(checkpoint_context: dict[str, Any]) -> dict[str, Any]:
    impact = checkpoint_context.get("impact") or {}
    decision_summary = checkpoint_context.get("decision_summary") or {}
    return {
        "user_prompt": str(checkpoint_context.get("user_prompt") or "")[:300],
        "files": list(impact.get("files") or [])[:20],
        "resources": list(impact.get("resources") or [])[:10],
        "basic_outcome": str(decision_summary.get("outcome") or "")[:100],
    }


def execute_checkpoint_summary(
    checkpoint_id: str,
    *,
    store=None,
    llm_call: Callable[..., Any] | None = None,
):
    """Claim one checkpoint execution, invoke one composite LLM, then persist once."""
    if store is None:
        store = DjangoCheckpointSummaryStore()
    claim = store.claim(checkpoint_id)
    if claim.status != "claimed":
        return claim

    if llm_call is None:
        from apps.services.llm.services.chat import unified_llm_call

        llm_call = unified_llm_call

    from apps.services.llm.services._runtime.invocation import SceneInvocationContext

    invocation = SceneInvocationContext.stable(
        invocation_id=claim.invocation_id,
        scene_key=CANONICAL_SCENE_KEY,
        execution_key=EXECUTION_KEY,
        organization_id=claim.organization_id,
        user_id=claim.user_id,
        business_object_type="space_checkpoint",
        business_object_id=claim.checkpoint_id,
        run_id=claim.agent_run_id,
        retry_source=(
            "ambiguous_provider_attempt" if claim.ambiguous_previous_attempt else ""
        ),
    )
    try:
        llm_result = llm_call(
            scene_key=CANONICAL_SCENE_KEY,
            variables=_build_prompt_variables(claim.checkpoint_context or {}),
            user_id=claim.user_id,
            organization_id=claim.organization_id,
            invocation_context=invocation,
            result_validator=parse_composite_checkpoint_summary,
        )
        summary = parse_composite_checkpoint_summary(llm_result.content)
    except CheckpointSummaryExecutionError as exc:
        store.fail(checkpoint_id, claim.invocation_id, exc.error_code)
        raise
    except Exception as exc:
        error = CheckpointSummaryExecutionError(
            "CHECKPOINT_SUMMARY_PROVIDER_FAILED",
            f"Checkpoint composite Provider 调用失败: {type(exc).__name__}",
        )
        store.fail(checkpoint_id, claim.invocation_id, error.error_code)
        raise error from exc

    try:
        return store.complete(
            checkpoint_id,
            claim.invocation_id,
            summary=summary,
        )
    except Exception as exc:
        error = CheckpointSummaryExecutionError(
            "CHECKPOINT_SUMMARY_PERSIST_FAILED",
            f"Checkpoint composite 持久化失败: {type(exc).__name__}",
        )
        try:
            store.fail(checkpoint_id, claim.invocation_id, error.error_code)
        except Exception:
            pass
        raise error from exc


class DjangoCheckpointSummaryStore:
    """SpaceCheckpoint metadata adapter with row-lock claim and atomic completion."""

    RUNNING_LEASE = timedelta(minutes=5)

    def __init__(self, *, now_provider: Callable[[], datetime] | None = None):
        if now_provider is None:
            from django.utils import timezone

            now_provider = timezone.now
        self._now = now_provider

    @staticmethod
    def _database_alias() -> str:
        from apps.services.common.db_router import postgres_app_db_alias

        return postgres_app_db_alias()

    @staticmethod
    def _locked_checkpoint(checkpoint_id: str, database_alias: str):
        from apps.collab.models import SpaceCheckpoint

        return (
            SpaceCheckpoint.objects.using(database_alias)
            .select_for_update()
            .filter(id=checkpoint_id)
            .first()
        )

    @staticmethod
    def _execution_state(checkpoint_context: dict[str, Any]) -> dict[str, Any]:
        state = checkpoint_context.get("summary_execution")
        return dict(state) if isinstance(state, dict) else {}

    @staticmethod
    def _is_legacy_completed(checkpoint_context: dict[str, Any]) -> bool:
        decision_summary = checkpoint_context.get("decision_summary") or {}
        return bool(
            checkpoint_context.get("intent_summary")
            and isinstance(decision_summary, dict)
            and decision_summary.get("status") == "ready"
        )

    def _running_retry_after(self, state: dict[str, Any], now: datetime) -> int:
        started_at = state.get("started_at")
        if not isinstance(started_at, str):
            return 0
        try:
            started = datetime.fromisoformat(started_at)
            if started.tzinfo is None and now.tzinfo is not None:
                started = started.replace(tzinfo=now.tzinfo)
            remaining = self.RUNNING_LEASE - (now - started)
            if remaining.total_seconds() <= 0:
                return 0
            return max(1, int(remaining.total_seconds()) + 1)
        except (TypeError, ValueError):
            return 0

    def claim(self, checkpoint_id: str) -> CheckpointSummaryClaim:
        from django.db import transaction

        database_alias = self._database_alias()
        invocation_id = build_checkpoint_summary_invocation_id(checkpoint_id)
        now = self._now()
        with transaction.atomic(using=database_alias):
            checkpoint = self._locked_checkpoint(checkpoint_id, database_alias)
            if checkpoint is None:
                return CheckpointSummaryClaim(
                    status="missing",
                    checkpoint_id=str(checkpoint_id),
                    invocation_id=invocation_id,
                )

            metadata = deepcopy(checkpoint.metadata or {})
            checkpoint_context = metadata.get("checkpoint_context")
            if not isinstance(checkpoint_context, dict) or not str(
                checkpoint_context.get("user_prompt") or ""
            ).strip():
                return CheckpointSummaryClaim(
                    status="skipped",
                    checkpoint_id=str(checkpoint_id),
                    invocation_id=invocation_id,
                )

            organization_id = str(checkpoint.organization_id or "")
            user_id = (
                str(checkpoint.editor_id or "")
                if checkpoint.editor_type == "user"
                else ""
            )
            if not organization_id or not user_id:
                return CheckpointSummaryClaim(
                    status="skipped",
                    checkpoint_id=str(checkpoint_id),
                    invocation_id=invocation_id,
                )

            state = self._execution_state(checkpoint_context)
            if state.get("status") == "completed" or self._is_legacy_completed(
                checkpoint_context
            ):
                if state.get("status") != "completed":
                    state.update(
                        {
                            "invocation_id": invocation_id,
                            "execution_key": EXECUTION_KEY,
                            "version": EXECUTION_VERSION,
                            "status": "completed",
                            "completed_at": now.isoformat(),
                        }
                    )
                    checkpoint_context["summary_execution"] = state
                    metadata["checkpoint_context"] = checkpoint_context
                    checkpoint.metadata = metadata
                    checkpoint.save(using=database_alias, update_fields=["metadata"])
                return CheckpointSummaryClaim(
                    status="completed",
                    checkpoint_id=str(checkpoint_id),
                    invocation_id=invocation_id,
                )

            previous_was_running = state.get("status") == "running"
            ambiguous_previous_attempt = previous_was_running or (
                state.get("status") == "failed"
                and state.get("error_code") == "CHECKPOINT_SUMMARY_PERSIST_FAILED"
            )
            retry_after_seconds = self._running_retry_after(state, now)
            if previous_was_running and retry_after_seconds:
                return CheckpointSummaryClaim(
                    status="in_progress",
                    checkpoint_id=str(checkpoint_id),
                    invocation_id=invocation_id,
                    retry_after_seconds=retry_after_seconds,
                )

            attempt_count = int(state.get("attempt_count") or 0) + 1
            state.update(
                {
                    "invocation_id": invocation_id,
                    "execution_key": EXECUTION_KEY,
                    "version": EXECUTION_VERSION,
                    "status": "running",
                    "started_at": now.isoformat(),
                    "attempt_count": attempt_count,
                    "ambiguous_previous_attempt": ambiguous_previous_attempt,
                }
            )
            state.pop("failed_at", None)
            state.pop("error_code", None)
            checkpoint_context["summary_execution"] = state
            metadata["checkpoint_context"] = checkpoint_context
            checkpoint.metadata = metadata
            checkpoint.save(using=database_alias, update_fields=["metadata"])

        return CheckpointSummaryClaim(
            status="claimed",
            checkpoint_id=str(checkpoint_id),
            invocation_id=invocation_id,
            organization_id=organization_id,
            user_id=user_id,
            checkpoint_context=deepcopy(checkpoint_context),
            agent_run_id=str(checkpoint.agent_run_id or ""),
            ambiguous_previous_attempt=ambiguous_previous_attempt,
        )

    def complete(self, checkpoint_id: str, invocation_id: str, *, summary):
        from django.db import transaction

        database_alias = self._database_alias()
        now = self._now()
        with transaction.atomic(using=database_alias):
            checkpoint = self._locked_checkpoint(checkpoint_id, database_alias)
            if checkpoint is None:
                raise CheckpointSummaryExecutionError(
                    "CHECKPOINT_SUMMARY_PERSIST_FAILED",
                    "Checkpoint 不存在",
                )
            metadata = deepcopy(checkpoint.metadata or {})
            checkpoint_context = metadata.get("checkpoint_context")
            if not isinstance(checkpoint_context, dict):
                raise CheckpointSummaryExecutionError(
                    "CHECKPOINT_SUMMARY_PERSIST_FAILED",
                    "Checkpoint context 不存在",
                )
            state = self._execution_state(checkpoint_context)
            if state.get("status") == "completed":
                return CheckpointSummaryExecutionResult(
                    status="completed",
                    checkpoint_id=str(checkpoint_id),
                    invocation_id=invocation_id,
                    decision_summary=checkpoint_context.get("decision_summary"),
                    anchor_session_id=str(checkpoint.anchor_session_id or ""),
                    anchor_message_id=str(checkpoint.anchor_message_id or ""),
                )
            if state.get("invocation_id") != invocation_id:
                raise CheckpointSummaryExecutionError(
                    "CHECKPOINT_SUMMARY_PERSIST_FAILED",
                    "Checkpoint invocation identity 不一致",
                )

            decision_summary = dict(checkpoint_context.get("decision_summary") or {})
            decision_summary.update(summary.decision_summary)
            decision_summary["intent"] = summary.intent_summary
            decision_summary["open_items"] = list(summary.unresolved_items)
            decision_summary["status"] = "ready"
            checkpoint_context["intent_summary"] = summary.intent_summary
            checkpoint_context["decision_summary"] = decision_summary
            checkpoint_context["unresolved_items"] = list(summary.unresolved_items)
            state.update(
                {
                    "status": "completed",
                    "completed_at": now.isoformat(),
                    "ambiguous_previous_attempt": bool(
                        state.get("ambiguous_previous_attempt")
                    ),
                }
            )
            state.pop("failed_at", None)
            state.pop("error_code", None)
            checkpoint_context["summary_execution"] = state
            metadata["checkpoint_context"] = checkpoint_context
            checkpoint.metadata = metadata
            checkpoint.save(using=database_alias, update_fields=["metadata"])

        return CheckpointSummaryExecutionResult(
            status="completed",
            checkpoint_id=str(checkpoint_id),
            invocation_id=invocation_id,
            decision_summary=decision_summary,
            anchor_session_id=str(checkpoint.anchor_session_id or ""),
            anchor_message_id=str(checkpoint.anchor_message_id or ""),
        )

    def fail(self, checkpoint_id: str, invocation_id: str, error_code: str) -> None:
        from django.db import transaction

        database_alias = self._database_alias()
        now = self._now()
        with transaction.atomic(using=database_alias):
            checkpoint = self._locked_checkpoint(checkpoint_id, database_alias)
            if checkpoint is None:
                return
            metadata = deepcopy(checkpoint.metadata or {})
            checkpoint_context = metadata.get("checkpoint_context")
            if not isinstance(checkpoint_context, dict):
                return
            state = self._execution_state(checkpoint_context)
            if state.get("status") == "completed":
                return
            if state.get("invocation_id") not in {None, "", invocation_id}:
                return
            state.update(
                {
                    "invocation_id": invocation_id,
                    "execution_key": EXECUTION_KEY,
                    "version": EXECUTION_VERSION,
                    "status": "failed",
                    "failed_at": now.isoformat(),
                    "error_code": str(error_code or ""),
                }
            )
            checkpoint_context["summary_execution"] = state
            metadata["checkpoint_context"] = checkpoint_context
            checkpoint.metadata = metadata
            checkpoint.save(using=database_alias, update_fields=["metadata"])


__all__ = [
    "CANONICAL_SCENE_KEY",
    "EXECUTION_KEY",
    "CheckpointSummaryClaim",
    "CheckpointSummaryExecutionError",
    "CheckpointSummaryExecutionResult",
    "CompositeCheckpointSummary",
    "DjangoCheckpointSummaryStore",
    "build_checkpoint_summary_invocation_id",
    "execute_checkpoint_summary",
    "parse_composite_checkpoint_summary",
]

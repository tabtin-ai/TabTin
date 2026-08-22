"""
RunService - 统一管理 Agent Run 生命周期。
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Dict, Optional

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from apps.chat.conversation.models import ChatSession
from apps.services.common.agent_protocol.constants import AgentStreamEvent
from apps.services.agent_engine.legacy_env import agent_engine_setting
from apps.services.agent_engine.models import ExecutionRun, SessionRunProjection
from apps.services.common.agent_protocol.namespace import redis_key, run_event_type, stream_event_type, stream_topic
from apps.services.common.db_router import postgres_app_db_alias
from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

_redis_circuit_open_until: float = 0.0
_REDIS_CIRCUIT_BREAKER_SECONDS = 30.0


class RunService:
    """Run 生命周期管理服务。"""

    @staticmethod
    def _cancel_key(run_id: str) -> str:
        return redis_key(["run", "cancel", run_id])

    @staticmethod
    def _get_cancel_ttl_seconds() -> int:
        return int(agent_engine_setting("AGENT_ENGINE_RUN_CANCEL_TTL_SECONDS", 3600))

    @staticmethod
    def _get_redis_client():
        try:
            from apps.services.agent_engine.services.frontend_action_service import get_frontend_action_service

            return get_frontend_action_service().redis_client
        except Exception as exc:
            logger.warning("[RunService] Redis acquisition failed: %s", exc)
            return None

    @staticmethod
    def start_run(
        *,
        run_id: str,
        thread_id: str,
        graph_type: str,
        trace_id: Optional[str] = None,
        session_id: Optional[str] = None,
        instance_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        user_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[ExecutionRun]:
        if not run_id or not thread_id:
            return None
        if not agent_engine_setting("AGENT_ENGINE_RUNS_ENABLED", True):
            return None
        try:
            uuid.UUID(str(run_id))
        except (ValueError, TypeError):
            logger.warning("[RunService] Invalid run_id: %s", run_id)
            return None

        run = ExecutionRun.objects.filter(run_id=run_id).first()
        if run:
            updated_fields = []
            if run.status != "running":
                run.status = "running"
                updated_fields.append("status")
            if trace_id and run.trace_id != trace_id:
                run.trace_id = trace_id
                updated_fields.append("trace_id")
            if metadata:
                run.metadata = {**(run.metadata or {}), **metadata}
                updated_fields.append("metadata")
            if updated_fields:
                run.save(update_fields=list(set(updated_fields)) + ["updated_at"])
            RunService._publish_run_event("start", run)
            return run

        with transaction.atomic():
            # 会话行是 sequence 分配锁；同一会话并发 start 不再同时读到相同 Max。
            # 无 session 的旧式 run 不受 (session_id, sequence) 唯一约束影响。
            if session_id:
                ChatSession.objects.select_for_update().filter(pk=session_id).only("pk").first()
            next_sequence = (
                ExecutionRun.objects.filter(session_id=session_id)
                .aggregate(value=Max("sequence"))["value"]
                or 0
            ) + 1
            run = ExecutionRun.objects.create(
                run_id=run_id,
                thread_id=thread_id,
                graph_type=graph_type,
                session_id=session_id,
                instance_id=instance_id,
                organization_id=organization_id,
                user_id=user_id,
                trace_id=trace_id,
                status="running",
                sequence=next_sequence,
                started_at=timezone.now(),
                metadata=metadata or {},
            )
        RunService._publish_run_event("start", run)
        return run

    @staticmethod
    def end_run(run_id: str, *, status: str, error: Optional[str] = None) -> Optional[ExecutionRun]:
        if not run_id:
            return None
        if not agent_engine_setting("AGENT_ENGINE_RUNS_ENABLED", True):
            return None

        with transaction.atomic(using=postgres_app_db_alias()):
            run = ExecutionRun.objects.select_for_update().filter(run_id=run_id).first()
            if not run:
                return None

            if status == "error":
                status = "failed"
            if run.status == "cancelling" and status in ("completed", "failed"):
                status = "cancelled"
            run.status = status
            run.error = error
            run.ended_at = timezone.now()
            run.save(update_fields=["status", "error", "ended_at", "updated_at"])
        RunService.clear_cancelled(run_id)

        event_name = "error" if status == "failed" else "end"
        RunService._publish_run_event(event_name, run)
        return run

    @staticmethod
    def request_cancel(run_id: str, *, reason: Optional[str] = None) -> Optional[ExecutionRun]:
        if not run_id:
            return None
        if not agent_engine_setting("AGENT_ENGINE_RUNS_ENABLED", True):
            return None
        try:
            uuid.UUID(str(run_id))
        except (ValueError, TypeError):
            logger.warning("[RunService] Invalid run_id: %s", run_id)
            return None

        client = RunService._get_redis_client()
        if client is not None:
            try:
                ttl = RunService._get_cancel_ttl_seconds()
                client.set(RunService._cancel_key(run_id), "1", ex=ttl)
            except Exception as exc:
                logger.warning("[RunService] Cancel marker write failed: %s", exc)

        with transaction.atomic(using=postgres_app_db_alias()):
            run = ExecutionRun.objects.select_for_update().filter(run_id=run_id).first()
            if not run:
                return None

            metadata = dict(run.metadata or {})

            if metadata.get("cancel_requested") and run.status != "running":
                return run

            metadata["cancel_requested"] = True
            metadata["cancel_requested_at"] = timezone.now().isoformat()
            if reason:
                metadata["cancel_reason"] = reason
            if run.status == "running":
                run.status = "cancelling"
            run.metadata = metadata
            run.save(update_fields=["status", "metadata", "updated_at"])
        RunService._publish_run_event("cancelling", run)
        return run

    @staticmethod
    def is_run_cancelled(run_id: Optional[str]) -> bool:
        global _redis_circuit_open_until
        if not run_id:
            return False
        if not agent_engine_setting("AGENT_ENGINE_RUNS_ENABLED", True):
            return False

        if time.monotonic() < _redis_circuit_open_until:
            return RunService._db_cancel_check(run_id)

        client = RunService._get_redis_client()
        if client is not None:
            try:
                if client.exists(RunService._cancel_key(run_id)):
                    return True
                return RunService._db_cancel_check(run_id)
            except Exception:
                _redis_circuit_open_until = time.monotonic() + _REDIS_CIRCUIT_BREAKER_SECONDS

        return RunService._db_cancel_check(run_id)

    @staticmethod
    def _db_cancel_check(run_id: str) -> bool:
        """DB fallback：检查 Run 状态是否为 cancelling/cancelled。"""
        try:
            status = ExecutionRun.objects.filter(run_id=run_id).values_list("status", flat=True).first()
            return status in ("cancelling", "cancelled")
        except Exception:
            return False

    @staticmethod
    def clear_cancelled(run_id: Optional[str]) -> None:
        if not run_id:
            return
        client = RunService._get_redis_client()
        if client is None:
            return
        try:
            client.delete(RunService._cancel_key(run_id))
        except Exception as exc:
            logger.warning("[RunService] Cancel marker cleanup failed: %s", exc)

    @staticmethod
    def get_latest_run(thread_id: str) -> Optional[ExecutionRun]:
        if not thread_id:
            return None
        session_id = thread_id
        if session_id.startswith("chat-session-"):
            session_id = session_id[len("chat-session-") :]
        try:
            normalized_session_id = uuid.UUID(session_id)
        except (TypeError, ValueError):
            normalized_session_id = None
        if normalized_session_id is not None:
            projection = (
                SessionRunProjection.objects.select_related("current_run")
                .filter(session_id=normalized_session_id)
                .first()
            )
            if projection is not None:
                return projection.current_run
        return (
            ExecutionRun.objects.filter(thread_id=thread_id)
            .order_by("-sequence", "-state_changed_at")
            .first()
        )

    @staticmethod
    def _publish_run_event(event_name: str, run: ExecutionRun) -> None:
        if not agent_engine_setting("AGENT_ENGINE_RUN_EVENTS_ENABLED", True):
            return
        try:
            payload = {
                "run_id": str(run.run_id),
                "thread_id": run.thread_id,
                "trace_id": str(run.trace_id) if run.trace_id else None,
                "status": run.status,
                "graph_type": run.graph_type,
                "session_id": run.session_id,
                "organization_id": run.organization_id,
                "user_id": run.user_id,
                "started_at": run.started_at.isoformat() if run.started_at else None,
                "ended_at": run.ended_at.isoformat() if run.ended_at else None,
                "error": run.error,
            }
            event_id = new_event_id()
            envelope = build_envelope(
                run_event_type(event_name),
                event_id,
                payload,
                event_id=event_id,
                thread_id=run.thread_id,
                trace_id=str(run.trace_id) if run.trace_id else None,
                session_id=run.session_id,
                organization_id=run.organization_id,
            )
            publish_ws_event(stream_topic(run.thread_id), envelope)

            phase = "start"
            if event_name == "error":
                phase = "error"
            elif event_name == "end":
                phase = "end"
            elif event_name == "cancelling":
                phase = "cancelling"
            lifecycle_payload = {
                "phase": phase,
                **payload,
            }
            lifecycle_event_id = new_event_id()
            lifecycle_envelope = build_envelope(
                stream_event_type(AgentStreamEvent.LIFECYCLE),
                lifecycle_event_id,
                lifecycle_payload,
                event_id=lifecycle_event_id,
                thread_id=run.thread_id,
                trace_id=str(run.trace_id) if run.trace_id else None,
                session_id=run.session_id,
                organization_id=run.organization_id,
            )
            publish_ws_event(stream_topic(run.thread_id), lifecycle_envelope)
        except Exception as exc:
            logger.warning("[RunService] Run event publish failed: %s", exc)


__all__ = ["RunService"]

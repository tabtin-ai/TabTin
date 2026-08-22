"""ChatSession 执行态事实与当前投影。

状态只由 dispatch / runtime 生命周期事件推进。消息角色和时间戳只在没有投影的
历史会话上作为兼容回退，不能反向写入这里。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from django.conf import settings
from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from apps.chat.conversation.models import ChatSession
from apps.services.agent_engine.models import ExecutionRun, SessionRunProjection
from apps.services.common.ws.bus import publish_to_user
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = frozenset(
    {
        ExecutionRun.Status.QUEUED,
        ExecutionRun.Status.RUNNING,
        ExecutionRun.Status.WAITING_USER,
        ExecutionRun.Status.PAUSED,
        ExecutionRun.Status.CANCELLING,
    }
)
TERMINAL_STATUSES = frozenset(
    {
        ExecutionRun.Status.COMPLETED,
        ExecutionRun.Status.FAILED,
        ExecutionRun.Status.CANCELLED,
        ExecutionRun.Status.INTERRUPTED,
    }
)
RUN_STATE_EVENT = "chat.session.run_state.updated"


def serialize_run_state(projection: SessionRunProjection | None) -> dict[str, Any] | None:
    if projection is None:
        return None
    status = projection.status
    if status == ExecutionRun.Status.FAILED and (
        projection.error_class == "ABORT" or projection.stop_reason == "aborted"
    ):
        status = ExecutionRun.Status.INTERRUPTED
    return {
        "run_id": str(projection.current_run_id),
        "sequence": projection.sequence,
        "revision": projection.revision,
        "status": status,
        "queue_depth": projection.queue_depth,
        "started_at": projection.started_at.isoformat() if projection.started_at else None,
        "state_changed_at": projection.state_changed_at.isoformat(),
        "ended_at": projection.ended_at.isoformat() if projection.ended_at else None,
        "stop_reason": projection.stop_reason,
        "error_class": projection.error_class,
        "waiting_interaction_id": (
            str(projection.waiting_interaction_id)
            if projection.waiting_interaction_id
            else None
        ),
    }


class SessionRunStateService:
    """在同一事务中维护 run 事实和 session 当前投影。"""

    @staticmethod
    def _normalize_session_id(thread_id: str | None) -> str | None:
        if not thread_id:
            return None
        candidate = (
            thread_id[len("chat-session-") :]
            if thread_id.startswith("chat-session-")
            else thread_id
        )
        try:
            return str(uuid.UUID(candidate))
        except (TypeError, ValueError):
            return None

    @classmethod
    def get_current_run(cls, thread_id: str) -> ExecutionRun | None:
        """Return the durable current run for bounded legacy event attribution."""
        session_id = cls._normalize_session_id(thread_id)
        if session_id is None:
            return None
        projection = (
            SessionRunProjection.objects
            .select_related("current_run")
            .filter(session_id=session_id)
            .only(
                "current_run__run_id",
                "current_run__session_id",
                "current_run__user_id",
                "current_run__metadata",
            )
            .first()
        )
        return projection.current_run if projection is not None else None

    @classmethod
    def has_terminal_state(
        cls,
        *,
        run_id: str,
        expected_thread_id: str,
    ) -> bool:
        """确认指定会话的 run 已有服务端终态事实。

        relay 重投同一 DONE 时，``event_revision`` 可能已被消费，
        ``transition`` 会返回空。此时只能按 run + session 双重边界
        确认既有终态，不能仅按 run_id 放行。
        """
        session_id = cls._normalize_session_id(expected_thread_id)
        try:
            normalized_run_id = uuid.UUID(str(run_id))
        except (TypeError, ValueError):
            return False
        if session_id is None:
            return False
        return ExecutionRun.objects.filter(
            run_id=normalized_run_id,
            session_id=session_id,
            status__in=TERMINAL_STATUSES,
        ).exists()

    @classmethod
    def accept_dispatch(
        cls,
        *,
        thread_id: str,
        run_id: str,
        task_id: str,
        execution_owner_user_id: str | None = None,
        target_device_installation_id: str | None = None,
    ) -> ExecutionRun | None:
        session_id = cls._normalize_session_id(thread_id)
        if not session_id:
            return None
        try:
            normalized_run_id = uuid.UUID(str(run_id))
        except (TypeError, ValueError):
            return None

        with transaction.atomic():
            session = (
                ChatSession.objects.select_for_update()
                .filter(id=session_id)
                .only("id", "user_id", "organization_id")
                .first()
            )
            if session is None:
                return None
            existing = (
                ExecutionRun.objects.select_for_update()
                .filter(run_id=normalized_run_id)
                .first()
            )
            if existing is not None:
                return existing if str(existing.session_id) == session_id else None

            last_sequence = (
                ExecutionRun.objects.filter(session_id=session_id)
                .aggregate(value=Max("sequence"))["value"]
                or 0
            )
            now = timezone.now()
            run_metadata = {"task_id": task_id}
            exact_target = str(target_device_installation_id or "").strip()
            if exact_target:
                run_metadata["target_device_installation_id"] = exact_target
            run = ExecutionRun.objects.create(
                run_id=normalized_run_id,
                thread_id=thread_id,
                graph_type="chat",
                session_id=session_id,
                organization_id=str(session.organization_id),
                user_id=str(execution_owner_user_id or session.user_id),
                sequence=last_sequence + 1,
                revision=0,
                status=ExecutionRun.Status.QUEUED,
                state_changed_at=now,
                metadata=run_metadata,
            )

            projection = (
                SessionRunProjection.objects.select_for_update()
                .filter(session_id=session_id)
                .first()
            )
            if projection is not None and projection.status in ACTIVE_STATUSES:
                projection.queue_depth += 1
                projection.revision += 1
                projection.state_changed_at = now
                projection.save(
                    update_fields=[
                        "queue_depth",
                        "revision",
                        "state_changed_at",
                        "updated_at",
                    ]
                )
            else:
                projection, _ = SessionRunProjection.objects.update_or_create(
                    session_id=session_id,
                    defaults={
                        "current_run": run,
                        "sequence": run.sequence,
                        # revision 只在当前 run 内单调；切换 sequence 后从首版开始。
                        "revision": 1,
                        "status": run.status,
                        "queue_depth": 0,
                        "started_at": None,
                        "state_changed_at": now,
                        "ended_at": None,
                        "stop_reason": None,
                        "error_class": None,
                        "waiting_interaction_id": None,
                    },
                )
            cls._publish_on_commit(session, projection)
            return run

    @classmethod
    def accept_local_dispatch(
        cls,
        *,
        thread_id: str,
        run_id: str,
        task_id: str,
        user_id: str,
        organization_id: str | None = None,
        runtime_source_prevalidated: bool = False,
    ) -> ExecutionRun | None:
        """登记 Electron 本机 IPC 已接受的轮次。

        本机执行不经过 ``PromptForwardService``，但跨设备任务列表仍必须读取同一份
        ``ExecutionRun`` / ``SessionRunProjection``。这里先校验会话归属，再复用
        ``accept_dispatch`` 的幂等事务；relay lifecycle 仍只是推进事实，不能创建事实。
        """
        session_id = cls._normalize_session_id(thread_id)
        if not session_id:
            return None
        session_query = ChatSession.objects.filter(id=session_id)
        if organization_id:
            session_query = session_query.filter(organization_id=organization_id)
        session = session_query.only(
            "user_id",
            "project_id",
            "organization_id",
        ).first()
        if session is None:
            return None
        if str(session.user_id) != str(user_id):
            try:
                normalized_run_id = uuid.UUID(str(run_id))
            except (TypeError, ValueError):
                return None
            if not ExecutionRun.objects.filter(
                run_id=normalized_run_id,
                session_id=session_id,
                user_id=str(user_id),
            ).exists():
                from apps.services.daemon_control.feature import (
                    daemon_control_enabled_for_organization,
                )

                if not (
                    runtime_source_prevalidated
                    and session.project_id is not None
                    and not daemon_control_enabled_for_organization(
                        user_id=str(user_id),
                        organization_id=str(session.organization_id),
                    )
                ):
                    return None
        return cls.accept_dispatch(
            thread_id=thread_id,
            run_id=run_id,
            task_id=task_id,
            execution_owner_user_id=(
                str(user_id)
                if runtime_source_prevalidated and session.project_id is not None
                else None
            ),
        )

    @classmethod
    def transition(
        cls,
        *,
        run_id: str,
        status: str,
        sequence: int | None = None,
        event_revision: int | None = None,
        expected_thread_id: str | None = None,
        stop_reason: str | None = None,
        error_class: str | None = None,
        error: str | None = None,
        waiting_interaction_id: str | None = None,
        allowed_from: frozenset[str] | None = None,
    ) -> SessionRunProjection | None:
        if status not in ExecutionRun.Status.values:
            raise ValueError(f"unsupported run status: {status}")
        try:
            normalized_run_id = uuid.UUID(str(run_id))
        except (TypeError, ValueError):
            return None
        run_query = ExecutionRun.objects.filter(run_id=normalized_run_id)
        if expected_thread_id is not None:
            expected_session_id = cls._normalize_session_id(expected_thread_id)
            if expected_session_id is None:
                return None
            run_query = run_query.filter(session_id=expected_session_id)
        session_id = (
            run_query
            .values_list("session_id", flat=True)
            .first()
        )
        if not session_id:
            return None

        with transaction.atomic():
            # 全部写路径统一锁序：Session → Run → Projection。
            session = (
                ChatSession.objects.select_for_update()
                .filter(pk=session_id)
                .only("id", "user_id", "organization_id")
                .first()
            )
            if session is None:
                return None
            run = (
                ExecutionRun.objects.select_for_update()
                .filter(run_id=normalized_run_id, session_id=session_id)
                .first()
            )
            if run is None:
                return None
            projection = (
                SessionRunProjection.objects.select_for_update()
                .filter(session_id=session_id)
                .first()
            )
            current_projection = (
                projection
                if projection is not None and projection.current_run_id == run.run_id
                else None
            )
            if sequence is not None and sequence != run.sequence:
                return None
            if event_revision is not None and event_revision <= run.revision:
                return None
            if allowed_from is not None and run.status not in allowed_from:
                return current_projection
            if run.status in TERMINAL_STATUSES:
                return current_projection

            now = timezone.now()
            normalized_interaction_id = None
            if waiting_interaction_id:
                try:
                    normalized_interaction_id = uuid.UUID(str(waiting_interaction_id))
                except (TypeError, ValueError):
                    normalized_interaction_id = None

            if (
                event_revision is None
                and run.status == status
                and run.stop_reason == stop_reason
                and run.error_class == error_class
                and str(run.waiting_interaction_id or "")
                == str(normalized_interaction_id or "")
            ):
                return current_projection

            run.status = status
            run.revision = event_revision or (run.revision + 1)
            run.state_changed_at = now
            if status == ExecutionRun.Status.RUNNING and run.started_at is None:
                run.started_at = now
            if status in TERMINAL_STATUSES:
                run.ended_at = now
                run.waiting_interaction_id = None
            else:
                run.ended_at = None
                run.waiting_interaction_id = normalized_interaction_id
            run.stop_reason = stop_reason
            run.error_class = error_class
            update_fields = [
                "status",
                "revision",
                "started_at",
                "state_changed_at",
                "ended_at",
                "stop_reason",
                "error_class",
                "waiting_interaction_id",
                "updated_at",
            ]
            if error is not None:
                # 截断避免异常栈过大；保留 setup_step 前缀便于检索。
                run.error = error[:4000] if error else None
                update_fields.append("error")
            run.save(update_fields=update_fields)

            if projection is None:
                return None

            switched_run = False
            if projection.current_run_id != run.run_id:
                if run.sequence <= projection.sequence:
                    return projection
                if status == ExecutionRun.Status.RUNNING:
                    projection.current_run = run
                    projection.sequence = run.sequence
                    projection.queue_depth = max(0, projection.queue_depth - 1)
                    switched_run = True
                elif status in TERMINAL_STATUSES:
                    projection.queue_depth = max(0, projection.queue_depth - 1)
                    projection.revision += 1
                    projection.state_changed_at = now
                    projection.save(
                        update_fields=[
                            "queue_depth",
                            "revision",
                            "state_changed_at",
                            "updated_at",
                        ]
                    )
                    cls._publish_on_commit(session, projection)
                    return projection
                else:
                    return projection

            projection.state_changed_at = now
            next_run = None
            if status in TERMINAL_STATUSES and projection.queue_depth > 0:
                next_run = (
                    ExecutionRun.objects.filter(
                        session_id=run.session_id,
                        sequence__gt=run.sequence,
                        status__in=ACTIVE_STATUSES,
                    )
                    .order_by("sequence")
                    .first()
                )

            if next_run is not None:
                projection.current_run = next_run
                projection.sequence = next_run.sequence
                projection.revision = max(1, next_run.revision)
                projection.status = next_run.status
                projection.queue_depth = max(0, projection.queue_depth - 1)
                projection.started_at = next_run.started_at
                projection.ended_at = next_run.ended_at
                projection.stop_reason = next_run.stop_reason
                projection.error_class = next_run.error_class
                projection.waiting_interaction_id = next_run.waiting_interaction_id
            else:
                projection.revision = (
                    max(1, run.revision)
                    if switched_run
                    else projection.revision + 1
                )
                projection.status = status
                projection.started_at = run.started_at
                projection.ended_at = run.ended_at
                projection.stop_reason = stop_reason
                projection.error_class = error_class
                projection.waiting_interaction_id = run.waiting_interaction_id
            projection.save()
            if (
                status in TERMINAL_STATUSES
                and run.terminal_projection_revision is None
            ):
                # 终态游标属于 run 自身，不能绑定“当前 projection 仍指向该 run”：
                # 有排队轮次时 projection 会在同一事务切到 next run，但刚完成的
                # 回复仍必须可被跨设备阅读水位确认。
                run.terminal_projection_revision = run.revision
                run.unread_eligible = status == ExecutionRun.Status.COMPLETED
                run.save(
                    update_fields=[
                        "terminal_projection_revision",
                        "unread_eligible",
                        "updated_at",
                    ]
                )
            cls._publish_on_commit(session, projection)
            if status in TERMINAL_STATUSES:
                from .session_read_state_service import SessionReadStateService

                SessionReadStateService.publish_current_on_commit(
                    session=session,
                )
            return projection

    @classmethod
    def transition_current(
        cls,
        *,
        session_id: str,
        status: str,
        **kwargs: Any,
    ) -> SessionRunProjection | None:
        projection = (
            SessionRunProjection.objects.filter(session_id=session_id)
            .only("current_run_id")
            .first()
        )
        if projection is None:
            return None
        return cls.transition(
            run_id=str(projection.current_run_id),
            status=status,
            **kwargs,
        )

    @classmethod
    def cancel_queued_after(
        cls,
        *,
        run_id: str,
        stop_reason: str = "cancelled_before_start",
    ) -> SessionRunProjection | None:
        """取消同次 session cancel 会被 host 清空、且不会产生 DONE 的排队运行。"""
        try:
            normalized_run_id = uuid.UUID(str(run_id))
        except (TypeError, ValueError):
            return None
        session_id = (
            ExecutionRun.objects.filter(run_id=normalized_run_id)
            .values_list("session_id", flat=True)
            .first()
        )
        if not session_id:
            return None

        with transaction.atomic():
            session = (
                ChatSession.objects.select_for_update()
                .filter(pk=session_id)
                .only("id", "user_id", "organization_id")
                .first()
            )
            if session is None:
                return None
            current_run = (
                ExecutionRun.objects.select_for_update()
                .filter(run_id=normalized_run_id, session_id=session_id)
                .first()
            )
            if current_run is None:
                return None
            projection = (
                SessionRunProjection.objects.select_for_update()
                .filter(
                    session_id=session_id,
                    current_run_id=current_run.run_id,
                )
                .first()
            )
            if session is None or projection is None:
                return projection

            queued_runs = list(
                ExecutionRun.objects.select_for_update()
                .filter(
                    session_id=session_id,
                    sequence__gt=current_run.sequence,
                    status=ExecutionRun.Status.QUEUED,
                )
                .order_by("sequence")
            )
            if not queued_runs:
                return projection

            now = timezone.now()
            for queued_run in queued_runs:
                queued_run.status = ExecutionRun.Status.CANCELLED
                queued_run.revision += 1
                queued_run.state_changed_at = now
                queued_run.ended_at = now
                queued_run.stop_reason = stop_reason
                queued_run.waiting_interaction_id = None
                queued_run.updated_at = now
            ExecutionRun.objects.bulk_update(
                queued_runs,
                [
                    "status",
                    "revision",
                    "state_changed_at",
                    "ended_at",
                    "stop_reason",
                    "waiting_interaction_id",
                    "updated_at",
                ],
            )
            projection.queue_depth = max(0, projection.queue_depth - len(queued_runs))
            projection.revision += 1
            projection.state_changed_at = now
            projection.save(
                update_fields=[
                    "queue_depth",
                    "revision",
                    "state_changed_at",
                    "updated_at",
                ]
            )
            cls._publish_on_commit(session, projection)
            return projection

    @staticmethod
    def _publish_on_commit(
        session: ChatSession,
        projection: SessionRunProjection,
    ) -> None:
        state = serialize_run_state(projection)
        payload = {
            "session_id": str(session.id),
            "organization_id": str(session.organization_id),
            "run_state": state,
        }
        user_id = str(session.user_id)

        def publish() -> None:
            try:
                event_id = new_event_id()
                envelope = build_envelope(RUN_STATE_EVENT, event_id, payload)
                publish_to_user(
                    user_id,
                    envelope,
                )
                from apps.chat.conversation.services.session_collaboration_events import (
                    publish_runtime_event,
                )

                publish_runtime_event(
                    str(session.thread_id or f"chat-session-{session.id}"),
                    envelope,
                    reliable=True,
                )
            except Exception:
                logger.warning(
                    "run-state publish failed session=%s",
                    session.id,
                    exc_info=True,
                )

        transaction.on_commit(publish)


__all__ = [
    "ACTIVE_STATUSES",
    "RUN_STATE_EVENT",
    "SessionRunStateService",
    "serialize_run_state",
]

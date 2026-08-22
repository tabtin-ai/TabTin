from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection
from django.db.models.deletion import ProtectedError
from django.db.models.signals import post_save
from django.test.utils import CaptureQueriesContext

from apps.chat.conversation.api.session import _build_session_summary
from apps.chat.conversation.api._common import _session_to_schema
from apps.chat.conversation.models import ChatSession
from apps.services.agent_engine.models import ExecutionRun, SessionRunProjection
from apps.services.agent_engine.services.session_run_state_service import (
    SessionRunStateService,
)
from apps.services.agent_engine.services.run_service import RunService
from apps.services.common.agent_protocol.constants import AgentStreamEvent
from apps.services.common.ws.handlers.relay_handler import _apply_run_state_events
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()

pytestmark = pytest.mark.django_db(databases=["default"])


@pytest.fixture(autouse=True)
def _disable_default_organization_signal():
    post_save.disconnect(create_default_organization, sender=User)
    try:
        yield
    finally:
        post_save.connect(create_default_organization, sender=User)


@pytest.fixture()
def run_session():
    user = User.objects.create_user(
        username=f"run_{uuid.uuid4().hex[:8]}",
        email=f"run-{uuid.uuid4().hex[:8]}@example.com",
        password="testpass123",
    )
    session = ChatSession.objects.create(
        user=user,
        organization_id=str(uuid.uuid4()),
        title="run state",
    )
    return user, session


def _accept(session: ChatSession, run_id: uuid.UUID):
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        return SessionRunStateService.accept_dispatch(
            thread_id=f"chat-session-{session.id}",
            run_id=str(run_id),
            task_id=f"prompt_{run_id.hex[:12]}",
        )


def test_accept_local_dispatch_requires_owner_and_is_idempotent(
    run_session,
    django_capture_on_commit_callbacks,
):
    user, session = run_session
    run_id = uuid.uuid4()

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ) as publish:
        denied = SessionRunStateService.accept_local_dispatch(
            thread_id=f"chat-session-{session.id}",
            run_id=str(run_id),
            task_id="local-task",
            user_id=str(uuid.uuid4()),
            organization_id=str(session.organization_id),
        )
        with django_capture_on_commit_callbacks(execute=True):
            first = SessionRunStateService.accept_local_dispatch(
                thread_id=f"chat-session-{session.id}",
                run_id=str(run_id),
                task_id="local-task",
                user_id=str(user.id),
                organization_id=str(session.organization_id),
            )
            duplicate = SessionRunStateService.accept_local_dispatch(
                thread_id=f"chat-session-{session.id}",
                run_id=str(run_id),
                task_id="local-task",
                user_id=str(user.id),
                organization_id=str(session.organization_id),
            )

    assert denied is None
    assert first is not None
    assert duplicate is not None and duplicate.pk == first.pk
    assert ExecutionRun.objects.filter(run_id=run_id).count() == 1
    assert SessionRunProjection.objects.get(session=session).sequence == 1
    publish.assert_called_once()


def test_accept_dispatch_records_execution_owner_and_exact_target(
    run_session,
):
    _session_owner, session = run_session
    execution_owner_id = uuid.uuid4()
    run_id = uuid.uuid4()

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        run = SessionRunStateService.accept_dispatch(
            thread_id=f"chat-session-{session.id}",
            run_id=str(run_id),
            task_id="shared-project-task",
            execution_owner_user_id=str(execution_owner_id),
            target_device_installation_id="initiator-installation",
        )

    assert run is not None
    assert run.user_id == str(execution_owner_id)
    assert run.metadata == {
        "task_id": "shared-project-task",
        "target_device_installation_id": "initiator-installation",
    }
    current = SessionRunStateService.get_current_run(
        f"chat-session-{session.id}",
    )
    assert current is not None and current.run_id == run_id


def test_accept_local_dispatch_reuses_shared_execution_owner_run(run_session):
    _session_owner, session = run_session
    execution_owner_id = uuid.uuid4()
    run_id = uuid.uuid4()

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        created = SessionRunStateService.accept_dispatch(
            thread_id=f"chat-session-{session.id}",
            run_id=str(run_id),
            task_id="shared-project-task",
            execution_owner_user_id=str(execution_owner_id),
            target_device_installation_id="initiator-installation",
        )
        accepted = SessionRunStateService.accept_local_dispatch(
            thread_id=f"chat-session-{session.id}",
            run_id=str(run_id),
            task_id="shared-project-task",
            user_id=str(execution_owner_id),
            organization_id=str(session.organization_id),
        )

    assert created is not None
    assert accepted is not None and accepted.pk == created.pk


def test_accept_local_dispatch_keeps_legacy_project_path_when_org_not_enabled():
    session = SimpleNamespace(
        user_id="session-owner",
        project_id=uuid.uuid4(),
        organization_id=uuid.uuid4(),
    )
    session_query = MagicMock()
    session_query.only.return_value.first.return_value = session
    accepted = object()

    with patch.object(ChatSession.objects, "filter", return_value=session_query), patch.object(
        ExecutionRun.objects,
        "filter",
    ) as run_filter, patch(
        "apps.services.daemon_control.feature.daemon_control_enabled_for_organization",
        return_value=False,
    ), patch.object(
        SessionRunStateService,
        "accept_dispatch",
        return_value=accepted,
    ):
        run_filter.return_value.exists.return_value = False
        result = SessionRunStateService.accept_local_dispatch(
            thread_id=f"chat-session-{uuid.uuid4()}",
            run_id=str(uuid.uuid4()),
            task_id="legacy-project-task",
            user_id=str(uuid.uuid4()),
            runtime_source_prevalidated=True,
        )

    assert result is accepted


def test_relay_lifecycle_start_recovers_missing_local_dispatch_fact(
    run_session,
    django_capture_on_commit_callbacks,
):
    _user, session = run_session
    run_id = uuid.uuid4()

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ) as publish:
        with django_capture_on_commit_callbacks(execute=True):
            _apply_run_state_events(
                f"chat-session-{session.id}",
                [(
                    AgentStreamEvent.LIFECYCLE,
                    {
                        "run_id": str(run_id),
                        "phase": "start",
                        "client_event_id": "local-client-event",
                        "arrival_seq": 1,
                    },
                )],
                str(_user.id),
            )

    run = ExecutionRun.objects.get(run_id=run_id)
    projection = SessionRunProjection.objects.get(session=session)
    assert run.status == ExecutionRun.Status.RUNNING
    assert projection.status == ExecutionRun.Status.RUNNING
    assert projection.current_run_id == run_id
    assert publish.call_count == 2


def test_relay_ignores_observer_trace_runs_for_session_projection(
    run_session,
):
    user, session = run_session
    main_run_id = uuid.uuid4()
    child_run_id = uuid.uuid4()
    _accept(session, main_run_id)
    SessionRunStateService.transition(
        run_id=str(main_run_id),
        status="completed",
        event_revision=2,
    )
    before = SessionRunProjection.objects.get(session=session)
    assert before.current_run_id == main_run_id
    assert before.status == ExecutionRun.Status.COMPLETED

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        confirmed = _apply_run_state_events(
            f"chat-session-{session.id}",
            [
                (
                    AgentStreamEvent.LIFECYCLE,
                    {
                        "run_id": str(child_run_id),
                        "phase": "start",
                        "thread_id": str(child_run_id),
                        "observer_only": True,
                        "arrival_seq": 3,
                    },
                ),
                (
                    AgentStreamEvent.DONE,
                    {
                        "run_id": str(child_run_id),
                        "thread_id": str(child_run_id),
                        "trace_forwarded": True,
                        "arrival_seq": 4,
                        "error": False,
                    },
                ),
            ],
            str(user.id),
        )

    assert confirmed is True
    after = SessionRunProjection.objects.get(session=session)
    assert after.current_run_id == main_run_id
    assert after.status == ExecutionRun.Status.COMPLETED
    assert not ExecutionRun.objects.filter(run_id=child_run_id).exists()


def test_relay_done_confirms_terminal_state_and_duplicate_is_idempotent(
    run_session,
):
    user, session = run_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    SessionRunStateService.transition(
        run_id=str(run_id),
        status="running",
        event_revision=2,
    )
    done_event = [(
        AgentStreamEvent.DONE,
        {
            "run_id": str(run_id),
            "arrival_seq": 3,
            "error": False,
        },
    )]

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        first_confirmed = _apply_run_state_events(
            f"chat-session-{session.id}",
            done_event,
            str(user.id),
        )
        duplicate_confirmed = _apply_run_state_events(
            f"chat-session-{session.id}",
            done_event,
            str(user.id),
        )

    run = ExecutionRun.objects.get(run_id=run_id)
    assert first_confirmed is True
    assert duplicate_confirmed is True
    assert run.status == ExecutionRun.Status.COMPLETED
    assert run.revision == 3


def test_relay_done_without_run_id_is_not_confirmed(run_session):
    user, session = run_session

    confirmed = _apply_run_state_events(
        f"chat-session-{session.id}",
        [(AgentStreamEvent.DONE, {"arrival_seq": 3, "error": False})],
        str(user.id),
    )

    assert confirmed is False


def test_run_identity_cannot_be_reused_or_transitioned_across_sessions(run_session):
    user, first_session = run_session
    second_session = ChatSession.objects.create(
        user=user,
        organization_id=first_session.organization_id,
        title="other session",
    )
    run_id = uuid.uuid4()
    first = _accept(first_session, run_id)

    reused = SessionRunStateService.accept_dispatch(
        thread_id=f"chat-session-{second_session.id}",
        run_id=str(run_id),
        task_id="cross-session",
    )
    transitioned = SessionRunStateService.transition(
        run_id=str(run_id),
        status="running",
        expected_thread_id=f"chat-session-{second_session.id}",
    )

    assert first is not None
    assert reused is None
    assert transitioned is None
    assert ExecutionRun.objects.get(run_id=run_id).status == ExecutionRun.Status.QUEUED


def test_lifecycle_is_idempotent_and_stale_run_cannot_override(run_session):
    _user, session = run_session
    first_id = uuid.uuid4()
    second_id = uuid.uuid4()
    first = _accept(session, first_id)
    second = _accept(session, second_id)

    assert first is not None and first.sequence == 1
    assert second is not None and second.sequence == 2
    projection = SessionRunProjection.objects.get(session=session)
    assert projection.current_run_id == first_id
    assert projection.queue_depth == 1

    SessionRunStateService.transition(run_id=str(first_id), status="running")
    SessionRunStateService.transition(
        run_id=str(first_id),
        status="waiting_user",
        waiting_interaction_id=str(uuid.uuid4()),
    )
    # 迟到的 runtime start 只能启动 queued run，不能把 HITL 状态倒退成 running。
    SessionRunStateService.transition(
        run_id=str(first_id),
        status="running",
        event_revision=3,
        allowed_from=frozenset({"queued", "running"}),
    )
    assert ExecutionRun.objects.get(run_id=first_id).status == "waiting_user"
    SessionRunStateService.transition(run_id=str(first_id), status="completed")
    current = SessionRunProjection.objects.get(session=session)
    assert current.current_run_id == second_id
    assert current.sequence == 2
    assert current.queue_depth == 0
    assert current.status == "queued"

    SessionRunStateService.transition(run_id=str(second_id), status="running")
    current.refresh_from_db()
    assert current.current_run_id == second_id
    assert current.sequence == 2
    assert current.queue_depth == 0
    assert current.status == "running"

    # 迟到的旧 run 终态和重复 lifecycle 都不能倒灌当前投影。
    revision = current.revision
    SessionRunStateService.transition(run_id=str(first_id), status="failed")
    SessionRunStateService.transition(
        run_id=str(second_id),
        status="running",
        event_revision=1,
    )
    current.refresh_from_db()
    assert current.current_run_id == second_id
    assert current.status == "running"
    assert current.revision == revision


def test_projection_revision_resets_when_sequence_switches(run_session):
    _user, session = run_session
    first_id = uuid.uuid4()
    second_id = uuid.uuid4()
    _accept(session, first_id)
    _accept(session, second_id)
    SessionRunStateService.transition(run_id=str(first_id), status="running")
    SessionRunStateService.transition(run_id=str(first_id), status="paused")
    SessionRunStateService.transition(run_id=str(first_id), status="running")

    before_switch = SessionRunProjection.objects.get(session=session)
    assert before_switch.sequence == 1
    assert before_switch.revision > 1

    SessionRunStateService.transition(run_id=str(first_id), status="completed")

    after_switch = SessionRunProjection.objects.get(session=session)
    assert after_switch.current_run_id == second_id
    assert after_switch.sequence == 2
    assert after_switch.revision == 1
    assert after_switch.status == "queued"


def test_terminal_state_derives_list_flags_and_serializes_contract(run_session):
    _user, session = run_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    SessionRunStateService.transition(run_id=str(run_id), status="running")
    SessionRunStateService.transition(
        run_id=str(run_id),
        status="failed",
        stop_reason="provider_error",
        error_class="upstream_timeout",
    )

    hydrated = ChatSession.objects.select_related("run_state_projection").get(
        pk=session.pk,
    )
    summary = _build_session_summary(hydrated, {}, {}, {})
    assert summary.has_active_task is False
    assert summary.last_run_failed is True
    assert summary.run_state is not None
    assert summary.run_state.model_dump().keys() == {
        "run_id",
        "sequence",
        "revision",
        "status",
        "queue_depth",
        "started_at",
        "state_changed_at",
        "ended_at",
        "stop_reason",
        "error_class",
        "waiting_interaction_id",
    }


def test_user_event_payload_matches_session_api_shape(
    run_session,
    django_capture_on_commit_callbacks,
):
    user, session = run_session
    run_id = uuid.uuid4()
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ) as publish, patch(
        "apps.chat.conversation.services.session_collaboration_events.publish_runtime_event",
    ) as publish_collaboration:
        with django_capture_on_commit_callbacks(execute=True):
            SessionRunStateService.accept_dispatch(
                thread_id=f"chat-session-{session.id}",
                run_id=str(run_id),
                task_id="prompt_contract",
            )

    publish.assert_called_once()
    target_user_id, envelope = publish.call_args.args
    assert target_user_id == str(user.id)
    assert envelope["type"] == "chat.session.run_state.updated"
    assert envelope["payload"]["session_id"] == str(session.id)
    assert envelope["payload"]["organization_id"] == session.organization_id
    assert envelope["payload"]["run_state"]["run_id"] == str(run_id)
    assert envelope["payload"]["run_state"]["status"] == "queued"
    publish_collaboration.assert_called_once_with(
        str(session.thread_id or f"chat-session-{session.id}"),
        envelope,
        reliable=True,
    )


def test_session_projection_prefetch_has_no_per_row_queries(run_session):
    user, first_session = run_session
    sessions = [first_session]
    for index in range(2):
        sessions.append(
            ChatSession.objects.create(
                user=user,
                organization_id=first_session.organization_id,
                title=f"run state {index}",
            )
        )
    for session in sessions:
        _accept(session, uuid.uuid4())

    with CaptureQueriesContext(connection) as queries:
        hydrated = list(
            ChatSession.objects.select_related("run_state_projection")
            .filter(id__in=[item.id for item in sessions])
            .order_by("id")
        )
        summaries = [
            _build_session_summary(item, {}, {}, {})
            for item in hydrated
        ]

    assert len(summaries) == 3
    assert len(queries) == 1
    assert all(summary.run_state is not None for summary in summaries)
    assert ExecutionRun.objects.filter(session_id__in=[str(s.id) for s in sessions]).count() == 3


def test_regular_session_schema_exposes_same_authoritative_contract(run_session):
    _user, session = run_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    SessionRunStateService.transition(run_id=str(run_id), status="running")
    SessionRunStateService.transition(
        run_id=str(run_id),
        status="failed",
        stop_reason="provider_error",
        error_class="upstream_timeout",
    )

    hydrated = ChatSession.objects.select_related("run_state_projection").get(
        pk=session.pk,
    )
    schema = _session_to_schema(
        hydrated,
        message_count=1,
        tracker_run_meta=None,
    )

    assert schema.has_active_task is False
    assert schema.last_run_failed is True
    assert schema.run_state is not None
    assert schema.run_state.model_dump() == {
        "run_id": str(run_id),
        "sequence": 1,
        "revision": schema.run_state.revision,
        "status": "failed",
        "queue_depth": 0,
        "started_at": schema.run_state.started_at,
        "state_changed_at": schema.run_state.state_changed_at,
        "ended_at": schema.run_state.ended_at,
        "stop_reason": "provider_error",
        "error_class": "upstream_timeout",
        "waiting_interaction_id": None,
    }


def test_regular_session_projection_join_has_no_per_row_queries(run_session):
    user, first_session = run_session
    sessions = [first_session]
    for index in range(2):
        sessions.append(
            ChatSession.objects.create(
                user=user,
                organization_id=first_session.organization_id,
                title=f"regular run state {index}",
            )
        )
    for session in sessions:
        _accept(session, uuid.uuid4())

    with CaptureQueriesContext(connection) as queries:
        hydrated = list(
            ChatSession.objects.select_related("run_state_projection")
            .filter(id__in=[item.id for item in sessions])
            .order_by("id")
        )
        schemas = [
            _session_to_schema(
                item,
                message_count=1,
                tracker_run_meta=None,
            )
            for item in hydrated
        ]

    assert len(queries) == 1
    assert all(schema.run_state is not None for schema in schemas)
    assert all(schema.has_active_task is True for schema in schemas)


def test_regular_session_schema_emits_explicit_null_without_projection(run_session):
    _user, session = run_session

    schema = _session_to_schema(
        session,
        message_count=0,
        tracker_run_meta=None,
    )
    payload = schema.model_dump()

    assert "run_state" in payload
    assert payload["run_state"] is None
    assert payload["last_run_failed"] is False
    assert payload["has_active_task"] is False


def test_current_projection_protects_authoritative_run_fact(run_session):
    _user, session = run_session
    run = _accept(session, uuid.uuid4())

    assert run is not None
    with pytest.raises(ProtectedError):
        run.delete()
    assert SessionRunProjection.objects.filter(session=session).exists()


def test_cancel_clears_all_queued_runs_before_current_terminal(run_session):
    _user, session = run_session
    current_id = uuid.uuid4()
    queued_ids = [uuid.uuid4(), uuid.uuid4()]
    _accept(session, current_id)
    for run_id in queued_ids:
        _accept(session, run_id)
    SessionRunStateService.transition(run_id=str(current_id), status="running")

    SessionRunStateService.transition(run_id=str(current_id), status="cancelling")
    SessionRunStateService.cancel_queued_after(run_id=str(current_id))
    cancelling = SessionRunProjection.objects.get(session=session)
    assert cancelling.status == "cancelling"
    assert cancelling.queue_depth == 0

    SessionRunStateService.transition(run_id=str(current_id), status="interrupted")
    terminal_revision = SessionRunProjection.objects.get(session=session).revision
    SessionRunStateService.transition(run_id=str(current_id), status="interrupted")

    projection = SessionRunProjection.objects.get(session=session)
    assert projection.current_run_id == current_id
    assert projection.status == "interrupted"
    assert projection.queue_depth == 0
    assert projection.revision == terminal_revision
    assert set(
        ExecutionRun.objects.filter(run_id__in=queued_ids).values_list(
            "status",
            flat=True,
        )
    ) == {"cancelled"}


def test_run_service_cancel_uses_active_single_pg_transaction(run_session):
    _user, session = run_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    SessionRunStateService.transition(run_id=str(run_id), status="running")

    with patch.object(RunService, "_get_redis_client", return_value=None):
        cancelled = RunService.request_cancel(str(run_id), reason="test")

    assert cancelled is not None
    assert cancelled.status == "cancelling"


def test_pause_resume_does_not_erase_pending_hitl_state(run_session):
    _user, session = run_session
    run_id = uuid.uuid4()
    interaction_id = uuid.uuid4()
    _accept(session, run_id)
    SessionRunStateService.transition(run_id=str(run_id), status="running")
    SessionRunStateService.transition(
        run_id=str(run_id),
        status="waiting_user",
        waiting_interaction_id=str(interaction_id),
    )

    SessionRunStateService.transition_current(
        session_id=str(session.id),
        status="paused",
        allowed_from=frozenset({"running", "paused"}),
    )
    SessionRunStateService.transition_current(
        session_id=str(session.id),
        status="running",
        allowed_from=frozenset({"paused"}),
    )

    projection = SessionRunProjection.objects.get(session=session)
    assert projection.status == "waiting_user"
    assert projection.waiting_interaction_id == interaction_id


def test_get_latest_run_preserves_non_chat_thread_fallback():
    run = ExecutionRun.objects.create(
        run_id=uuid.uuid4(),
        thread_id="tracker-task-non-uuid",
        graph_type="tracker",
        status="running",
        sequence=1,
    )

    assert RunService.get_latest_run("tracker-task-non-uuid") == run


@pytest.mark.django_db(transaction=True, databases=["default"])
def test_pg_concurrent_dispatch_retry_and_cancel_keep_projection_monotonic(run_session):
    _user, session = run_session
    current_id = uuid.uuid4()
    queued_id = uuid.uuid4()
    _accept(session, current_id)
    _accept(session, queued_id)
    SessionRunStateService.transition(run_id=str(current_id), status="running")
    barrier = Barrier(2)

    def retry_dispatch():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            SessionRunStateService.accept_dispatch(
                thread_id=f"chat-session-{session.id}",
                run_id=str(queued_id),
                task_id="prompt_retry",
            )
        finally:
            close_old_connections()

    def cancel_current_and_queue():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            SessionRunStateService.transition(
                run_id=str(current_id),
                status="cancelling",
            )
            SessionRunStateService.cancel_queued_after(run_id=str(current_id))
        finally:
            close_old_connections()

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ), ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(retry_dispatch),
            pool.submit(cancel_current_and_queue),
        ]
        for future in futures:
            future.result(timeout=10)

    projection = SessionRunProjection.objects.get(session=session)
    assert projection.current_run_id == current_id
    assert projection.status == "cancelling"
    assert projection.queue_depth == 0
    assert ExecutionRun.objects.filter(
        run_id=queued_id,
        status="cancelled",
    ).exists()
    assert ExecutionRun.objects.filter(session_id=str(session.id)).count() == 2

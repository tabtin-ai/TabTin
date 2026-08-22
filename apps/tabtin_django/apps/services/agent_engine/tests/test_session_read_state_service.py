from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db.models.signals import post_save

from apps.chat.conversation.models import ChatSession
from apps.services.agent_engine.models import (
    ExecutionRun,
    SessionReadReceipt,
    SessionRunProjection,
)
from apps.services.agent_engine.services.session_read_state_service import (
    SessionReadStateService,
    has_unread_completed_run,
)
from apps.services.agent_engine.services.session_run_state_service import (
    SessionRunStateService,
)
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
def read_session():
    user = User.objects.create_user(
        username=f"read_{uuid.uuid4().hex[:8]}",
        email=f"read-{uuid.uuid4().hex[:8]}@example.com",
        password="testpass123",
    )
    session = ChatSession.objects.create(
        user=user,
        organization_id=str(uuid.uuid4()),
        title="read watermark",
    )
    return user, session


def _accept(session: ChatSession, run_id: uuid.UUID) -> ExecutionRun:
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        run = SessionRunStateService.accept_dispatch(
            thread_id=f"chat-session-{session.id}",
            run_id=str(run_id),
            task_id=f"prompt_{run_id.hex[:12]}",
        )
    assert run is not None
    return run


def _complete(session: ChatSession, run_id: uuid.UUID) -> SessionRunProjection:
    _accept(session, run_id)
    SessionRunStateService.transition(run_id=str(run_id), status="running")
    SessionRunStateService.transition(run_id=str(run_id), status="completed")
    return SessionRunProjection.objects.select_related("current_run").get(
        session=session,
    )


def test_completed_run_freezes_terminal_cursor_and_becomes_unread(read_session):
    _user, session = read_session
    run_id = uuid.uuid4()

    _complete(session, run_id)
    run = ExecutionRun.objects.get(run_id=run_id)

    assert run.unread_eligible is True
    assert run.terminal_projection_revision == run.revision
    assert has_unread_completed_run(run, None) is True


def test_ack_is_monotonic_and_duplicate_does_not_change_read_at(read_session):
    user, session = read_session
    run_id = uuid.uuid4()
    _complete(session, run_id)
    terminal_revision = ExecutionRun.objects.get(
        run_id=run_id,
    ).terminal_projection_revision
    assert terminal_revision is not None

    first = SessionReadStateService.acknowledge(
        session_id=str(session.id),
        user=user,
        through_run_id=str(run_id),
        through_revision=terminal_revision,
    )
    receipt = SessionReadReceipt.objects.get(user=user, session=session)
    first_read_at = receipt.read_at

    duplicate = SessionReadStateService.acknowledge(
        session_id=str(session.id),
        user=user,
        through_run_id=str(run_id),
        through_revision=terminal_revision,
    )
    receipt.refresh_from_db()

    assert first["outcome"] == "advanced"
    assert first["has_unread_reply"] is False
    assert duplicate["outcome"] == "noop"
    assert receipt.read_at == first_read_at


def test_old_ack_cannot_clear_a_newer_completed_run(read_session):
    user, session = read_session
    first_id = uuid.uuid4()
    _complete(session, first_id)
    first_revision = ExecutionRun.objects.get(
        run_id=first_id,
    ).terminal_projection_revision
    assert first_revision is not None
    SessionReadStateService.acknowledge(
        session_id=str(session.id),
        user=user,
        through_run_id=str(first_id),
        through_revision=first_revision,
    )

    second_id = uuid.uuid4()
    second_projection = _complete(session, second_id)
    stale = SessionReadStateService.acknowledge(
        session_id=str(session.id),
        user=user,
        through_run_id=str(first_id),
        through_revision=first_revision,
    )
    receipt = SessionReadReceipt.objects.get(user=user, session=session)

    assert second_projection.sequence == 2
    assert stale["outcome"] == "noop"
    assert stale["has_unread_reply"] is True
    assert receipt.last_read_run_sequence == 1


@pytest.mark.parametrize("terminal_status", ["failed", "cancelled", "interrupted"])
def test_non_completed_terminal_states_never_become_unread(
    read_session,
    terminal_status,
):
    _user, session = read_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    SessionRunStateService.transition(run_id=str(run_id), status="running")
    SessionRunStateService.transition(run_id=str(run_id), status=terminal_status)

    projection = SessionRunProjection.objects.select_related("current_run").get(
        session=session,
    )
    assert projection.current_run.unread_eligible is False
    assert has_unread_completed_run(None, None) is False


def test_pre_rollout_completed_history_is_not_marked_unread(read_session):
    _user, session = read_session
    run = ExecutionRun.objects.create(
        run_id=uuid.uuid4(),
        thread_id=f"chat-session-{session.id}",
        graph_type="chat",
        session_id=str(session.id),
        organization_id=session.organization_id,
        user_id=str(session.user_id),
        sequence=1,
        revision=1,
        status=ExecutionRun.Status.COMPLETED,
        terminal_projection_revision=1,
        unread_eligible=False,
    )
    projection = SessionRunProjection.objects.create(
        session=session,
        current_run=run,
        sequence=1,
        revision=1,
        status=ExecutionRun.Status.COMPLETED,
        state_changed_at=run.state_changed_at,
    )

    assert has_unread_completed_run(run, None) is False


def test_completed_unread_survives_a_later_failed_run(read_session):
    user, session = read_session
    completed_id = uuid.uuid4()
    _complete(session, completed_id)

    failed_id = uuid.uuid4()
    _accept(session, failed_id)
    SessionRunStateService.transition(run_id=str(failed_id), status="running")
    SessionRunStateService.transition(run_id=str(failed_id), status="failed")

    latest_completed = SessionReadStateService.latest_completed_run(
        session_id=session.id,
    )
    snapshot = SessionReadStateService.snapshot(
        receipt=None,
        latest_completed_run=latest_completed,
    )

    assert snapshot["has_unread_reply"] is True
    assert snapshot["read_state"]["latest_completed_run_id"] == str(completed_id)
    assert snapshot["read_state"]["latest_completed_run_sequence"] == 1

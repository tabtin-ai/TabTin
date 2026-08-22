from __future__ import annotations

import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.utils import timezone

from apps.chat.conversation.models import ChatSession
from apps.services.agent_engine.api.subtask_run_api import (
    LocalSessionRunDispatchIn,
    RunHostLeaseClaimIn,
    accept_local_session_run,
    claim_run_host_lease,
)
from apps.services.agent_engine.models import (
    ExecutionRun,
    RunHostLease,
    SessionRunProjection,
)
from apps.services.agent_engine.services.run_host_lease_service import (
    DEFAULT_LEASE_SECONDS,
    FENCE_REASON_HELD,
    FENCE_REASON_LEASE_EXPIRED,
    FENCE_REASON_OWNERSHIP_TRANSFERRED,
    HOST_LOST_ERROR_CLASS,
    LEASE_EXPIRED_STOP_REASON,
    RunHostLeaseService,
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
def lease_session():
    user = User.objects.create_user(
        username=f"lease_{uuid.uuid4().hex[:8]}",
        email=f"lease-{uuid.uuid4().hex[:8]}@example.com",
        password="testpass123",
    )
    session = ChatSession.objects.create(
        user=user,
        organization_id=str(uuid.uuid4()),
        title="lease state",
    )
    return user, session


def _accept(session: ChatSession, run_id: uuid.UUID):
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        run = SessionRunStateService.accept_dispatch(
            thread_id=f"chat-session-{session.id}",
            run_id=str(run_id),
            task_id=f"prompt_{run_id.hex[:12]}",
        )
        SessionRunStateService.transition(run_id=str(run_id), status="running")
    return run


def test_long_waiting_and_paused_runs_survive_with_heartbeats(lease_session):
    user, session = lease_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    started = timezone.now()
    claimed = RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id="device-a",
        user_id=str(user.id),
        lease_seconds=90,
        now=started,
    )
    token = claimed["lease_token"]

    SessionRunStateService.transition(
        run_id=str(run_id),
        status="waiting_user",
        waiting_interaction_id=str(uuid.uuid4()),
    )
    # fake clock 推进 31 分钟，run state 不变，但 host 每分钟续租。
    for minute in range(1, 32):
        renewed = RunHostLeaseService.heartbeat(
            run_id=str(run_id),
            host_id="device-a",
            lease_token=token,
            user_id=str(user.id),
            lease_seconds=90,
            now=started + timedelta(minutes=minute),
        )
        assert renewed["outcome"] == "renewed"
    assert RunHostLeaseService.expire_due(
        now=started + timedelta(minutes=31, seconds=89)
    ) == []
    assert ExecutionRun.objects.get(run_id=run_id).status == "waiting_user"

    SessionRunStateService.transition(run_id=str(run_id), status="paused")
    renewed = RunHostLeaseService.heartbeat(
        run_id=str(run_id),
        host_id="device-a",
        lease_token=token,
        user_id=str(user.id),
        now=started + timedelta(minutes=32),
    )
    assert renewed["outcome"] == "renewed"
    assert RunHostLeaseService.expire_due(
        now=started + timedelta(minutes=33, seconds=29)
    ) == []
    assert ExecutionRun.objects.get(run_id=run_id).status == "paused"


def test_expired_lease_converges_once_and_absorbs_late_terminal(lease_session):
    user, session = lease_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    started = timezone.now()
    RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id="device-hard-exit",
        user_id=str(user.id),
        lease_seconds=30,
        now=started,
    )

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        first = RunHostLeaseService.expire_due(
            now=started + timedelta(seconds=31)
        )
        within_grace = RunHostLeaseService.expire_due(
            now=started + timedelta(seconds=60)
        )
        second = RunHostLeaseService.expire_due(
            now=started + timedelta(seconds=31 + DEFAULT_LEASE_SECONDS + 1)
        )
        SessionRunStateService.transition(
            run_id=str(run_id),
            status="completed",
        )

    assert first == [str(run_id)]
    assert within_grace == []
    assert second == [str(run_id)]
    run = ExecutionRun.objects.get(run_id=run_id)
    projection = SessionRunProjection.objects.get(session=session)
    lease = RunHostLease.objects.get(run_id=run_id)
    assert run.status == "interrupted"
    assert run.stop_reason == LEASE_EXPIRED_STOP_REASON
    assert run.error_class == HOST_LOST_ERROR_CLASS
    assert projection.status == "interrupted"
    assert projection.current_run_id == run_id
    assert lease.release_reason == LEASE_EXPIRED_STOP_REASON


def test_old_client_without_lease_is_never_swept(lease_session):
    _user, session = lease_session
    run_id = uuid.uuid4()
    _accept(session, run_id)

    assert RunHostLeaseService.expire_due(
        now=timezone.now() + timedelta(days=30)
    ) == []
    assert not RunHostLease.objects.filter(run_id=run_id).exists()
    assert ExecutionRun.objects.get(run_id=run_id).status == "running"
    assert SessionRunProjection.objects.get(session=session).status == "running"


def test_queued_run_can_hold_lease_and_expires_without_replacing_current(
    lease_session,
):
    user, session = lease_session
    current_id = uuid.uuid4()
    queued_id = uuid.uuid4()
    _accept(session, current_id)
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        SessionRunStateService.accept_dispatch(
            thread_id=f"chat-session-{session.id}",
            run_id=str(queued_id),
            task_id="queued-task",
        )
    started = timezone.now()

    claimed = RunHostLeaseService.claim(
        run_id=str(queued_id),
        host_id="device-queue",
        user_id=str(user.id),
        lease_seconds=30,
        now=started,
    )
    assert claimed["outcome"] == "claimed"
    assert RunHostLeaseService.heartbeat(
        run_id=str(queued_id),
        host_id="device-queue",
        lease_token=claimed["lease_token"],
        user_id=str(user.id),
        lease_seconds=30,
        now=started + timedelta(seconds=10),
    )["outcome"] == "renewed"

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        released = RunHostLeaseService.expire_due(
            now=started + timedelta(seconds=41),
        )
        expired = RunHostLeaseService.expire_due(
            now=started + timedelta(seconds=41 + DEFAULT_LEASE_SECONDS + 1),
        )

    projection = SessionRunProjection.objects.get(session=session)
    assert released == [str(queued_id)]
    assert expired == [str(queued_id)]
    queued_run = ExecutionRun.objects.get(run_id=queued_id)
    assert queued_run.status == "interrupted"
    assert queued_run.stop_reason == LEASE_EXPIRED_STOP_REASON
    assert queued_run.error_class == HOST_LOST_ERROR_CLASS
    assert projection.current_run_id == current_id
    assert projection.queue_depth == 0


def test_fencing_rejects_wrong_token_and_stale_sequence(lease_session):
    user, session = lease_session
    old_id = uuid.uuid4()
    next_id = uuid.uuid4()
    _accept(session, old_id)
    claimed = RunHostLeaseService.claim(
        run_id=str(old_id),
        host_id="device-a",
        user_id=str(user.id),
    )
    wrong_token = RunHostLeaseService.heartbeat(
        run_id=str(old_id),
        host_id="device-a",
        lease_token=str(uuid.uuid4()),
        user_id=str(user.id),
    )
    assert wrong_token["outcome"] == "fenced"
    assert wrong_token["reason"] == FENCE_REASON_OWNERSHIP_TRANSFERRED

    # 排队 run 成为新 sequence 后，旧 run 即使携带原 token 也不能覆盖投影。
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        SessionRunStateService.accept_dispatch(
            thread_id=f"chat-session-{session.id}",
            run_id=str(next_id),
            task_id="next",
        )
        SessionRunStateService.transition(run_id=str(old_id), status="completed")
        SessionRunStateService.transition(run_id=str(next_id), status="running")

    result = RunHostLeaseService.reconcile(
        host_id="device-a",
        user_id=str(user.id),
        active_runs=[
            {"run_id": str(old_id), "lease_token": claimed["lease_token"]}
        ],
    )
    projection = SessionRunProjection.objects.get(session=session)
    assert result["runs"][0]["outcome"] == "fenced"
    assert projection.current_run_id == next_id
    assert projection.status == "running"


def test_same_host_reclaim_rotates_token_and_fences_old_process(lease_session):
    user, _session = lease_session
    run_id = uuid.uuid4()
    _accept(_session, run_id)
    started = timezone.now()
    first = RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id=" device-a ",
        user_id=str(user.id),
        now=started,
    )
    second = RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id="device-a",
        user_id=str(user.id),
        now=started + timedelta(seconds=1),
    )

    assert first["outcome"] == second["outcome"] == "claimed"
    assert second["generation"] == first["generation"] + 1
    assert second["lease_token"] != first["lease_token"]
    assert RunHostLeaseService.heartbeat(
        run_id=str(run_id),
        host_id="device-a",
        lease_token=first["lease_token"],
        user_id=str(user.id),
        now=started + timedelta(seconds=2),
    )["outcome"] == "fenced"
    assert RunHostLeaseService.heartbeat(
        run_id=str(run_id),
        host_id=" device-a ",
        lease_token=second["lease_token"],
        user_id=str(user.id),
        now=started + timedelta(seconds=2),
    )["outcome"] == "renewed"


def test_reconcile_empty_set_converges_host_owned_run(lease_session):
    user, session = lease_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    started = timezone.now()
    RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id="device-reconnected-empty",
        user_id=str(user.id),
        now=started,
    )

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        result = RunHostLeaseService.reconcile(
            host_id="device-reconnected-empty",
            user_id=str(user.id),
            active_runs=[],
            now=started + timedelta(seconds=1),
        )

    assert result["converged_run_ids"] == [str(run_id)]
    run = ExecutionRun.objects.get(run_id=run_id)
    projection = SessionRunProjection.objects.get(session=session)
    assert run.status == "interrupted"
    assert run.stop_reason == LEASE_EXPIRED_STOP_REASON
    assert run.error_class == HOST_LOST_ERROR_CLASS
    assert projection.status == "interrupted"


def test_same_host_reclaims_expired_lease_without_interrupting_run(lease_session):
    user, session = lease_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    started = timezone.now()
    first = RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id="device-reclaim",
        user_id=str(user.id),
        lease_seconds=30,
        now=started,
    )
    late = started + timedelta(seconds=31)
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        released = RunHostLeaseService.expire_due(now=late)
        heartbeat = RunHostLeaseService.heartbeat(
            run_id=str(run_id),
            host_id="device-reclaim",
            lease_token=first["lease_token"],
            user_id=str(user.id),
            now=late,
        )
        reclaimed = RunHostLeaseService.claim(
            run_id=str(run_id),
            host_id="device-reclaim",
            user_id=str(user.id),
            now=late,
        )
        other = RunHostLeaseService.claim(
            run_id=str(run_id),
            host_id="device-other",
            user_id=str(user.id),
            now=late,
        )

    assert released == [str(run_id)]
    assert heartbeat["outcome"] == "fenced"
    assert heartbeat["reason"] == FENCE_REASON_LEASE_EXPIRED
    assert reclaimed["outcome"] == "claimed"
    assert reclaimed["lease_token"] != first["lease_token"]
    assert ExecutionRun.objects.get(run_id=run_id).status == "running"
    assert other["outcome"] == "held"
    assert other["reason"] == FENCE_REASON_HELD


def test_other_host_cannot_claim_expired_release_before_owner_returns(
    lease_session,
):
    user, session = lease_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    started = timezone.now()
    RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id="device-owner",
        user_id=str(user.id),
        lease_seconds=30,
        now=started,
    )
    late = started + timedelta(seconds=31)
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        released = RunHostLeaseService.expire_due(now=late)
        other = RunHostLeaseService.claim(
            run_id=str(run_id),
            host_id="device-intruder",
            user_id=str(user.id),
            now=late,
        )
        owner = RunHostLeaseService.claim(
            run_id=str(run_id),
            host_id="device-owner",
            user_id=str(user.id),
            now=late,
        )

    assert released == [str(run_id)]
    assert other["outcome"] == "held"
    assert other["reason"] == FENCE_REASON_HELD
    assert owner["outcome"] == "claimed"
    assert ExecutionRun.objects.get(run_id=run_id).status == "running"


def test_reconcile_auto_claims_after_expired_heartbeat(lease_session):
    user, session = lease_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    started = timezone.now()
    first = RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id="device-reconcile",
        user_id=str(user.id),
        lease_seconds=30,
        now=started,
    )
    late = started + timedelta(seconds=31)
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        released = RunHostLeaseService.expire_due(now=late)
        result = RunHostLeaseService.reconcile(
            host_id="device-reconcile",
            user_id=str(user.id),
            active_runs=[
                {
                    "run_id": str(run_id),
                    "lease_token": first["lease_token"],
                }
            ],
            now=late,
        )

    assert released == [str(run_id)]
    assert result["runs"][0]["outcome"] == "claimed"
    assert result["runs"][0]["lease_token"] != first["lease_token"]
    assert result["converged_run_ids"] == []
    assert ExecutionRun.objects.get(run_id=run_id).status == "running"


def test_other_live_host_still_blocks_claim(lease_session):
    user, _session = lease_session
    run_id = uuid.uuid4()
    _accept(_session, run_id)
    RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id="device-owner",
        user_id=str(user.id),
    )
    result = RunHostLeaseService.claim(
        run_id=str(run_id),
        host_id="device-intruder",
        user_id=str(user.id),
    )
    assert result["outcome"] == "held"
    assert result["reason"] == FENCE_REASON_HELD


def test_claim_api_binds_lease_to_authenticated_user(lease_session):
    user, session = lease_session
    run_id = uuid.uuid4()
    _accept(session, run_id)
    request = SimpleNamespace(auth=user)

    result = claim_run_host_lease(
        request,
        RunHostLeaseClaimIn(
            run_id=str(run_id),
            host_id="api-device",
            lease_seconds=90,
        ),
    )

    assert result["outcome"] == "claimed"
    assert result["host_id"] == "api-device"
    assert RunHostLease.objects.filter(
        run_id=run_id,
        run__user_id=str(user.id),
    ).exists()


def test_accept_local_session_run_atomically_creates_run_projection_and_lease(
    lease_session,
):
    user, session = lease_session
    run_id = uuid.uuid4()
    request = SimpleNamespace(auth=user)

    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        result = accept_local_session_run(
            request,
            LocalSessionRunDispatchIn(
                thread_id=f"chat-session-{session.id}",
                run_id=str(run_id),
                task_id="electron-local-task",
                organization_id=str(session.organization_id),
                host_id="electron:api-device",
                lease_seconds=90,
            ),
        )
        duplicate = accept_local_session_run(
            request,
            LocalSessionRunDispatchIn(
                thread_id=f"chat-session-{session.id}",
                run_id=str(run_id),
                task_id="electron-local-task",
                organization_id=str(session.organization_id),
                host_id="electron:api-device",
                lease_seconds=90,
            ),
        )

    assert result["accepted"] is True
    assert result["outcome"] == "claimed"
    assert result["run_id"] == str(run_id)
    assert result["host_id"] == "electron:api-device"
    assert duplicate["lease_token"] == result["lease_token"]
    assert duplicate["generation"] == result["generation"]
    assert result["run_state"]["status"] == "queued"
    assert ExecutionRun.objects.filter(
        run_id=run_id,
        session_id=session.id,
        user_id=str(user.id),
    ).exists()
    assert SessionRunProjection.objects.filter(
        session=session,
        current_run_id=run_id,
        status="queued",
    ).exists()
    assert RunHostLease.objects.filter(
        run_id=run_id,
        host_id="electron:api-device",
    ).exists()

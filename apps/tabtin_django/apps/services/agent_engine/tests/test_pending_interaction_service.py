from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import override_settings
from django.utils import timezone

from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.services.agent_engine.models import PendingInteraction
from apps.services.agent_engine.services.pending_interaction_service import (
    can_resolve_pending_interaction,
    cancel_pending_interactions_by_thread,
    expire_due_interactions_for_user,
    hitl_message_client_event_id,
    list_pending_interactions_for_user,
    list_pending_interactions_for_thread,
    list_pending_single_hitl_for_thread,
    mark_action_approval_resolved,
    mark_single_hitl_resolved,
    mark_tool_approval_resolved_from_payload,
    runtime_can_open_interaction,
    upsert_action_approval_interaction,
    upsert_single_hitl_interaction,
    upsert_tool_approval_interaction,
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
def pending_session():
    user = User.objects.create_user(
        username=f"pending_{uuid.uuid4().hex[:8]}",
        email=f"pending-{uuid.uuid4().hex[:8]}@example.com",
        password="testpass123",
    )
    session = ChatSession.objects.create(
        user=user,
        organization_id="pending-organization",
        title="pending test",
    )
    return user, session, f"chat-session-{session.id}"


def _payload(batch_id: str = "approval-1") -> dict:
    return {
        "batch_id": batch_id,
        "approval_type": "tool_permission",
        "action_requests": [
            {
                "request_id": batch_id,
                "tool_call_id": batch_id,
                "tool_name": "browser.act",
                "tool_input": {"url": "https://example.com"},
                "decision_reason": {"type": "user_interactive", "scope": "once"},
                "allowed_scopes": ["once"],
                "allowed_outcomes": ["allow", "deny"],
                "risk_level": "high",
            }
        ],
        "runtime_mode": "interactive",
        "expires_at": int((timezone.now().timestamp() + 120) * 1000),
        "schema_version": 1,
    }


def test_pending_interaction_owner_can_resolve_on_frozen_runtime(pending_session):
    user, session, thread_id = pending_session
    session.target_device_installation_id = "daemon-frozen"
    session.save(update_fields=["target_device_installation_id"])
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload={"request_id": "ask-frozen"},
            source_device_fingerprint="daemon-frozen",
        )

    assert can_resolve_pending_interaction(
        thread_id=thread_id,
        request_key="ask-frozen",
        user_id=str(user.id),
        kinds=("ask_choice",),
    )


def test_pending_interaction_resolution_fails_closed(pending_session):
    user, session, thread_id = pending_session
    session.target_device_installation_id = "daemon-frozen"
    session.save(update_fields=["target_device_installation_id"])
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        interaction = upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload={"request_id": "ask-secure"},
            source_device_fingerprint="daemon-frozen",
        )

    def check():
        return can_resolve_pending_interaction(
            thread_id=thread_id,
            request_key="ask-secure",
            user_id=str(user.id),
            kinds=("ask_choice",),
        )

    assert not can_resolve_pending_interaction(
        thread_id=thread_id,
        request_key="missing",
        user_id=str(user.id),
        kinds=("ask_choice",),
    )
    assert not can_resolve_pending_interaction(
        thread_id=thread_id,
        request_key="ask-secure",
        user_id=str(uuid.uuid4()),
        kinds=("ask_choice",),
    )

    interaction.source_device_fingerprint = "daemon-other"
    interaction.save(update_fields=["source_device_fingerprint"])
    assert not check()

    interaction.source_device_fingerprint = "daemon-frozen"
    interaction.payload = []
    interaction.save(update_fields=["source_device_fingerprint", "payload"])
    assert not check()

    interaction.payload = {
        "request_id": "ask-secure",
        "__team_space_execution_redaction_required": True,
    }
    interaction.save(update_fields=["payload"])
    assert not check()

    with patch.object(PendingInteraction.objects, "using", side_effect=RuntimeError("db down")):
        assert not check()


def test_team_execution_owner_can_resolve_pending_interaction(pending_session):
    user, session, thread_id = pending_session
    session.target_device_installation_id = "session-owner-device"
    session.save(update_fields=["target_device_installation_id"])
    execution_owner_id = str(uuid.uuid4())
    run_id = uuid.uuid4()
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        SessionRunStateService.accept_dispatch(
            thread_id=thread_id,
            run_id=str(run_id),
            task_id="shared-project-task",
            execution_owner_user_id=execution_owner_id,
            target_device_installation_id="daemon-team",
        )
    payload = _payload("approval-team-owner")
    payload["run_id"] = str(run_id)
    payload["team_space_execution"] = {
        "initiator_user_id": str(user.id),
        "execution_owner_user_id": execution_owner_id,
    }
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        interaction = upsert_tool_approval_interaction(
            thread_id=thread_id,
            payload=payload,
            source_device_fingerprint="daemon-team",
        )

    assert interaction is not None
    assert interaction.user_id == user.id
    assert can_resolve_pending_interaction(
        thread_id=thread_id,
        request_key="approval-team-owner",
        user_id=execution_owner_id,
        kinds=("tool_approval",),
    )
    assert not can_resolve_pending_interaction(
        thread_id=thread_id,
        request_key="approval-team-owner",
        user_id=str(user.id),
        kinds=("tool_approval",),
    )


def test_runtime_source_must_own_session_and_match_frozen_device(pending_session):
    user, session, thread_id = pending_session
    session.target_device_installation_id = "daemon-frozen"
    session.save(update_fields=["target_device_installation_id"])

    assert runtime_can_open_interaction(
        thread_id=thread_id,
        user_id=str(user.id),
        source_device_fingerprint="daemon-frozen",
    )
    assert not runtime_can_open_interaction(
        thread_id=thread_id,
        user_id=str(uuid.uuid4()),
        source_device_fingerprint="daemon-frozen",
    )
    assert not runtime_can_open_interaction(
        thread_id=thread_id,
        user_id=str(user.id),
        source_device_fingerprint="daemon-other",
    )
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service._resolve_interaction_session",
        side_effect=RuntimeError("db down"),
    ):
        assert not runtime_can_open_interaction(
            thread_id=thread_id,
            user_id=str(user.id),
            source_device_fingerprint="daemon-frozen",
        )


def test_runtime_source_uses_execution_run_owner_and_exact_target(pending_session):
    session_owner, session, thread_id = pending_session
    session.target_device_installation_id = "session-owner-device"
    session.save(update_fields=["target_device_installation_id"])
    execution_owner_id = str(uuid.uuid4())
    run_id = uuid.uuid4()
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.publish_to_user",
    ):
        SessionRunStateService.accept_dispatch(
            thread_id=thread_id,
            run_id=str(run_id),
            task_id="shared-project-task",
            execution_owner_user_id=execution_owner_id,
            target_device_installation_id="execution-owner-device",
        )

    assert runtime_can_open_interaction(
        thread_id=thread_id,
        run_id=str(run_id),
        user_id=execution_owner_id,
        source_device_fingerprint="execution-owner-device",
    )
    assert not runtime_can_open_interaction(
        thread_id=thread_id,
        run_id=str(run_id),
        user_id=str(session_owner.id),
        source_device_fingerprint="session-owner-device",
    )


def test_non_targeted_runtime_source_must_match_workspace_device():
    session = SimpleNamespace(
        user_id="owner-1",
        target_device_installation_id="",
        workspace=SimpleNamespace(
            device=SimpleNamespace(fingerprint="workspace-device"),
        ),
    )
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service._resolve_interaction_session",
        return_value=session,
    ):
        assert runtime_can_open_interaction(
            thread_id="chat-session-session-1",
            user_id="owner-1",
            source_device_fingerprint="workspace-device",
        )
        assert not runtime_can_open_interaction(
            thread_id="chat-session-session-1",
            user_id="owner-1",
            source_device_fingerprint="other-owned-device",
        )


def test_project_legacy_runtime_without_run_uses_current_run_fact():
    session = SimpleNamespace(
        user_id="session-owner",
        project_id="project-1",
        organization_id="organization-1",
        target_device_installation_id="session-owner-device",
        workspace=None,
    )
    current_run = SimpleNamespace(
        run_id="run-1",
        user_id="execution-owner",
        metadata={"target_device_installation_id": "execution-device"},
    )
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service._resolve_interaction_session",
        return_value=session,
    ), patch(
        "apps.services.agent_engine.services.pending_interaction_service._resolve_current_interaction_run",
        return_value=current_run,
    ):
        assert runtime_can_open_interaction(
            thread_id="chat-session-session-1",
            user_id="execution-owner",
            source_device_fingerprint="execution-device",
        )
        assert not runtime_can_open_interaction(
            thread_id="chat-session-session-1",
            user_id="session-owner",
            source_device_fingerprint="session-owner-device",
        )


@pytest.mark.parametrize("daemon_control_enabled", [False, True])
def test_project_unknown_run_never_falls_back_to_current_run(
    daemon_control_enabled,
):
    session = SimpleNamespace(
        user_id="session-owner",
        project_id="project-1",
        target_device_installation_id="session-owner-device",
        workspace=None,
    )
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service._resolve_interaction_session",
        return_value=session,
    ), patch(
        "apps.services.agent_engine.services.pending_interaction_service._resolve_interaction_run",
        return_value=None,
    ), patch(
        "apps.services.agent_engine.services.pending_interaction_service._legacy_project_runtime_source_matches",
        return_value=False,
    ) as legacy_match, patch(
        "apps.services.daemon_control.feature.daemon_control_enabled_for_organization",
        return_value=daemon_control_enabled,
    ), override_settings(
        DAEMON_CONTROL_ENABLED=daemon_control_enabled,
    ):
        assert not runtime_can_open_interaction(
            thread_id="chat-session-session-1",
            run_id="unknown-run",
            user_id="execution-owner",
            source_device_fingerprint="execution-device",
        )
        if daemon_control_enabled:
            legacy_match.assert_not_called()
        else:
            legacy_match.assert_called_once()


def test_upsert_creates_queryable_pending_and_notifies_user(pending_session):
    user, _session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ) as publish_to_user:
        interaction = upsert_tool_approval_interaction(
            thread_id=thread_id,
            payload=_payload(),
            source_device_fingerprint="electron-test",
        )

        assert interaction is not None
        assert PendingInteraction.objects.count() == 1
        listed = list_pending_interactions_for_thread(str(user.id), thread_id)
        assert len(listed) == 1
        assert listed[0]["request_key"] == "approval-1"
        assert listed[0]["status"] == "pending"
        assert publish_to_user.call_count == 1
        assert publish_to_user.call_args.args[0] == str(user.id)
        assert publish_to_user.call_args.args[1]["type"] == "agent.user.interaction_requested"


def test_replayed_request_does_not_reopen_resolved_interaction(pending_session):
    _user, _session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ) as publish_to_user:
        upsert_tool_approval_interaction(thread_id=thread_id, payload=_payload())
        mark_tool_approval_resolved_from_payload(
            thread_id=thread_id,
            payload={"batch_id": "approval-1", "decisions": [{"outcome": "allow"}]},
        )

        replay = _payload()
        replay["action_requests"][0]["tool_name"] = "browser.changed"
        upsert_tool_approval_interaction(thread_id=thread_id, payload=replay)

        interaction = PendingInteraction.objects.get()
        assert interaction.status == "resolved"
        assert interaction.payload["action_requests"][0]["tool_name"] == "browser.act"
        assert publish_to_user.call_count == 2  # requested + resolved, no replay requested


def test_resolve_only_waits_for_pending_interactions_from_same_run(pending_session):
    _user, _session, thread_id = pending_session
    old_run_id = str(uuid.uuid4())
    current_run_id = str(uuid.uuid4())
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.transition",
    ) as transition:
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload={"request_id": "old-request", "run_id": old_run_id},
            publish=False,
        )
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload={"request_id": "current-request", "run_id": current_run_id},
            publish=False,
        )
        transition.reset_mock()

        mark_single_hitl_resolved(
            thread_id=thread_id,
            request_id="current-request",
            publish=False,
        )

    transition.assert_called_once_with(
        run_id=current_run_id,
        status="running",
        allowed_from=frozenset({"waiting_user"}),
    )


def test_resolve_does_not_resume_a_paused_session(pending_session):
    _user, session, thread_id = pending_session
    run_id = str(uuid.uuid4())
    session.is_paused = True
    session.save(update_fields=["is_paused"])
    with patch(
        "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.transition",
    ) as transition:
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload={"request_id": "paused-request", "run_id": run_id},
            publish=False,
        )
        transition.reset_mock()

        mark_single_hitl_resolved(
            thread_id=thread_id,
            request_id="paused-request",
            publish=False,
        )

    transition.assert_not_called()


def test_query_expires_stale_pending(pending_session):
    user, _session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ) as publish_to_user:
        payload = _payload("approval-expired")
        payload["expires_at"] = int((timezone.now().timestamp() - 1) * 1000)
        upsert_tool_approval_interaction(thread_id=thread_id, payload=payload, publish=False)

        expired = expire_due_interactions_for_user(str(user.id), thread_id=thread_id)

        assert expired == 0
        interaction = PendingInteraction.objects.get()
        assert interaction.status == "expired"
        assert publish_to_user.call_args.args[1]["type"] == "agent.user.interaction_expired"


def test_list_pending_interactions_is_scoped_to_user_and_organization(pending_session):
    user, _session, thread_id = pending_session
    other_user = User.objects.create_user(
        username=f"pending_other_{uuid.uuid4().hex[:8]}",
        email=f"pending-other-{uuid.uuid4().hex[:8]}@example.com",
        password="testpass123",
    )
    other_session = ChatSession.objects.create(
        user=other_user,
        organization_id="other-organization",
        title="other pending test",
    )
    other_thread_id = f"chat-session-{other_session.id}"

    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_tool_approval_interaction(thread_id=thread_id, payload=_payload("approval-owned"))
        upsert_tool_approval_interaction(thread_id=other_thread_id, payload=_payload("approval-other"))

    listed = list_pending_interactions_for_user(str(user.id))
    assert [item["request_key"] for item in listed] == ["approval-owned"]

    assert list_pending_interactions_for_user(
        str(user.id),
        organization_id="other-organization",
    ) == []
    scoped = list_pending_interactions_for_user(str(user.id), organization_id="pending-organization")
    assert [item["request_key"] for item in scoped] == ["approval-owned"]


def test_interaction_event_fans_out_to_execution_owner(pending_session):
    """#2355：team space 待办事实的 requested/resolved 事件要同时通知 execution owner。"""
    user, _session, thread_id = pending_session
    owner_id = str(uuid.uuid4())
    payload = _payload("approval-team")
    payload["team_space_execution"] = {
        "initiator_user_id": str(user.id),
        "execution_owner_user_id": owner_id,
        "collaboration_space_id": str(uuid.uuid4()),
    }

    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
        return_value=True,
    ) as publish_to_user:
        upsert_tool_approval_interaction(thread_id=thread_id, payload=payload)
        mark_tool_approval_resolved_from_payload(
            thread_id=thread_id,
            payload={"batch_id": "approval-team", "decisions": [{"outcome": "allow"}]},
        )

    requested_targets = [
        call.args[0] for call in publish_to_user.call_args_list
        if call.args[1]["type"] == "agent.user.interaction_requested"
    ]
    resolved_targets = [
        call.args[0] for call in publish_to_user.call_args_list
        if call.args[1]["type"] == "agent.user.interaction_resolved"
    ]
    assert set(requested_targets) == {str(user.id), owner_id}
    assert set(resolved_targets) == {str(user.id), owner_id}

    requested_by_recipient = {
        call.args[0]: call.args[1]["payload"]["interaction"]["payload"]
        for call in publish_to_user.call_args_list
        if call.args[1]["type"] == "agent.user.interaction_requested"
    }
    initiator_payload = requested_by_recipient[str(user.id)]
    assert initiator_payload == {
        "details_redacted": True,
        "action_requests": [{
            "request_id": "approval-team",
            "tool_call_id": "approval-team",
            "tool_name": "redacted_tool",
        }],
        "batch_id": "approval-team",
        "approval_type": "tool_permission",
        "runtime_mode": "interactive",
        "expires_at": payload["expires_at"],
        "schema_version": 1,
        "team_space_execution": payload["team_space_execution"],
    }

    execution_owner_payload = requested_by_recipient[owner_id]
    assert execution_owner_payload == payload


def test_execution_owner_sees_team_pending_in_global_list(pending_session):
    """#2355：execution owner 的全局 pending 列表要包含成员会话里的 team space 待办。"""
    user, _session, thread_id = pending_session
    owner_id = str(uuid.uuid4())
    stranger_id = str(uuid.uuid4())
    payload = _payload("approval-owner-visible")
    payload["team_space_execution"] = {
        "initiator_user_id": str(user.id),
        "execution_owner_user_id": owner_id,
        "collaboration_space_id": str(uuid.uuid4()),
    }

    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_tool_approval_interaction(thread_id=thread_id, payload=payload)

    owner_listed = list_pending_interactions_for_user(owner_id)
    assert [item["request_key"] for item in owner_listed] == ["approval-owner-visible"]

    member_listed = list_pending_interactions_for_user(str(user.id))
    assert [item["request_key"] for item in member_listed] == ["approval-owner-visible"]

    assert list_pending_interactions_for_user(stranger_id) == []


def test_action_approval_interaction_resolves_without_reappearing(pending_session):
    user, _session, thread_id = pending_session

    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ) as publish_to_user:
        interaction = upsert_action_approval_interaction(
            thread_id=thread_id,
            approval_id="approval-action-1",
            payload={
                "approval_id": "approval-action-1",
                "command": "open https://example.com",
                "thread_id": thread_id,
            },
            source_device_fingerprint="electron-test",
        )
        assert interaction is not None
        assert interaction.kind == "tool_approval"
        assert interaction.source == "agent_action"
        assert interaction.request_key == "approval-action-1"
        assert interaction.user_id == user.id

        resolved = mark_action_approval_resolved(
            thread_id=thread_id,
            approval_id="approval-action-1",
            approved=True,
            scope="once",
        )
        assert resolved is not None
        assert resolved.status == "resolved"

        replay = upsert_action_approval_interaction(
            thread_id=thread_id,
            approval_id="approval-action-1",
            payload={
                "approval_id": "approval-action-1",
                "command": "open https://changed.example.com",
                "thread_id": thread_id,
            },
        )

    assert replay is not None
    assert replay.status == "resolved"
    interaction.refresh_from_db()
    assert interaction.payload["command"] == "open https://example.com"
    assert list_pending_interactions_for_thread(str(user.id), thread_id) == []
    assert [
        call.args[1]["type"] for call in publish_to_user.call_args_list
    ] == [
        "agent.user.interaction_requested",
        "agent.user.interaction_resolved",
    ]


def test_single_hitl_interaction_is_queryable_and_resolved(pending_session):
    user, _session, thread_id = pending_session
    payload = {
        "request_id": "ask-1",
        "tool_name": "ask_user",
        "interaction_type": "choice",
        "blocking_policy": "blocking",
        "intent": "clarify",
        "form_mode": "single",
        "questions": [
            {
                "id": "q1",
                "prompt": "选哪个？",
                "header": "方向",
                "options": [{"id": "a", "label": "A", "description": ""}],
            }
        ],
    }

    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ) as publish_to_user:
        interaction = upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload=payload,
            source_device_fingerprint="electron-test",
        )

        assert interaction is not None
        assert interaction.kind == "ask_choice"
        assert interaction.request_key == "ask-1"
        listed = list_pending_interactions_for_thread(str(user.id), thread_id)
        assert len(listed) == 1
        assert listed[0]["payload"]["questions"][0]["id"] == "q1"

        resolved = mark_single_hitl_resolved(
            thread_id=thread_id,
            request_id="ask-1",
            result={"response": {"answers": []}},
        )

    assert resolved is not None
    assert resolved.status == "resolved"
    assert list_pending_interactions_for_thread(str(user.id), thread_id) == []
    assert [
        call.args[1]["type"] for call in publish_to_user.call_args_list
    ] == [
        "agent.user.interaction_requested",
        "agent.user.interaction_resolved",
    ]


# ── ：HITL 事实镜像为持久化 ChatMessage（hitl_interaction） ────────────────


# 新契约：hitl_interaction 消息本体由 **runtime 权威产出**（*_required / *_resolved
# 事件同发 persist_message，经 relay 落 ChatMessage）。pending_interaction_service 在
# runtime 在场的 create/resolve **不再自建** ChatMessage（避免与 persist 双写、撞
# client_event_id 唯一约束）；只保留 PendingInteraction（在线 waiter 登记 + 惰性过期）
# 与 runtime 不在场时（expire / cancel）的终态 _sync 兜底。


def test_upsert_does_not_self_author_hitl_chat_message(pending_session):
    """create：只建 PendingInteraction，不自建 hitl ChatMessage（runtime persist 才是作者）。"""
    _user, session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_tool_approval_interaction(thread_id=thread_id, payload=_payload())

    assert PendingInteraction.objects.filter(
        thread_id=thread_id, kind="tool_approval", request_key="approval-1", status="pending",
    ).exists()
    assert not ChatMessage.objects.filter(session=session, message_kind="hitl_interaction").exists()


def test_resolve_does_not_self_author_hitl_chat_message(pending_session):
    """resolve（runtime 在场）：翻 PendingInteraction 终态，但不自建 ChatMessage（runtime persist 权威）。"""
    _user, session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_tool_approval_interaction(thread_id=thread_id, payload=_payload())
        mark_tool_approval_resolved_from_payload(
            thread_id=thread_id,
            payload={"batch_id": "approval-1", "decisions": [{"outcome": "allow"}]},
        )

    pi = PendingInteraction.objects.get(thread_id=thread_id, kind="tool_approval", request_key="approval-1")
    assert pi.status == "resolved"
    assert not ChatMessage.objects.filter(session=session, message_kind="hitl_interaction").exists()


def test_expired_interaction_flips_hitl_chat_message_status(pending_session):
    user, session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        payload = _payload("approval-msg-expired")
        payload["expires_at"] = int((timezone.now().timestamp() - 1) * 1000)
        upsert_tool_approval_interaction(thread_id=thread_id, payload=payload, publish=False)
        expire_due_interactions_for_user(str(user.id), thread_id=thread_id)

    msg = ChatMessage.objects.get(session=session, message_kind="hitl_interaction")
    assert msg.metadata["hitl"]["status"] == "expired"


def test_dead_runtime_hitl_chat_message_payload_is_redacted(pending_session):
    """runtime 不在场的终态（cancel）由 service _sync 落库——team space payload 必须脱敏
    （与 thread 广播同口径）；runtime 在场路径的脱敏由 relay_message_writer 在写 persist
    落库前做（见 test_relay_message_writer）。"""
    user, session, thread_id = pending_session
    payload = _payload("approval-team-msg")
    payload["team_space_execution"] = {
        "initiator_user_id": str(user.id),
        "execution_owner_user_id": str(uuid.uuid4()),
        "collaboration_space_id": str(uuid.uuid4()),
    }
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_tool_approval_interaction(thread_id=thread_id, payload=payload)
        cancel_pending_interactions_by_thread(thread_id, reason="runtime_gone", publish=False)

    msg = ChatMessage.objects.get(session=session, message_kind="hitl_interaction")
    stored = msg.metadata["hitl"]["payload"]
    assert stored["details_redacted"] is True
    assert stored["action_requests"][0]["tool_name"] == "redacted_tool"
    assert "tool_input" not in stored["action_requests"][0]
    assert stored["batch_id"] == "approval-team-msg"


def test_single_hitl_create_resolve_does_not_self_author(pending_session):
    """ask 追问的 create/resolve（runtime 在场）同样不自建 ChatMessage（runtime persist 权威）。"""
    _user, session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload={"request_id": "ask-msg-1", "questions": [{"id": "q1"}]},
        )
        mark_single_hitl_resolved(
            thread_id=thread_id,
            request_id="ask-msg-1",
            result={"response": {"answers": []}},
        )

    pi = PendingInteraction.objects.get(thread_id=thread_id, kind="ask_choice", request_key="ask-msg-1")
    assert pi.status == "resolved"
    assert not ChatMessage.objects.filter(session=session, message_kind="hitl_interaction").exists()


def test_cancel_pending_interactions_by_thread_marks_hitl_message_cancelled(pending_session):
    """#5526：runtime 销毁取消 pending 后，hitl 消息必须终态化，阻止幽灵卡恢复。"""
    _user, session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_tool_approval_interaction(thread_id=thread_id, payload=_payload("approval-runtime-gone"))
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload={"request_id": "ask-runtime-gone", "questions": [{"id": "q1"}]},
        )
        cancelled = cancel_pending_interactions_by_thread(
            thread_id,
            reason="runtime_gone",
            publish=True,
        )

    assert cancelled == 2
    assert PendingInteraction.objects.filter(thread_id=thread_id, status="pending").count() == 0
    approval_msg = ChatMessage.objects.get(
        session=session,
        client_event_id=hitl_message_client_event_id("tool_approval", "approval-runtime-gone"),
    )
    ask_msg = ChatMessage.objects.get(
        session=session,
        client_event_id=hitl_message_client_event_id("ask_choice", "ask-runtime-gone"),
    )
    assert approval_msg.metadata["hitl"]["status"] == "cancelled"
    assert approval_msg.metadata["hitl"]["result"]["reason"] == "runtime_gone"
    assert ask_msg.metadata["hitl"]["status"] == "cancelled"
    # 幂等：再调一次不再重复取消
    assert cancel_pending_interactions_by_thread(thread_id, reason="runtime_gone") == 0


# ── ：单 HITL 断点恢复查询 ────────────────────────────────
#
# 覆盖 list_pending_single_hitl_for_thread 的关键分支：
#   1. 仅 pending → 返回 wire 形态
#   2. 混合 pending + resolved（近期）→ 两条都返回
#   3. resolved 但久远（超过 5min 回窗）→ 不返回
#   4. pending 但 expires_at < now → 翻成 expired
#   5. include_resolved=False → 仅 pending
#   6. 非法 thread_id → 空
#   7. 无 pending 行 → 空
#   8. tool_approval 类 → 不被 single_hitl 查询命中（走 pending_approvals 通道）


def _single_hitl_payload(request_id: str = "ask-x", *, runtime_mode: str = "interactive") -> dict:
    return {
        "request_id": request_id,
        "tool_name": "ask_user",
        "interaction_type": "ask_user",
        "blocking_policy": "hard",
        "intent": "choose",
        "form_mode": "questions",
        "runtime_mode": runtime_mode,
        "questions": [
            {
                "id": "q1",
                "prompt": "选哪个？",
                "header": "方向",
                "options": [{"id": "y", "label": "Yes", "description": ""}],
            }
        ],
    }


def test_list_pending_single_hitl_returns_pending_row(pending_session):
    _user, _session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload=_single_hitl_payload("ask-6022-1", runtime_mode="solo"),
        )
    rows = list_pending_single_hitl_for_thread(thread_id)
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == "ask_choice"
    assert row["request_key"] == "ask-6022-1"
    assert row["status"] == "pending"
    assert row["thread_id"] == thread_id
    # runtime_mode 从 payload 反推
    assert row["runtime_mode"] == "solo"
    # payload 直接透传
    assert row["payload"]["tool_name"] == "ask_user"
    assert row["payload"]["questions"][0]["id"] == "q1"


def test_list_pending_single_hitl_includes_resolved_recent(pending_session):
    _user, _session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        # pending
        upsert_single_hitl_interaction(
            kind="ask_form",
            thread_id=thread_id,
            payload=_single_hitl_payload("ask-6022-2"),
        )
        # resolved（近期）
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload=_single_hitl_payload("ask-6022-3"),
        )
        mark_single_hitl_resolved(
            thread_id=thread_id,
            request_id="ask-6022-3",
            result={"answers": [{"question_id": "q1", "selected_options": ["y"]}]},
        )

    rows = list_pending_single_hitl_for_thread(thread_id)
    assert len(rows) == 2
    statuses = sorted(r["status"] for r in rows)
    assert statuses == ["pending", "resolved"]
    resolved_row = next(r for r in rows if r["status"] == "resolved")
    assert resolved_row["request_key"] == "ask-6022-3"
    assert resolved_row["result"]["answers"][0]["selected_options"] == ["y"]


def test_list_pending_single_hitl_skips_stale_resolved(pending_session):
    _user, _session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload=_single_hitl_payload("ask-old"),
        )
        mark_single_hitl_resolved(
            thread_id=thread_id,
            request_id="ask-old",
            result={"answers": []},
        )
    # 手工把 resolved_at 拨老到超过 5min 回窗
    from datetime import timedelta as _td
    stale = timezone.now() - _td(minutes=10)
    PendingInteraction.objects.filter(
        thread_id=thread_id, kind="ask_choice", request_key="ask-old",
    ).update(resolved_at=stale, updated_at=stale)

    rows = list_pending_single_hitl_for_thread(thread_id)
    assert rows == []


def test_list_pending_single_hitl_flips_expired_pending(pending_session):
    _user, _session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        payload = _single_hitl_payload("ask-expired")
        # 直接给一个过期 expires_at（比 DEFAULT_INTERACTION_TTL_SECONDS 早）
        payload["expires_at"] = int((timezone.now().timestamp() - 60) * 1000)
        upsert_single_hitl_interaction(
            kind="permission_request",
            thread_id=thread_id,
            payload=payload,
        )

    rows = list_pending_single_hitl_for_thread(thread_id)
    assert len(rows) == 1
    # pending 但 expires_at < now → 翻成 expired（runtime 侧走 inject 兜底文案）
    assert rows[0]["status"] == "expired"


def test_list_pending_single_hitl_include_resolved_false(pending_session):
    _user, _session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_single_hitl_interaction(
            kind="ask_choice",
            thread_id=thread_id,
            payload=_single_hitl_payload("ask-pending"),
        )
        upsert_single_hitl_interaction(
            kind="ask_form",
            thread_id=thread_id,
            payload=_single_hitl_payload("ask-resolved"),
        )
        mark_single_hitl_resolved(
            thread_id=thread_id,
            request_id="ask-resolved",
            result={"skipped": True},
        )
    rows = list_pending_single_hitl_for_thread(thread_id, include_resolved=False)
    assert len(rows) == 1
    assert rows[0]["status"] == "pending"


def test_list_pending_single_hitl_ignores_tool_approval(pending_session):
    """tool_approval 走 ConversationState.interrupt_state.pending_approvals，
    不应被 single_hitl 查询命中。"""
    _user, _session, thread_id = pending_session
    with patch(
        "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
    ):
        upsert_tool_approval_interaction(thread_id=thread_id, payload=_payload("approval-6022"))
    rows = list_pending_single_hitl_for_thread(thread_id)
    assert rows == []


def test_list_pending_single_hitl_empty_thread():
    """空 thread_id / 未见过的 thread → 空列表，不报错。"""
    assert list_pending_single_hitl_for_thread("") == []
    assert list_pending_single_hitl_for_thread(f"chat-session-{uuid.uuid4()}") == []


def test_resolve_marks_hitl_waiting_notifications_once(pending_session):
    """#5337：pending → 终态时按 interaction_id 清铃铛；重复 resolve 不二次调用。"""
    _user, _session, thread_id = pending_session
    with (
        patch(
            "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
        ),
        patch(
            "apps.services.notification.services.notification_service"
            ".NotificationService.mark_agent_hitl_waiting_read",
            return_value=1,
        ) as mark_hitl_read,
    ):
        interaction = upsert_tool_approval_interaction(
            thread_id=thread_id,
            payload=_payload("approval-ack-hitl"),
            publish=False,
        )
        assert interaction is not None

        mark_tool_approval_resolved_from_payload(
            thread_id=thread_id,
            payload={
                "batch_id": "approval-ack-hitl",
                "decisions": [{"outcome": "allow"}],
            },
        )
        mark_tool_approval_resolved_from_payload(
            thread_id=thread_id,
            payload={
                "batch_id": "approval-ack-hitl",
                "decisions": [{"outcome": "allow"}],
            },
        )

        assert mark_hitl_read.call_count == 1
        assert mark_hitl_read.call_args.kwargs["interaction_id"] == str(interaction.id)
        assert mark_hitl_read.call_args.kwargs["request_key"] == "approval-ack-hitl"

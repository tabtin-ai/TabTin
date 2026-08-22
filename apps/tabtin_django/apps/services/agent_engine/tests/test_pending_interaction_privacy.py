from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from apps.services.agent_engine.services.pending_interaction_service import (
    TEAM_SPACE_EXECUTION_REDACTION_REQUIRED_KEY,
    redact_team_space_tool_approval_payload,
    serialize_interaction,
)


def _interaction(payload: dict) -> SimpleNamespace:
    now = datetime(2026, 7, 3, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=uuid.uuid4(),
        kind="tool_approval",
        status="pending",
        thread_id="chat-session-team",
        session_id=uuid.uuid4(),
        organization_id=uuid.uuid4(),
        user_id="user-owner",
        request_key="batch-team",
        source="agent_stream",
        payload=payload,
        result={},
        expires_at=now,
        resolved_at=None,
        created_at=now,
        updated_at=now,
    )


def _team_payload() -> dict:
    return {
        "batch_id": "batch-team",
        "approval_type": "tool_permission",
        "action_requests": [
            {
                "request_id": "req-team",
                "tool_call_id": "call-team",
                "tool_name": "run_terminal_command",
                "tool_input": {"command": "touch team.txt"},
                "decision_reason": {"type": "workspace_out", "path": "/private/team.txt"},
            }
        ],
        "runtime_mode": "interactive",
        "schema_version": 1,
        # ：与 hitl_interaction 同源的稳定 UUID，脱敏后仍须保留
        "message_id": "2c07a4d6-60fb-54af-8491-786b724e100c",
        "team_space_execution": {
            "collaboration_space_id": "space-team",
            "execution_space_id": "space-owner",
            "initiator_user_id": "user-member",
            "execution_owner_user_id": "user-owner",
        },
    }


def test_team_space_tool_approval_payload_full_for_execution_owner() -> None:
    payload = serialize_interaction(
        _interaction(_team_payload()),
        viewer_user_id="user-owner",
    )["payload"]

    action = payload["action_requests"][0]
    assert action["tool_name"] == "run_terminal_command"
    assert action["tool_input"]["command"] == "touch team.txt"
    assert action["decision_reason"]["path"] == "/private/team.txt"


def test_team_space_tool_approval_payload_redacted_for_non_owner_member() -> None:
    payload = serialize_interaction(
        _interaction(_team_payload()),
        viewer_user_id="user-member",
    )["payload"]

    assert payload["details_redacted"] is True
    assert payload["team_space_execution"]["execution_owner_user_id"] == "user-owner"
    assert payload["team_space_execution"]["initiator_user_id"] == "user-member"
    assert payload["action_requests"] == [{
        "request_id": "req-team",
        "tool_call_id": "call-team",
        "tool_name": "redacted_tool",
    }]
    assert "tool_input" not in payload["action_requests"][0]
    assert "decision_reason" not in payload["action_requests"][0]
    assert "allowed_scopes" not in payload["action_requests"][0]
    assert "allowed_outcomes" not in payload["action_requests"][0]


def test_redaction_helper_leaves_personal_approval_payload_unchanged() -> None:
    payload = _team_payload()
    payload.pop("team_space_execution")

    assert redact_team_space_tool_approval_payload(payload) is payload


def test_redaction_helper_removes_sensitive_details_from_team_broadcast() -> None:
    payload = redact_team_space_tool_approval_payload(_team_payload())

    assert payload["details_redacted"] is True
    assert payload["action_requests"] == [{
        "request_id": "req-team",
        "tool_call_id": "call-team",
        "tool_name": "redacted_tool",
    }]
    assert payload["team_space_execution"]["execution_owner_user_id"] == "user-owner"
    assert payload["message_id"] == "2c07a4d6-60fb-54af-8491-786b724e100c"


def test_redaction_helper_conservatively_redacts_when_team_metadata_missing() -> None:
    payload = _team_payload()
    payload.pop("team_space_execution")
    payload[TEAM_SPACE_EXECUTION_REDACTION_REQUIRED_KEY] = True

    redacted = redact_team_space_tool_approval_payload(payload)

    assert redacted["details_redacted"] is True
    assert redacted["action_requests"] == [{
        "request_id": "req-team",
        "tool_call_id": "call-team",
        "tool_name": "redacted_tool",
    }]
    assert TEAM_SPACE_EXECUTION_REDACTION_REQUIRED_KEY not in redacted
    assert "tool_input" not in redacted["action_requests"][0]
    assert "decision_reason" not in redacted["action_requests"][0]

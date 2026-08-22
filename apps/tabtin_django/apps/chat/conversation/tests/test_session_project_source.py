from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from apps.chat.conversation.api.session import _build_session_summary


def test_session_summary_exposes_companion_project_source():
    session = MagicMock()
    session.id = "session-1"
    session.title = "Release audit"
    session.status = "active"
    session.organization_id = "organization-1"
    session.workspace_id = "workspace-1"
    session.space_id = None
    session.created_at = datetime(2026, 7, 18, tzinfo=timezone.utc)
    session.updated_at = session.created_at
    session.last_message_at = None
    session.revert_message_id = None
    session._total_message_count = 0
    session._last_msg_role = None
    session._last_msg_content = ""
    session.title_generation_status = None
    session.agent_id = "agent-2"

    with patch(
        "apps.chat.conversation.api.session._build_session_rollback_state",
        return_value=None,
    ), patch(
        "apps.chat.conversation.services.title_generator.TitleGeneratorService.should_auto_generate_title",
        return_value=False,
    ):
        summary = _build_session_summary(
            session,
            space_info={
                "workspace-1": {
                    "name": "Allen's Space",
                    "project_id": "project-1",
                    "project_name": "Mobile Launch",
                    "agent_id": "agent-legacy",
                    "icon": None,
                    "avatar": None,
                },
            },
            agent_info={
                "agent-2": {
                    "name": "Release Agent",
                    "type": "bot",
                },
            },
        )

    assert summary.space_id == "workspace-1"
    assert summary.space_name == "Allen's Space"
    assert summary.project_id == "project-1"
    assert summary.project_name == "Mobile Launch"
    assert summary.agent_id == "agent-2"
    assert summary.agent_name == "Release Agent"

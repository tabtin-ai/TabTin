"""会话列表二行预览：最后一条不论出自 Agent 还是用户，都要给预览。

过去只有 `last_role == 'assistant'` 才回填，用户刚发完话列表就空一行；
Electron 发送时本来就用用户输入做乐观预览，刷新后被抹掉是不一致。
向前兼容：只是把过去恒为 None 的分支填上值，字段类型语义不变。
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.chat.conversation.api.session import _build_session_summary


def _session(role: str, content: str):
    s = MagicMock()
    s.id = "session-1"
    s.title = "周报"
    s.status = "active"
    s.organization_id = "org-1"
    s.workspace_id = "workspace-1"
    s.project_id = None
    s.agent_id = None
    s.target_device_id = ""
    s.created_at = datetime(2026, 8, 1, tzinfo=timezone.utc)
    s.updated_at = s.created_at
    s.last_message_at = None
    s.revert_message_id = None
    s._total_message_count = 2
    s._last_msg_role = role
    s._last_msg_content = content
    s.title_generation_status = None
    return s


def _summary(role: str, content: str, workspace=None):
    session = _session(role, content)
    with patch(
        "apps.chat.conversation.api.session._build_session_rollback_state",
        return_value=None,
    ), patch(
        "apps.chat.conversation.services.title_generator."
        "TitleGeneratorService.should_auto_generate_title",
        return_value=False,
    ), patch(
        "apps.services.agent_engine.services.session_read_state_service."
        "SessionReadStateService.snapshot",
        return_value={"has_unread_reply": False, "read_state": None},
    ), patch(
        # 运行态投影不是本用例的关注点；Mock 出来的字段过不了 schema 校验。
        "apps.services.agent_engine.services.session_run_state_service."
        "serialize_run_state",
        return_value=None,
    ):
        return _build_session_summary(
            session,
            space_info={"workspace-1": workspace or {"name": "默认 Workspace"}},
            project_info={},
            agent_info={},
        )


@pytest.mark.django_db
def test_assistant_last_message_has_preview():
    assert _summary("assistant", "我已经把表建好了").last_message_preview == "我已经把表建好了"


@pytest.mark.django_db
def test_user_last_message_also_has_preview():
    """回归点：过去这里返回 None，列表二行会空掉。"""
    assert _summary("user", "帮我把上周数据做成周报").last_message_preview == "帮我把上周数据做成周报"


@pytest.mark.django_db
def test_empty_content_still_yields_none():
    assert _summary("user", "").last_message_preview is None


@pytest.mark.django_db
def test_summary_includes_authoritative_execution_target():
    summary = _summary("user", "执行", {
        "name": "默认 Workspace",
        "device_id": "device-1",
    })

    assert summary.execution_target == {
        "kind": "bound_device",
        "device_identity_key": "device-1",
    }


@pytest.mark.django_db
def test_summary_preserves_legacy_frozen_execution_target():
    session = _session("user", "执行")
    session.target_device_id = "frozen-device"
    with patch(
        "apps.chat.conversation.api.session._build_session_rollback_state",
        return_value=None,
    ), patch(
        "apps.chat.conversation.services.title_generator."
        "TitleGeneratorService.should_auto_generate_title",
        return_value=False,
    ), patch(
        "apps.services.agent_engine.services.session_read_state_service."
        "SessionReadStateService.snapshot",
        return_value={"has_unread_reply": False, "read_state": None},
    ), patch(
        "apps.services.agent_engine.services.session_run_state_service."
        "serialize_run_state",
        return_value=None,
    ):
        summary = _build_session_summary(
            session,
            space_info={"workspace-1": {"name": "默认 Workspace", "device_id": "current-device"}},
            project_info={},
            agent_info={},
        )

    assert summary.execution_target == {
        "kind": "bound_device",
        "device_identity_key": "frozen-device",
    }

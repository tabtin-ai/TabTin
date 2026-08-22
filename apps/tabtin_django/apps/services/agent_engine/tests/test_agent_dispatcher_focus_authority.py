"""AgentDispatcher · Session/TaskRun → ``_server_focus_authority``（ R2-1）。

权威 Session 绑定 TaskRun 时，即使客户端视觉 Focus 仅为 tabdoc/chat，
forward 的 app_context 仍须携带服务端权威 project/task 锚点。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.agent_engine.context.focus_snapshot import SERVER_FOCUS_AUTHORITY_KEY
from apps.services.agent_engine.engine.agent_dispatcher import AgentDispatcher


def _make_space(space_id="space-1", organization_id="wt-1"):
    space = MagicMock()
    space.id = space_id
    space.organization_id = organization_id
    agent = MagicMock()
    agent.id = "agent-1"
    agent.custom_rules = ""
    agent.agent_config = {}
    space.agent = agent
    return space


def _make_session(session_id="sess-1", thread_id="chat-session-sess-1"):
    session = MagicMock()
    session.id = session_id
    session.user_id = "user-1"
    session.effective_thread_id = thread_id
    return session


def _resolve_config_stub(*_args, **_kwargs):
    config = MagicMock()
    config.agent_config = {}
    config.agent_id = "agent-1"
    config.custom_rules = ""
    config.approval_mode = "always_ask"
    config.approval_grant = "always_ask"
    config.working_dir_type = "code"
    config.workspace_root = "/Users/me/dev"
    config.agent_owner_user_id = "user-1"
    return config


@patch(
    "apps.services.agent_engine.engine.agent_dispatcher._resolve_disabled_apps_for_space",
    return_value=[],
)
@patch(
    "apps.services.agent_engine.engine.agent_dispatcher._resolve_disabled_tool_prefixes",
    return_value=[],
)
@patch(
    "apps.services.agent_engine.persistence.conversation_store."
    "ConversationStore.peek_interrupt_state",
    return_value=None,
)
@patch(
    "apps.services.agent_execution.effective_runtime_config."
    "resolve_effective_runtime_config",
    new=_resolve_config_stub,
)
class AgentDispatcherFocusAuthorityTests(SimpleTestCase):

    @patch(
        "apps.tabtinspace.services.project_task_runtime."
        "resolve_project_task_execution_anchor",
        return_value={
            "project_id": "proj-1",
            "task_id": "task-1",
            "task_run_id": "run-1",
            "collaboration_space_id": "proj-1",
            "execution_space_id": "ws-1",
        },
    )
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_session_task_run_authority_even_when_visual_is_tabdoc(
        self, mock_pfs_cls, _resolve_anchor, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-auth", "published": 1}
        instance.derive_enabled_apps_for_forward.return_value = []
        instance.derive_human_readable_names_for_forward.return_value = {
            "space_name": "ws",
            "organization_name": "org",
        }
        instance.resolve_personal_rules_by_owner_id.return_value = ""

        AgentDispatcher().dispatch_external(
            _make_session(),
            "继续改文档",
            _make_space(),
            attachments=None,
            thread_id="chat-session-sess-1",
            app_context={
                "appType": "tabdoc",
                "spaceId": "ws-1",
                "appMeta": {"current_doc_id": "doc-1"},
            },
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        app_context = kwargs["app_context"]
        self.assertEqual(app_context["appType"], "tabdoc")
        authority = app_context[SERVER_FOCUS_AUTHORITY_KEY]
        self.assertEqual(authority["collaborationSpaceId"], "proj-1")
        self.assertEqual(authority["executionSpaceId"], "ws-1")
        self.assertEqual(authority["appMeta"]["project_id"], "proj-1")
        self.assertEqual(authority["appMeta"]["task_id"], "task-1")
        self.assertEqual(authority["appMeta"]["task_run_id"], "run-1")

    @patch(
        "apps.tabtinspace.services.project_task_runtime."
        "resolve_project_task_execution_anchor",
        return_value={
            "project_id": "proj-1",
            "task_id": "task-1",
            "task_run_id": "run-1",
            "collaboration_space_id": "proj-1",
            "execution_space_id": "ws-1",
        },
    )
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_session_task_run_authority_even_when_visual_is_chat(
        self, mock_pfs_cls, _resolve_anchor, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-chat", "published": 1}
        instance.derive_enabled_apps_for_forward.return_value = []
        instance.derive_human_readable_names_for_forward.return_value = {
            "space_name": "ws",
            "organization_name": "org",
        }
        instance.resolve_personal_rules_by_owner_id.return_value = ""

        AgentDispatcher().dispatch_external(
            _make_session(),
            "追问一句",
            _make_space(),
            attachments=None,
            thread_id="chat-session-sess-1",
            app_context={"appType": "chat", "spaceId": "ws-1"},
        )

        app_context = instance.forward_prompt.call_args.kwargs["app_context"]
        self.assertEqual(app_context["appType"], "chat")
        authority = app_context[SERVER_FOCUS_AUTHORITY_KEY]
        self.assertEqual(authority["appMeta"]["project_id"], "proj-1")
        self.assertEqual(authority["appMeta"]["task_id"], "task-1")

    @patch(
        "apps.tabtinspace.services.project_task_runtime."
        "resolve_project_task_execution_anchor",
        return_value=None,
    )
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_ordinary_chat_has_no_task_authority(
        self, mock_pfs_cls, _resolve_anchor, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-plain", "published": 1}
        instance.derive_enabled_apps_for_forward.return_value = []
        instance.derive_human_readable_names_for_forward.return_value = {
            "space_name": "ws",
            "organization_name": "org",
        }
        instance.resolve_personal_rules_by_owner_id.return_value = ""

        AgentDispatcher().dispatch_external(
            _make_session(),
            "普通聊天",
            _make_space(),
            attachments=None,
            thread_id="chat-session-sess-1",
            app_context={"appType": "chat"},
        )

        app_context = instance.forward_prompt.call_args.kwargs["app_context"]
        self.assertNotIn(SERVER_FOCUS_AUTHORITY_KEY, app_context)

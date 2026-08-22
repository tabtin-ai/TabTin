"""``AgentDispatcher.dispatch_external`` 把 ``app_context['workspace_snapshot']``
透传给 ``PromptForwardService.forward_prompt`` 的窄修补单测（W6 M3 · L-W6-02）。

PD-12 + W6 M2 在 wire / Daemon / Python pydantic 三层都加了
``workspace_snapshot`` 字段，但 M2 时 ``AgentDispatcher`` /
``forward_to_local_runtime`` 两个调用方仍未把客户端上传的快照传给
``forward_prompt`` —— 链路就此断在 dispatcher 层。

本测试覆盖 W6 M3 的接通修复：
1. 客户端在 ``app_context['workspace_snapshot']`` 上传 dict → dispatcher 把
   它原样透传给 ``forward_prompt(workspace_snapshot=...)``
2. ``app_context`` 缺失 / 不含 ``workspace_snapshot`` → 透传 None（与"未传"
   等价；下游 wire schema z.unknown() + Daemon decodeWorkspaceSnapshot type
   guard 会兜底为 undefined，daemon 退化到 sandbox-only 工作区）
3. ``app_context['workspace_snapshot']`` 是非 dict / 空 dict → 透传 None
   （防御性：避免畸形客户端 payload 把 ``[]`` / ``"foo"`` 当 snapshot 注入
   wire payload，让 Daemon 端 type guard 单独承担更复杂的形态校验）

不连真实 DB（``SimpleTestCase``）：``ConversationStore`` 与
``PromptForwardService`` 都被 mock，单测仅校验 caller 层的数据搬运逻辑。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.services.agent_engine.engine.agent_dispatcher import AgentDispatcher
from apps.services.daemon_control.client import TargetDeviceUnavailable


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


def _make_workspace_snapshot():
    return {
        "sources": {
            "sandbox": "/Users/me/.tabtin/sandbox/space-1",
            "tabcodeProjects": ["/Users/me/dev/midscene"],
            "tabfolderDirs": ["/Users/me/Documents/work"],
            "attachedFiles": [],
        },
        "allowedPaths": [
            "/Users/me/.tabtin/sandbox/space-1",
            "/Users/me/dev/midscene",
            "/Users/me/Documents/work",
        ],
        "allowedFiles": [],
        "spaceSessionId": "space-1::session-abc",
    }


def _resolve_config_stub(*_args, **_kwargs):
    config = MagicMock()
    config.agent_config = {}
    config.agent_id = "agent-1"
    config.custom_rules = ""
    config.approval_mode = "always_ask"
    config.approval_grant = "always_ask"
    config.working_dir_type = "code"
    config.workspace_root = "/Users/me/dev"
    config.device_fingerprint = "electron-installation-1"
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
class AgentDispatcherWorkspaceSnapshotForwardTests(SimpleTestCase):
    def setUp(self):
        self.feature_patch = patch(
            "apps.platform_config.services.PlatformRuntimeConfigService.evaluate_feature",
            return_value=SimpleNamespace(enabled=True),
        )
        self.feature_patch.start()
        self.addCleanup(self.feature_patch.stop)

    @override_settings(TABTIN_EDITION="community", DAEMON_CONTROL_ENABLED=False)
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_community_freezes_effective_workspace_device_for_prompt_admission(
        self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "run here",
            _make_space(),
            thread_id="chat-session-sess-1",
        )

        self.assertEqual(
            instance.forward_prompt.call_args.kwargs["target_device_fingerprint"],
            "electron-installation-1",
        )

    @override_settings(DAEMON_CONTROL_ENABLED=False)
    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    @patch("apps.services.daemon_control.client.resolve_device")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_team_execution_keeps_legacy_workspace_route_when_control_is_disabled(
        self, mock_pfs_cls, resolve_device, resolve_installation,
        _peek, _disabled_prefixes, _disabled_apps,
    ):
        session = _make_session()
        session.target_device_id = "session-owner-device"
        session.target_device_installation_id = "session-owner-installation"
        session.workspace = SimpleNamespace(
            id="session-owner-workspace",
            device=SimpleNamespace(fingerprint="session-owner-installation"),
        )
        execution_workspace = SimpleNamespace(
            id="initiator-workspace",
            organization_id="wt-1",
            device=SimpleNamespace(fingerprint="initiator-installation"),
        )
        execution_context = SimpleNamespace(
            is_team_space=True,
            collaboration_space_id="project-1",
            execution_space_id="initiator-workspace",
            initiator_user_id="initiator-user",
            execution_owner_user_id="initiator-user",
            execution_space=execution_workspace,
        )
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid", "published": 1}

        AgentDispatcher().dispatch_external(
            session,
            "run in my workspace",
            _make_space(),
            thread_id="chat-session-sess-1",
            execution_context=execution_context,
        )

        resolve_device.assert_not_called()
        resolve_installation.assert_not_called()
        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertIs(kwargs["space"], execution_workspace)
        self.assertEqual(kwargs["execution_owner_user_id"], "initiator-user")
        self.assertIsNone(kwargs["target_device_fingerprint"])

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_team_execution_validates_workspace_installation_before_exact_route(
        self, mock_pfs_cls, resolve_installation,
        _peek, _disabled_prefixes, _disabled_apps,
    ):
        session = _make_session()
        session.target_device_id = "session-owner-device"
        execution_workspace = SimpleNamespace(
            id="initiator-workspace",
            organization_id="wt-1",
            device=SimpleNamespace(fingerprint="initiator-installation"),
        )
        execution_context = SimpleNamespace(
            is_team_space=True,
            collaboration_space_id="project-1",
            execution_space_id="initiator-workspace",
            initiator_user_id="initiator-user",
            execution_owner_user_id="initiator-user",
            execution_space=execution_workspace,
        )
        resolve_installation.return_value = {
            "installation_id": "initiator-installation",
        }
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid", "published": 1}

        AgentDispatcher().dispatch_external(
            session,
            "run in my workspace",
            _make_space(),
            thread_id="chat-session-sess-1",
            execution_context=execution_context,
        )

        resolve_installation.assert_called_once_with(
            owner_user_id="initiator-user",
            installation_id="initiator-installation",
        )
        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertIs(kwargs["space"], execution_workspace)
        self.assertEqual(
            kwargs["target_device_fingerprint"],
            "initiator-installation",
        )

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_team_execution_does_not_fall_back_when_installation_is_unavailable(
        self, mock_pfs_cls, resolve_installation,
        _peek, _disabled_prefixes, _disabled_apps,
    ):
        session = _make_session()
        execution_workspace = SimpleNamespace(
            id="initiator-workspace",
            organization_id="wt-1",
            device=SimpleNamespace(fingerprint="initiator-installation"),
        )
        execution_context = SimpleNamespace(
            is_team_space=True,
            collaboration_space_id="project-1",
            execution_space_id="initiator-workspace",
            initiator_user_id="initiator-user",
            execution_owner_user_id="initiator-user",
            execution_space=execution_workspace,
        )
        resolve_installation.side_effect = TargetDeviceUnavailable(
            "目标设备不存在或当前不可接单",
        )

        result = AgentDispatcher().dispatch_external(
            session,
            "run in my workspace",
            _make_space(),
            thread_id="chat-session-sess-1",
            execution_context=execution_context,
        )

        self.assertEqual(result["published"], 0)
        resolve_installation.assert_called_once_with(
            owner_user_id="initiator-user",
            installation_id="initiator-installation",
        )
        mock_pfs_cls.assert_not_called()

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch("apps.services.daemon_control.client.resolve_device")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_frozen_target_device_is_resolved_and_forwarded(
        self, mock_pfs_cls, resolve_device, _peek, _disabled_prefixes, _disabled_apps,
    ):
        session = _make_session()
        session.target_device_id = "control-device-1"
        session.target_device_installation_id = "daemon-installation-1"
        resolve_device.return_value = {
            "device_id": "control-device-1",
            "installation_id": "daemon-installation-1",
        }
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid", "published": 1}

        AgentDispatcher().dispatch_external(
            session,
            "run here",
            _make_space(),
            thread_id="chat-session-sess-1",
        )

        resolve_device.assert_called_once_with(
            owner_user_id="user-1",
            device_id="control-device-1",
        )
        self.assertEqual(
            instance.forward_prompt.call_args.kwargs["target_device_fingerprint"],
            "daemon-installation-1",
        )

    @override_settings(DAEMON_CONTROL_ENABLED=False)
    @patch("apps.services.daemon_control.client.resolve_device")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_frozen_target_is_not_dispatched_when_daemon_control_is_disabled(
        self, mock_pfs_cls, resolve_device, _peek, _disabled_prefixes, _disabled_apps,
    ):
        session = _make_session()
        session.target_device_id = "control-device-1"

        result = AgentDispatcher().dispatch_external(
            session,
            "run here",
            _make_space(),
            thread_id="chat-session-sess-1",
        )

        self.assertEqual(result["published"], 0)
        resolve_device.assert_not_called()
        mock_pfs_cls.assert_not_called()

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_workspace_snapshot_in_app_context_forwarded_to_prompt(
        self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps,
    ):
        snap = _make_workspace_snapshot()
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-snap", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "ls 我的项目",
            _make_space(),
            attachments=None,
            thread_id="chat-session-sess-1",
            app_context={
                "current_space_id": "space-1",
                "workspace_snapshot": snap,
            },
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertIn("workspace_snapshot", kwargs)
        self.assertEqual(kwargs["workspace_snapshot"], snap)

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_blocks_forwarded_as_user_message_blocks(self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps):
        """#6559：chat content_blocks 非 text 块透传到 wire user_message_blocks。"""
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-blocks", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "看这张表",
            _make_space(),
            attachments=None,
            blocks=[
                {"type": "text", "text": "看这张表"},
                {"type": "table_selection", "table_id": "t1", "preview": "表"},
            ],
            thread_id="chat-session-sess-1",
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(
            kwargs["user_message_blocks"],
            [{"type": "table_selection", "table_id": "t1", "preview": "表"}],
        )

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_image_block_is_runtime_attachment_not_context_block(
        self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-image", "published": 1}
        image = {
            "type": "image",
            "file_id": "11111111-1111-4111-8111-111111111111",
            "filename": "photo.png",
            "mime_type": "image/png",
            "url": "https://files.example/photo.png",
        }

        AgentDispatcher().dispatch_external(
            _make_session(),
            "",
            _make_space(),
            attachments=None,
            blocks=[image],
            thread_id="chat-session-sess-1",
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs["attachments"], [image])
        self.assertIsNone(kwargs["user_message_blocks"])

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_reply_context_in_app_context_forwarded_to_prompt(
        self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps,
    ):
        preview = {"role": "assistant", "author": "AI", "text": "被引用内容"}
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-reply", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "测试引用回复不显示 XML",
            _make_space(),
            attachments=None,
            thread_id="chat-session-sess-1",
            client_message_id="22222222-2222-4222-8222-222222222222",
            app_context={
                "display_message": "测试引用回复不显示 XML",
                "reply_to_message_id": "11111111-1111-4111-8111-111111111111",
                "reply_to_preview": preview,
            },
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs["display_message"], "测试引用回复不显示 XML")
        self.assertEqual(kwargs["reply_to_message_id"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(kwargs["reply_to_preview"], preview)
        self.assertEqual(kwargs["prompt"], "测试引用回复不显示 XML")

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_missing_app_context_passes_none_workspace_snapshot(
        self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-no-ctx", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "no app_context here",
            _make_space(),
            attachments=None,
            thread_id="chat-session-sess-1",
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertIn("workspace_snapshot", kwargs)
        self.assertIsNone(kwargs["workspace_snapshot"])

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_app_context_without_workspace_snapshot_key_passes_none(
        self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-no-ws", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "context without snapshot",
            _make_space(),
            attachments=None,
            thread_id="chat-session-sess-1",
            app_context={"current_space_id": "space-1"},
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertIsNone(kwargs["workspace_snapshot"])

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_malformed_workspace_snapshot_dropped_to_none(
        self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-bad", "published": 1}

        # 非 dict / 空 dict / list 都视作"客户端形态错误"，等价于未上传。
        # 让 daemon 端用 sandbox 兜底，而不是把脏数据顶进 wire payload。
        for bad in ["not-a-dict", [], {}, 42, None]:
            instance.reset_mock()
            instance.forward_prompt.return_value = {"task_id": "tid-bad", "published": 1}
            AgentDispatcher().dispatch_external(
                _make_session(),
                "bad snapshot",
                _make_space(),
                attachments=None,
                thread_id="chat-session-sess-1",
                app_context={"workspace_snapshot": bad},
            )
            kwargs = instance.forward_prompt.call_args.kwargs
            self.assertIsNone(
                kwargs["workspace_snapshot"],
                f"expected None for malformed snapshot {bad!r}",
            )

"""``RemoteAgentDispatcher`` 三分支路由的单元测试。

覆盖 W13 D2 三个核心分支：
1. control_device 未绑定 → 走 lightweight（注入 runtime_mode）
2. control_device 离线 → device_offline 兼容字典 + (server) 桌面通知
3. control_device 在线 → forward_to_local_runtime 接管

所有外部依赖 (ChatService / PromptForwardService / NotificationService /
ChatSession ORM) 全部用 mock 替换，单测不连任何 Django DB。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.remote_agent.device_resolver import (
    DispatchTarget,
    format_device_name,
)
from apps.services.remote_agent.dispatcher import RemoteAgentDispatcher


def _make_user(uid: str = "user-1"):
    user = MagicMock()
    user.id = uid
    return user


def _make_session(session_id: str = "sess-1", workspace=None, user_id: str = "user-1"):
    session = MagicMock()
    session.id = session_id
    session.user_id = user_id
    session.workspace = workspace
    session.thread_id = f"chat-session-{session_id}"
    return session


def _make_agent(*, agent_id="agent-1", user_id="user-1", organization_id="wt-1", name="Tin"):
    agent = MagicMock()
    agent.id = agent_id
    agent.user_id = user_id
    agent.organization_id = organization_id
    agent.name = name
    agent.custom_rules = ""
    agent.agent_config = {}
    return agent


def _make_device(*, status="online", name="MacBook", device_id="dev-1", fp="abcdef123456", device_type="daemon"):
    device = MagicMock()
    device.id = device_id
    device.name = name
    device.fingerprint = fp
    device.device_type = device_type
    device.status = status
    return device


class FormatDeviceNameTests(SimpleTestCase):
    def test_uses_device_name_when_present(self):
        device = _make_device(name="生产服务器")
        self.assertEqual(format_device_name(device), "生产服务器")

    def test_falls_back_to_device_type_and_short_fingerprint(self):
        device = _make_device(name="", fp="a3f2c1b9d4e5", device_type="daemon")
        self.assertEqual(format_device_name(device), "daemon 设备 (a3f2c1)")

    def test_falls_back_when_fingerprint_missing(self):
        device = _make_device(name="", fp="", device_type="electron")
        self.assertEqual(format_device_name(device), "electron 设备 (unknown)")

    def test_handles_none_device(self):
        self.assertEqual(format_device_name(None), "未绑定设备")


class DispatcherLightweightBranchTests(SimpleTestCase):
    """control_device 未绑定时 → 走轻量分支。"""

    def setUp(self):
        self.user = _make_user()
        self.session = _make_session()

    @patch("apps.services.remote_agent.dispatcher._load_session")
    @patch("apps.services.remote_agent.dispatcher.resolve_dispatch_target")
    @patch("apps.services.agent_execution.chat_service.ChatService")
    def test_no_control_device_routes_to_lightweight_with_runtime_mode_injected(
        self, mock_chat_service, mock_resolve, mock_load,
    ):
        mock_load.return_value = self.session
        mock_resolve.return_value = DispatchTarget(
            space=None, agent=None, control_device=None, binding_source="none",
        )
        mock_chat_service.send_message_sync.return_value = {
            "message_id": "msg-x",
            "reply": "lightweight reply",
        }

        result = RemoteAgentDispatcher.send_message_sync(
            session_id="sess-1",
            user=self.user,
            message="hello",
            client_type="server",
            execution_profile="task",
            app_context={"foo": "bar"},
        )

        self.assertEqual(result["reply"], "lightweight reply")
        mock_chat_service.send_message_sync.assert_called_once()
        kwargs = mock_chat_service.send_message_sync.call_args.kwargs
        self.assertEqual(kwargs["app_context"]["runtime_mode"], "lightweight")
        self.assertEqual(kwargs["app_context"]["foo"], "bar")
        self.assertEqual(kwargs["client_type"], "server")

    @patch("apps.services.remote_agent.dispatcher._load_session")
    @patch("apps.services.remote_agent.dispatcher.resolve_dispatch_target")
    @patch("apps.services.agent_execution.chat_service.ChatService")
    def test_existing_runtime_mode_in_app_context_is_preserved(
        self, mock_chat_service, mock_resolve, mock_load,
    ):
        mock_load.return_value = self.session
        mock_resolve.return_value = DispatchTarget(
            space=None, agent=None, control_device=None, binding_source="none",
        )
        mock_chat_service.send_message_sync.return_value = {"reply": "ok"}

        RemoteAgentDispatcher.send_message_sync(
            session_id="sess-1",
            user=self.user,
            message="hello",
            client_type="server",
            execution_profile="task",
            app_context={"runtime_mode": "custom"},
        )

        kwargs = mock_chat_service.send_message_sync.call_args.kwargs
        self.assertEqual(kwargs["app_context"]["runtime_mode"], "custom")


class DispatcherOfflineBranchTests(SimpleTestCase):
    """control_device 已绑但离线 → 立即返回 device_offline + (server) 通知。"""

    def setUp(self):
        self.user = _make_user()
        self.session = _make_session(workspace=MagicMock())

    @patch("apps.services.remote_agent.dispatcher._load_session")
    @patch("apps.services.remote_agent.dispatcher.resolve_dispatch_target")
    @patch("apps.services.remote_agent.dispatcher.notify_owner_device_offline")
    def test_offline_notifies_with_tracker_context_extracted_from_app_context(
        self, mock_notify, mock_resolve, mock_load,
    ):
        """波次 4 Stage 2.4 一刀切：dispatcher 仅透传 tracker_id / tracker_run_id /
        tracker_name —— ``_tracker_*`` 前缀 state key 是唯一活路径，
        legacy ``_agenda_goal_*`` / ``_tabgoal_*`` 已下线。
        """
        device = _make_device(status="offline", name="prod-daemon")
        agent = _make_agent()
        mock_load.return_value = self.session
        mock_resolve.return_value = DispatchTarget(
            space=self.session.workspace,
            agent=agent,
            control_device=device,
            binding_source="agent.control_device",
        )

        RemoteAgentDispatcher.send_message_sync(
            session_id="sess-1",
            user=self.user,
            message="hello",
            client_type="server",
            execution_profile="task",
            app_context={
                "_tracker_tracker_id": "tracker-7",
                "_tracker_tracker_run_id": "tr-7",
                "tracker_name": "周报汇总",
            },
        )

        mock_notify.assert_called_once()
        notif_app_ctx = mock_notify.call_args.kwargs["app_context"]
        self.assertEqual(notif_app_ctx["tracker_id"], "tracker-7")
        self.assertEqual(notif_app_ctx["tracker_run_id"], "tr-7")
        self.assertEqual(notif_app_ctx["tracker_name"], "周报汇总")
        self.assertNotIn("step_run_id", notif_app_ctx)
        self.assertNotIn("step_name", notif_app_ctx)

    @patch("apps.services.remote_agent.dispatcher._load_session")
    @patch("apps.services.remote_agent.dispatcher.resolve_dispatch_target")
    @patch("apps.services.remote_agent.dispatcher.notify_owner_device_offline")
    def test_offline_returns_device_offline_dict(
        self, mock_notify, mock_resolve, mock_load,
    ):
        device = _make_device(status="offline", name="生产 daemon")
        agent = _make_agent()
        mock_load.return_value = self.session
        mock_resolve.return_value = DispatchTarget(
            space=self.session.workspace,
            agent=agent,
            control_device=device,
            binding_source="agent.control_device",
        )

        result = RemoteAgentDispatcher.send_message_sync(
            session_id="sess-1",
            user=self.user,
            message="hello",
            client_type="server",
            execution_profile="task",
        )

        self.assertEqual(result["error_category"], "device_offline")
        self.assertIn("生产 daemon", result["reply"])
        self.assertEqual(result["content"], "")
        self.assertIsNone(result["model_id"])
        self.assertEqual(result["_remote_agent_device_name"], "生产 daemon")
        # server 客户端 → 必须触发桌面通知
        mock_notify.assert_called_once()
        call_kwargs = mock_notify.call_args.kwargs
        self.assertEqual(call_kwargs["agent"], agent)
        self.assertEqual(call_kwargs["device"], device)
        self.assertEqual(call_kwargs["device_name"], "生产 daemon")

    @patch("apps.services.remote_agent.dispatcher._load_session")
    @patch("apps.services.remote_agent.dispatcher.resolve_dispatch_target")
    @patch("apps.services.remote_agent.dispatcher.notify_owner_device_offline")
    def test_offline_does_not_notify_for_channel_client(
        self, mock_notify, mock_resolve, mock_load,
    ):
        device = _make_device(status="offline")
        mock_load.return_value = self.session
        mock_resolve.return_value = DispatchTarget(
            space=self.session.workspace,
            agent=_make_agent(),
            control_device=device,
            binding_source="agent.control_device",
        )

        result = RemoteAgentDispatcher.send_message_sync(
            session_id="sess-1",
            user=self.user,
            message="hello",
            client_type="channel",
            execution_profile="task",
        )

        self.assertEqual(result["error_category"], "device_offline")
        # 渠道客户端 → 不通知，避免把内部错误暴露给外部用户
        mock_notify.assert_not_called()

    @patch("apps.services.remote_agent.dispatcher._load_session")
    @patch("apps.services.remote_agent.dispatcher.resolve_dispatch_target")
    @patch("apps.services.remote_agent.dispatcher.notify_owner_device_offline")
    def test_offline_uses_device_name_fallback(
        self, mock_notify, mock_resolve, mock_load,
    ):
        device = _make_device(status="offline", name="", fp="a3f2c1b9", device_type="daemon")
        mock_load.return_value = self.session
        mock_resolve.return_value = DispatchTarget(
            space=self.session.workspace,
            agent=_make_agent(),
            control_device=device,
            binding_source="agent.control_device",
        )

        result = RemoteAgentDispatcher.send_message_sync(
            session_id="sess-1",
            user=self.user,
            message="hello",
            client_type="server",
            execution_profile="task",
        )

        self.assertIn("daemon 设备 (a3f2c1)", result["reply"])
        self.assertEqual(result["_remote_agent_device_name"], "daemon 设备 (a3f2c1)")


class DispatcherOnlineBranchTests(SimpleTestCase):
    """control_device 在线 → 调 forward_to_local_runtime。"""

    def setUp(self):
        self.user = _make_user()
        self.session = _make_session(workspace=MagicMock())

    @patch("apps.services.remote_agent.dispatcher._load_session")
    @patch("apps.services.remote_agent.dispatcher.resolve_dispatch_target")
    @patch("apps.services.remote_agent.dispatcher.forward_to_local_runtime")
    def test_online_routes_to_forward_to_local_runtime(
        self, mock_forward, mock_resolve, mock_load,
    ):
        device = _make_device(status="online")
        agent = _make_agent()
        mock_load.return_value = self.session
        mock_resolve.return_value = DispatchTarget(
            space=self.session.workspace,
            agent=agent,
            control_device=device,
            binding_source="agent.control_device",
        )
        mock_forward.return_value = {
            "message_id": None,
            "reply": "from local runtime",
            "content": "from local runtime",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "error_category": None,
            "error_message": None,
        }

        result = RemoteAgentDispatcher.send_message_sync(
            session_id="sess-1",
            user=self.user,
            message="hello",
            client_type="server",
            execution_profile="task",
            attachments=[{"value": "x"}],
            app_context={"foo": "bar"},
        )

        self.assertEqual(result["reply"], "from local runtime")
        mock_forward.assert_called_once()
        kwargs = mock_forward.call_args.kwargs
        self.assertEqual(kwargs["session"], self.session)
        self.assertEqual(kwargs["space"], self.session.workspace)
        self.assertEqual(kwargs["agent"], agent)
        self.assertEqual(kwargs["message"], "hello")
        self.assertEqual(kwargs["attachments"], [{"value": "x"}])
        self.assertEqual(kwargs["app_context"], {"foo": "bar"})

    @patch("apps.services.remote_agent.dispatcher._load_session")
    def test_session_not_found_raises_404(self, mock_load):
        from ninja.errors import HttpError

        mock_load.return_value = None

        with self.assertRaises(HttpError):
            RemoteAgentDispatcher.send_message_sync(
                session_id="sess-missing",
                user=self.user,
                message="hello",
                client_type="server",
                execution_profile="task",
            )


class DispatcherBusyAvailableTests(SimpleTestCase):
    """W13 D6 短期实施：device.status='busy' 必须视为可用，走 forward 分支。

    历史行为是 ``status != 'online'`` 立即返回 device_offline，与产品方向
    "多 Agent 并发是默认能力" 直接冲突——detail 见
     D6 / 。
    """

    def setUp(self):
        self.user = _make_user()
        self.session = _make_session(workspace=MagicMock())

    @patch("apps.services.remote_agent.dispatcher._load_session")
    @patch("apps.services.remote_agent.dispatcher.resolve_dispatch_target")
    @patch("apps.services.remote_agent.dispatcher.forward_to_local_runtime")
    @patch("apps.services.remote_agent.dispatcher.notify_owner_device_offline")
    def test_dispatch_with_busy_device_routes_to_forward(
        self, mock_notify, mock_forward, mock_resolve, mock_load,
    ):
        device = _make_device(status="busy", name="busy-daemon")
        agent = _make_agent()
        mock_load.return_value = self.session
        mock_resolve.return_value = DispatchTarget(
            space=self.session.workspace,
            agent=agent,
            control_device=device,
            binding_source="agent.control_device",
        )
        mock_forward.return_value = {
            "reply": "from local runtime",
            "content": "from local runtime",
            "error_category": None,
        }

        result = RemoteAgentDispatcher.send_message_sync(
            session_id="sess-1",
            user=self.user,
            message="hello",
            client_type="server",
            execution_profile="task",
        )

        self.assertEqual(result["reply"], "from local runtime")
        mock_forward.assert_called_once()
        mock_notify.assert_not_called()
        kwargs = mock_forward.call_args.kwargs
        self.assertIs(kwargs["control_device"], device)

    @patch("apps.services.remote_agent.dispatcher._load_session")
    @patch("apps.services.remote_agent.dispatcher.resolve_dispatch_target")
    @patch("apps.services.remote_agent.dispatcher.forward_to_local_runtime")
    @patch("apps.services.remote_agent.dispatcher.notify_owner_device_offline")
    def test_unknown_status_still_treated_as_offline(
        self, mock_notify, mock_forward, mock_resolve, mock_load,
    ):
        # 任何不在 DEVICE_AVAILABLE_STATUSES 内的值（包括 'unknown' / None）
        # 都要走 offline 分支，避免漏配新枚举导致的"过度放行"。
        device = _make_device(status="weird-state", name="prod-daemon")
        agent = _make_agent()
        mock_load.return_value = self.session
        mock_resolve.return_value = DispatchTarget(
            space=self.session.workspace,
            agent=agent,
            control_device=device,
            binding_source="agent.control_device",
        )

        result = RemoteAgentDispatcher.send_message_sync(
            session_id="sess-1",
            user=self.user,
            message="hello",
            client_type="server",
            execution_profile="task",
        )

        self.assertEqual(result["error_category"], "device_offline")
        mock_forward.assert_not_called()
        mock_notify.assert_called_once()


class DispatcherSignatureCompatibilityTests(SimpleTestCase):
    """``RemoteAgentDispatcher.send_message_sync`` 必须是 ``ChatService.send_message_sync``
    的 drop-in 替换（签名 ⊇ ChatService）。"""

    def test_signature_matches_chat_service(self):
        """契约是「dispatcher 签名 ⊇ ChatService 签名」而非完全相等。

        ChatService 的每个参数都要在 dispatcher 里以相同（名 / 默认值 / 调用约定）、
        相同相对顺序作为 **前缀** 出现——这样把 6 个调用点从 ChatService 切到 dispatcher
        时不会漏改 / 错位参数（即 drop-in 兼容）。dispatcher 允许在尾部追加 **forward
        专属** 的可选参数：如 ``interaction_mode``（ 无人值守 HITL），它只在「设备
        forward 路径」（forward_to_local_runtime → prompt_forward_service → 设备 payload）
        被消费；云端 lightweight 路径（dispatch_lightweight → ChatService）走
        ``execution_profile="task"`` 的 server_auto 达成同样的无人值守，故 ``interaction_mode``
        本就不必贯通 ChatService —— dispatcher 也确实不把它转发给 lightweight 分支。
        """
        import inspect

        from apps.services.agent_execution.chat_service import ChatService

        chat_params = [
            (name, param.default, param.kind)
            for name, param in inspect.signature(ChatService.send_message_sync).parameters.items()
        ]
        dispatcher_params = [
            (name, param.default, param.kind)
            for name, param in inspect.signature(RemoteAgentDispatcher.send_message_sync).parameters.items()
        ]

        # 1) ChatService 的参数必须是 dispatcher 参数的前缀（名 / 默认值 / 调用约定 / 顺序全等）。
        self.assertEqual(
            dispatcher_params[: len(chat_params)], chat_params,
            "RemoteAgentDispatcher.send_message_sync 必须与 ChatService.send_message_sync 保持 "
            "drop-in 兼容：ChatService 的参数需以相同名 / 默认值 / 调用约定 / 顺序作为前缀出现；"
            "不一致会导致 6 个调用点从 ChatService 切到 dispatcher 时漏改 / 错位参数。",
        )

        # 2) dispatcher 多出的尾部参数（forward 专属，如 interaction_mode）必须都带默认值，
        #    否则老调用点没传就会报错，破坏 drop-in 契约。
        for name, default, _kind in dispatcher_params[len(chat_params):]:
            self.assertIsNot(
                default, inspect.Parameter.empty,
                f"dispatcher 多出的参数 {name} 必须有默认值，否则破坏与 ChatService 的 drop-in 兼容。",
            )

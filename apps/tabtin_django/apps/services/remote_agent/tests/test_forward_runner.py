"""``forward_to_local_runtime`` 的单元测试。

覆盖：
1. published=0 → 立刻返回 device_unreachable，不进入轮询
2. 拿到 Redis 结果 → 翻译为 ChatService 兼容 dict
3. error=True 且无分类 → error_category='runtime_failed'
4. 透传 / ``[code]`` 前缀解析已知错误分类（如点券不足）
5. 超时 → error_category='remote_agent_timeout' + 触发 forward_cancel
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.remote_agent.forward_runner import (
    DEFAULT_TIMEOUT_SECONDS,
    _build_chat_service_compat_dict,
    forward_to_local_runtime,
)


def _make_session(session_id="sess-1"):
    session = MagicMock()
    session.id = session_id
    session.thread_id = f"chat-session-{session_id}"
    # 默认非回退态——避免 MagicMock 自动属性把 revert_message_id 当 truthy，
    # 误触发 forward 路径的回退清理。回退态用例显式赋值。
    session.revert_message_id = None
    return session


def _make_agent():
    agent = MagicMock()
    agent.id = "agent-1"
    agent.custom_rules = "保持中立"
    agent.working_dir_type = "code"
    agent.agent_config = {"workspace_root": "/tmp/ws"}
    return agent


class ForwardRunnerTests(SimpleTestCase):
    """``forward_to_local_runtime`` 在每个 case 里都会 ``peek_interrupt_state``
    查 PG，SimpleTestCase 不连真实 DB，统一 patch 该 helper 避免误打 PG。"""

    def setUp(self):
        super().setUp()
        self._peek_patcher = patch(
            "apps.services.agent_engine.persistence.conversation_store."
            "ConversationStore.peek_interrupt_state",
            return_value=None,
        )
        self.mock_peek = self._peek_patcher.start()
        self.addCleanup(self._peek_patcher.stop)

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_published_zero_returns_device_unreachable_without_polling(
        self, mock_pfs_cls,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-1", "published": 0}
        space = MagicMock()
        space.id = "workspace-1"
        space.working_dir = "/tmp/ws"
        space.working_dir_type = ""

        with patch("django.core.cache.cache.get") as mock_cache_get:
            result = forward_to_local_runtime(
                session=_make_session(),
                space=space,
                agent=_make_agent(),
                message="hello",
                attachments=None,
                app_context=None,
                model_id="model-1",
            )

        mock_cache_get.assert_not_called()
        self.assertEqual(result["error_category"], "device_unreachable")
        self.assertEqual(result["_remote_agent_runtime_mode"], "local")
        instance.forward_prompt.assert_called_once()
        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs["runtime_mode"], "local")
        self.assertEqual(kwargs["agent_backend_config"]["type"], "local")
        self.assertEqual(kwargs["custom_rules"], "保持中立")
        self.assertEqual(kwargs["workspace_root"], "/tmp/ws")
        self.assertEqual(kwargs["agent_id"], "agent-1")
        self.assertEqual(kwargs["model_id"], "model-1")
        self.assertEqual(kwargs["space_id"], "workspace-1")
        # interrupt_state 默认 None：无 ConversationState 行 → peek 返回 None
        # 应原样透传给 forward_prompt，让其 payload 构造跳过该字段。
        self.assertIn("interrupt_state", kwargs)
        self.assertIsNone(kwargs["interrupt_state"])
        # L-W6-02 (W6 M3)：app_context=None → workspace_snapshot=None
        # （与"未上传 workspace_snapshot"等价；daemon 退化到 sandbox 兜底）。
        self.assertIn("workspace_snapshot", kwargs)
        self.assertIsNone(kwargs["workspace_snapshot"])

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_workspace_snapshot_in_app_context_forwarded_to_prompt(self, mock_pfs_cls):
        """L-W6-02 (W6 M3)：app_context['workspace_snapshot'] 是 dict 时透传给 forward_prompt。

        与 chat.send_message handler 白名单的同字段 + AgentDispatcher 透传链路对称：
        即使是经 ``forward_runner`` 路径（scheduler / lightweight_dispatch 等
        服务端发起），只要调用方在 app_context 里塞了 workspace_snapshot，
        就能直接落到 wire payload 给 Daemon 用。
        """
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-snap", "published": 0}

        snap = {
            "sources": {
                "sandbox": "/tmp/ws/sandbox",
                "tabcodeProjects": ["/Users/me/dev/proj"],
                "tabfolderDirs": [],
                "attachedFiles": [],
            },
            "allowedPaths": ["/tmp/ws/sandbox", "/Users/me/dev/proj"],
            "allowedFiles": [],
            "spaceSessionId": "space-1::session-runner",
        }

        with patch("django.core.cache.cache.get"):
            forward_to_local_runtime(
                session=_make_session(),
                space=MagicMock(),
                agent=_make_agent(),
                message="ls 我的项目",
                attachments=None,
                app_context={"workspace_snapshot": snap},
                model_id="model-1",
            )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs["workspace_snapshot"], snap)

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_agent_mention_interrupt_flag_forwarded_to_prompt(self, mock_pfs_cls):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-interrupt", "published": 0}

        forward_to_local_runtime(
            session=_make_session(),
            space=MagicMock(),
            agent=_make_agent(),
            message="@Agent 处理这个任务",
            attachments=None,
            app_context={"_interrupt_agent_active": True},
        )

        self.assertIs(
            instance.forward_prompt.call_args.kwargs["interrupt_active"],
            True,
        )

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_skill_slash_invoke_is_normalized_and_forwarded_once(self, mock_pfs_cls):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-skill", "published": 0}

        with patch(
            "apps.services.agent_engine.services.persistence_pipeline.persist_user_messages"
        ):
            forward_to_local_runtime(
                session=_make_session(),
                space=MagicMock(),
                agent=_make_agent(),
                message="/summarize 重点",
                attachments=None,
                app_context={
                    "_skill_slash_invoke": {
                        "skill_key": "  summarize  ",
                        "args": "重点",
                        "untrusted": "ignored",
                    }
                },
            )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(
            kwargs["skill_slash_invoke"],
            {"skill_key": "summarize", "args": "重点"},
        )
        self.assertNotIn("_skill_slash_invoke", kwargs["app_context"])

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_working_dir_type_forwarded_to_prompt(self, mock_pfs_cls):
        """work_mode：``space.working_dir_type`` 必须透传给 ``forward_prompt``，
        否则 scheduler / remote_agent 旁路任务的 system prompt 缺 ``<work_mode>``
        段（与 ``AgentDispatcher.dispatch_external`` 对称）。"""
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-wd", "published": 0}

        space = MagicMock()
        space.working_dir_type = "code"
        space.working_dir = None

        forward_to_local_runtime(
            session=_make_session(),
            space=space,
            agent=_make_agent(),
            message="hello",
            attachments=None,
            app_context=None,
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs["working_dir_type"], "code")

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_empty_working_dir_type_forwarded_as_none(self, mock_pfs_cls):
        """未设置 working_dir_type（空串）→ 归一为 None 透传；下游 forward_prompt
        据此跳过 ``<work_mode>`` 段（与 dispatcher 取值语义一致）。"""
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-wd2", "published": 0}

        space = MagicMock()
        space.working_dir_type = ""
        space.working_dir = None

        forward_to_local_runtime(
            session=_make_session(),
            space=space,
            agent=_make_agent(),
            message="hello",
            attachments=None,
            app_context=None,
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertIn("working_dir_type", kwargs)
        self.assertIsNone(kwargs["working_dir_type"])

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_redis_result_translated_to_chat_service_dict(self, mock_pfs_cls):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-2", "published": 1}

        payload = json.dumps({
            "content": "hi from daemon",
            "error": False,
            "error_message": "",
            "agent_type": "local",
        })
        with patch("django.core.cache.cache.get", return_value=payload):
            result = forward_to_local_runtime(
                session=_make_session(),
                space=MagicMock(),
                agent=_make_agent(),
                message="hello",
                attachments=[{"value": "att1"}],
                app_context={"runtime_timeout_seconds": 10},
            )

        self.assertEqual(result["reply"], "hi from daemon")
        self.assertEqual(result["content"], "hi from daemon")
        self.assertIsNone(result["error_category"])
        self.assertIsNone(result["error_message"])
        self.assertEqual(result["_remote_agent_task_id"], "tid-2")

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_daemon_error_payload_translated_to_runtime_failed(self, mock_pfs_cls):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-3", "published": 1}

        payload = json.dumps({
            "content": "",
            "error": True,
            "error_message": "claude process crashed",
        })
        with patch("django.core.cache.cache.get", return_value=payload):
            result = forward_to_local_runtime(
                session=_make_session(),
                space=MagicMock(),
                agent=_make_agent(),
                message="hello",
                attachments=None,
                app_context={"runtime_timeout_seconds": 10},
            )

        self.assertEqual(result["error_category"], "runtime_failed")
        self.assertEqual(result["error_message"], "claude process crashed")
        self.assertEqual(result["reply"], "claude process crashed")

    def test_compat_dict_passthrough_organization_insufficient_credits(self):
        result = _build_chat_service_compat_dict(
            payload={
                "content": (
                    "[organization_insufficient_credits] 本月 LLM 点券已用完，"
                    "请联系组织管理员充值或开启点券自动补充"
                ),
                "error": True,
                "error_category": "organization_insufficient_credits",
                "error_code": "organization_insufficient_credits",
                "error_message": (
                    "[organization_insufficient_credits] 本月 LLM 点券已用完，"
                    "请联系组织管理员充值或开启点券自动补充"
                ),
            },
            task_id="tid-credits-1",
        )
        self.assertEqual(result["error_category"], "organization_insufficient_credits")
        self.assertEqual(result["error_code"], "organization_insufficient_credits")

    def test_compat_dict_parses_bracket_prefix_when_category_missing(self):
        result = _build_chat_service_compat_dict(
            payload={
                "content": "",
                "error": True,
                "error_message": (
                    "[organization_insufficient_credits] 本月 LLM 点券已用完，"
                    "请联系组织管理员充值或开启点券自动补充"
                ),
            },
            task_id="tid-credits-2",
        )
        self.assertEqual(result["error_category"], "organization_insufficient_credits")
        self.assertEqual(result["error_code"], "organization_insufficient_credits")
        self.assertNotEqual(result["error_category"], "runtime_failed")

    def test_compat_dict_success_keeps_null_category(self):
        result = _build_chat_service_compat_dict(
            payload={"content": "ok", "error": False},
            task_id="tid-ok",
        )
        self.assertIsNone(result["error_category"])
        self.assertNotIn("error_code", result)

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_internal_system_prompt_context_forwards_to_prompt_payload(self, mock_pfs_cls):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-sys", "published": 0}

        forward_to_local_runtime(
            session=_make_session(),
            space=MagicMock(),
            agent=_make_agent(),
            message="hello",
            attachments=None,
            app_context={"_rendered_system_prompt": "内部 system prompt"},
            model_id="model-1",
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs["model_id"], "model-1")
        self.assertEqual(kwargs["system_prompt"], "内部 system prompt")

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_interrupt_state_from_conversation_state_forwarded_to_prompt(
        self, mock_pfs_cls,
    ):
        """W3-轮 1 L3-1-A：ConversationState 含 pending_approvals 时，forward_prompt
        必须收到 interrupt_state 整包；否则 daemon 拿不到 crash 前的审批快照，
        北极星 §1.4 重启 → 重建 PendingApprovalRegistry 的链路就接不上。"""
        nested_interrupt = {
            "pending_approvals": [
                {
                    "batch_id": "b-1",
                    "runtime_mode": "interactive",
                    "approval_type": "tool_permission",
                    "entries": [
                        {
                            "request_id": "req-1",
                            "tool_call_id": "tc-1",
                            "tool_name": "shell.run",
                            "status": "pending",
                        }
                    ],
                }
            ],
        }
        self.mock_peek.return_value = nested_interrupt

        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-int", "published": 0}

        forward_to_local_runtime(
            session=_make_session(),
            space=MagicMock(),
            agent=_make_agent(),
            message="resume me",
            attachments=None,
            app_context=None,
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs["interrupt_state"], nested_interrupt)
        # peek_interrupt_state 用了 thread_id 路由（forward_runner._ensure_thread_id 的产物）
        self.mock_peek.assert_called_once()
        peek_thread = self.mock_peek.call_args.args[0]
        self.assertTrue(peek_thread)

    @patch("apps.services.remote_agent.forward_runner.time.sleep", return_value=None)
    @patch(
        "apps.services.remote_agent.forward_runner.time.monotonic",
        side_effect=[0.0, 0.0, 1.0, 2.0, 3.0, 100.0, 200.0],
    )
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_timeout_returns_remote_agent_timeout_and_cancels(
        self, mock_pfs_cls, _mock_monotonic, _mock_sleep,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-4", "published": 1}
        instance.forward_cancel.return_value = 1

        with patch("django.core.cache.cache.get", return_value=None):
            result = forward_to_local_runtime(
                session=_make_session(),
                space=MagicMock(),
                agent=_make_agent(),
                message="hello",
                attachments=None,
                app_context={"runtime_timeout_seconds": 30},
            )

        self.assertEqual(result["error_category"], "remote_agent_timeout")
        self.assertIn("30s", result["reply"])
        instance.forward_cancel.assert_called_once()

    @patch("apps.services.remote_agent.forward_runner.time.sleep", return_value=None)
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_transient_cache_error_keeps_polling_then_succeeds(
        self, mock_pfs_cls, _mock_sleep,
    ):
        """GH ：轮询中 ``cache.get`` 抛 Redis 异常**不能**让任务崩——吞掉、
        继续轮询；下一次读到 relay recover 补写的结果后正常返回 success。"""
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-redis-blip", "published": 1}

        payload = json.dumps({
            "content": "done after redis recovered",
            "error": False,
            "error_message": "",
            "agent_type": "local",
        })
        # 第一次轮询 Redis 抖动抛异常（含 "Timeout" 字样，模拟真实报文），
        # 第二次读到补写进来的结果。
        with patch(
            "django.core.cache.cache.get",
            side_effect=[RuntimeError("Timeout reading from socket"), payload],
        ):
            result = forward_to_local_runtime(
                session=_make_session(),
                space=MagicMock(),
                agent=_make_agent(),
                message="hello",
                attachments=None,
                app_context={"runtime_timeout_seconds": 30},
            )

        # 没崩、没误标，正常拿到结果
        self.assertEqual(result["reply"], "done after redis recovered")
        self.assertIsNone(result["error_category"])
        instance.forward_cancel.assert_not_called()

    @patch("apps.services.remote_agent.forward_runner.time.sleep", return_value=None)
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_tracker_cancelled_mid_poll_returns_cancelled_and_forwards_cancel(
        self, mock_pfs_cls, _mock_sleep,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-cancel", "published": 1}
        instance.forward_cancel.return_value = 1

        with patch("django.core.cache.cache.get", return_value=None), patch(
            "apps.tracker.services.tracker_executor._record_runtime_task_id",
        ), patch(
            "apps.tracker.services.tracker_executor._is_tracker_run_cancelled",
            side_effect=[False, True],
        ):
            result = forward_to_local_runtime(
                session=_make_session(),
                space=MagicMock(),
                agent=_make_agent(),
                message="hello",
                attachments=None,
                app_context={
                    "runtime_timeout_seconds": 30,
                    "_tracker_tracker_run_id": "run-cancel-1",
                },
            )

        self.assertEqual(result["error_category"], "cancelled")
        instance.forward_cancel.assert_called_once()

    @patch("apps.services.remote_agent.forward_runner.time.sleep", return_value=None)
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_project_task_cancelled_mid_poll_returns_cancelled_and_forwards_cancel(
        self, mock_pfs_cls, _mock_sleep,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-project-cancel", "published": 1}
        instance.forward_cancel.return_value = 1

        with patch("django.core.cache.cache.get", return_value=None), patch(
            "apps.tabtinspace.services.project_task_runtime.is_project_task_run_cancelled",
            side_effect=[False, True],
        ):
            result = forward_to_local_runtime(
                session=_make_session(),
                space=MagicMock(),
                agent=_make_agent(),
                message="hello",
                attachments=None,
                app_context={
                    "runtime_timeout_seconds": 30,
                    "_project_task_run_id": "project-run-cancel-1",
                },
            )

        self.assertEqual(result["error_category"], "cancelled")
        self.assertEqual(result["error_message"], "project_task_run_cancelled")
        instance.forward_cancel.assert_called_once()

    @patch("apps.services.remote_agent.forward_runner.time.sleep", return_value=None)
    @patch(
        "apps.services.remote_agent.forward_runner.time.monotonic",
        side_effect=[0.0, 0.0, 1.0, 2.0, 3.0, 100.0, 200.0],
    )
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_persistent_cache_error_returns_backend_unavailable_not_timeout(
        self, mock_pfs_cls, _mock_monotonic, _mock_sleep,
    ):
        """GH ：整个等待窗口内 ``cache.get`` 持续抛 Redis 异常 → 归类
        ``result_backend_unavailable``，**不得**误标成 ``remote_agent_timeout``
        （否则 humanize 成「执行时间超过了上限」误导用户）。"""
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-redis-down", "published": 1}
        instance.forward_cancel.return_value = 1

        with patch(
            "django.core.cache.cache.get",
            side_effect=RuntimeError("Timeout reading from socket"),
        ):
            result = forward_to_local_runtime(
                session=_make_session(),
                space=MagicMock(),
                agent=_make_agent(),
                message="hello",
                attachments=None,
                app_context={"runtime_timeout_seconds": 30},
            )

        self.assertEqual(result["error_category"], "result_backend_unavailable")
        self.assertNotEqual(result["error_category"], "remote_agent_timeout")
        # error_message 不得携带原始 redis "Timeout" 字样，避免下游 humanize 误标超时
        self.assertNotIn("Timeout", result["error_message"])
        instance.forward_cancel.assert_called_once()


class ForwardRunnerPersistsUserMessageTests(SimpleTestCase):
    """TS-24：forward 路径（设备在线）转发前必须把 prompt 落成带 ``content`` 的
    user 消息——对齐 IPC/lightweight 路径，修 Tracker run / channel 等会话里
    user 气泡空（content / content_blocks_json 都空）的 bug。

    关键断言：
    1. ``persist_user_messages`` 被调用，且 messages == [prompt]（content 落库点）；
    2. 落库用的 ``client_message_id`` 与透传给 ``forward_prompt`` 的**完全一致**——
       这保证 daemon 回显的 ``agent.stream.user`` 事件按 (session, client_event_id)
       UniqueConstraint 命中去重，**不产生第二条 user 消息**；
    3. 调用方未传 client_message_id（Tracker / channel）时自生成 UUID；显式传入
       时原样保留。
    """

    def setUp(self):
        super().setUp()
        self._peek_patcher = patch(
            "apps.services.agent_engine.persistence.conversation_store."
            "ConversationStore.peek_interrupt_state",
            return_value=None,
        )
        self._peek_patcher.start()
        self.addCleanup(self._peek_patcher.stop)

    @patch("apps.services.agent_engine.services.persistence_pipeline.persist_user_messages")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_user_message_persisted_with_content_before_forward(
        self, mock_pfs_cls, mock_persist,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-u", "published": 0}

        session = _make_session("sess-persist")
        session.user_id = "user-42"

        forward_to_local_runtime(
            session=session,
            space=MagicMock(),
            agent=_make_agent(),
            message="## 目标\n请独立完成任务",
            attachments=None,
            app_context=None,
            client_message_id=None,
        )

        # 1. 落库点被调用，且 messages == [prompt]（user 消息带 content）
        mock_persist.assert_called_once()
        args, kwargs = mock_persist.call_args
        self.assertEqual(args[0], session)
        self.assertEqual(args[1], ["## 目标\n请独立完成任务"])
        self.assertEqual(kwargs["sender_user_id"], "user-42")

        # 2. 自生成 client_message_id（调用方未传）
        cmid = kwargs["client_message_id"]
        self.assertTrue(cmid)

        # 3. 同一 client_message_id 透传给 forward_prompt → daemon 回显去重，
        #    不会另起一条空 content 的 user 消息。
        fwd_kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(fwd_kwargs["client_message_id"], cmid)

    @patch("apps.services.agent_engine.services.persistence_pipeline.persist_user_messages")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_explicit_client_message_id_preserved(self, mock_pfs_cls, mock_persist):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-u2", "published": 0}

        explicit_id = "11111111-1111-1111-1111-111111111111"
        forward_to_local_runtime(
            session=_make_session("sess-explicit"),
            space=MagicMock(),
            agent=_make_agent(),
            message="hi",
            attachments=None,
            app_context=None,
            client_message_id=explicit_id,
        )

        self.assertEqual(mock_persist.call_args.kwargs["client_message_id"], explicit_id)
        self.assertEqual(
            instance.forward_prompt.call_args.kwargs["client_message_id"], explicit_id,
        )

    @patch("apps.services.agent_engine.services.persistence_pipeline.persist_user_messages")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_reply_context_forwarded_to_daemon_and_persisted(self, mock_pfs_cls, mock_persist):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-reply", "published": 0}

        explicit_id = "22222222-2222-4222-8222-222222222222"
        preview = {
            "role": "assistant",
            "author": "AI",
            "text": "被引用的回答",
        }

        forward_to_local_runtime(
            session=_make_session("sess-reply"),
            space=MagicMock(),
            agent=_make_agent(),
            message="测试引用回复不显示 XML",
            attachments=None,
            app_context={
                "display_message": "测试引用回复不显示 XML",
                "reply_to_message_id": "11111111-1111-4111-8111-111111111111",
                "reply_to_preview": preview,
            },
            client_message_id=explicit_id,
        )

        persist_kwargs = mock_persist.call_args.kwargs
        self.assertEqual(persist_kwargs["reply_to_message_id"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(persist_kwargs["reply_to_preview"], preview)
        self.assertEqual(mock_persist.call_args.args[1], ["测试引用回复不显示 XML"])

        fwd_kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(fwd_kwargs["display_message"], "测试引用回复不显示 XML")
        self.assertEqual(fwd_kwargs["reply_to_message_id"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(fwd_kwargs["reply_to_preview"], preview)
        self.assertEqual(fwd_kwargs["prompt"], "测试引用回复不显示 XML")

    @patch("apps.services.agent_engine.services.persistence_pipeline.persist_user_messages")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_persist_failure_is_non_fatal(self, mock_pfs_cls, mock_persist):
        """落库失败不阻断转发（daemon 回显仍兜底落库）。"""
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-u3", "published": 0}
        mock_persist.side_effect = RuntimeError("db down")

        result = forward_to_local_runtime(
            session=_make_session("sess-fail"),
            space=MagicMock(),
            agent=_make_agent(),
            message="hi",
            attachments=None,
            app_context=None,
        )

        # 仍走到 forward 并正常返回（published=0 → device_unreachable）
        self.assertEqual(result["error_category"], "device_unreachable")
        instance.forward_prompt.assert_called_once()

    @patch("apps.services.agent_engine.services.persistence_pipeline.cleanup_reverted_messages")
    @patch("apps.services.agent_engine.services.persistence_pipeline.persist_user_messages")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_reverted_session_cleaned_before_forward(
        self, mock_pfs_cls, mock_persist, mock_cleanup,
    ):
        """#2101：forward 路径（服务端代发 + 设备在线）代发消息前补回退清理。

        软回退态会话经 RemoteAgentDispatcher 直连 forward 时不经 _stage_prepare，
        必须在落 user 消息前清回退态，否则 revert_message_id 永不清除。
        """
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-rv", "published": 0}

        session = _make_session("sess-reverted")
        session.revert_message_id = "4275cbce-113b-4f57-bb6d-bea2f7426b8f"

        forward_to_local_runtime(
            session=session,
            space=MagicMock(),
            agent=_make_agent(),
            message="继续",
            attachments=None,
            app_context=None,
            client_message_id=None,
        )

        mock_cleanup.assert_called_once_with(session)

    @patch("apps.services.agent_engine.services.persistence_pipeline.cleanup_reverted_messages")
    @patch("apps.services.agent_engine.services.persistence_pipeline.persist_user_messages")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_non_reverted_session_skips_cleanup(
        self, mock_pfs_cls, mock_persist, mock_cleanup,
    ):
        """非回退态会话 forward 不触发 cleanup（避免多余 DB 操作）。"""
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-nr", "published": 0}

        forward_to_local_runtime(
            session=_make_session("sess-normal"),
            space=MagicMock(),
            agent=_make_agent(),
            message="hi",
            attachments=None,
            app_context=None,
            client_message_id=None,
        )

        mock_cleanup.assert_not_called()

    @patch("apps.chat.conversation.models.ChatMessage")
    @patch("apps.services.agent_engine.services.persistence_pipeline.persist_user_messages")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_tracker_forward_does_not_write_start_placeholder(
        self, mock_pfs_cls, mock_persist, mock_chat_message,
    ):
        """Tracker 进度走 Run.status + 前端指示器，不再落伪 assistant 占位消息。"""
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-tracker", "published": 0}

        session = _make_session("sess-tracker")
        session.user_id = "user-42"

        forward_to_local_runtime(
            session=session,
            space=MagicMock(),
            agent=_make_agent(),
            message="## 任务\n请独立完成任务",
            attachments=None,
            app_context={"_origin_source": "tracker"},
        )

        mock_chat_message.objects.create.assert_not_called()
        mock_persist.assert_called_once()

    @patch("apps.chat.conversation.models.ChatMessage")
    @patch("apps.services.agent_engine.services.persistence_pipeline.persist_user_messages")
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_non_tracker_forward_does_not_write_assistant_placeholder(
        self, mock_pfs_cls, mock_persist, mock_chat_message,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-chat", "published": 0}

        forward_to_local_runtime(
            session=_make_session("sess-chat"),
            space=MagicMock(),
            agent=_make_agent(),
            message="hi",
            attachments=None,
            app_context=None,
        )

        mock_chat_message.objects.create.assert_not_called()


class CheckDeviceDroppedOfflineTests(SimpleTestCase):
    """W13 D6 短期实施：``_check_device_dropped_offline`` 必须把 busy 视为可用。

    如果把 busy 误判为掉线，``forward_to_local_runtime`` 会在轮询期内主动
    取消任务并返回 device_dropped——把"明明能干活的 busy 设备"误判为
    "中途掉线"。
    """

    def test_check_device_dropped_offline_treats_busy_as_alive(self):
        from apps.services.remote_agent.forward_runner import (
            _check_device_dropped_offline,
        )

        with patch("apps.tabtinspace.models.Device.objects") as mock_objects:
            chain = (
                mock_objects.filter.return_value
                .values_list.return_value
                .first
            )
            chain.return_value = "busy"
            self.assertFalse(_check_device_dropped_offline("dev-1"))

    def test_check_device_dropped_offline_treats_offline_as_dropped(self):
        from apps.services.remote_agent.forward_runner import (
            _check_device_dropped_offline,
        )

        with patch("apps.tabtinspace.models.Device.objects") as mock_objects:
            chain = (
                mock_objects.filter.return_value
                .values_list.return_value
                .first
            )
            chain.return_value = "offline"
            self.assertTrue(_check_device_dropped_offline("dev-1"))

    def test_check_device_dropped_offline_returns_false_when_unknown(self):
        from apps.services.remote_agent.forward_runner import (
            _check_device_dropped_offline,
        )

        with patch("apps.tabtinspace.models.Device.objects") as mock_objects:
            chain = (
                mock_objects.filter.return_value
                .values_list.return_value
                .first
            )
            chain.return_value = None
            # status=None → 视为"无法判断"，不主动制造误判（继续等）
            self.assertFalse(_check_device_dropped_offline("dev-1"))


class TimeoutResolutionTests(SimpleTestCase):
    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    def test_default_timeout_used_when_app_context_missing(self, mock_pfs_cls):
        from apps.services.remote_agent.forward_runner import _resolve_timeout

        self.assertEqual(_resolve_timeout(None), DEFAULT_TIMEOUT_SECONDS)
        self.assertEqual(_resolve_timeout({}), DEFAULT_TIMEOUT_SECONDS)
        self.assertEqual(_resolve_timeout({"runtime_timeout_seconds": "abc"}), DEFAULT_TIMEOUT_SECONDS)

    def test_explicit_timeout_clamped_to_max(self):
        from apps.services.remote_agent.forward_runner import (
            MAX_TIMEOUT_SECONDS,
            _resolve_timeout,
        )

        self.assertEqual(
            _resolve_timeout({"runtime_timeout_seconds": 99999}),
            MAX_TIMEOUT_SECONDS,
        )

    def test_explicit_timeout_clamped_to_min(self):
        from apps.services.remote_agent.forward_runner import _resolve_timeout

        self.assertEqual(_resolve_timeout({"runtime_timeout_seconds": 1}), 30)

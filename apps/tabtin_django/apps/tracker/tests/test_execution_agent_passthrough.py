"""TS-7（P0）回归测试：Tracker 选定的执行 Agent 必须贯穿执行链。

问题背景：
- Tracker 创建时要求 ``agent_id``、UI 也让用户选「谁来执行」，但执行时
  ``skill_executor._run_skill_agent`` 构造的 ``app_context`` 里没有
  ``_execution_agent_id``，调度层 ``device_resolver.resolve_dispatch_target``
  取不到显式 Agent，于是回落到 ChatSession 所在 Space 的默认绑定 Agent。
- 后果：用户选了指定执行 Agent，实际还是默认 Space 绑定 Agent 在跑——权限 / 审计 / 结果归属
  全部错位，定级 P0。

本文件分两层钉死修复：
1. ``ExecutorThreadsAgentIdTest``：执行入口把 ``tracker.agent_id`` 写进
   ``app_context["_execution_agent_id"]``（且为空时不塞、维持回落语义）。
2. ``DispatchTargetHonorsSelectedAgentTest``：调度解析拿到该 id 后，最终命中
   Tracker 选中的 Agent，而**不是** Space 默认绑定 Agent。

两层都用 mock 隔离 DB，属自包含单测（不连 live stack / dev DB）。
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _atomic_cm():
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=None)
    cm.__exit__ = MagicMock(return_value=False)
    return cm


def _stub_tracker_run_filter(tracker_run_cls, *, update_return=1, count=1):
    """run_index 的 count 与 chat_session_id 回填的 update 共用 filter()。"""
    qs = MagicMock(name="run_filter_qs")
    qs.count.return_value = count
    qs.update.return_value = update_return
    qs.filter.return_value = qs
    tracker_run_cls.objects.filter.return_value = qs
    return qs


def _patch_resolve_execution_model_id(model_id=None):
    """SimpleTestCase 禁止打 DB；隔离  catalog 解析。"""
    return patch(
        "apps.services.agent_execution.model_resolver.resolve_execution_model_id",
        return_value=str(model_id or uuid.uuid4()),
    )


def _make_tracker_run(*, agent_id):
    """构造一个最小可驱动 ``_run_skill_agent`` 的 fake TrackerRun。

    DB 写入（ChatSession / ChatContext / TrackerRun.update / save）全部由
    调用方 patch，这里只负责让属性访问不崩。
    """
    tracker = MagicMock(name="tracker")
    tracker.id = uuid.uuid4()
    tracker.name = "调研 dify"
    tracker.description = "调研 dify 产品架构"
    tracker.organization_id = uuid.uuid4()
    tracker.space_id = uuid.uuid4()
    tracker.workspace_id = uuid.uuid4()
    tracker.skill_key = "research_skill"
    tracker.skill_params = None
    tracker.created_by = MagicMock(name="creator")  # 必须 truthy 否则提前 fail
    tracker.agent_id = agent_id

    run = MagicMock(name="tracker_run")
    run.id = uuid.uuid4()
    run.tracker = tracker
    run.status = "running"
    run.context = {}
    # ：必须显式 None，否则 MagicMock 真值会让复用路径误以为已有 session。
    run.chat_session_id = None
    run.created_at = None
    # finished_at - (started_at or finished_at)：started_at 必须是真值或 None，
    # MagicMock 与 datetime 相减会 TypeError。置 None 走 finished_at 自减 = 0。
    run.started_at = None
    return run, tracker


class ExecutorThreadsAgentIdTest(SimpleTestCase):
    """skill_executor 执行入口必须把选定 Agent 透传进 app_context。"""

    def _drive_run_skill_agent(self, *, agent_id):
        """驱动 ``_run_skill_agent`` 走成功分支，返回它传给 dispatcher 的 app_context。"""
        # tracker_executor ↔ skill_executor 存在既有循环 import（生产里前者先加载）。
        # 测试若先 import skill_executor 会撞 partially-initialized，故先预热 tracker_executor。
        from apps.tracker.services import tracker_executor  # noqa: F401
        from apps.tracker.services import skill_executor

        run, tracker = _make_tracker_run(agent_id=agent_id)
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}
        notifier = MagicMock(name="notifier")

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session
        chat_context_cls = MagicMock(name="ChatContext")

        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        # 长度 >=10 且无 error_category → 命中成功分支，避免触发 humanize 导入路径。
        dispatcher.send_message_sync.return_value = {"reply": "已完成调研并产出结论。" * 3}

        # TS-18：dispatch 前会调 resolve_dispatch_target 判断有无设备。这些 TS-7
        # 透传用例只关心 app_context，给一个"有设备"的解析结果让它走正常 dispatch 路径
        # （否则会被无设备闸门拦下、根本不调 send_message_sync）。
        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=MagicMock(control_device=MagicMock(name="online_device")),
             ), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", chat_context_cls), \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats"), \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim"), \
             _patch_resolve_execution_model_id(), \
             patch(
                 "apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed"
             ):
            _stub_tracker_run_filter(tracker_run_cls, update_return=None)
            skill_executor._run_skill_agent(run, skill_data, notifier)

        dispatcher.send_message_sync.assert_called_once()
        return dispatcher.send_message_sync.call_args.kwargs["app_context"], tracker

    def test_selected_agent_id_is_threaded_into_app_context(self):
        """Tracker 绑定 agent_id 时，app_context 必须带上 ``_execution_agent_id``。

        这是修复的核心断言：没有这一步，调度层根本拿不到用户选的 Agent。
        """
        selected_agent_id = uuid.uuid4()
        app_context, tracker = self._drive_run_skill_agent(agent_id=selected_agent_id)

        self.assertIn(
            "_execution_agent_id", app_context,
            "执行入口必须把 Tracker 选定 Agent 透传进 app_context，否则调度回落默认绑定",
        )
        self.assertEqual(
            app_context["_execution_agent_id"], str(selected_agent_id),
            "透传值须为 tracker.agent_id 的字符串形态（device_resolver 按 str 解析）",
        )

    def test_no_agent_id_rejects_missing_binding(self):
        """agent_id 为空时执行入口应拒绝，不再回落 Space 默认 Agent。"""
        from apps.tracker.services import tracker_executor  # noqa: F401
        from apps.tracker.services import skill_executor

        run, _tracker = _make_tracker_run(agent_id=None)
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}
        dispatcher = MagicMock(name="RemoteAgentDispatcher")

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch.object(skill_executor, "_fail_tracker_run") as fail:
            skill_executor._run_skill_agent(run, skill_data, MagicMock(name="notifier"))

        fail.assert_called_once()
        self.assertIn("缺少预授权", fail.call_args.args[1])
        dispatcher.send_message_sync.assert_not_called()

    def test_run_finalized_during_dispatch_does_not_double_count(self):
        """recovery 已补写终态时，活 worker 返回后不得重复统计 / 级联。"""
        from apps.tracker.services import tracker_executor  # noqa: F401 预热循环 import
        from apps.tracker.services import skill_executor

        run, _tracker = _make_tracker_run(agent_id=uuid.uuid4())
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}
        notifier = MagicMock(name="notifier")

        def mark_completed(*_args, **_kwargs):
            run.status = "completed"

        run.refresh_from_db.side_effect = mark_completed

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session
        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {"reply": "已完成调研并产出结论。" * 3}

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=MagicMock(control_device=MagicMock(name="online_device")),
             ), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", MagicMock()), \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats") as stats_mock, \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim") as release_mock, \
             _patch_resolve_execution_model_id(), \
             patch(
                 "apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed"
             ) as cascade_mock:
            _stub_tracker_run_filter(tracker_run_cls, update_return=None)
            skill_executor._run_skill_agent(run, skill_data, notifier)

        dispatcher.send_message_sync.assert_called_once()
        stats_mock.assert_not_called()
        release_mock.assert_not_called()
        cascade_mock.assert_not_called()
        notifier.notify_progress.assert_called()

    def test_terminal_write_race_does_not_double_count(self):
        """relay done fast-path 抢先写终态时，worker 的最终 CAS 写入失败后不得重复副作用。"""
        from apps.tracker.services import tracker_executor  # noqa: F401 预热循环 import
        from apps.tracker.services import skill_executor

        run, _tracker = _make_tracker_run(agent_id=uuid.uuid4())
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}
        notifier = MagicMock(name="notifier")

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session
        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {"reply": "已完成调研并产出结论。" * 3}

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=MagicMock(control_device=MagicMock(name="online_device")),
             ), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", MagicMock()), \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats") as stats_mock, \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim") as release_mock, \
             _patch_resolve_execution_model_id(), \
             patch(
                 "apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed"
             ) as cascade_mock:
            _stub_tracker_run_filter(tracker_run_cls, update_return=0)
            skill_executor._run_skill_agent(run, skill_data, notifier)

        dispatcher.send_message_sync.assert_called_once()
        stats_mock.assert_not_called()
        release_mock.assert_not_called()
        cascade_mock.assert_not_called()
        notifier.notify_progress.assert_called()

    def test_execution_model_id_threaded_from_agent_preferred_model(self):
        """TS-18 设备路径：执行入口须把选定 Agent 的 ``preferred_model_id`` 透传为
        ``send_message_sync(model_id=...)``。缺它时 forward 回落字面 "default" →
        设备 runtime「模型不存在」失败、且服务端拿不到 model 算不出上下文窗口。"""
        from apps.tracker.services import tracker_executor  # noqa: F401 预热循环 import
        from apps.tracker.services import skill_executor

        selected_model_id = uuid.uuid4()
        run, tracker = _make_tracker_run(agent_id=uuid.uuid4())
        tracker.agent.preferred_model_id = selected_model_id
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session
        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {"reply": "已完成调研并产出结论。" * 3}

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=MagicMock(control_device=MagicMock(name="online_device")),
             ), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", MagicMock()), \
             patch(
                 "apps.services.agent_execution.model_resolver.resolve_execution_model_id",
                 return_value=str(selected_model_id),
             ) as resolve_exec_mock, \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats"), \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim"), \
             patch("apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed"):
            _stub_tracker_run_filter(tracker_run_cls, update_return=None)
            skill_executor._run_skill_agent(run, skill_data, MagicMock(name="notifier"))

        resolve_exec_mock.assert_called_once()
        self.assertEqual(
            resolve_exec_mock.call_args.kwargs.get("preferred_model_id"),
            selected_model_id,
        )
        kwargs = dispatcher.send_message_sync.call_args.kwargs
        self.assertEqual(
            kwargs.get("model_id"), str(selected_model_id),
            "catalog 内 preferred 须经 resolve_execution_model_id 透传为 model_id",
        )

    def test_model_id_falls_back_to_resolve_model_when_no_preferred(self):
        """TS-38 / ：无 preferred 或 preferred 不可用时，走 resolve_execution_model_id
        的 catalog 默认链，避免 model_id=None 透传到 forward。"""
        from apps.tracker.services import tracker_executor  # noqa: F401 预热循环 import
        from apps.tracker.services import skill_executor

        fallback_model_id = uuid.uuid4()
        run, tracker = _make_tracker_run(agent_id=uuid.uuid4())
        # 执行 Agent 未配置首选模型 → 触发 catalog 默认链兜底。
        tracker.agent.preferred_model_id = None
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session
        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {"reply": "已完成调研并产出结论。" * 3}

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=MagicMock(control_device=MagicMock(name="online_device")),
             ), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", MagicMock()), \
             patch(
                 "apps.services.agent_execution.model_resolver.resolve_execution_model_id",
                 return_value=str(fallback_model_id),
             ) as resolve_exec_mock, \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats"), \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim"), \
             patch("apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed"):
            _stub_tracker_run_filter(tracker_run_cls, update_return=None)
            skill_executor._run_skill_agent(run, skill_data, MagicMock(name="notifier"))

        resolve_exec_mock.assert_called_once()
        kwargs = dispatcher.send_message_sync.call_args.kwargs
        self.assertEqual(
            kwargs.get("model_id"), str(fallback_model_id),
            "preferred_model_id 为空时须用 resolve_execution_model_id 兜底出真实模型，不能传 None",
        )

    def test_stale_preferred_not_blindly_forwarded(self):
        """#5814：preferred 不在 catalog 时不得原样透传 stale UUID。"""
        from apps.tracker.services import tracker_executor  # noqa: F401
        from apps.tracker.services import skill_executor

        stale = uuid.uuid4()
        fallback = uuid.uuid4()
        run, tracker = _make_tracker_run(agent_id=uuid.uuid4())
        tracker.agent.preferred_model_id = stale
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session
        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {"reply": "已完成调研并产出结论。" * 3}

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=MagicMock(control_device=MagicMock(name="online_device")),
             ), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", MagicMock()), \
             patch(
                 "apps.services.agent_execution.model_resolver.resolve_execution_model_id",
                 return_value=str(fallback),
             ) as resolve_exec_mock, \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats"), \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim"), \
             patch("apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed"):
            _stub_tracker_run_filter(tracker_run_cls, update_return=None)
            skill_executor._run_skill_agent(run, skill_data, MagicMock(name="notifier"))

        self.assertEqual(resolve_exec_mock.call_args.kwargs.get("preferred_model_id"), stale)
        self.assertEqual(
            dispatcher.send_message_sync.call_args.kwargs.get("model_id"),
            str(fallback),
        )


class PureAgentNoSkillPromptTest(SimpleTestCase):
    """纯 Agent 模式（2026-06）：无 Skill 时执行入口仍能派活。

    钉死两件事：
    1. ``_run_skill_agent`` 接受 ``skill_data=None`` 不崩，照常 dispatch。
    2. 派给 Agent 的 prompt 用「指令(skill_params.instructions)」作任务主体，
       且不含「Skill 方法论」段，并提示 Agent 可自行搜索/调用 Skill
       （skills_search / skills_read）——这是「Agent 自助找 Skill」的产品契约。
    """

    def _drive_no_skill(self, *, instructions):
        from apps.tracker.services import tracker_executor  # noqa: F401 预热循环 import
        from apps.tracker.services import skill_executor

        run, tracker = _make_tracker_run(agent_id=uuid.uuid4())
        # 纯 Agent 模式：无 skill_key、指令作为任务载体。
        tracker.skill_key = ""
        tracker.skill_params = {"instructions": instructions}

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session
        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {"reply": "已完成任务并产出结论。" * 3}

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=MagicMock(control_device=MagicMock(name="online_device")),
             ), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", MagicMock()), \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats"), \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim"), \
             _patch_resolve_execution_model_id(), \
             patch("apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed"):
            _stub_tracker_run_filter(tracker_run_cls, update_return=None)
            # skill_data=None ⇒ 纯 Agent 路径
            skill_executor._run_skill_agent(run, None, MagicMock(name="notifier"))

        dispatcher.send_message_sync.assert_called_once()
        return dispatcher.send_message_sync.call_args.kwargs

    def test_no_skill_prompt_uses_instructions_as_task(self):
        kwargs = self._drive_no_skill(instructions="每天汇总今日邮件并发到 Inbox")
        message = kwargs["message"]

        self.assertIn("每天汇总今日邮件并发到 Inbox", message)
        self.assertNotIn("Skill 方法论", message)
        self.assertIn("skills_search", message)
        # ：UI 气泡只展示用户指令，模板引导语不暴露
        self.assertEqual(
            kwargs["app_context"]["display_message"],
            "每天汇总今日邮件并发到 Inbox",
        )
        self.assertIn("## 任务", message)
        self.assertNotEqual(kwargs["app_context"]["display_message"], message)


class ErrorCategoryRecoveryActionsTest(SimpleTestCase):
    """Agent 协议错误分类失败时,也要把结构化恢复动作写入 run context。"""

    def test_device_offline_error_suspends_waiting_device(self):
        from apps.tracker.services import tracker_executor  # noqa: F401 预热循环 import
        from apps.tracker.services import skill_executor

        run, tracker = _make_tracker_run(agent_id=uuid.uuid4())
        tracker.agent.preferred_model_id = uuid.uuid4()
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session
        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {
            "reply": "",
            "error_category": "device_offline",
            "error_message": "control_device sedas-MacBook-Air.local (darwin) status=offline",
        }

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=MagicMock(control_device=MagicMock(name="online_device")),
             ), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", MagicMock()), \
             patch.object(skill_executor, "_resolve_tracker_binding_device", return_value=MagicMock(name="offline_device")), \
             patch.object(skill_executor, "suspend_tracker_run_waiting_device", return_value=True) as suspend_run, \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats"), \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim"), \
             _patch_resolve_execution_model_id():
            _stub_tracker_run_filter(tracker_run_cls, update_return=None)
            skill_executor._run_skill_agent(run, skill_data, MagicMock(name="notifier"))

        suspend_run.assert_called_once()
        self.assertEqual(run.context["agent_result"]["error_category"], "device_offline")

    def test_device_dropped_error_suspends_waiting_device(self):
        """#4163：中途掉线复用 waiting_device，不直接判死。"""
        from apps.tracker.services import tracker_executor  # noqa: F401 预热循环 import
        from apps.tracker.services import skill_executor

        run, tracker = _make_tracker_run(agent_id=uuid.uuid4())
        tracker.agent.preferred_model_id = uuid.uuid4()
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session
        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {
            "reply": "执行设备在任务中途掉线，请确认客户端在线后重试。",
            "error_category": "device_dropped",
            "error_message": "control_device abc dropped to offline mid-task",
        }

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=MagicMock(control_device=MagicMock(name="online_device")),
             ), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", MagicMock()), \
             patch.object(skill_executor, "_resolve_tracker_binding_device", return_value=MagicMock(name="dropped_device")), \
             patch.object(skill_executor, "suspend_tracker_run_waiting_device", return_value=True) as suspend_run, \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats"), \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim"), \
             _patch_resolve_execution_model_id():
            _stub_tracker_run_filter(tracker_run_cls, update_return=None)
            skill_executor._run_skill_agent(run, skill_data, MagicMock(name="notifier"))

        suspend_run.assert_called_once()
        self.assertEqual(run.context["agent_result"]["error_category"], "device_dropped")


class DispatchTargetHonorsSelectedAgentTest(SimpleTestCase):
    """调度解析必须命中显式 / 会话 Agent，而非已废弃的 Space 默认绑定。

    ：只 mock ``_load_agent_by_id``；``_load_space_execution_agent`` 已随
    Space FK 退役。``resolve_dispatch_target`` 读 ``session.workspace``。
    """

    def setUp(self):
        self.selected_id = str(uuid.uuid4())
        self.agent_selected = MagicMock(name="agent_selected_by_tracker")
        self.agent_selected.control_device = None
        self.agent_selected.bound_device = None

        self.session = MagicMock(name="chat_session")
        self.session.id = uuid.uuid4()
        self.session.workspace = MagicMock(name="bot_workspace")
        self.session.agent_id = None

    def _fake_load_by_id(self, agent_id):
        return self.agent_selected if str(agent_id) == self.selected_id else None

    def test_explicit_agent_id_hits_selected_not_default(self):
        """app_context 带 ``_execution_agent_id`` → 命中 Tracker 选中的 Agent。"""
        from apps.services.remote_agent.device_resolver import resolve_dispatch_target

        with patch(
            "apps.tabtinspace.services.execution_binding._load_agent_by_id",
            side_effect=self._fake_load_by_id,
        ):
            target = resolve_dispatch_target(
                self.session, {"_execution_agent_id": self.selected_id}
            )

        self.assertIs(
            target.agent, self.agent_selected,
            "显式 _execution_agent_id 必须命中选中 Agent",
        )

    def test_missing_explicit_id_uses_session_agent_id(self):
        """无显式 id → 使用 session.agent_id（ 会话指针）。"""
        from apps.services.remote_agent.device_resolver import resolve_dispatch_target

        self.session.agent_id = self.selected_id
        with patch(
            "apps.tabtinspace.services.execution_binding._load_agent_by_id",
            side_effect=self._fake_load_by_id,
        ):
            target = resolve_dispatch_target(self.session, {})

        self.assertIs(
            target.agent, self.agent_selected,
            "未显式指定时应使用 session.agent_id",
        )

    def test_extract_explicit_agent_id_coerces_and_accepts_both_keys(self):
        """``_extract_explicit_agent_id`` 字段名 / str 强转契约钉死。"""
        from apps.services.remote_agent.device_resolver import _extract_explicit_agent_id

        aid = uuid.uuid4()
        self.assertEqual(_extract_explicit_agent_id({"_execution_agent_id": aid}), str(aid))
        self.assertEqual(_extract_explicit_agent_id({"execution_agent_id": aid}), str(aid))
        self.assertIsNone(_extract_explicit_agent_id({}))
        self.assertIsNone(_extract_explicit_agent_id(None))

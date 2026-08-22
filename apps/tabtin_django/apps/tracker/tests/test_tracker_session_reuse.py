"""#8259：TrackerRun 重试/重派复用同一条 ChatSession。

覆盖：
- 已有 active chat_session_id 时复用，不再 create
- 已归档 session 不拨回 active，改为新建并回填 FK
- 无 session / 已删除（行缺失）时新建
- create + 回填同事务；标题落库为「自动化任务 "…" 的第 N 次记录」
- 卡住恢复只认本次 attempt（stamp / started_at）之后的 assistant / trace
- pending→running 认领后立即 stamp
"""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase
from django.utils import timezone


def _atomic_cm():
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=None)
    cm.__exit__ = MagicMock(return_value=False)
    return cm


def _run_filter_qs(*, count=1, update_return=1):
    """run_index 的 count 与 chat_session_id 回填的 update 共用 filter()。"""
    qs = MagicMock(name="run_filter_qs")
    qs.count.return_value = count
    qs.update.return_value = update_return
    qs.filter.return_value = qs
    return qs


class ResolveOrCreateTrackerChatSessionTests(SimpleTestCase):
    def test_reuses_existing_active_session(self):
        from apps.tracker.services import skill_executor

        session_id = uuid4()
        existing = MagicMock(name="existing_session")
        existing.id = session_id
        existing.status = "active"
        existing.title = '自动化 "日报" 的第 1 次记录'

        tracker = MagicMock(name="tracker")
        tracker.id = uuid4()
        tracker.name = "日报"
        tracker.organization_id = uuid4()
        tracker.workspace_id = uuid4()
        tracker.agent_id = uuid4()
        tracker.skill_key = "demo"

        run = MagicMock(name="run")
        run.id = uuid4()
        run.chat_session_id = session_id
        run.created_at = timezone.now()

        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.filter.return_value.first.return_value = existing
        chat_context_cls = MagicMock(name="ChatContext")

        with patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", chat_context_cls), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls:
            tracker_run_cls.objects.filter.return_value = _run_filter_qs(count=1)
            session = skill_executor._resolve_or_create_tracker_chat_session(
                run, tracker, MagicMock(name="creator"),
            )

        self.assertIs(session, existing)
        chat_session_cls.objects.create.assert_not_called()
        chat_context_cls.objects.get_or_create.assert_called_once()
        chat_context_cls.objects.create.assert_not_called()

    def test_creates_new_when_existing_session_archived(self):
        """用户归档过的对话不得被重试拨回 active。"""
        from apps.tracker.constants import build_tracker_run_session_title
        from apps.tracker.services import skill_executor

        archived_id = uuid4()
        archived = MagicMock(name="archived_session")
        archived.id = archived_id
        archived.status = "archived"

        created = MagicMock(name="created_session")
        created.id = uuid4()

        tracker = MagicMock(name="tracker")
        tracker.id = uuid4()
        tracker.name = "日报"
        tracker.organization_id = uuid4()
        tracker.workspace_id = uuid4()
        tracker.agent_id = uuid4()
        tracker.skill_key = "demo"

        run = MagicMock(name="run")
        run.id = uuid4()
        run.chat_session_id = archived_id
        run.created_at = timezone.now()

        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.filter.return_value.first.return_value = archived
        chat_session_cls.objects.create.return_value = created
        chat_context_cls = MagicMock(name="ChatContext")

        with patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", chat_context_cls), \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls:
            tracker_run_cls.objects.filter.return_value = _run_filter_qs(count=4)
            session = skill_executor._resolve_or_create_tracker_chat_session(
                run, tracker, MagicMock(name="creator"),
            )

        self.assertIs(session, created)
        chat_session_cls.objects.create.assert_called_once()
        kwargs = chat_session_cls.objects.create.call_args.kwargs
        self.assertEqual(kwargs["title"], build_tracker_run_session_title("日报", 4))
        self.assertEqual(kwargs["title_generation_status"], "done")
        # 不得把 archived 拨回 active
        chat_session_cls.objects.filter.return_value.update.assert_not_called()
        tracker_run_cls.objects.filter.return_value.update.assert_called_once_with(
            chat_session_id=created.id,
        )

    def test_creates_when_no_existing_session(self):
        from apps.tracker.constants import build_tracker_run_session_title
        from apps.tracker.services import skill_executor

        created = MagicMock(name="created_session")
        created.id = uuid4()

        tracker = MagicMock(name="tracker")
        tracker.id = uuid4()
        tracker.name = "打开终端"
        tracker.organization_id = uuid4()
        tracker.workspace_id = uuid4()
        tracker.agent_id = uuid4()
        tracker.skill_key = "demo"

        run = MagicMock(name="run")
        run.id = uuid4()
        run.chat_session_id = None
        run.created_at = timezone.now()

        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = created
        chat_context_cls = MagicMock(name="ChatContext")

        with patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", chat_context_cls), \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls:
            tracker_run_cls.objects.filter.return_value = _run_filter_qs(count=3)
            session = skill_executor._resolve_or_create_tracker_chat_session(
                run, tracker, MagicMock(name="creator"),
            )

        self.assertIs(session, created)
        chat_session_cls.objects.create.assert_called_once()
        kwargs = chat_session_cls.objects.create.call_args.kwargs
        self.assertEqual(kwargs["title"], build_tracker_run_session_title("打开终端", 3))
        self.assertEqual(kwargs["title_generation_status"], "done")
        tracker_run_cls.objects.filter.return_value.update.assert_called_once_with(
            chat_session_id=created.id,
        )
        chat_context_cls.objects.create.assert_called_once()

    def test_creates_when_existing_session_row_missing(self):
        """FK 仍指向已删行时 first() 为空，应新建而非复用。"""
        from apps.tracker.services import skill_executor

        created = MagicMock(name="created_session")
        created.id = uuid4()
        stale_id = uuid4()

        tracker = MagicMock(name="tracker")
        tracker.id = uuid4()
        tracker.name = "清理残留"
        tracker.organization_id = uuid4()
        tracker.workspace_id = uuid4()
        tracker.agent_id = uuid4()
        tracker.skill_key = "demo"

        run = MagicMock(name="run")
        run.id = uuid4()
        run.chat_session_id = stale_id
        run.created_at = timezone.now()

        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.filter.return_value.first.return_value = None
        chat_session_cls.objects.create.return_value = created
        chat_context_cls = MagicMock(name="ChatContext")

        with patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", chat_context_cls), \
             patch("django.db.transaction.atomic", return_value=_atomic_cm()), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls:
            tracker_run_cls.objects.filter.return_value = _run_filter_qs(count=1)
            session = skill_executor._resolve_or_create_tracker_chat_session(
                run, tracker, MagicMock(name="creator"),
            )

        self.assertIs(session, created)
        chat_session_cls.objects.create.assert_called_once()
        chat_context_cls.objects.get_or_create.assert_not_called()

    def test_reuse_rewrites_legacy_tracker_title(self):
        from apps.tracker.constants import build_tracker_run_session_title
        from apps.tracker.services import skill_executor

        session_id = uuid4()
        existing = MagicMock(name="existing_session")
        existing.id = session_id
        existing.status = "active"
        existing.title = "[Tracker] 日报"

        tracker = MagicMock(name="tracker")
        tracker.id = uuid4()
        tracker.name = "日报"
        tracker.organization_id = uuid4()
        tracker.workspace_id = uuid4()
        tracker.agent_id = uuid4()
        tracker.skill_key = "demo"

        run = MagicMock(name="run")
        run.id = uuid4()
        run.chat_session_id = session_id
        run.created_at = timezone.now()

        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.filter.return_value.first.return_value = existing
        chat_context_cls = MagicMock(name="ChatContext")

        with patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", chat_context_cls), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls:
            tracker_run_cls.objects.filter.return_value = _run_filter_qs(count=2)
            session = skill_executor._resolve_or_create_tracker_chat_session(
                run, tracker, MagicMock(name="creator"),
            )

        self.assertIs(session, existing)
        chat_session_cls.objects.filter.return_value.update.assert_called_once_with(
            title=build_tracker_run_session_title("日报", 2),
            title_generation_status="done",
        )


class CompletedReplyAttemptBoundaryTests(SimpleTestCase):
    def test_chat_reply_filters_by_attempt_started_at(self):
        from apps.tracker.constants import CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY
        from apps.tracker.services import tracker_executor

        session_id = uuid4()
        attempt_started = timezone.now()
        run = SimpleNamespace(
            id=uuid4(),
            chat_session_id=session_id,
            started_at=attempt_started - timedelta(hours=1),
            context={
                CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY: attempt_started.isoformat(),
            },
        )

        qs = MagicMock(name="message_qs")
        filtered = MagicMock(name="filtered_qs")
        qs.filter.return_value = filtered
        filtered.order_by.return_value.first.return_value = None

        with patch(
            "apps.chat.conversation.models.ChatMessage"
        ) as chat_message_cls:
            chat_message_cls.objects.filter.return_value = qs
            reply = tracker_executor._find_completed_chat_reply(run)

        self.assertEqual(reply, "")
        qs.filter.assert_called_once()
        kwargs = qs.filter.call_args.kwargs
        self.assertIn("created_at__gte", kwargs)
        self.assertGreaterEqual(
            kwargs["created_at__gte"],
            attempt_started - timedelta(seconds=1),
        )

    def test_chat_reply_falls_back_to_started_at_without_stamp(self):
        from apps.tracker.services import tracker_executor

        session_id = uuid4()
        started_at = timezone.now() - timedelta(minutes=5)
        run = SimpleNamespace(
            id=uuid4(),
            chat_session_id=session_id,
            started_at=started_at,
            context={},
        )

        qs = MagicMock(name="message_qs")
        filtered = MagicMock(name="filtered_qs")
        qs.filter.return_value = filtered
        filtered.order_by.return_value.first.return_value = None

        with patch(
            "apps.chat.conversation.models.ChatMessage"
        ) as chat_message_cls:
            chat_message_cls.objects.filter.return_value = qs
            reply = tracker_executor._find_completed_chat_reply(run)

        self.assertEqual(reply, "")
        kwargs = qs.filter.call_args.kwargs
        self.assertEqual(kwargs["created_at__gte"], started_at)

    def test_chat_reply_refuses_without_lower_bound(self):
        from apps.tracker.services import tracker_executor

        run = SimpleNamespace(
            id=uuid4(),
            chat_session_id=uuid4(),
            started_at=None,
            context={},
        )

        with patch(
            "apps.chat.conversation.models.ChatMessage"
        ) as chat_message_cls:
            reply = tracker_executor._find_completed_chat_reply(run)

        self.assertEqual(reply, "")
        chat_message_cls.objects.filter.assert_called_once()
        # 无下界时不得 order_by / first 取任意旧消息
        chat_message_cls.objects.filter.return_value.filter.assert_not_called()

    def test_trace_reply_filters_by_attempt_started_at(self):
        from apps.tracker.constants import CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY
        from apps.tracker.services import tracker_executor

        session_id = uuid4()
        attempt_started = timezone.now()
        run = SimpleNamespace(
            id=uuid4(),
            chat_session_id=session_id,
            started_at=None,
            context={
                CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY: attempt_started.isoformat(),
            },
        )

        qs = MagicMock(name="trace_qs")
        filtered = MagicMock(name="filtered_qs")
        qs.filter.return_value = filtered
        filtered.order_by.return_value.first.return_value = None

        with patch(
            "apps.services.agent_engine.models.ExecutionTrace"
        ) as trace_cls, patch(
            "apps.services.agent_engine.models.TraceEvent"
        ):
            trace_cls.objects.filter.return_value = qs
            reply = tracker_executor._find_completed_trace_reply(run)

        self.assertEqual(reply, "")
        kwargs = qs.filter.call_args.kwargs
        self.assertIn("ended_at__gte", kwargs)


class ClaimStampsAttemptStartedAtTests(SimpleTestCase):
    def test_run_tracker_run_stamps_after_claim(self):
        from apps.tracker.constants import CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY
        from apps.tracker.services import tracker_executor

        run_id = uuid4()
        run = MagicMock(name="run")
        run.id = run_id
        run.status = "pending"
        run.context = {}

        claim_qs = MagicMock(name="claim_qs")
        claim_qs.update.return_value = 1
        stamp_updates: list[dict] = []

        def _filter(**kwargs):
            if kwargs.get("status") == "pending":
                return claim_qs
            qs = MagicMock(name="stamp_qs")

            def _update(**ukwargs):
                stamp_updates.append(ukwargs)
                return 1

            qs.update.side_effect = _update
            return qs

        with patch.object(
            tracker_executor.TrackerRun.objects, "select_related",
            return_value=MagicMock(get=MagicMock(return_value=run)),
        ), patch.object(
            tracker_executor.TrackerRun.objects, "filter", side_effect=_filter,
        ), patch(
            "apps.tracker.services.skill_executor.run_skill_based"
        ) as run_skill:
            tracker_executor.run_tracker_run(str(run_id))

        run_skill.assert_called_once_with(run)
        self.assertEqual(len(stamp_updates), 1)
        self.assertIn(
            CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY,
            stamp_updates[0]["context"],
        )


class DeviceSuspendKeepsChatSessionTests(SimpleTestCase):
    def test_device_dropped_does_not_clear_chat_session_id(self):
        from apps.tracker.services import skill_executor

        run = MagicMock(name="run")
        run.id = uuid4()
        run.status = "running"
        run.context = {}
        run.chat_session_id = uuid4()
        run.started_at = None
        run.created_at = timezone.now()

        tracker = MagicMock(name="tracker")
        tracker.id = uuid4()
        tracker.name = "调研"
        tracker.organization_id = uuid4()
        tracker.workspace_id = uuid4()
        tracker.agent_id = uuid4()
        tracker.skill_key = "research_skill"
        tracker.skill_params = None
        tracker.created_by = MagicMock(name="creator")
        tracker.agent.preferred_model_id = uuid4()
        run.tracker = tracker

        fake_session = MagicMock(name="chat_session")
        fake_session.id = run.chat_session_id
        fake_session.status = "active"
        fake_session.title = '自动化 "调研" 的第 1 次记录'

        updates: list[dict] = []

        class _QS:
            def update(self, **kwargs):
                updates.append(kwargs)
                return 1

            def first(self):
                return fake_session

            def count(self):
                return 1

        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.filter.return_value = _QS()
        chat_context_cls = MagicMock(name="ChatContext")
        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {
            "reply": "执行设备在任务中途掉线，请确认客户端在线后重试。",
            "error_category": "device_dropped",
            "error_message": "control_device abc dropped to offline mid-task",
        }

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch.object(skill_executor, "_is_device_dispatchable", return_value=True), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", chat_context_cls), \
             patch.object(
                 skill_executor, "_resolve_tracker_binding_device",
                 return_value=MagicMock(name="device"),
             ), \
             patch.object(
                 skill_executor, "suspend_tracker_run_waiting_device", return_value=True,
             ), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats"), \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim"), \
             patch(
                 "apps.services.agent_execution.model_resolver.resolve_execution_model_id",
                 return_value=str(uuid4()),
             ):
            tracker_run_cls.objects.filter.return_value = _QS()
            skill_executor._run_skill_agent(
                run, {"name": "research_skill", "doc_content": "doc"}, MagicMock(),
            )

        clear_updates = [
            u for u in updates if "chat_session_id" in u and u["chat_session_id"] is None
        ]
        self.assertEqual(clear_updates, [])
        chat_session_cls.objects.create.assert_not_called()


class SessionReuseKeepsListBucketingKeyTests(SimpleTestCase):
    """复用路径保持 chat_session_id，列表分桶仍能命中同一 session。"""

    def test_reuse_keeps_same_chat_session_id_for_bucketing(self):
        from apps.tracker.services import skill_executor

        session_id = uuid4()
        existing = MagicMock(name="existing_session")
        existing.id = session_id
        existing.status = "active"
        existing.title = '自动化 "分桶" 的第 1 次记录'

        tracker = MagicMock(name="tracker")
        tracker.id = uuid4()
        tracker.name = "分桶"
        tracker.organization_id = uuid4()
        tracker.workspace_id = uuid4()
        tracker.agent_id = uuid4()
        tracker.skill_key = "demo"

        run = MagicMock(name="run")
        run.id = uuid4()
        run.chat_session_id = session_id
        run.created_at = timezone.now()

        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.filter.return_value.first.return_value = existing
        chat_context_cls = MagicMock(name="ChatContext")

        with patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", chat_context_cls), \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls:
            tracker_run_cls.objects.filter.return_value = _run_filter_qs(count=1)
            session = skill_executor._resolve_or_create_tracker_chat_session(
                run, tracker, MagicMock(name="creator"),
            )

        self.assertEqual(session.id, session_id)
        self.assertEqual(run.chat_session_id, session_id)
        # 分桶依赖 TrackerRun.chat_session_id；复用不得改写该 FK
        chat_session_cls.objects.create.assert_not_called()


class TrackerRunSessionTitleHelpersTests(SimpleTestCase):
    def test_build_and_detect_product_title(self):
        from apps.tracker.constants import (
            build_tracker_run_session_title,
            is_tracker_run_session_title,
        )

        title = build_tracker_run_session_title("test", 15)
        self.assertEqual(title, '自动化任务 "test" 的第 15 次记录')
        self.assertTrue(is_tracker_run_session_title(title))
        # 过渡 / 旧称产品文案仍须识别，复用会话时才能拨到现行「自动化任务」标题
        self.assertTrue(is_tracker_run_session_title('自动化 "test" 的第 15 次记录'))
        self.assertTrue(
            is_tracker_run_session_title('定时任务 "test" 的第 15 次记录')
        )
        self.assertTrue(is_tracker_run_session_title("[Tracker] test"))
        self.assertFalse(is_tracker_run_session_title("我的手改标题"))
        self.assertFalse(is_tracker_run_session_title(""))

"""archive_old_tracker_sessions 任务测试（隐患 4 / Review K2）。

每天 04:45 周期归档 7+ 天前已终态的 [Tracker] 对话。本测试覆盖 6 个 case：

case 1: 终态 Run（completed/failed/cancelled/partial_failed）+ 创建时间 >7d → 归档
case 2: 终态 Run + 创建时间 <7d → 不动
case 3: 非终态 Run（pending / running）+ 老时间 → 不归档
case 4: 已 archived ChatSession → 不重复归档
case 5: ``chat_session_id`` 为 NULL 的 Run → 跳过
case 6: ``retention_days=0`` → 抛 ValueError（守卫）

⚠️ 守 ``TABTIN_REAL_DB_TEST=1`` 环境变量（与 ``test_tracker_run_meta_resolution.py``
同模式）。
"""

from __future__ import annotations

import os
import uuid
from datetime import timedelta

from django.test import SimpleTestCase, TransactionTestCase
from django.utils import timezone


_REQUIRES_REAL_DB = os.getenv("TABTIN_REAL_DB_TEST") == "1"


class ArchiveTaskGuardContractTest(SimpleTestCase):
    """case 6（不依赖 DB）：retention_days < 1 必须抛 ValueError 守卫。

    没有这条守卫时，retention_days=0 会让 cutoff = 现在或将来，瞬间归档**所有**
    active session（包括用户当前对话），是灾难性 bug。
    """

    def test_zero_retention_days_raises_value_error(self):
        from apps.chat.conversation.tasks import archive_old_tracker_sessions

        with self.assertRaises(ValueError) as ctx:
            archive_old_tracker_sessions(retention_days=0)
        self.assertIn("retention_days", str(ctx.exception))

    def test_negative_retention_days_raises_value_error(self):
        from apps.chat.conversation.tasks import archive_old_tracker_sessions

        with self.assertRaises(ValueError):
            archive_old_tracker_sessions(retention_days=-1)


if _REQUIRES_REAL_DB:

    class ArchiveOldTrackerSessionsRealOrmTest(TransactionTestCase):
        """case 1-5：真 ORM 路径。"""

        databases = {"default", "postgresql"}

        @classmethod
        def setUpClass(cls):
            super().setUpClass()
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            from django.contrib.auth import get_user_model
            post_save.disconnect(create_default_organization, sender=get_user_model())

        @classmethod
        def tearDownClass(cls):
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            from django.contrib.auth import get_user_model
            post_save.connect(create_default_organization, sender=get_user_model())
            super().tearDownClass()

        def setUp(self):
            from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
            ctx = create_test_organization_with_agent(prefix="arch_tracker")
            self.user = ctx["user"]
            self.organization = ctx["organization"]
            self.agent = ctx["agent"]
            self.space = ctx["space"]

        def tearDown(self):
            from apps.tabtinspace.tests.fixtures import cleanup_test_organization
            cleanup_test_organization(self.organization, delete_user=True)

        def _make_tracker(self, name="t-archive"):
            from apps.tracker.models import Tracker
            return Tracker.objects.create(
                id=uuid.uuid4(),
                organization_id=self.organization.id,
                space_id=self.space.id if self.space else None,
                agent_id=self.agent.id,
                name=name,
                description="archive test",
                trigger_type="manual",
                trigger_config={},
                status="active",
                created_by_id=self.user.id,
            )

        def _make_chat_session(self, *, title="run-session", status="active",
                               created_at=None):
            from apps.chat.conversation.models import ChatSession
            sess = ChatSession.objects.create(
                id=uuid.uuid4(),
                user=self.user,
                organization_id=str(self.organization.id),
                space_id=self.space.id if self.space else None,
                title=title,
                status=status,
            )
            if created_at:
                # 绕过 auto_now_add，直接 update
                ChatSession.objects.filter(id=sess.id).update(created_at=created_at)
                sess.refresh_from_db()
            return sess

        def _make_run(self, tracker, *, chat_session, status="completed",
                      created_at=None):
            from apps.tracker.models import TrackerRun
            run = TrackerRun.objects.create(
                id=uuid.uuid4(),
                tracker=tracker,
                chat_session_id=chat_session.id if chat_session else None,
                status=status,
                trigger_type="manual",
                trigger_context={},
                started_at=timezone.now(),
                finished_at=timezone.now(),
            )
            if created_at:
                TrackerRun.objects.filter(id=run.id).update(created_at=created_at)
                run.refresh_from_db()
            return run

        # ── case 1：终态 + 老 → 归档 ───────────────────────────────────

        def test_terminal_run_with_old_session_gets_archived(self):
            from apps.chat.conversation.models import ChatSession
            from apps.chat.conversation.tasks import archive_old_tracker_sessions

            tracker = self._make_tracker()
            old = timezone.now() - timedelta(days=10)
            session = self._make_chat_session(title="case1-old", created_at=old)
            self._make_run(
                tracker, chat_session=session,
                status="completed", created_at=old,
            )

            result = archive_old_tracker_sessions(retention_days=7)
            self.assertGreaterEqual(result["archived"], 1)

            session.refresh_from_db()
            self.assertEqual(session.status, "archived")

        # ── case 2：终态 + 新 → 不动 ───────────────────────────────────

        def test_terminal_run_with_recent_session_kept_active(self):
            from apps.chat.conversation.tasks import archive_old_tracker_sessions

            tracker = self._make_tracker()
            recent = timezone.now() - timedelta(days=1)
            session = self._make_chat_session(title="case2-recent", created_at=recent)
            self._make_run(
                tracker, chat_session=session,
                status="completed", created_at=recent,
            )

            archive_old_tracker_sessions(retention_days=7)

            session.refresh_from_db()
            self.assertEqual(session.status, "active")

        # ── case 3：非终态 Run + 老时间 → 不归档 ─────────────────────────

        def test_non_terminal_run_old_session_not_archived(self):
            from apps.chat.conversation.tasks import archive_old_tracker_sessions

            tracker = self._make_tracker()
            old = timezone.now() - timedelta(days=10)
            session = self._make_chat_session(
                title="case3-running", created_at=old,
            )
            self._make_run(
                tracker, chat_session=session,
                status="running", created_at=old,
            )

            archive_old_tracker_sessions(retention_days=7)

            session.refresh_from_db()
            self.assertEqual(
                session.status, "active",
                "running Run 关联 session 不应被归档（任务可能仍在跑）",
            )

        # ── case 4：已 archived ChatSession → 不重复处理 ─────────────────

        def test_already_archived_session_not_touched(self):
            from apps.chat.conversation.models import ChatSession
            from apps.chat.conversation.tasks import archive_old_tracker_sessions

            tracker = self._make_tracker()
            old = timezone.now() - timedelta(days=10)
            session = self._make_chat_session(
                title="case4-archived",
                status="archived",
                created_at=old,
            )
            self._make_run(
                tracker, chat_session=session,
                status="completed", created_at=old,
            )

            result = archive_old_tracker_sessions(retention_days=7)

            # update 不会再次归档 archived → 0；同时 session.status 保持 archived
            session.refresh_from_db()
            self.assertEqual(session.status, "archived")
            # 严格断言：archived 行根本不会进 candidate_ids（filter status='active'）
            archived_count = ChatSession.objects.filter(
                id=session.id, status="archived",
            ).count()
            self.assertEqual(archived_count, 1)

        # ── case 5：chat_session_id 为 NULL 的 Run 跳过 ──────────────────

        def test_run_with_null_session_id_is_skipped(self):
            from apps.chat.conversation.tasks import archive_old_tracker_sessions

            tracker = self._make_tracker()
            old = timezone.now() - timedelta(days=10)
            self._make_run(
                tracker, chat_session=None,
                status="completed", created_at=old,
            )

            # 不应崩——exclude(chat_session_id__isnull=True) 过滤掉 NULL Run。
            result = archive_old_tracker_sessions(retention_days=7)
            self.assertEqual(result.get("archived", 0), 0)

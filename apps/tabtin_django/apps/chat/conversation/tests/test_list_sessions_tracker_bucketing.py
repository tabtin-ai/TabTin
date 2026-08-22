"""
隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）后端单测

测试 ``list_sessions`` / ``list_all_sessions`` 的 ``include_tracker_runs`` 参数:

  1. 默认（``include_tracker_runs=false``):剔除关联 TrackerRun 的 ChatSession,
     响应附带 ``tracker_run_count`` 让前端折叠分组 header 显示数量。
  2. ``include_tracker_runs=true``:仅返回关联 TrackerRun 的 ChatSession
     (即"打开折叠分组 → 单独 fetch Tracker 对话"模式)。
  3. 跨库 PG 查询失败时 fallback 到原"不分桶"行为(返回全部) +
     ``tracker_run_count=None`` —— 不让 chat 列表 API 因 scheduler 故障整个 500。

测试设计参考 ``test_tracker_run_meta_resolution.py`` / ``test_session_reuse.py``:
跨库 fixture 必须用 ``TransactionTestCase`` + ``databases = {"default", "postgresql"}``,
SimpleTestCase 跑跨库 ORM 写入会"看起来 pass 实际 except 吞 ORMError"(总控反思 9)。
"""
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from apps.chat.conversation.models import ChatSession
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class ListSessionsTrackerBucketingTest(TransactionTestCase):
    """list_sessions / list_all_sessions 的 include_tracker_runs 分桶单测。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 防止默认 organization signal 自动建团队干扰
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
        ctx = create_test_organization_with_agent(prefix="bucket")
        self.user = ctx["user"]
        self.organization = ctx["organization"]
        self.agent = ctx["agent"]
        self.space = ctx["space"]
        from apps.tabtinspace.models import SpaceMembership
        SpaceMembership.objects.get_or_create(
            workspace=self.space,
            user=self.user,
            defaults={"role": "owner"},
        )

        # JWT 认证 + active UserSession,模拟登录态
        self.raw_session_key = f"tracker_bucket_{uuid.uuid4().hex}"
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(self.raw_session_key),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="tracker-bucket-test",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        self.token = generate_jwt_token(
            self.user,
            expire_hours=1,
            token_type="access",
            session_key=self.raw_session_key,
        )
        self.auth_headers = {"HTTP_AUTHORIZATION": f"Bearer {self.token}"}

    def tearDown(self):
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization
        cleanup_test_organization(self.organization, delete_user=True)

    def _get(self, url):
        return self.client.get(url, **self.auth_headers)

    def _create_chat_session(
        self,
        title="s",
        agent=None,
        project=None,
        workspace=None,
    ):
        workspace_id = None
        if workspace is not None:
            workspace_id = workspace.id
        elif self.space is not None:
            workspace_id = self.space.id
        return ChatSession.objects.create(
            id=uuid.uuid4(),
            user=self.user,
            organization_id=str(self.organization.id),
            workspace_id=workspace_id,
            project=project,
            agent_id=(agent or self.agent).id,
            title=title,
            status="active",
        )

    def _attach_run_projection(self, session, status="waiting_user"):
        """为 session 挂一条 SessionRunProjection（列表 run_status 筛选真源）。"""
        from apps.services.agent_engine.models import ExecutionRun, SessionRunProjection

        now = timezone.now()
        run = ExecutionRun.objects.create(
            run_id=uuid.uuid4(),
            thread_id=f"chat-session-{session.id}",
            graph_type="chat",
            session_id=str(session.id),
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            status=status,
            sequence=1,
            revision=1,
            state_changed_at=now,
            started_at=now,
        )
        return SessionRunProjection.objects.create(
            session=session,
            current_run=run,
            sequence=1,
            revision=1,
            status=status,
            state_changed_at=now,
            started_at=now,
            waiting_interaction_id=(
                uuid.uuid4() if status == "waiting_user" else None
            ),
        )

    def _create_agent_mention_job(self, session, status="succeeded"):
        from apps.tabchat.models import AgentMentionJob

        return AgentMentionJob.objects.create(
            source_message_ref=f"message-{session.id}",
            agent_id=str(self.agent.id),
            organization_id=str(self.organization.id),
            status=status,
            session_id=session.id,
            billing_idempotency_key=f"mention-{session.id}",
        )

    def _create_mention_context(self, session):
        from apps.chat.conversation.models import ChatContext
        from apps.tabchat.constants import TABCHAT_MENTION_INVOKED_FROM

        return ChatContext.objects.create(
            session=session,
            context_data={"_invoked_from": TABCHAT_MENTION_INVOKED_FROM},
        )

    def _create_tracker(self, name="T"):
        from apps.tracker.models import Tracker
        return Tracker.objects.create(
            id=uuid.uuid4(),
            organization_id=self.organization.id,
            workspace_id=self.space.id if self.space else None,
            agent_id=self.agent.id,
            name=name,
            description="test instructions",
            trigger_type="manual",
            trigger_config={},
            status="active",
            created_by_id=self.user.id,
        )

    def _create_tracker_run(self, tracker, chat_session, status="completed"):
        from apps.tracker.models import TrackerRun
        return TrackerRun.objects.create(
            id=uuid.uuid4(),
            tracker=tracker,
            chat_session_id=chat_session.id,
            status=status,
            trigger_type="manual",
            trigger_context={},
        )

    def _seed_mixed_sessions(self):
        """建 3 普通 session + 2 tracker session。返回 (normal_ids, tracker_ids)。"""
        normal = [self._create_chat_session(title=f"normal-{i}") for i in range(3)]
        tracker_sessions = [
            self._create_chat_session(title=f"[Tracker] run-{i}") for i in range(2)
        ]
        tr = self._create_tracker(name="周报整理")
        for s in tracker_sessions:
            self._create_tracker_run(tr, s)
        return (
            {str(s.id) for s in normal},
            {str(s.id) for s in tracker_sessions},
        )

    # ── list_all_sessions（跨 Space 主列表）─────────────────────────

    def test_list_all_sessions_uses_session_agent_not_space_agent(self):
        from apps.agent.models import Agent

        other_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="Session Truth Agent",
            type="bot",
        )
        session = self._create_chat_session(
            title="session-agent-truth",
            agent=other_agent,
        )

        response = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}"
            f"&agent_id={other_agent.id}"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json().get("data", response.json())
        self.assertEqual([item["id"] for item in data["sessions"]], [str(session.id)])
        self.assertEqual(data["sessions"][0]["agent_id"], str(other_agent.id))
        self.assertEqual(data["sessions"][0]["agent_name"], "Session Truth Agent")

        keyword_response = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}"
            "&keyword=Session%20Truth%20Agent"
        )
        keyword_data = keyword_response.json().get("data", keyword_response.json())
        self.assertEqual(
            [item["id"] for item in keyword_data["sessions"]],
            [str(session.id)],
        )

    def test_list_all_sessions_does_not_return_sessions_from_another_organization(self):
        """同一用户属于 A、B 时，A 的 agent 查询不得混入 B 的会话。"""
        from apps.tabtinspace.tests.fixtures import (
            cleanup_test_organization,
            create_test_organization_with_agent,
        )

        session_a = self._create_chat_session(title="organization-a")
        other_ctx = create_test_organization_with_agent(
            owner=self.user,
            prefix="bucket_other_org",
        )
        try:
            session_b = ChatSession.objects.create(
                id=uuid.uuid4(),
                user=self.user,
                organization_id=str(other_ctx["organization"].id),
                workspace_id=other_ctx["space"].id,
                # 故意复用组织 A 的 agent，确保该断言验证的是 organization_id 过滤，
                # 而非 agent_id 恰好不同带来的排除。
                agent_id=self.agent.id,
                title="organization-b",
                status="active",
            )

            response = self._get(
                f"/api/chat/sessions/all?organization_id={self.organization.id}"
                f"&agent_id={self.agent.id}"
            )

            self.assertEqual(response.status_code, 200)
            data = response.json().get("data", response.json())
            session_ids = {item["id"] for item in data["sessions"]}
            self.assertIn(str(session_a.id), session_ids)
            self.assertNotIn(str(session_b.id), session_ids)
        finally:
            cleanup_test_organization(other_ctx["organization"], delete_user=False)

    def test_list_all_sessions_handles_project_without_icon_field(self):
        """Project 没有 icon 列，带 Project 的新会话也必须能正常拉取。"""
        from apps.tabtinspace.models import Project

        project = Project.objects.create(
            organization=self.organization,
            name="Project session",
            avatar="project-avatar.png",
        )
        session = self._create_chat_session(
            title="project-backed-session",
            project=project,
        )

        response = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)
        item = next(row for row in data["sessions"] if row["id"] == str(session.id))
        self.assertEqual(item["project_id"], str(project.id))
        self.assertEqual(item["project_name"], "Project session")
        self.assertIsNone(item["agent_icon"])
        self.assertEqual(item["agent_avatar"], "project-avatar.png")

    def test_list_all_sessions_excludes_tracker_runs_by_default(self):
        """默认 include_tracker_runs=false:剔除 Tracker session + 返 tracker_run_count。"""
        normal_ids, tracker_ids = self._seed_mixed_sessions()

        response = self._get(f"/api/chat/sessions/all?organization_id={self.organization.id}")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)

        returned_ids = {s["id"] for s in data["sessions"]}
        # 普通 session 应当全部返回
        self.assertEqual(returned_ids, normal_ids)
        # Tracker session 不在 sessions 里
        self.assertTrue(tracker_ids.isdisjoint(returned_ids))
        # tracker_run_count = 实际剔除掉的 Tracker session 数(2)
        self.assertEqual(data["tracker_run_count"], 2)
        # total 也应当是剔除后的数量,跟 sessions 长度一致
        self.assertEqual(data["total"], 3)

    def test_list_all_sessions_only_tracker_runs_when_include_true(self):
        """include_tracker_runs=true:仅返回 Tracker session(供前端展开折叠分组单独 fetch)。"""
        _normal_ids, tracker_ids = self._seed_mixed_sessions()

        response = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}"
            f"&include_tracker_runs=true"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)

        returned_ids = {s["id"] for s in data["sessions"]}
        self.assertEqual(returned_ids, tracker_ids)
        self.assertEqual(data["total"], 2)
        # 每条返回的 session 都应当带 tracker_run 元数据(批量解析 helper 注入)
        for s in data["sessions"]:
            self.assertIsNotNone(s.get("tracker_run"))

    def test_list_all_sessions_fallback_when_pg_query_fails(self):
        """跨库 helper 返 None 时(PG 暂时不可用) → fallback 到不分桶 +
        tracker_run_count=None,不让 chat 列表 API 整个 500。"""
        normal_ids, tracker_ids = self._seed_mixed_sessions()

        with patch(
            "apps.chat.conversation.api.session._fetch_tracker_run_session_ids",
            return_value=None,
        ):
            response = self._get(f"/api/chat/sessions/all?organization_id={self.organization.id}")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)
        returned_ids = {s["id"] for s in data["sessions"]}
        # fallback 行为:返全部(普通 + tracker)
        self.assertEqual(returned_ids, normal_ids | tracker_ids)
        # tracker_run_count 为 None(前端按"不显示 badge"处理)
        self.assertIsNone(data["tracker_run_count"])

    # ── list_sessions（单 Space 列表,同源行为）──────────────────────

    def test_list_sessions_excludes_agent_mention_sessions_when_requested(self):
        normal_session = self._create_chat_session(title="normal-task")
        mention_session = self._create_chat_session(title="user-editable-title")
        self._create_agent_mention_job(mention_session)

        response = self._get(
            f"/api/chat/sessions?workspace_id={self.space.id}"
            "&exclude_agent_mention_sessions=true"
        )

        self.assertEqual(response.status_code, 200)
        data = response.json().get("data", response.json())
        self.assertEqual(
            [session["id"] for session in data["sessions"]],
            [str(normal_session.id)],
        )
        self.assertEqual(data["total"], 1)
        self.assertEqual(
            data["excluded_agent_mention_session_ids"],
            [str(mention_session.id)],
        )
        self.assertFalse(data["sessions"][0]["is_agent_mention_session"])

    def test_list_sessions_marks_agent_mention_flag_without_explicit_filter(self):
        mention_session = self._create_chat_session(title="user-editable-title")
        self._create_agent_mention_job(mention_session)

        response = self._get(f"/api/chat/sessions?workspace_id={self.space.id}")

        self.assertEqual(response.status_code, 200)
        data = response.json().get("data", response.json())
        row = next(
            session
            for session in data["sessions"]
            if session["id"] == str(mention_session.id)
        )
        self.assertTrue(row["is_agent_mention_session"])

    def test_list_sessions_excludes_mention_via_chat_context_without_job(self):
        """Job 尚未回填时，ChatContext._invoked_from=tabchat_mention 仍应排除。"""
        normal_session = self._create_chat_session(title="normal-task")
        mention_session = self._create_chat_session(title="user-editable-title")
        self._create_mention_context(mention_session)

        response = self._get(
            f"/api/chat/sessions?workspace_id={self.space.id}"
            "&exclude_agent_mention_sessions=true"
        )

        self.assertEqual(response.status_code, 200)
        data = response.json().get("data", response.json())
        self.assertEqual(
            [session["id"] for session in data["sessions"]],
            [str(normal_session.id)],
        )
        self.assertEqual(
            data["excluded_agent_mention_session_ids"],
            [str(mention_session.id)],
        )

    def test_list_sessions_keeps_agent_mentions_without_explicit_filter(self):
        mention_session = self._create_chat_session(title="[私信@小Tin]")
        self._create_agent_mention_job(mention_session)

        response = self._get(f"/api/chat/sessions?workspace_id={self.space.id}")

        self.assertEqual(response.status_code, 200)
        data = response.json().get("data", response.json())
        self.assertIn(
            str(mention_session.id),
            [session["id"] for session in data["sessions"]],
        )
        self.assertEqual(data["excluded_agent_mention_session_ids"], [])

    def test_list_sessions_filters_agent_mentions_before_pagination(self):
        base = timezone.now()
        normal_session = self._create_chat_session(title="normal-task")
        mention_session = self._create_chat_session(title="mention-task")
        ChatSession.objects.filter(pk=normal_session.pk).update(last_message_at=base)
        ChatSession.objects.filter(pk=mention_session.pk).update(
            last_message_at=base + timedelta(minutes=1),
        )
        self._create_agent_mention_job(mention_session, status="failed")

        response = self._get(
            f"/api/chat/sessions?workspace_id={self.space.id}"
            "&exclude_agent_mention_sessions=true&limit=1"
        )

        self.assertEqual(response.status_code, 200)
        data = response.json().get("data", response.json())
        self.assertEqual(
            [session["id"] for session in data["sessions"]],
            [str(normal_session.id)],
        )
        self.assertEqual(data["total"], 1)

    def test_list_sessions_excludes_mentions_before_tracker_bucketing(self):
        normal_session = self._create_chat_session(title="normal-task")
        mention_session = self._create_chat_session(title="mention-tracker-task")
        self._create_agent_mention_job(mention_session)
        tracker = self._create_tracker(name="mention-overlap")
        self._create_tracker_run(tracker, mention_session)

        response = self._get(
            f"/api/chat/sessions?workspace_id={self.space.id}"
            "&exclude_agent_mention_sessions=true&include_tracker_runs=true"
        )

        self.assertEqual(response.status_code, 200)
        data = response.json().get("data", response.json())
        self.assertEqual(data["sessions"], [])
        self.assertEqual(
            data["excluded_agent_mention_session_ids"],
            [str(mention_session.id)],
        )
        self.assertNotIn(
            str(normal_session.id),
            [session["id"] for session in data["sessions"]],
        )

    def test_list_sessions_excludes_tracker_runs_by_default(self):
        normal_ids, tracker_ids = self._seed_mixed_sessions()

        response = self._get(f"/api/chat/sessions?space_id={self.space.id}")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)

        returned_ids = {s["id"] for s in data["sessions"]}
        self.assertEqual(returned_ids, normal_ids)
        self.assertTrue(tracker_ids.isdisjoint(returned_ids))
        self.assertEqual(data["tracker_run_count"], 2)

    def test_list_sessions_only_tracker_runs_when_include_true(self):
        _normal_ids, tracker_ids = self._seed_mixed_sessions()

        response = self._get(
            f"/api/chat/sessions?space_id={self.space.id}&include_tracker_runs=true"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)

        returned_ids = {s["id"] for s in data["sessions"]}
        self.assertEqual(returned_ids, tracker_ids)

    def test_list_sessions_zero_tracker_runs(self):
        """没有任何 Tracker session 时:tracker_run_count=0,sessions 仍正常返回。"""
        normal = [self._create_chat_session(title=f"n-{i}") for i in range(2)]
        normal_ids = {str(s.id) for s in normal}

        response = self._get(f"/api/chat/sessions?space_id={self.space.id}")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)

        self.assertEqual({s["id"] for s in data["sessions"]}, normal_ids)
        self.assertEqual(data["tracker_run_count"], 0)

    # ── ：list_all_sessions workspace_id / run_status ─────────

    def test_list_all_sessions_filters_by_workspace_id_with_continuous_pagination(self):
        """workspace_id 只返回该 workspace；过滤后再分页，offset 连续不跳条。"""
        from apps.tabtinspace.tests.fixtures import create_test_bot_space

        other_workspace = create_test_bot_space(
            organization=self.organization,
            agent=self.agent,
            name="other-ws",
            prefix="bucket_other",
            created_by_id=self.user.id,
        )
        base = timezone.now()
        in_ws = []
        for i in range(3):
            session = self._create_chat_session(
                title=f"in-ws-{i}",
                workspace=self.space,
            )
            ChatSession.objects.filter(pk=session.pk).update(
                last_message_at=base - timedelta(minutes=i),
            )
            session.refresh_from_db()
            in_ws.append(session)
        out_ws = self._create_chat_session(
            title="out-ws",
            workspace=other_workspace,
        )
        ChatSession.objects.filter(pk=out_ws.pk).update(
            last_message_at=base + timedelta(minutes=1),
        )

        page1 = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}"
            f"&workspace_id={self.space.id}&limit=2&offset=0"
        )
        self.assertEqual(page1.status_code, 200)
        data1 = page1.json().get("data", page1.json())
        page1_ids = [row["id"] for row in data1["sessions"]]
        self.assertEqual(
            page1_ids,
            [str(in_ws[0].id), str(in_ws[1].id)],
        )
        self.assertEqual(data1["total"], 3)
        self.assertTrue(data1["has_more"])
        self.assertNotIn(str(out_ws.id), page1_ids)

        page2 = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}"
            f"&workspace_id={self.space.id}&limit=2&offset=2"
        )
        self.assertEqual(page2.status_code, 200)
        data2 = page2.json().get("data", page2.json())
        self.assertEqual(
            [row["id"] for row in data2["sessions"]],
            [str(in_ws[2].id)],
        )
        self.assertEqual(data2["total"], 3)
        self.assertFalse(data2["has_more"])

    def test_list_all_sessions_rejects_invalid_workspace_id(self):
        response = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}"
            "&workspace_id=not-a-uuid"
        )
        self.assertEqual(response.status_code, 400)

    def test_list_all_sessions_filters_by_run_status_waiting_user(self):
        """run_status=waiting_user 只返回有 waiting 投影的 session；无投影不误纳入。"""
        waiting = self._create_chat_session(title="waiting")
        running = self._create_chat_session(title="running")
        bare = self._create_chat_session(title="no-projection")
        self._attach_run_projection(waiting, status="waiting_user")
        self._attach_run_projection(running, status="running")

        response = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}"
            "&run_status=waiting_user"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json().get("data", response.json())
        returned_ids = {row["id"] for row in data["sessions"]}
        self.assertEqual(returned_ids, {str(waiting.id)})
        self.assertNotIn(str(running.id), returned_ids)
        self.assertNotIn(str(bare.id), returned_ids)
        self.assertEqual(data["total"], 1)

    def test_list_all_sessions_new_filters_compose_with_existing_params(self):
        """workspace_id + run_status 可与 keyword / agent_id / include_tracker_runs 组合。"""
        from apps.agent.models import Agent
        from apps.tabtinspace.tests.fixtures import create_test_bot_space

        other_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="Compose Filter Agent",
            type="bot",
        )
        other_workspace = create_test_bot_space(
            organization=self.organization,
            agent=self.agent,
            name="compose-other-ws",
            prefix="bucket_compose",
            created_by_id=self.user.id,
        )

        match = self._create_chat_session(
            title="compose-match-keyword",
            agent=other_agent,
            workspace=self.space,
        )
        self._attach_run_projection(match, status="waiting_user")

        wrong_run = self._create_chat_session(
            title="compose-match-keyword-running",
            agent=other_agent,
            workspace=self.space,
        )
        self._attach_run_projection(wrong_run, status="running")

        wrong_ws = self._create_chat_session(
            title="compose-match-keyword-other-ws",
            agent=other_agent,
            workspace=other_workspace,
        )
        self._attach_run_projection(wrong_ws, status="waiting_user")

        tracker_match = self._create_chat_session(
            title="[Tracker] compose-match-keyword",
            agent=other_agent,
            workspace=self.space,
        )
        self._attach_run_projection(tracker_match, status="waiting_user")
        self._create_tracker_run(self._create_tracker(name="compose-tracker"), tracker_match)

        response = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}"
            f"&workspace_id={self.space.id}"
            "&run_status=waiting_user"
            f"&agent_id={other_agent.id}"
            "&keyword=compose-match-keyword"
            "&include_tracker_runs=false"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json().get("data", response.json())
        returned_ids = {row["id"] for row in data["sessions"]}
        self.assertEqual(returned_ids, {str(match.id)})
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["tracker_run_count"], 1)

        tracker_response = self._get(
            f"/api/chat/sessions/all?organization_id={self.organization.id}"
            f"&workspace_id={self.space.id}"
            "&run_status=waiting_user"
            f"&agent_id={other_agent.id}"
            "&keyword=compose-match-keyword"
            "&include_tracker_runs=true"
        )
        self.assertEqual(tracker_response.status_code, 200)
        tracker_data = tracker_response.json().get("data", tracker_response.json())
        self.assertEqual(
            {row["id"] for row in tracker_data["sessions"]},
            {str(tracker_match.id)},
        )

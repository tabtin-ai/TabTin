"""记录评论的 REST/CLI Agent 展示身份安全归因测试。"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone

from apps.agent.models import Agent
from apps.chat.conversation.models import ChatSession
from apps.services.agent_engine.models import ExecutionRun, SessionRunProjection
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import RecordComment, Table, TableRecord
from apps.tabtinspace.models import Organization
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


def _jwt_headers(user) -> dict[str, str]:
    raw_key = f"record_comment_actor_{uuid.uuid4().hex}"
    UserSession.objects.create(
        session_key=SessionManager.hash_session_key(raw_key),
        user=user,
        session_type="web",
        ip_address="127.0.0.1",
        user_agent="record-comment-actor-test",
        expires_at=timezone.now() + timedelta(hours=2),
    )
    token = generate_jwt_token(
        user,
        expire_hours=1,
        token_type="access",
        session_key=raw_key,
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


class RecordCommentAgentAttributionTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.client = Client()
        invite_gate_patcher = patch(
            "apps.users.auth.invite_gate_middleware.is_invite_gate_enabled",
            return_value=False,
        )
        invite_gate_patcher.start()
        self.addCleanup(invite_gate_patcher.stop)

        suffix = uuid.uuid4().hex[:8]
        self.user = User.objects.create_user(
            username=f"comment_actor_{suffix}",
            email=f"comment_actor_{suffix}@example.com",
            password="x",
        )
        self.other_user = User.objects.create_user(
            username=f"comment_actor_other_{suffix}",
            email=f"comment_actor_other_{suffix}@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name=f"评论 Agent 归因组织 {suffix}",
            owner=self.user,
        )
        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=uuid.uuid4(),
            owner_id=self.user.id,
            name="评论 Agent 归因表",
        )
        self.record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            data={},
        )
        self.agent = Agent.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            owner_user_id=self.user.id,
            name="可信执行 Agent",
            type="bot",
            is_active=True,
        )

    def _create_session_and_run(
        self,
        *,
        user=None,
        organization=None,
        agent=None,
        status: str = ExecutionRun.Status.RUNNING,
    ) -> tuple[ChatSession, ExecutionRun]:
        bound_user = user or self.user
        bound_organization = organization or self.organization
        session = ChatSession.objects.create(
            user=bound_user,
            organization_id=str(bound_organization.id),
            agent=agent or self.agent,
            title="Agent 评论归因会话",
        )
        run = ExecutionRun.objects.create(
            run_id=uuid.uuid4(),
            thread_id=f"chat-session-{session.id}",
            graph_type="chat",
            session_id=str(session.id),
            organization_id=str(bound_organization.id),
            user_id=str(bound_user.id),
            status=status,
        )
        SessionRunProjection.objects.create(
            session=session,
            current_run=run,
            sequence=run.sequence,
            revision=run.revision,
            status=status,
            state_changed_at=timezone.now(),
        )
        return session, run

    def _post_comment(
        self,
        *,
        headers: dict[str, str],
        reply_to_comment_id: uuid.UUID | None = None,
    ) -> dict:
        body = {
            "content": "通过 CLI 写下的评论",
            "client_request_id": str(uuid.uuid4()),
        }
        if reply_to_comment_id is not None:
            body["reply_to_comment_id"] = str(reply_to_comment_id)
        with patch(
            "apps.tabdata.services.comment_service.RecordCommentService._get_visible_record",
            return_value=self.record,
        ):
            response = self.client.post(
                f"/api/tabdata/records/{self.record.id}/comments",
                data=json.dumps(body),
                content_type="application/json",
                **headers,
            )
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()["data"]["comment"]

    def test_owned_run_and_matching_session_resolve_active_agent_actor(self) -> None:
        session, run = self._create_session_and_run(agent=self.agent)

        comment = self._post_comment(
            headers={
                **_jwt_headers(self.user),
                "HTTP_X_TABTIN_AGENT_RUN_ID": str(run.run_id),
                "HTTP_X_TABTIN_SESSION_ID": str(session.id),
                # 裸 Agent 头不能参与选择；合法 actor 必须来自 run/session 绑定。
                "HTTP_X_TABTIN_AGENT_ID": str(uuid.uuid4()),
            }
        )

        self.assertEqual(
            comment["actor"],
            {"type": "agent", "id": str(self.agent.id), "name": self.agent.name},
        )
        self.assertEqual(comment["authorization_subject"]["id"], str(self.user.id))
        stored = RecordComment.objects.using(TABDATA_DB_ALIAS).get(id=comment["id"])
        self.assertEqual(stored.author_id, self.user.id)
        self.assertEqual(stored.agent_run_id, str(run.run_id))
        self.assertEqual(stored.session_id, str(session.id))
        self.assertEqual(
            comment["audit"],
            {"agent_run_id": str(run.run_id), "session_id": str(session.id)},
        )

    def test_reply_keeps_owned_agent_attribution_and_parent_context(self) -> None:
        parent = RecordComment.objects.using(TABDATA_DB_ALIAS).create(
            record=self.record,
            content="需要 Agent 回复的评论",
            author=self.user,
            author_name=self.user.get_display_name(),
            actor_type=RecordComment.ACTOR_TYPE_HUMAN,
            actor_id=str(self.user.id),
            actor_name=self.user.get_display_name(),
        )
        session, run = self._create_session_and_run(agent=self.agent)

        comment = self._post_comment(
            reply_to_comment_id=parent.id,
            headers={
                **_jwt_headers(self.user),
                "HTTP_X_TABTIN_AGENT_RUN_ID": str(run.run_id),
                "HTTP_X_TABTIN_SESSION_ID": str(session.id),
            },
        )

        self.assertEqual(comment["reply_to"]["id"], str(parent.id))
        self.assertEqual(
            comment["actor"],
            {"type": "agent", "id": str(self.agent.id), "name": self.agent.name},
        )
        self.assertEqual(
            comment["audit"],
            {"agent_run_id": str(run.run_id), "session_id": str(session.id)},
        )

    def test_spoofed_other_user_run_falls_back_to_human_actor(self) -> None:
        session, run = self._create_session_and_run(
            user=self.other_user,
            agent=self.agent,
        )

        comment = self._post_comment(
            headers={
                **_jwt_headers(self.user),
                "HTTP_X_TABTIN_AGENT_RUN_ID": str(run.run_id),
                "HTTP_X_TABTIN_SESSION_ID": str(session.id),
            }
        )

        self.assertEqual(comment["actor"]["type"], "human")
        self.assertEqual(comment["actor"]["id"], str(self.user.id))
        self.assertEqual(
            comment["audit"],
            {"agent_run_id": None, "session_id": None},
        )
        stored = RecordComment.objects.using(TABDATA_DB_ALIAS).get(id=comment["id"])
        self.assertEqual(stored.agent_run_id, "")
        self.assertEqual(stored.session_id, "")

    def test_bare_agent_header_falls_back_to_human_actor(self) -> None:
        comment = self._post_comment(
            headers={
                **_jwt_headers(self.user),
                "HTTP_X_TABTIN_AGENT_ID": str(self.agent.id),
            }
        )

        self.assertEqual(comment["actor"]["type"], "human")
        self.assertEqual(comment["actor"]["id"], str(self.user.id))
        stored = RecordComment.objects.using(TABDATA_DB_ALIAS).get(id=comment["id"])
        self.assertEqual(stored.agent_run_id, "")
        self.assertEqual(stored.session_id, "")

    def test_completed_run_falls_back_to_human_and_drops_audit(self) -> None:
        session, run = self._create_session_and_run(
            agent=self.agent,
            status=ExecutionRun.Status.COMPLETED,
        )

        comment = self._post_comment(
            headers={
                **_jwt_headers(self.user),
                "HTTP_X_TABTIN_AGENT_RUN_ID": str(run.run_id),
                "HTTP_X_TABTIN_SESSION_ID": str(session.id),
            }
        )

        self.assertEqual(comment["actor"]["type"], "human")
        self.assertEqual(
            comment["audit"],
            {"agent_run_id": None, "session_id": None},
        )
        stored = RecordComment.objects.using(TABDATA_DB_ALIAS).get(id=comment["id"])
        self.assertEqual(stored.agent_run_id, "")
        self.assertEqual(stored.session_id, "")

    def test_non_current_running_run_falls_back_to_human_and_drops_audit(self) -> None:
        session, old_run = self._create_session_and_run(agent=self.agent)
        current_run = ExecutionRun.objects.create(
            run_id=uuid.uuid4(),
            thread_id=f"chat-session-{session.id}",
            graph_type="chat",
            session_id=str(session.id),
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            sequence=2,
            status=ExecutionRun.Status.RUNNING,
        )
        SessionRunProjection.objects.filter(session=session).update(
            current_run=current_run,
            sequence=current_run.sequence,
            status=ExecutionRun.Status.RUNNING,
            state_changed_at=timezone.now(),
        )

        comment = self._post_comment(
            headers={
                **_jwt_headers(self.user),
                "HTTP_X_TABTIN_AGENT_RUN_ID": str(old_run.run_id),
                "HTTP_X_TABTIN_SESSION_ID": str(session.id),
            }
        )

        self.assertEqual(comment["actor"]["type"], "human")
        self.assertEqual(
            comment["audit"],
            {"agent_run_id": None, "session_id": None},
        )
        stored = RecordComment.objects.using(TABDATA_DB_ALIAS).get(id=comment["id"])
        self.assertEqual(stored.agent_run_id, "")
        self.assertEqual(stored.session_id, "")

    def test_run_session_organization_and_active_agent_must_all_match(self) -> None:
        valid_session, valid_run = self._create_session_and_run(agent=self.agent)
        mismatched_session = ChatSession.objects.create(
            user=self.user,
            organization_id=str(self.organization.id),
            agent=self.agent,
            title="不匹配会话",
        )
        mismatched_session_comment = self._post_comment(
            headers={
                **_jwt_headers(self.user),
                "HTTP_X_TABTIN_AGENT_RUN_ID": str(valid_run.run_id),
                "HTTP_X_TABTIN_SESSION_ID": str(mismatched_session.id),
            }
        )
        self.assertEqual(mismatched_session_comment["actor"]["type"], "human")

        other_organization = Organization.objects.create(
            name=f"其他组织 {uuid.uuid4().hex[:8]}",
            owner=self.user,
        )
        other_agent = Agent.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=other_organization.id,
            owner_user_id=self.user.id,
            name="其他组织 Agent",
            type="bot",
            is_active=True,
        )
        cross_org_session, cross_org_run = self._create_session_and_run(
            organization=other_organization,
            agent=other_agent,
        )
        cross_org_comment = self._post_comment(
            headers={
                **_jwt_headers(self.user),
                "HTTP_X_TABTIN_AGENT_RUN_ID": str(cross_org_run.run_id),
                "HTTP_X_TABTIN_SESSION_ID": str(cross_org_session.id),
            }
        )
        self.assertEqual(cross_org_comment["actor"]["type"], "human")

        self.agent.is_active = False
        self.agent.save(update_fields=["is_active"])
        inactive_comment = self._post_comment(
            headers={
                **_jwt_headers(self.user),
                "HTTP_X_TABTIN_AGENT_RUN_ID": str(valid_run.run_id),
                "HTTP_X_TABTIN_SESSION_ID": str(valid_session.id),
            }
        )
        self.assertEqual(inactive_comment["actor"]["type"], "human")

"""会话缺失 Agent 的数据回填回归测试。"""

from __future__ import annotations

from importlib import import_module

from django.apps import apps as django_apps
from django.test import TransactionTestCase

from apps.agent.models import Agent
from apps.chat.conversation.models import ChatSession
from apps.tabtinspace.models import SpaceMembership
from apps.tabtinspace.tests.fixtures import (
    cleanup_test_organization,
    create_test_organization_with_agent,
)


class MissingSessionAgentBackfillTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.ctx = create_test_organization_with_agent(prefix="missing-session-agent")
        self.user = self.ctx["user"]
        self.organization = self.ctx["organization"]
        self.workspace = self.ctx["workspace"]
        self.agent = self.ctx["agent"]
        self.migration = import_module(
            "apps.chat.conversation.migrations.0071_backfill_missing_session_agents",
        )

    def tearDown(self):
        cleanup_test_organization(self.organization, delete_user=True)

    def _session_without_agent(self):
        return ChatSession.objects.create(
            user=self.user,
            organization_id=str(self.organization.id),
            workspace=self.workspace,
            agent=None,
            title="needs an Agent",
        )

    def test_backfills_the_only_active_workspace_agent_owned_by_session_user(self):
        session = self._session_without_agent()

        self.migration.backfill_missing_session_agents(django_apps, None)

        session.refresh_from_db()
        self.assertEqual(session.agent_id, self.agent.id)

    def test_leaves_ambiguous_workspace_agent_bindings_empty(self):
        other = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="Another Agent",
            type="bot",
        )
        SpaceMembership.objects.create(
            workspace=self.workspace,
            agent=other,
            role="owner",
            is_active=True,
        )
        session = self._session_without_agent()

        self.migration.backfill_missing_session_agents(django_apps, None)

        session.refresh_from_db()
        self.assertIsNone(session.agent_id)

    def test_uses_the_users_default_agent_when_project_workspace_has_no_agent_membership(self):
        """Project 伴生 Workspace 只记录用户成员关系时仍可修复旧会话。"""
        SpaceMembership.objects.filter(
            workspace=self.workspace,
            agent=self.agent,
        ).delete()
        self.agent.is_default = True
        self.agent.save(update_fields=["is_default", "updated_at"])
        session = self._session_without_agent()

        self.migration.backfill_missing_session_agents(django_apps, None)

        session.refresh_from_db()
        self.assertEqual(session.agent_id, self.agent.id)

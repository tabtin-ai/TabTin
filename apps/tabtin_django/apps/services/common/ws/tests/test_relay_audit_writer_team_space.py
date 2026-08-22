"""Team Space approval audit tenant lookup regression tests."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.chat.conversation.models import ChatSession
from apps.services.common.ws.handlers.relay_audit_writer import (
    _invalidate_tenant_cache,
    _resolve_tenant_uncached,
)
from apps.tabtinspace.models import Agent, Space, Organization


User = get_user_model()


class TeamSpaceRelayAuditWriterTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        _invalidate_tenant_cache()
        self.owner = User.objects.create_user(
            username="team_space_audit_owner",
            email="team_space_audit_owner@test.com",
            password="pass123",
        )
        self.initiator = User.objects.create_user(
            username="team_space_audit_initiator",
            email="team_space_audit_initiator@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="Team Space Audit",
            owner=self.owner,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            user=self.owner,
            owner_user=self.owner,
            name="Owner Agent",
            type="bot",
        )
        self.execution_space = Space.objects.create(
            organization=self.organization,
            agent=self.agent,
            type=Space.SpaceType.WORKSPACE,
            name="Owner Workspace",
        )
        self.team_space = Space.objects.create(
            organization=self.organization,
            type=Space.SpaceType.TEAM_SPACE,
            name="Team Room",
            execution_space=self.execution_space,
        )
        self.session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            space=self.team_space,
            title="Team AI Session",
        )
        self.thread_id = f"chat-session-{self.session.id}"

    def tearDown(self) -> None:
        _invalidate_tenant_cache()

    def test_team_space_tenant_lookup_uses_execution_space_agent(self) -> None:
        tenant = _resolve_tenant_uncached(str(self.session.id))

        self.assertIsNotNone(tenant)
        self.assertEqual(
            tenant,
            (str(self.organization.id), str(self.agent.id), str(self.session.id)),
        )

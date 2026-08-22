import uuid

from django.test import TestCase

from apps.chat.conversation.models import ChatSession
from apps.services.agent_execution.effective_runtime_config import (
    EffectiveRuntimeConfigError,
    resolve_effective_runtime_config,
)
from apps.tabtinspace.models import Agent, Device, Workspace
from apps.tabtinspace.tests.fixtures import (
    create_test_organization,
    create_test_user,
)


class EffectiveRuntimeConfigTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = create_test_user(prefix="runtime-config")
        self.organization = create_test_organization(
            owner=self.user,
            prefix="runtime-config",
        )
        self.organization.settings = {"allow_member_yolo": True}
        self.organization.save(update_fields=["settings"])
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name="runtime device",
            device_type="electron",
            role="control",
            fingerprint=f"runtime-{uuid.uuid4()}",
            status="online",
        )
        self.agent_a = self._agent("A")
        self.agent_b = self._agent("B")
        self.workspace_x = self._workspace("X", "/tmp/runtime-x", "full_access")
        self.workspace_y = self._workspace("Y", "/tmp/runtime-y", "auto")

    def _agent(self, name):
        return Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=name,
            type="bot",
            is_active=True,
            custom_rules=f"rules-{name}",
            agent_config={"memory": {"enabled": True}},
        )

    def _workspace(self, name, working_dir, approval_grant):
        return Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            name=name,
            working_dir=working_dir,
            normalized_working_dir=working_dir,
            created_by=self.user,
            trust_status=Workspace.TrustStatus.TRUSTED,
            approval_grant=approval_grant,
        )

    def _session(self, agent, workspace):
        return ChatSession.objects.create(
            user=self.user,
            organization_id=self.organization.id,
            agent=agent,
            workspace=workspace,
        )

    def test_agents_and_workspaces_form_independent_combinations(self):
        combinations = (
            (self.agent_a, self.workspace_x),
            (self.agent_a, self.workspace_y),
            (self.agent_b, self.workspace_x),
        )
        for agent, workspace in combinations:
            config = resolve_effective_runtime_config(
                self._session(agent, workspace),
                self.user,
            )
            self.assertEqual(config.agent_id, str(agent.id))
            self.assertEqual(config.workspace_id, str(workspace.id))

    def test_turn_override_does_not_mutate_session_pointer(self):
        session = self._session(self.agent_a, self.workspace_x)
        config = resolve_effective_runtime_config(
            session,
            self.user,
            agent_id=self.agent_b.id,
        )
        session.refresh_from_db()
        self.assertEqual(config.agent_id, str(self.agent_b.id))
        self.assertEqual(session.agent_id, self.agent_a.id)

    def test_observer_session_cannot_resolve_execution(self):
        session = self._session(self.agent_a, None)
        with self.assertRaises(EffectiveRuntimeConfigError) as context:
            resolve_effective_runtime_config(session, self.user)
        self.assertEqual(context.exception.code, "OBSERVER_SESSION")

    def test_approval_is_bounded_by_workspace(self):
        session = self._session(self.agent_a, self.workspace_y)
        config = resolve_effective_runtime_config(session, self.user)
        self.assertEqual(config.approval_mode, "auto")
        self.assertEqual(config.approval_grant, "auto")

    def _close_org_yolo(self):
        self.organization.settings = {"allow_member_yolo": False}
        self.organization.save(update_fields=["settings"])

    def test_org_closed_clamps_auto_session_and_grant(self):
        """#8440：关闸后 session=auto + grant=auto → always_ask。"""
        self._close_org_yolo()
        config = resolve_effective_runtime_config(
            self._session(self.agent_a, self.workspace_y),
            self.user,
        )
        self.assertEqual(config.approval_mode, "always_ask")
        self.assertEqual(config.approval_grant, "always_ask")

    def test_org_closed_clamps_full_access_session_and_grant(self):
        """#8440：关闸后 session=full_access + grant=full_access → always_ask。"""
        self._close_org_yolo()
        config = resolve_effective_runtime_config(
            self._session(self.agent_a, self.workspace_x),
            self.user,
        )
        self.assertEqual(config.approval_mode, "always_ask")
        self.assertEqual(config.approval_grant, "always_ask")

    def test_org_closed_clamps_full_access_session_with_auto_grant(self):
        """#8440：关闸后 session=full_access + grant=auto → always_ask。"""
        self._close_org_yolo()
        config = resolve_effective_runtime_config(
            self._session(self.agent_a, self.workspace_y),
            self.user,
        )
        self.assertEqual(config.approval_mode, "always_ask")
        self.assertEqual(config.approval_grant, "always_ask")

    def test_org_settings_missing_key_failsafe_clamps_to_always_ask(self):
        """#8440：settings 缺 allow_member_yolo 时按 governance fail-safe 关闸。"""
        self.organization.settings = {}
        self.organization.save(update_fields=["settings"])
        config = resolve_effective_runtime_config(
            self._session(self.agent_a, self.workspace_x),
            self.user,
        )
        self.assertEqual(config.approval_mode, "always_ask")
        self.assertEqual(config.approval_grant, "always_ask")

    def test_org_open_still_allows_full_access_when_grant_allows(self):
        """组织开放时，session + workspace 均为 full_access 应放行。"""
        session = self._session(self.agent_a, self.workspace_x)
        config = resolve_effective_runtime_config(session, self.user)
        self.assertEqual(config.approval_mode, "full_access")
        self.assertEqual(config.approval_grant, "full_access")

    def test_next_turn_reads_updated_agent_config(self):
        session = self._session(self.agent_a, self.workspace_x)
        first = resolve_effective_runtime_config(session, self.user)
        self.agent_a.custom_rules = "updated-rules"
        self.agent_a.save(update_fields=["custom_rules"])
        second = resolve_effective_runtime_config(session, self.user)
        self.assertEqual(first.custom_rules, "rules-A")
        self.assertEqual(second.custom_rules, "updated-rules")

    def test_deleting_workspace_keeps_agent_and_observer_session(self):
        session = self._session(self.agent_a, self.workspace_x)
        self.workspace_x.delete()
        session.refresh_from_db()
        self.assertIsNone(session.workspace_id)
        self.assertTrue(Agent.objects.filter(id=self.agent_a.id).exists())

    def test_deleting_agent_keeps_workspace_and_readable_session(self):
        session = self._session(self.agent_a, self.workspace_x)
        self.agent_a.delete()
        session.refresh_from_db()
        self.assertIsNone(session.agent_id)
        self.assertTrue(Workspace.objects.filter(id=self.workspace_x.id).exists())

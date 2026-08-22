"""#6184/#6353/#7523：默认 Agent 幂等补建、迁移 demote 与不可删除护栏。"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models import CASCADE, PROTECT, SET_NULL
from django.db.models.deletion import ProtectedError
from django.db.models.signals import post_save
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.agent.models import Agent
from apps.agent_memory.models import AgentMemory
from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.services.common.agent_template_registry import get_agent_template
from apps.skills.models import AgentSkillLink
from apps.tabtinspace.models import (
    Organization,
    OrganizationMember,
    ProjectTask,
    ProjectTaskRun,
    SpaceMembership,
)
from apps.tracker.models import Tracker
from apps.tabtinspace.services.agent_service import MAX_CUSTOM_BOT_AGENTS, AgentService
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.onboarding_defaults import (
    AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY,
    CODE_ENGINEER_REMOVED_DEFAULT_SKILL_KEYS_V6,
    CODE_ENGINEER_STARTER_SKILL_KEYS,
    CODE_ENGINEER_STARTER_SKILL_KEYS_V3,
    CODE_ENGINEER_STARTER_SKILL_KEYS_V4,
    CODE_ENGINEER_STARTER_SKILL_KEYS_V7,
    DEFAULT_ONBOARDING_AGENT_NAME,
    OSS_STARTER_SKILL_KEYS_TO_UNASSIGN,
    STARTER_AGENT_ROSTER_VERSION,
    STARTER_AGENT_TEMPLATE_IDS,
    SYSTEM_DEFAULT_PROVISION_SOURCE,
    build_system_default_agent_settings,
    is_system_default_agent,
)
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class DefaultAgentGuaranteeTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        suffix = uuid4().hex[:8]
        self.user = User.objects.create_user(
            username=f"default-agent-{suffix}",
            email=f"default-agent-{suffix}@tabtin.test",
            password="TabTinTest#2026",
        )
        self.organization = Organization.objects.create(
            name=f"Default Agent Org {suffix}",
            owner=self.user,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role="owner",
        )
        session_key = f"default-agent-{uuid4().hex}"
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(session_key),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="default-agent-test",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=1),
            is_active=True,
        )
        token = generate_jwt_token(
            self.user,
            expire_hours=1,
            token_type="access",
            session_key=session_key,
        )
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {token}"}
        self.service = AgentService(user=self.user)

    def test_ensure_creates_system_default_xiaotin(self):
        agent = self.service.ensure_default_agent(self.organization.id)
        self.assertIsNotNone(agent)
        self.assertTrue(agent.is_default)
        self.assertTrue(agent.is_active)
        self.assertEqual(agent.name, DEFAULT_ONBOARDING_AGENT_NAME)
        self.assertEqual(agent.owner_user_id, self.user.id)
        self.assertTrue(is_system_default_agent(agent))
        self.assertEqual(
            agent.settings.get("provision_source"),
            SYSTEM_DEFAULT_PROVISION_SOURCE,
        )

        again = self.service.ensure_default_agent(self.organization.id)
        self.assertEqual(again.id, agent.id)
        self.assertEqual(
            Agent.objects.filter(
                organization=self.organization,
                owner_user=self.user,
                is_default=True,
                is_active=True,
            ).count(),
            1,
        )

    def test_ensure_creates_xiaotin_without_promoting_migrated_bots(self):
        """#7523：有 Space 迁移分身时新建系统小Tin，不提升最早 bot。"""
        older = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="旧分身",
            type="bot",
            is_default=False,
        )
        Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="新分身",
            type="bot",
            is_default=False,
        )

        ensured = self.service.ensure_default_agent(self.organization.id)
        self.assertNotEqual(ensured.id, older.id)
        self.assertEqual(ensured.name, DEFAULT_ONBOARDING_AGENT_NAME)
        self.assertTrue(is_system_default_agent(ensured))

        older.refresh_from_db()
        self.assertFalse(older.is_default)

    def test_ensure_demotes_legacy_default_and_creates_system_xiaotin(self):
        """#7523：历史误标默认（无 system provenance）被 demote，并补建小Tin。"""
        legacy = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="默认 Space 执行身份",
            type="bot",
            is_default=True,
            settings={},
        )

        ensured = self.service.ensure_default_agent(self.organization.id)
        self.assertNotEqual(ensured.id, legacy.id)
        self.assertTrue(is_system_default_agent(ensured))

        legacy.refresh_from_db()
        self.assertFalse(legacy.is_default)
        self.assertEqual(
            Agent.objects.filter(
                organization=self.organization,
                owner_user=self.user,
                is_default=True,
                is_active=True,
            ).count(),
            1,
        )

    def test_ensure_reactivates_inactive_system_default(self):
        inactive = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            is_active=False,
            settings=build_system_default_agent_settings(),
        )
        ensured = self.service.ensure_default_agent(self.organization.id)
        self.assertEqual(ensured.id, inactive.id)
        inactive.refresh_from_db()
        self.assertTrue(inactive.is_active)
        self.assertTrue(inactive.is_default)

    def test_delete_rejects_default_agent(self):
        agent = self.service.ensure_default_agent(self.organization.id)
        Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="可删分身",
            type="bot",
            is_default=False,
        )
        with self.assertRaises(ServiceError) as ctx:
            self.service.delete_agent(agent.id)
        self.assertEqual(ctx.exception.code, "DEFAULT_AGENT_PROTECTED")
        agent.refresh_from_db()
        self.assertTrue(agent.is_active)

    def test_delete_allows_non_default_persona(self):
        default = self.service.ensure_default_agent(self.organization.id)
        persona = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="可删分身",
            type="bot",
            is_default=False,
        )
        self.assertTrue(self.service.delete_agent(persona.id))
        persona.refresh_from_db()
        self.assertFalse(persona.is_active)
        default.refresh_from_db()
        self.assertTrue(default.is_active)

    def test_permanent_delete_removes_deactivated_persona(self):
        self.service.ensure_default_agent(self.organization.id)
        persona = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="待彻底删除分身",
            type="bot",
            is_default=False,
            is_active=False,
        )

        self.assertTrue(self.service.permanently_delete_agent(persona.id))
        self.assertFalse(Agent.objects.filter(id=persona.id).exists())

    def test_permanent_delete_rejects_active_persona(self):
        self.service.ensure_default_agent(self.organization.id)
        persona = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="活跃分身",
            type="bot",
            is_default=False,
            is_active=True,
        )

        with self.assertRaises(ServiceError) as ctx:
            self.service.permanently_delete_agent(persona.id)

        self.assertEqual(ctx.exception.code, "AGENT_MUST_BE_DEACTIVATED")
        self.assertTrue(Agent.objects.filter(id=persona.id).exists())

    def test_permanent_delete_rejects_default_persona(self):
        default = self.service.ensure_default_agent(self.organization.id)
        default.is_active = False
        default.save(update_fields=["is_active", "updated_at"])

        with self.assertRaises(ServiceError) as ctx:
            self.service.permanently_delete_agent(default.id)

        self.assertEqual(ctx.exception.code, "DEFAULT_AGENT_PROTECTED")
        self.assertTrue(Agent.objects.filter(id=default.id).exists())

    def test_permanent_delete_rejects_non_owner(self):
        persona = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="他人不可删除的分身",
            type="bot",
            is_default=False,
            is_active=False,
        )
        other_user = User.objects.create_user(
            username=f"other-{uuid4().hex[:8]}",
            email=f"other-{uuid4().hex[:8]}@tabtin.test",
            password="TabTinTest#2026",
        )

        with self.assertRaises(ServiceError) as ctx:
            AgentService(user=other_user).permanently_delete_agent(persona.id)

        self.assertEqual(ctx.exception.code, "PERMISSION_DENIED")
        self.assertTrue(Agent.objects.filter(id=persona.id).exists())

    def test_permanent_delete_maps_protected_history_to_conflict(self):
        persona = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="存在受保护历史的分身",
            type="bot",
            is_default=False,
            is_active=False,
        )
        protected_error = ProtectedError(
            "Agent is referenced by protected history",
            [],
        )

        with patch.object(Agent, "delete", side_effect=protected_error):
            with self.assertRaises(ServiceError) as ctx:
                self.service.permanently_delete_agent(persona.id)

        self.assertEqual(ctx.exception.code, "AGENT_HAS_PROTECTED_HISTORY")
        self.assertEqual(ctx.exception.status, 409)
        self.assertTrue(Agent.objects.filter(id=persona.id).exists())

    def test_agent_relation_delete_contracts_preserve_history(self):
        expected_on_delete = {
            (AgentMemory, "agent"): CASCADE,
            (AgentSkillLink, "agent"): CASCADE,
            (SpaceMembership, "agent"): CASCADE,
            (ChatSession, "agent"): SET_NULL,
            (ChatMessage, "agent"): SET_NULL,
            (Tracker, "agent"): SET_NULL,
            (ProjectTask, "selected_agent"): SET_NULL,
            (ProjectTaskRun, "agent"): PROTECT,
        }

        for (model, field_name), expected in expected_on_delete.items():
            with self.subTest(model=model.__name__, field=field_name):
                self.assertIs(
                    model._meta.get_field(field_name).remote_field.on_delete,
                    expected,
                )

    def test_list_api_ensures_five_agent_starter_roster(self):
        self.assertFalse(
            Agent.objects.filter(
                organization=self.organization,
                owner_user=self.user,
                is_active=True,
            ).exists()
        )
        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)
        agents = data.get("agents") or []
        self.assertEqual(len(agents), 5)
        self.assertTrue(agents[0]["is_default"])
        self.assertEqual(agents[0]["name"], DEFAULT_ONBOARDING_AGENT_NAME)
        agent = Agent.objects.get(id=agents[0]["id"])
        self.assertTrue(is_system_default_agent(agent))
        self.assertEqual(agent.template_id, "general-assistant")
        self.assertEqual(
            agent.settings.get("avatar_key"),
            "general-assistant",
        )
        self.assertEqual(
            agent.settings.get(AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY),
            STARTER_AGENT_ROSTER_VERSION,
        )
        self.assertEqual(
            set(
                Agent.objects.filter(
                    organization=self.organization,
                    owner_user=self.user,
                    is_active=True,
                ).values_list("template_id", flat=True)
            ),
            set(STARTER_AGENT_TEMPLATE_IDS),
        )
        self.assertEqual(
            set(
                Agent.objects.filter(
                    organization=self.organization,
                    owner_user=self.user,
                    is_active=True,
                ).values_list("name", flat=True)
            ),
            {
                DEFAULT_ONBOARDING_AGENT_NAME,
                "小Tin 代码版",
                "小Tin 文书版",
                "小Tin 数据版",
                "小Tin 冲浪版",
            },
        )
        starter_agents = Agent.objects.filter(
            organization=self.organization,
            owner_user=self.user,
            is_active=True,
        )
        for starter_agent in starter_agents:
            self.assertTrue(starter_agent.custom_rules.strip())
            self.assertLessEqual(len(starter_agent.custom_rules), 80)

        code_agent = starter_agents.get(template_id="code-engineer")
        self.assertTrue(
            set(CODE_ENGINEER_STARTER_SKILL_KEYS).issubset(
                set(
                    AgentSkillLink.objects.filter(agent=code_agent)
                    .values_list("skill_canonical_key", flat=True)
                )
            )
        )

    def test_roster_upgrade_backfills_empty_rules_without_overwriting_user_edits(self):
        default = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            custom_rules="",
            settings=build_system_default_agent_settings(
                {
                    AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY:
                        STARTER_AGENT_ROSTER_VERSION - 1,
                }
            ),
        )
        for template_id in STARTER_AGENT_TEMPLATE_IDS[1:]:
            Agent.objects.create(
                organization=self.organization,
                owner_user=self.user,
                name=template_id,
                type="bot",
                template_id=template_id,
                custom_rules=(
                    "保留用户写的规则"
                    if template_id == "code-engineer"
                    else ""
                ),
            )

        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        default.refresh_from_db()
        self.assertEqual(
            default.settings[AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY],
            STARTER_AGENT_ROSTER_VERSION,
        )
        self.assertTrue(default.custom_rules)
        specialists = Agent.objects.filter(
            organization=self.organization,
            owner_user=self.user,
            template_id__in=STARTER_AGENT_TEMPLATE_IDS[1:],
        )
        self.assertTrue(all(agent.custom_rules for agent in specialists))
        self.assertEqual(
            specialists.get(template_id="code-engineer").custom_rules,
            "保留用户写的规则",
        )

    def test_roster_v3_backfills_code_skills_and_v8_reenables_locked_skill(self):
        default = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            settings=build_system_default_agent_settings(
                {AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY: 2}
            ),
        )
        code_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="小Tin 代码版",
            type="bot",
            template_id="code-engineer",
        )
        disabled_key = CODE_ENGINEER_STARTER_SKILL_KEYS_V3[0]
        AgentSkillLink.objects.create(
            agent=code_agent,
            skill_canonical_key=disabled_key,
            source="app",
            enabled=False,
        )

        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        links = AgentSkillLink.objects.filter(agent=code_agent)
        self.assertTrue(
            set(CODE_ENGINEER_STARTER_SKILL_KEYS_V3).issubset(
                set(links.values_list("skill_canonical_key", flat=True))
            )
        )
        self.assertTrue(links.get(skill_canonical_key=disabled_key).enabled)
        default.refresh_from_db()
        self.assertEqual(
            default.settings[AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY],
            STARTER_AGENT_ROSTER_VERSION,
        )

    def test_roster_v4_backfills_issue_workflow_for_existing_code_agent(self):
        default = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            settings=build_system_default_agent_settings(
                {AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY: 3}
            ),
        )
        code_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="小Tin 代码版",
            type="bot",
            template_id="code-engineer",
        )

        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            AgentSkillLink.objects.filter(
                agent=code_agent,
                skill_canonical_key=CODE_ENGINEER_STARTER_SKILL_KEYS_V4[0],
                enabled=True,
            ).exists()
        )
        default.refresh_from_db()
        self.assertEqual(
            default.settings[AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY],
            STARTER_AGENT_ROSTER_VERSION,
        )

    def test_roster_v6_removes_short_lived_review_defaults(self):
        default = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            settings=build_system_default_agent_settings(
                {AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY: 5}
            ),
        )
        code_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="小Tin 代码版",
            type="bot",
            template_id="code-engineer",
        )
        AgentSkillLink.objects.bulk_create(
            [
                AgentSkillLink(
                    agent=code_agent,
                    skill_canonical_key=skill_key,
                    source="app",
                    enabled=True,
                )
                for skill_key in CODE_ENGINEER_REMOVED_DEFAULT_SKILL_KEYS_V6
            ]
        )

        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            AgentSkillLink.objects.filter(
                agent=code_agent,
                skill_canonical_key__in=CODE_ENGINEER_REMOVED_DEFAULT_SKILL_KEYS_V6,
            ).exists()
        )
        default.refresh_from_db()
        self.assertEqual(
            default.settings[AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY],
            STARTER_AGENT_ROSTER_VERSION,
        )

    def test_roster_v7_backfills_ponytail_for_existing_code_agent(self):
        default = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            settings=build_system_default_agent_settings(
                {AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY: 6}
            ),
        )
        code_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="小Tin 代码版",
            type="bot",
            template_id="code-engineer",
        )

        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            AgentSkillLink.objects.filter(
                agent=code_agent,
                skill_canonical_key=CODE_ENGINEER_STARTER_SKILL_KEYS_V7[0],
                enabled=True,
            ).exists()
        )
        default.refresh_from_db()
        self.assertEqual(
            default.settings[AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY],
            STARTER_AGENT_ROSTER_VERSION,
        )

    def test_roster_v8_backfills_and_reenables_core_template_skills(self):
        default = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            template_id="general-assistant",
            settings=build_system_default_agent_settings(
                {AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY: 7}
            ),
        )
        doc_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="小Tin 文档版",
            type="bot",
            template_id="doc-writer",
        )
        general_template = get_agent_template("general-assistant")
        doc_template = get_agent_template("doc-writer")
        self.assertIsNotNone(general_template)
        self.assertIsNotNone(doc_template)
        AgentSkillLink.objects.create(
            agent=default,
            skill_canonical_key=general_template.skills[-1],
            source="app",
            enabled=False,
        )
        AgentSkillLink.objects.create(
            agent=doc_agent,
            skill_canonical_key=doc_template.skills[0],
            source="app",
            enabled=False,
        )

        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        for agent, template in (
            (default, general_template),
            (doc_agent, doc_template),
        ):
            links = AgentSkillLink.objects.filter(
                agent=agent,
                skill_canonical_key__in=template.skills,
            )
            self.assertEqual(links.count(), len(template.skills))
            self.assertFalse(links.filter(enabled=False).exists())
        default.refresh_from_db()
        self.assertEqual(
            default.settings[AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY],
            STARTER_AGENT_ROSTER_VERSION,
        )

    def test_roster_v9_unassigns_retired_oss_starter_skills(self):
        default = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            template_id="general-assistant",
            settings=build_system_default_agent_settings(
                {AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY: 8}
            ),
        )
        doc_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="小Tin 文书版",
            type="bot",
            template_id="doc-writer",
        )
        data_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="小Tin 数据版",
            type="bot",
            template_id="data-analyst",
        )
        retired_doc = OSS_STARTER_SKILL_KEYS_TO_UNASSIGN[0]
        retired_data = OSS_STARTER_SKILL_KEYS_TO_UNASSIGN[3]
        AgentSkillLink.objects.create(
            agent=doc_agent,
            skill_canonical_key=retired_doc,
            source="app",
            enabled=True,
        )
        AgentSkillLink.objects.create(
            agent=data_agent,
            skill_canonical_key=retired_data,
            source="app",
            enabled=True,
        )

        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            AgentSkillLink.objects.filter(
                agent=doc_agent,
                skill_canonical_key__in=OSS_STARTER_SKILL_KEYS_TO_UNASSIGN,
            ).exists()
        )
        self.assertFalse(
            AgentSkillLink.objects.filter(
                agent=data_agent,
                skill_canonical_key__in=OSS_STARTER_SKILL_KEYS_TO_UNASSIGN,
            ).exists()
        )
        default.refresh_from_db()
        self.assertEqual(
            default.settings[AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY],
            STARTER_AGENT_ROSTER_VERSION,
        )

    def test_starter_roster_is_idempotent_and_respects_deactivation(self):
        first = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )
        self.assertEqual(first.status_code, 200)
        specialist = Agent.objects.get(
            organization=self.organization,
            owner_user=self.user,
            template_id="code-engineer",
        )
        specialist.is_active = False
        specialist.save(update_fields=["is_active", "updated_at"])

        second = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )
        self.assertEqual(second.status_code, 200)
        self.assertEqual(
            Agent.objects.filter(
                organization=self.organization,
                owner_user=self.user,
                template_id="code-engineer",
            ).count(),
            1,
        )
        self.assertEqual(len(second.json()["data"]["agents"]), 4)

    def test_starter_roster_reuses_existing_template_agent(self):
        existing = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="我已有的代码分身",
            type="bot",
            template_id="code-engineer",
            template_version="0.2.0",
        )
        existing_office_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="我已有的跑腿分身",
            type="bot",
            template_id="office-secretary",
            template_version="0.2.0",
        )

        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            Agent.objects.filter(
                organization=self.organization,
                owner_user=self.user,
                template_id="code-engineer",
            ).count(),
            1,
        )
        existing.refresh_from_db()
        self.assertTrue(existing.is_active)
        self.assertEqual(existing.settings.get("avatar_key"), "code-engineer")
        existing_office_agent.refresh_from_db()
        self.assertEqual(
            existing_office_agent.settings.get("avatar_key"),
            "office-secretary",
        )

    def test_listing_fast_path_does_not_enter_locked_ensure_for_existing_default(self):
        """已有默认 Agent 的列表热路径纯读：不加锁、不修 Skill/App。"""
        agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            is_active=True,
            settings=build_system_default_agent_settings(),
        )

        with (
            patch.object(self.service, "ensure_default_agent") as locked_ensure,
            patch(
                "apps.skills.services.default_agent_skill_seed."
                "repair_default_agent_skills_if_needed"
            ) as repair_skills,
        ):
            ensured = self.service.ensure_default_agent_for_listing(self.organization.id)

        self.assertEqual(ensured.id, agent.id)
        locked_ensure.assert_not_called()
        repair_skills.assert_not_called()

    def test_listing_falls_back_to_locked_ensure_when_default_is_missing(self):
        """缺失态仍复用原有创建/复活/迁移纠偏逻辑。"""
        sentinel = object()
        with patch.object(
            self.service,
            "ensure_default_agent",
            return_value=sentinel,
        ) as locked_ensure:
            ensured = self.service.ensure_default_agent_for_listing(self.organization.id)

        self.assertIs(ensured, sentinel)
        locked_ensure.assert_called_once_with(self.organization.id)

    def test_list_api_degrades_when_ensure_hits_database_error(self):
        """补建遇锁超时等 DB 错误时，列表应降级返回已有 Agent，不 500。"""
        from django.db import OperationalError

        existing = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="已有分身",
            type="bot",
            is_default=False,
            is_active=True,
        )

        with patch.object(
            AgentService,
            "ensure_starter_agent_roster_for_listing",
            side_effect=OperationalError("canceling statement due to lock timeout"),
        ):
            response = self.client.get(
                f"/api/agents?organization_id={self.organization.id}",
                **self.auth,
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)
        agents = data.get("agents") or []
        self.assertEqual(len(agents), 1)
        self.assertEqual(agents[0]["id"], str(existing.id))

    def test_delete_api_rejects_default_agent(self):
        agent = self.service.ensure_default_agent(self.organization.id)
        Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="可删分身",
            type="bot",
            is_default=False,
        )
        response = self.client.delete(f"/api/agents/{agent.id}", **self.auth)
        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertEqual(payload.get("code"), "DEFAULT_AGENT_PROTECTED")
        agent.refresh_from_db()
        self.assertTrue(agent.is_active)

    def test_reactivate_api_returns_serialized_agent(self):
        default = self.service.ensure_default_agent(self.organization.id)
        persona = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="可恢复分身",
            type="bot",
            is_default=False,
        )
        self.assertTrue(self.service.delete_agent(persona.id))

        response = self.client.post(
            f"/api/agents/{persona.id}/reactivate",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)
        self.assertTrue(payload.get("success", True))
        self.assertEqual(data["id"], str(persona.id))
        self.assertTrue(data["is_active"])
        persona.refresh_from_db()
        self.assertTrue(persona.is_active)
        default.refresh_from_db()
        self.assertTrue(default.is_active)

    def test_permanent_delete_api_removes_deactivated_persona(self):
        self.service.ensure_default_agent(self.organization.id)
        persona = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="接口待彻底删除分身",
            type="bot",
            is_default=False,
            is_active=False,
        )

        response = self.client.delete(
            f"/api/agents/{persona.id}/permanent",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(Agent.objects.filter(id=persona.id).exists())

    def test_deactivated_list_exposes_default_protection_flag(self):
        default = self.service.ensure_default_agent(self.organization.id)
        default.is_active = False
        default.save(update_fields=["is_active", "updated_at"])

        response = self.client.get(
            f"/api/agents/deactivated?organization_id={self.organization.id}",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        item = next(
            item
            for item in response.json()["data"]["items"]
            if item["id"] == str(default.id)
        )
        self.assertTrue(item["is_default"])

    def test_custom_quota_excludes_system_default(self):
        """#7523：系统默认不计自建配额。"""
        default = self.service.ensure_default_agent(self.organization.id)
        self.assertTrue(default.is_default)
        for i in range(MAX_CUSTOM_BOT_AGENTS):
            created = self.service.create_agent(
                organization_id=self.organization.id,
                name=f"自建{i}",
            )
            self.assertIsNotNone(created)
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_agent(
                organization_id=self.organization.id,
                name="超额",
            )
        self.assertEqual(ctx.exception.code, "AGENT_LIMIT_EXCEEDED")

    def test_create_agent_strips_system_default_provision_source(self):
        """#7523：用户/模板创建路径不得写入 system_default provenance。"""
        from apps.tabtinspace.services.onboarding_defaults import (
            AGENT_SETTINGS_PROVISION_SOURCE_KEY,
            SYSTEM_DEFAULT_PROVISION_SOURCE,
            strip_reserved_provision_source,
        )

        polluted = strip_reserved_provision_source(
            {AGENT_SETTINGS_PROVISION_SOURCE_KEY: SYSTEM_DEFAULT_PROVISION_SOURCE, "icon": "x"},
        )
        self.assertNotIn(AGENT_SETTINGS_PROVISION_SOURCE_KEY, polluted)
        self.assertEqual(polluted.get("icon"), "x")

        created = self.service.create_agent(
            organization_id=self.organization.id,
            name="自建分身",
        )
        self.assertIsNotNone(created)
        self.assertNotEqual(
            (created.settings or {}).get(AGENT_SETTINGS_PROVISION_SOURCE_KEY),
            SYSTEM_DEFAULT_PROVISION_SOURCE,
        )

"""#6955：用户级技能库总闸 + Agent 子开关合成。"""

from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from django.test import TransactionTestCase

from apps.agent.models import Agent
from apps.skills.models import AgentSkillLink, Skill, UserSkillPreference
from apps.skills.services.agent_link_service import AgentSkillLinkService
from apps.skills.services.registry_service import SkillsRegistryService
from apps.skills.services.skill_service import SkillNotFoundError, SkillService
from apps.skills.services.space_context import SkillSpaceContext
from apps.tabtinspace.models import Device, Organization, Workspace
from apps.users.auth.models import User


pytestmark = pytest.mark.requires_pg_native


class UserSkillPreferenceLayerTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        token = uuid.uuid4().hex
        self.user = User.objects.create_user(
            email=f"pref-{token}@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name=f"Pref {token}",
            owner=self.user,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="Pref Agent",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name="Pref Device",
            fingerprint=f"pref-device-{token}",
        )
        root = f"/tmp/tabtin-pref-{token}"
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            name="Pref Workspace",
            working_dir=root,
            normalized_working_dir=root,
            created_by=self.user,
        )
        self.context = SkillSpaceContext(
            space_id=self.workspace.id,
            agent_id=self.agent.id,
            organization_id=self.organization.id,
            device_id=self.device.id,
        )

    def _create_skill(self, slug="gate"):
        return Skill.objects.create(
            owner_user_id=self.user.id,
            slug=slug,
            name=slug.title(),
            visibility=Skill.VISIBILITY_PRIVATE,
        )

    def test_library_enable_sets_user_gate_without_agent_id(self):
        skill = self._create_skill()
        pref = SkillService.enable_skill(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
        )
        self.assertTrue(pref.enabled)
        self.assertFalse(
            AgentSkillLink.objects.filter(skill_canonical_key=skill.canonical_key).exists()
        )

    def test_library_enable_unknown_user_skill_raises(self):
        with self.assertRaises(SkillNotFoundError):
            SkillService.enable_skill(
                user_id=self.user.id,
                skill_canonical_key="user:never-existed-6955",
            )

    def test_import_batch_enrichment_passes_agent_id(self):
        skill = self._create_skill("import-enrich")
        with patch.object(
            SkillService, "import_skill",
            return_value=(skill, [], False, []),
        ), patch.object(
            SkillsRegistryService,
            "resolve_agent_skill_state",
            return_value={
                skill.canonical_key: {
                    "enabled": True,
                    "installed_version_seq": 1,
                    "install_content_hash": "abc",
                    "installed_on_device": True,
                },
            },
        ) as resolve_mock:
            batch = SkillService.import_skills_batch(
                user_id=self.user.id,
                organization_id=self.organization.id,
                agent_id=self.agent.id,
                items=[{"name": "x"}],
            )
        self.assertEqual(batch["summary"]["ok"], 1)
        resolve_mock.assert_called_once_with(
            None,
            agent_id=str(self.agent.id),
            user_id=str(self.user.id),
        )
        self.assertTrue(batch["results"][0]["skill"]["enabled"])

    def test_library_enable_with_agent_opens_both_layers(self):
        skill = self._create_skill("both")
        SkillService.enable_skill(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
            organization_id=self.organization.id,
            agent_id=self.agent.id,
        )
        pref = UserSkillPreference.objects.get(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
        )
        link = AgentSkillLink.objects.get(
            agent=self.agent,
            skill_canonical_key=skill.canonical_key,
        )
        self.assertTrue(pref.enabled)
        self.assertTrue(link.enabled)

    def test_library_disable_keeps_agent_link(self):
        skill = self._create_skill("keep")
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
        )
        UserSkillPreference.objects.create(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
            enabled=True,
        )
        SkillService.disable_skill(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
        )
        pref = UserSkillPreference.objects.get(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
        )
        link = AgentSkillLink.objects.get(
            agent=self.agent,
            skill_canonical_key=skill.canonical_key,
        )
        self.assertFalse(pref.enabled)
        self.assertTrue(link.enabled)

    def test_injection_defaults_user_gate_on_without_preference_row(self):
        """无 UserSkillPreference 行时总闸默认开；Agent 携带即可注入。"""
        skill = self._create_skill("and")
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
        )
        state = SkillsRegistryService.resolve_agent_skill_state(
            agent_id=str(self.agent.id),
            user_id=str(self.user.id),
        )
        self.assertTrue(state[skill.canonical_key]["enabled"])
        self.assertTrue(state[skill.canonical_key]["agent_enabled"])
        self.assertTrue(state[skill.canonical_key]["user_enabled"])

        UserSkillPreference.objects.create(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
            enabled=False,
        )
        state = SkillsRegistryService.resolve_agent_skill_state(
            agent_id=str(self.agent.id),
            user_id=str(self.user.id),
        )
        self.assertFalse(state[skill.canonical_key]["enabled"])
        self.assertFalse(state[skill.canonical_key]["user_enabled"])
        self.assertTrue(state[skill.canonical_key]["agent_enabled"])

    def test_visible_enabled_is_user_gate(self):
        skill = self._create_skill("visible-gate")
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
        )
        UserSkillPreference.objects.create(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
            enabled=False,
        )
        with patch.object(
            SkillsRegistryService, "list_platform_skills", return_value=[]
        ), patch.object(
            SkillsRegistryService, "list_app_skills", return_value=[]
        ), patch.object(
            SkillsRegistryService, "list_device_skills", return_value=[]
        ):
            entries = SkillService.list_visible_skills(
                user_id=self.user.id,
                organization_id=self.organization.id,
                agent_id=self.agent.id,
            )
        entry = next(item for item in entries if item["skill_key"] == skill.canonical_key)
        self.assertFalse(entry["enabled"])
        self.assertTrue(entry["agent_enabled"])

    def test_agent_list_links_effective_enabled(self):
        skill = self._create_skill("list")
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
        )
        items = AgentSkillLinkService.list_links(
            self.agent, requesting_user_id=self.user.id,
        )
        item = next(i for i in items if i["skill_canonical_key"] == skill.canonical_key)
        # 无总闸行 = 默认开
        self.assertTrue(item["enabled"])
        self.assertTrue(item["agent_enabled"])
        self.assertTrue(item["user_enabled"])

        UserSkillPreference.objects.create(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
            enabled=False,
        )
        items = AgentSkillLinkService.list_links(
            self.agent, requesting_user_id=self.user.id,
        )
        item = next(i for i in items if i["skill_canonical_key"] == skill.canonical_key)
        self.assertFalse(item["enabled"])
        self.assertTrue(item["agent_enabled"])
        self.assertFalse(item["user_enabled"])

    def test_visible_api_includes_user_gates_for_local_catalog(self):
        """本机 catalog 不在 skills 列表里时，仍通过 user_gates 下发总闸。"""
        from types import SimpleNamespace

        from apps.skills.api import list_visible_skills

        UserSkillPreference.objects.create(
            user_id=self.user.id,
            skill_canonical_key="device:lark-approval",
            enabled=True,
        )
        request = SimpleNamespace(auth=self.user, GET={})
        with patch.object(
            SkillsRegistryService, "list_platform_skills", return_value=[]
        ), patch.object(
            SkillsRegistryService, "list_app_skills", return_value=[]
        ), patch.object(
            SkillsRegistryService, "list_device_skills", return_value=[]
        ), patch(
            "apps.skills.api._check_organization_member", return_value=True,
        ):
            body = list_visible_skills(
                request,
                organization_id=str(self.organization.id),
                agent_id=str(self.agent.id),
            )
        self.assertIsInstance(body, dict)
        data = body.get("data") or body
        self.assertTrue(data.get("user_gates", {}).get("device:lark-approval"))

"""device 来源跨组织共享与 Agent/Device 分层契约。"""

from __future__ import annotations

import uuid

import pytest
from django.test import TransactionTestCase

from apps.agent.models import Agent
from apps.skills.models import AgentSkillLink, Skill, SkillEnablement
from apps.skills.services.registry_service import (
    SOURCE_DEVICE,
    SOURCE_PLATFORM,
    SOURCE_USER,
    SkillsRegistryService,
)
from apps.skills.services.skill_service import SkillService
from apps.tabtinspace.models import Device, Organization, Space
from apps.users.auth.models import User


@pytest.mark.requires_pg_native
class DeviceSourceContractTest(TransactionTestCase):
    """device 来源不进 Skill 表，携带意图跟 Agent，安装事实跟 Device。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        token = uuid.uuid4().hex
        self.user = User.objects.create_user(
            email=f"device-skill-{token}@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name=f"Device Skill {token}",
            owner=self.user,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="Device Skill Agent",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name="Device Skill Device",
            fingerprint=f"device-skill-{token}",
        )
        self.space = Space.objects.create(
            organization=self.organization,
            agent=self.agent,
            control_device=self.device,
            name="Device Skill Space",
        )

    def test_device_source_skill_does_not_enter_skill_table(self):
        valid_sources = {choice[0] for choice in Skill.SOURCE_CHOICES}
        self.assertEqual(valid_sources, {SOURCE_USER})
        self.assertNotIn(SOURCE_DEVICE, valid_sources)
        self.assertNotIn(SOURCE_PLATFORM, valid_sources)

    def test_device_install_has_no_skill_id(self):
        row = SkillEnablement.objects.create(
            device_id=self.device.id,
            skill_id=None,
            skill_canonical_key="device:tabtin-cli",
            source=SOURCE_DEVICE,
        )
        self.assertIsNone(row.skill_id)
        self.assertEqual(row.source, SOURCE_DEVICE)

    def test_device_skill_enable_disable_flow_changes_agent_link_only(self):
        canonical = "device:my-cli-tool"

        link = SkillService.enable_skill(
            user_id=self.user.id,
            organization_id=self.organization.id,
            agent_id=self.agent.id,
            skill_canonical_key=canonical,
        )
        self.assertEqual(link.agent_id, self.agent.id) if hasattr(link, "agent_id") else None
        self.assertEqual(link.source, SOURCE_DEVICE)
        self.assertTrue(link.enabled)
        self.assertFalse(SkillEnablement.objects.exists())

        self.assertTrue(SkillService.disable_skill(
            user_id=self.user.id,
            skill_canonical_key=canonical,
        ))
        row = AgentSkillLink.objects.get(
            agent=self.agent, skill_canonical_key=canonical,
        )
        # 关总闸不改 Agent 携带；这里仅确认 Agent 携带行仍在（enabled 由技能库总闸驱动）。
        self.assertTrue(row.enabled)
        self.assertFalse(SkillEnablement.objects.exists())

    def test_device_skill_disable_without_link_is_idempotent_off(self):
        canonical = "device:never-enabled-before"

        self.assertFalse(AgentSkillLink.objects.filter(
            agent=self.agent,
            skill_canonical_key=canonical,
        ).exists())
        self.assertTrue(SkillService.disable_skill(
            user_id=self.user.id,
            skill_canonical_key=canonical,
        ))
        self.assertFalse(AgentSkillLink.objects.filter(
            agent=self.agent,
            skill_canonical_key=canonical,
        ).exists())

    def test_device_skill_filter_requires_explicit_agent_enable(self):
        skills = [{
            "skill_key": "device:local-cli",
            "source": SOURCE_DEVICE,
            "name": "local-cli",
        }]
        self.assertEqual(
            SkillsRegistryService._filter_by_agent_links(skills, {}),
            [],
        )
        self.assertEqual(
            SkillsRegistryService._filter_by_agent_links(
                skills, {"device:local-cli": {"enabled": False}},
            ),
            [],
        )
        filtered = SkillsRegistryService._filter_by_agent_links(
            skills, {"device:local-cli": {"enabled": True}},
        )
        self.assertEqual(len(filtered), 1)

    def test_device_skill_can_be_enabled_by_agents_in_separate_organizations(self):
        token = uuid.uuid4().hex
        other_org = Organization.objects.create(
            name=f"Other Device Skill {token}",
            owner=self.user,
        )
        other_agent = Agent.objects.create(
            organization=other_org,
            owner_user=self.user,
            name="Other Device Skill Agent",
        )
        other_space = Space.objects.create(
            organization=other_org,
            agent=other_agent,
            name="Other Device Skill Space",
        )
        canonical = "device:shared-cli"

        SkillService.enable_skill(
            user_id=self.user.id,
            organization_id=self.organization.id,
            agent_id=self.agent.id,
            skill_canonical_key=canonical,
        )
        SkillService.enable_skill(
            user_id=self.user.id,
            organization_id=other_org.id,
            agent_id=other_agent.id,
            skill_canonical_key=canonical,
        )

        rows = AgentSkillLink.objects.filter(skill_canonical_key=canonical)
        self.assertEqual(rows.count(), 2)
        self.assertSetEqual(
            set(rows.values_list("agent_id", flat=True)),
            {self.agent.id, other_agent.id},
        )

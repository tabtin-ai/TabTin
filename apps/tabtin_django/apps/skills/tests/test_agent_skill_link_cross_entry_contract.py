"""#6350：Agent 页携带 API 与 Skill 库 enable/disable/config 跨入口契约一致。

覆盖：
1. organization unpublished → 两条入口均拒绝非 owner
2. SubAgentTemplate 同步 / 清理两条入口一致
3. 无效 / 他人 credential → 两条入口均拒绝；config merge 不 silent wipe
"""

from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from django.test import TransactionTestCase

from apps.agent.models import Agent
from apps.skills.models import AgentSkillLink, Skill, SkillPublishedVersion
from apps.skills.services.agent_link_service import (
    AgentSkillLinkCredentialValidationError,
    AgentSkillLinkError,
    AgentSkillLinkService,
)
from apps.skills.services.agent_link_writer import (
    AgentSkillLinkCredentialError,
    AgentSkillLinkWriter,
    AgentSkillLinkWriterError,
    UNPUBLISHED_SKILL_MESSAGE,
)
from apps.skills.services.space_context import SkillSpaceContext
from apps.skills.services.skill_service import SkillService, SkillServiceError
from apps.tabtinspace.models import Organization
from apps.tabtinspace.services.app_settings_service import AppSettingsService
from apps.users.auth.models import User


@pytest.mark.django_db(databases=["default", "postgresql"])
class AgentSkillLinkCrossEntryContractTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        token = uuid.uuid4().hex[:10]
        self.owner = User.objects.create_user(
            email=f"owner-{token}@example.com",
            password="test-password",
        )
        self.teammate = User.objects.create_user(
            email=f"mate-{token}@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name=f"CrossEntry {token}",
            owner=self.owner,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.teammate,
            name="CrossEntry Agent",
        )
        self.space_id = uuid.uuid4()
        self.context = SkillSpaceContext(
            space_id=self.space_id,
            agent_id=self.agent.id,
            organization_id=self.organization.id,
            device_id=None,
        )

    def _make_org_skill(self, *, slug: str, published: bool, with_agents: bool = False):
        skill = Skill.objects.create(
            owner_user_id=self.owner.id,
            slug=slug,
            name=slug,
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization.id,
            latest_version_seq=1 if published else None,
            agents_json=(
                [{
                    "name": f"{slug}-agent",
                    "description": "cross-entry subagent",
                    "system_prompt": "you help",
                    "subagent_type": "execute",
                }]
                if with_agents
                else []
            ),
        )
        if published:
            SkillPublishedVersion.objects.create(
                skill=skill,
                version_seq=1,
                version_label="1.0.0",
                published_by=self.owner.id,
                review_status=SkillPublishedVersion.REVIEW_APPROVED,
            )
        return skill

    # ------------------------------------------------------------------
    # 1. unpublished organization skill
    # ------------------------------------------------------------------

    def test_unpublished_org_skill_rejected_by_both_entries(self):
        skill = self._make_org_skill(slug="team-draft", published=False)

        with self.assertRaises(AgentSkillLinkError) as agent_ctx:
            AgentSkillLinkService.attach_skill(
                self.agent,
                skill_canonical_key=skill.canonical_key,
                requesting_user_id=self.teammate.id,
                space_id=self.space_id,
            )
        self.assertIn("尚未发布", str(agent_ctx.exception))

        with self.assertRaises(SkillServiceError) as skill_ctx:
            SkillService.enable_skill(
                user_id=self.teammate.id,
                organization_id=self.organization.id,
                skill_canonical_key=skill.canonical_key,
                agent_id=self.agent.id,
            )
        self.assertIn("尚未发布", str(skill_ctx.exception))
        self.assertEqual(str(agent_ctx.exception), str(skill_ctx.exception))
        self.assertEqual(str(agent_ctx.exception), UNPUBLISHED_SKILL_MESSAGE)

        self.assertFalse(
            AgentSkillLink.objects.filter(
                agent_id=self.agent.id,
                skill_canonical_key=skill.canonical_key,
            ).exists()
        )

    def test_owner_can_attach_unpublished_via_both_entries(self):
        skill = self._make_org_skill(slug="owner-draft", published=False)
        owner_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="Owner Agent",
        )
        owner_context = SkillSpaceContext(
            space_id=self.space_id,
            agent_id=owner_agent.id,
            organization_id=self.organization.id,
            device_id=None,
        )

        item = AgentSkillLinkService.attach_skill(
            owner_agent,
            skill_canonical_key=skill.canonical_key,
            requesting_user_id=self.owner.id,
            space_id=self.space_id,
        )
        self.assertTrue(item["enabled"])

        AgentSkillLink.objects.filter(agent_id=owner_agent.id).delete()

        row = SkillService.enable_skill(
            user_id=self.owner.id,
            organization_id=self.organization.id,
            skill_canonical_key=skill.canonical_key,
            agent_id=owner_agent.id,
        )
        self.assertTrue(row.enabled)

    # ------------------------------------------------------------------
    # 2. SubAgent sync consistency
    # ------------------------------------------------------------------

    def test_subagent_sync_consistent_across_entries(self):
        from apps.services.agent_engine.models import SubAgentTemplate

        skill = self._make_org_skill(
            slug="with-subagent", published=True, with_agents=True,
        )
        SubAgentTemplate.objects.filter(
            space_id=self.space_id, skill_key=skill.canonical_key,
        ).delete()

        AgentSkillLinkService.attach_skill(
            self.agent,
            skill_canonical_key=skill.canonical_key,
            requesting_user_id=self.teammate.id,
            space_id=self.space_id,
        )
        templates_via_agent = list(
            SubAgentTemplate.objects.filter(
                space_id=self.space_id, skill_key=skill.canonical_key,
            ).values_list("name", flat=True)
        )
        self.assertEqual(templates_via_agent, [f"{skill.slug}-agent"])

        AgentSkillLinkService.detach_skill(
            self.agent,
            skill_canonical_key=skill.canonical_key,
            space_id=self.space_id,
        )
        self.assertFalse(
            SubAgentTemplate.objects.filter(
                space_id=self.space_id, skill_key=skill.canonical_key,
            ).exists()
        )

        # ：enable/disable_skill 不再接 space_id；SubAgent 同步的 workspace
        # 由 Agent 最近 ChatSession 内部推导。直接 patch resolve_sync_space_id
        # 把已构造好的 workspace_id 喂给 Writer。
        with patch.object(
            AgentSkillLinkWriter, "resolve_sync_space_id", return_value=self.space_id,
        ):
            SkillService.enable_skill(
                user_id=self.teammate.id,
                organization_id=self.organization.id,
                skill_canonical_key=skill.canonical_key,
                agent_id=self.agent.id,
            )
        templates_via_skill = list(
            SubAgentTemplate.objects.filter(
                space_id=self.space_id, skill_key=skill.canonical_key,
            ).values_list("name", flat=True)
        )
        self.assertEqual(templates_via_skill, templates_via_agent)

        # ：技能库关总闸保留 Agent 携带与 SubAgent 模板；卸载才摘除。
        with patch.object(
            AgentSkillLinkWriter, "resolve_sync_space_id", return_value=self.space_id,
        ):
            SkillService.disable_skill(
                user_id=self.teammate.id,
                skill_canonical_key=skill.canonical_key,
            )
        self.assertTrue(
            SubAgentTemplate.objects.filter(
                space_id=self.space_id, skill_key=skill.canonical_key,
            ).exists()
        )
        with patch.object(
            AgentSkillLinkWriter, "resolve_sync_space_id", return_value=self.space_id,
        ):
            SkillService.disable_skill(
                user_id=self.teammate.id,
                skill_canonical_key=skill.canonical_key,
                remove=True,
            )
        self.assertFalse(
            SubAgentTemplate.objects.filter(
                space_id=self.space_id, skill_key=skill.canonical_key,
            ).exists()
        )

    # ------------------------------------------------------------------
    # 2b. 无 workspace / 无会话：attach 仍成功，但跳过 SubAgent sync
    # ------------------------------------------------------------------

    def test_attach_without_workspace_skips_subagent_sync(self):
        from apps.services.agent_engine.models import SubAgentTemplate

        skill = self._make_org_skill(
            slug="no-space-subagent", published=True, with_agents=True,
        )
        fake_space = self.agent.id
        SubAgentTemplate.objects.filter(
            space_id=fake_space, skill_key=skill.canonical_key,
        ).delete()

        item = AgentSkillLinkService.attach_skill(
            self.agent,
            skill_canonical_key=skill.canonical_key,
            requesting_user_id=self.teammate.id,
            # 不传 space_id，且 setUp 未建 ChatSession → resolve 得 None
        )
        self.assertTrue(
            AgentSkillLink.objects.filter(
                agent_id=self.agent.id,
                skill_canonical_key=skill.canonical_key,
                enabled=True,
            ).exists()
        )
        sync = item.get("agents_sync") or {}
        self.assertEqual(sync.get("status"), "skipped")
        self.assertEqual(sync.get("reason"), "no_workspace")
        self.assertFalse(
            SubAgentTemplate.objects.filter(
                space_id=fake_space, skill_key=skill.canonical_key,
            ).exists(),
            "禁止回落 agent.id 写入假 space",
        )
        self.assertIsNone(
            AgentSkillLinkWriter.resolve_sync_space_id(self.agent),
        )

    # ------------------------------------------------------------------
    # 3. credential + config merge
    # ------------------------------------------------------------------

    def test_invalid_credential_rejected_by_both_entries(self):
        skill = self._make_org_skill(slug="cred-skill", published=True)
        AgentSkillLinkWriter.attach(
            agent_id=self.agent.id,
            organization_id=self.organization.id,
            requesting_user_id=self.teammate.id,
            skill_canonical_key=skill.canonical_key,
            sync_space_id=self.space_id,
        )
        bad_cred = str(uuid.uuid4())

        with patch.object(
            AppSettingsService,
            "_validate_api_key_credential",
            return_value=(False, AppSettingsService.CRED_ERR_NOT_FOUND),
        ):
            with self.assertRaises(AgentSkillLinkCredentialValidationError) as agent_ctx:
                AgentSkillLinkService.update_link(
                    self.agent,
                    skill_canonical_key=skill.canonical_key,
                    requesting_user_id=self.teammate.id,
                    config_json={"credential_id": bad_cred, "tone": "keep-me"},
                    space_id=self.space_id,
                )
            self.assertEqual(
                agent_ctx.exception.err_code,
                AppSettingsService.CRED_ERR_NOT_FOUND,
            )

            with self.assertRaises(AgentSkillLinkCredentialError) as writer_ctx:
                AgentSkillLinkWriter.merge_config(
                    agent_id=self.agent.id,
                    skill_canonical_key=skill.canonical_key,
                    requesting_user_id=self.teammate.id,
                    sync_space_id=self.space_id,
                    credential_id=bad_cred,
                )
            self.assertEqual(
                writer_ctx.exception.err_code,
                AppSettingsService.CRED_ERR_NOT_FOUND,
            )

        link = AgentSkillLink.objects.get(
            agent_id=self.agent.id,
            skill_canonical_key=skill.canonical_key,
        )
        self.assertNotIn("credential_id", link.config_json or {})
        self.assertNotIn("tone", link.config_json or {})

    def test_config_merge_preserves_unrelated_keys(self):
        skill = self._make_org_skill(slug="merge-skill", published=True)
        AgentSkillLink.objects.create(
            agent_id=self.agent.id,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
            config_json={"tone": "concise", "env": {"A": "1"}},
        )

        with patch.object(
            AppSettingsService,
            "_validate_api_key_credential",
            return_value=(True, ""),
        ):
            AgentSkillLinkService.update_link(
                self.agent,
                skill_canonical_key=skill.canonical_key,
                requesting_user_id=self.teammate.id,
                config_json={"credential_id": str(uuid.uuid4())},
                space_id=self.space_id,
            )

        link = AgentSkillLink.objects.get(
            agent_id=self.agent.id,
            skill_canonical_key=skill.canonical_key,
        )
        self.assertEqual(link.config_json.get("tone"), "concise")
        self.assertEqual(link.config_json.get("env"), {"A": "1"})
        self.assertTrue(link.config_json.get("credential_id"))

        AgentSkillLinkWriter.merge_config(
            agent_id=self.agent.id,
            skill_canonical_key=skill.canonical_key,
            requesting_user_id=self.teammate.id,
            sync_space_id=self.space_id,
            env={"B": "2"},
        )
        link.refresh_from_db()
        self.assertEqual(link.config_json.get("tone"), "concise")
        self.assertEqual(link.config_json.get("env"), {"B": "2"})
        self.assertTrue(link.config_json.get("credential_id"))


@pytest.mark.django_db(databases=["default", "postgresql"])
class ResolveUserSkillOrganizationIdTest(TransactionTestCase):
    """Writer.resolve_user_skill 直接吃 organization_id（不经 Space mock）。"""

    databases = {"default", "postgresql"}

    def test_org_teammate_sees_skill_but_writer_blocks_unpublished_attach(self):
        owner_id = uuid.uuid4()
        mate_id = uuid.uuid4()
        org_id = uuid.uuid4()
        skill = Skill.objects.create(
            owner_user_id=owner_id,
            slug="org-unpub",
            name="Org Unpub",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=org_id,
            latest_version_seq=None,
        )
        resolved = AgentSkillLinkWriter.resolve_user_skill(
            slug="org-unpub",
            requesting_user_id=mate_id,
            organization_id=org_id,
        )
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.skill_id, skill.skill_id)

        with self.assertRaises(AgentSkillLinkWriterError) as ctx:
            AgentSkillLinkWriter.require_runnable_for_non_owner(
                skill=skill,
                requesting_user_id=mate_id,
            )
        self.assertEqual(str(ctx.exception), UNPUBLISHED_SKILL_MESSAGE)

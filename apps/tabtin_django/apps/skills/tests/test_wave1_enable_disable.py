"""#3266 M4.5 /  terminal Agent intent / Device installation contract."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.test import TransactionTestCase

from apps.agent.models import Agent
from apps.skills.api import get_skill_configs, update_skill_config, update_skill_visibility
from apps.skills.models import (
    AgentSkillLink,
    Skill,
    SkillEnablement,
    SkillPublishedVersion,
)
from apps.skills.schemas import SkillConfigUpdateRequest
from apps.skills.services.published_version_cleanup import dedupe_published_versions
from apps.skills.services.registry_service import SkillsRegistryService
from apps.skills.services.skill_service import (
    SkillPermissionError,
    SkillService,
    SkillServiceError,
)
from apps.skills.services.stats_service import SkillStatsService
from apps.tabtinspace.models import Device, Organization, Workspace
from apps.users.auth.models import User


pytestmark = pytest.mark.requires_pg_native


class SkillTerminalModelTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        token = uuid.uuid4().hex
        self.user = User.objects.create_user(
            email=f"skill-{token}@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name=f"Skill {token}",
            owner=self.user,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="Skill Agent",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name="Test Device",
            fingerprint=f"skill-device-{token}",
        )
        #  / ：Space 表已 DROP；SubAgent 同步锚用 Workspace。
        root = f"/tmp/tabtin-skill-wave1-{token}"
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            name="Skill Workspace",
            working_dir=root,
            normalized_working_dir=root,
            created_by=self.user,
        )

    def create_skill(self, slug="probe"):
        return Skill.objects.create(
            owner_user_id=self.user.id,
            slug=slug,
            name=slug.title(),
            visibility=Skill.VISIBILITY_PRIVATE,
        )

    def test_create_adds_disabled_agent_link_without_device_install(self):
        skill = SkillService.create_user_skill(
            owner_user_id=self.user.id,
            organization_id=self.organization.id,
            agent_id=self.agent.id,
            name="Created Skill",
            skip_initial_publish=True,
        )

        link = AgentSkillLink.objects.get(
            agent=self.agent,
            skill_id=skill.skill_id,
        )
        self.assertFalse(link.enabled)
        self.assertFalse(
            SkillEnablement.objects.filter(skill_id=skill.skill_id).exists()
        )

    def test_enable_disable_updates_user_gate_keeps_agent_link(self):
        """#6955：技能库开关写用户总闸；关总闸保留 Agent 携带行。"""
        from apps.skills.models import UserSkillPreference

        skill = self.create_skill()

        pref = SkillService.enable_skill(
            user_id=self.user.id,
            organization_id=self.organization.id,
            skill_canonical_key=skill.canonical_key,
            agent_id=self.agent.id,
        )
        self.assertTrue(pref.enabled)
        link = AgentSkillLink.objects.get(
            agent=self.agent,
            skill_canonical_key=skill.canonical_key,
        )
        self.assertTrue(link.enabled)
        self.assertFalse(SkillEnablement.objects.exists())

        self.assertTrue(
            SkillService.disable_skill(
                user_id=self.user.id,
                skill_canonical_key=skill.canonical_key,
            )
        )
        pref = UserSkillPreference.objects.get(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
        )
        self.assertFalse(pref.enabled)
        link.refresh_from_db()
        self.assertTrue(link.enabled)

    def test_enable_rejects_agent_owned_by_another_organization_member(self):
        """普通启用入口不能绕过批量入口已有的 Agent owner 门禁。"""
        other_user = User.objects.create_user(
            email=f"other-agent-owner-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        other_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=other_user,
            name="Other Member Agent",
        )
        skill = self.create_skill("owner-guard")

        with self.assertRaisesRegex(SkillPermissionError, "无权"):
            SkillService.enable_skill(
                user_id=self.user.id,
                organization_id=self.organization.id,
                skill_canonical_key=skill.canonical_key,
                agent_id=other_agent.id,
            )

        self.assertFalse(
            AgentSkillLink.objects.filter(
                agent=other_agent,
                skill_canonical_key=skill.canonical_key,
            ).exists()
        )

    def test_visible_combines_agent_intent_with_control_device_install(self):
        skill = self.create_skill("visible")
        from apps.skills.models import UserSkillPreference

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
        SkillEnablement.objects.create(
            device_id=self.device.id,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            installed_version_seq=3,
            install_content_hash="device-hash",
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
        self.assertTrue(entry["installed"])
        self.assertTrue(entry["enabled"])
        self.assertTrue(entry["installed_on_device"])
        self.assertEqual(entry["installed_version_seq"], 3)
        self.assertEqual(entry["install_content_hash"], "device-hash")

    def test_visible_reports_device_install_without_claiming_agent_carry(self):
        skill = self.create_skill("device-only")
        SkillEnablement.objects.create(
            device_id=self.device.id,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            installed_version_seq=2,
            install_content_hash="device-only-hash",
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
        self.assertFalse(entry["installed"])
        self.assertFalse(entry["enabled"])
        self.assertTrue(entry["installed_on_device"])
        self.assertEqual(entry["installed_version_seq"], 2)
        self.assertEqual(entry["install_content_hash"], "device-only-hash")

    def test_carried_private_skill_survives_visibility_tightening(self):
        other_user = User.objects.create_user(
            email=f"other-skill-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        skill = Skill.objects.create(
            owner_user_id=other_user.id,
            slug="carried-private",
            name="Carried Private",
            visibility=Skill.VISIBILITY_PRIVATE,
        )
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
        )

        with patch.object(
            SkillsRegistryService, "list_platform_skills", return_value=[]
        ), patch.object(
            SkillsRegistryService, "list_app_skills", return_value=[]
        ), patch.object(
            SkillsRegistryService, "list_device_skills", return_value=[]
        ):
            visible = SkillService.list_visible_skills(
                user_id=self.user.id,
                organization_id=self.organization.id,
                agent_id=self.agent.id,
            )
            available = SkillsRegistryService.list_available_skills(
                user_id=str(self.user.id),
                organization_id=str(self.organization.id),
                agent_id=str(self.agent.id),
            )

        self.assertIn(skill.canonical_key, {item["skill_key"] for item in visible})
        self.assertIn(skill.canonical_key, {item["skill_key"] for item in available})

    def test_config_api_reads_and_writes_agent_link(self):
        skill = self.create_skill("configured")
        link = AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
        )
        request = SimpleNamespace(auth=self.user)

        with patch("apps.skills.api._check_organization_member", return_value=True):
            update_skill_config(
                request,
                skill.canonical_key,
                SkillConfigUpdateRequest(
                    organization_id=str(self.organization.id),
                    agent_id=str(self.agent.id),
                    enabled=False,
                    env={"REGION": "test"},
                    config={"mode": "strict"},
                ),
            )
            get_skill_configs(
                request,
                organization_id=str(self.organization.id),
                agent_id=str(self.agent.id),
            )

        link.refresh_from_db()
        self.assertFalse(link.enabled)
        self.assertEqual(link.config_json["env"], {"REGION": "test"})
        self.assertEqual(link.config_json["config"], {"mode": "strict"})
        self.assertFalse(SkillEnablement.objects.exists())

    def test_import_batch_uses_agent_and_device_layers(self):
        skill = self.create_skill("imported")
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=False,
        )

        with patch.object(
            SkillService,
            "import_skill",
            return_value=(skill, [{"path": "SKILL.md", "content": "# imported"}], False, []),
        ):
            result = SkillService.import_skills_batch(
                user_id=self.user.id,
                organization_id=self.organization.id,
                agent_id=self.agent.id,
                items=[{"files": [{"path": "SKILL.md", "content": "# imported"}]}],
            )

        self.assertEqual(result["summary"], {"ok": 1, "failed": 0})
        entry = result["results"][0]["skill"]
        self.assertFalse(entry["enabled"])
        self.assertFalse(entry["installed_on_device"])

    def test_publish_does_not_rewrite_device_install_fact(self):
        skill = self.create_skill("published")
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
        )
        installation = SkillEnablement.objects.create(
            device_id=self.device.id,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            installed_version_seq=1,
            install_content_hash="old-device-hash",
        )

        def publish_from_zip(_zip_bytes, **kwargs):
            current = kwargs["known_skill"]
            current.latest_version_seq = 2
            current.install_content_hash = "new-release-hash"
            current.save(
                update_fields=["latest_version_seq", "install_content_hash", "updated_at"]
            )
            SkillPublishedVersion.objects.create(
                skill=current,
                version_seq=2,
                version_label="0.0.2",
                bundle_sha256="new-release-hash",
                published_by=self.user.id,
            )

        with patch(
            "apps.skills.services.publish_service.SkillPublishService.publish_from_zip",
            side_effect=publish_from_zip,
        ):
            SkillService.publish_skill(
                skill_id=skill.skill_id,
                owner_user_id=self.user.id,
                organization_id=self.organization.id,
                agent_id=self.agent.id,
                version_label="0.0.2",
                files=[{
                    "path": "SKILL.md",
                    "content": "---\nname: published\ndescription: test\n---\n",
                }],
            )

        installation.refresh_from_db()
        self.assertEqual(installation.installed_version_seq, 1)
        self.assertEqual(installation.install_content_hash, "old-device-hash")

    def test_version_dedupe_does_not_rewrite_device_install_fact(self):
        skill = self.create_skill("dedupe")
        for version_seq in (1, 2):
            SkillPublishedVersion.objects.create(
                skill=skill,
                version_seq=version_seq,
                version_label="1.0.0",
                bundle_sha256=f"hash-{version_seq}",
                published_by=self.user.id,
            )
        installation = SkillEnablement.objects.create(
            device_id=self.device.id,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            installed_version_seq=1,
            install_content_hash="device-version-one",
        )

        stats = dedupe_published_versions(execute=True)

        installation.refresh_from_db()
        self.assertEqual(installation.installed_version_seq, 1)
        self.assertTrue(SkillPublishedVersion.objects.filter(
            skill=skill,
            version_seq=1,
        ).exists())
        self.assertEqual(stats["rows_skipped_installed"], 1)

    def test_enable_agent_ids_rejects_unauthorized_target_atomically(self):
        other_user = User.objects.create_user(
            email=f"unauthorized-skill-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        other_org = Organization.objects.create(
            name="Unauthorized Skill Org",
            owner=other_user,
        )
        other_agent = Agent.objects.create(
            organization=other_org,
            owner_user=other_user,
            name="Unauthorized Agent",
        )
        skill = self.create_skill("permission")

        with self.assertRaisesRegex(SkillPermissionError, "无权"):
            SkillService._apply_enable_agent_ids(
                user_id=self.user.id,
                skill=skill,
                enable_agent_ids=[str(self.agent.id), str(other_agent.id)],
            )

        self.assertFalse(AgentSkillLink.objects.filter(
            skill_id=skill.skill_id,
        ).exists())

        skill_count = Skill.objects.count()
        with self.assertRaisesRegex(SkillPermissionError, "无权"):
            SkillService.import_skill(
                user_id=self.user.id,
                organization_id=self.organization.id,
                agent_id=self.agent.id,
                name="unauthorized-import",
                files=[{
                    "path": "SKILL.md",
                    "content": "---\nname: unauthorized-import\ndescription: test\n---\n",
                }],
                enable_agent_ids=[str(other_agent.id)],
            )
        self.assertEqual(Skill.objects.count(), skill_count)

    def test_visibility_requires_target_organization_membership(self):
        """Owner 也不能把 Skill 共享到自己不属于的 Organization。"""
        other_user = User.objects.create_user(
            email=f"visibility-owner-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        other_org = Organization.objects.create(
            name="Visibility Target Org",
            owner=other_user,
        )
        skill = self.create_skill("visibility-target-org")
        request = SimpleNamespace(auth=self.user)
        payload = SimpleNamespace(
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=str(other_org.id),
        )

        response = update_skill_visibility(request, skill.skill_id, payload)

        self.assertEqual(response.status_code, 403)
        skill.refresh_from_db()
        self.assertEqual(skill.visibility, Skill.VISIBILITY_PRIVATE)
        self.assertIsNone(skill.organization_id)

    def test_visibility_private_allows_owner_after_leaving_organization(self):
        """Owner 离开组织后仍能把自己的 Skill 下架回 private。"""
        org_owner = User.objects.create_user(
            email=f"visibility-org-owner-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        other_org = Organization.objects.create(
            name="Visibility Existing Org",
            owner=org_owner,
        )
        skill = Skill.objects.create(
            owner_user_id=self.user.id,
            slug="visibility-existing-org",
            name="Visibility Existing Org",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=other_org.id,
        )
        request = SimpleNamespace(auth=self.user)
        payload = SimpleNamespace(
            visibility=Skill.VISIBILITY_PRIVATE,
            organization_id=None,
        )

        response = update_skill_visibility(request, skill.skill_id, payload)

        self.assertTrue(response["success"])
        skill.refresh_from_db()
        self.assertEqual(skill.visibility, Skill.VISIBILITY_PRIVATE)
        self.assertIsNone(skill.organization_id)

    def test_visibility_rejects_duplicate_organization_slug(self):
        """canonical key 仍按 slug 解析时，同组织不能出现两个同名共享 Skill。"""
        other_user = User.objects.create_user(
            email=f"duplicate-skill-owner-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        Skill.objects.create(
            owner_user_id=other_user.id,
            slug="shared-name",
            name="Shared Name",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization.id,
        )
        private_skill = self.create_skill("shared-name")

        with self.assertRaisesRegex(SkillServiceError, "标识名"):
            SkillService.set_visibility(
                skill_id=private_skill.skill_id,
                owner_user_id=self.user.id,
                visibility=Skill.VISIBILITY_ORGANIZATION,
                organization_id=self.organization.id,
            )

        private_skill.refresh_from_db()
        self.assertEqual(private_skill.visibility, Skill.VISIBILITY_PRIVATE)
        self.assertIsNone(private_skill.organization_id)

    def test_publish_rejects_duplicate_organization_slug(self):
        """共享主路径 create+publish 也必须拦组织内相同标识名。"""
        other_user = User.objects.create_user(
            email=f"duplicate-publish-owner-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        Skill.objects.create(
            owner_user_id=other_user.id,
            slug="brainstorming-org-token",
            name="brainstorming",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization.id,
        )
        private_skill = self.create_skill("brainstorming-org-token")

        with patch(
            "apps.skills.services.publish_service.SkillPublishService.publish_from_zip",
        ) as publish_from_zip:
            with self.assertRaisesRegex(SkillServiceError, "标识名"):
                SkillService.publish_skill(
                    skill_id=private_skill.skill_id,
                    owner_user_id=self.user.id,
                    organization_id=self.organization.id,
                    version_label="0.0.1",
                    visibility=Skill.VISIBILITY_ORGANIZATION,
                    files=[{
                        "path": "SKILL.md",
                        "content": "---\nname: brainstorming-org-token\ndescription: test\n---\n",
                    }],
                )
            publish_from_zip.assert_not_called()

        private_skill.refresh_from_db()
        self.assertEqual(private_skill.visibility, Skill.VISIBILITY_PRIVATE)
        self.assertIsNone(private_skill.organization_id)

    def test_team_installs_excludes_disabled_agent_links(self):
        skill = Skill.objects.create(
            owner_user_id=self.user.id,
            slug="team-disabled",
            name="Team Disabled",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization.id,
        )
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=False,
        )

        result = SkillStatsService.get_team_installs(str(self.organization.id))

        entry = next(item for item in result if item["skill_key"] == skill.canonical_key)
        self.assertFalse(entry["installed"])
        self.assertEqual(entry["installed_by"], [])

    def test_enable_without_agent_falls_back_to_user_gate(self):
        """#7118：agent_id 缺省时 enable_skill 只写用户总闸，不建 AgentSkillLink。"""
        skill = self.create_skill("orphan")

        pref = SkillService.enable_skill(
            user_id=self.user.id,
            skill_canonical_key=skill.canonical_key,
        )
        self.assertTrue(pref.enabled)
        self.assertFalse(
            AgentSkillLink.objects.filter(skill_id=skill.skill_id).exists()
        )

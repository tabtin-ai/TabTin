"""Wave 1 重写：SkillService / SkillsRegistryService 回归测试。

旧 ``ManagedSkillsService`` 已删除（W0 决策补丁 1，无兼容负担）。
新模型行为：
- ``SkillService.create_user_skill``：创建即进入能力库，但默认停用
- ``AgentSkillLink``：Agent 携带、启用状态与私有配置的 SSoT
- ``SkillEnablement``：设备安装版本与内容指纹登记，不随服务端启停改写
- ``SkillsRegistryService.list_user_skills_visible``：visibility 三档过滤
- ``SkillsRegistryService.list_user_skills_owned``：仅 owner 视角
"""
from __future__ import annotations

import importlib
import uuid

import pytest
from django.apps import apps as django_apps
from django.db import connection
from django.test import TransactionTestCase

from apps.agent.models import Agent
from apps.skills.models import (
    AgentSkillLink,
    Skill,
    SkillEnablement,
    SkillPublishedVersion,
    UserSkillPreference,
)
from apps.skills.services.registry_service import SkillsRegistryService
from apps.skills.services.skill_service import (
    SkillNotFoundError,
    SkillService,
    SkillServiceError,
)
from apps.tabtinspace.models import Device, Organization, OrganizationMember
from apps.users.auth.models import User


class SkillContextMixin:
    def setUp(self):
        token = uuid.uuid4().hex
        self.owner = User.objects.create_user(
            email=f"skill-regression-{token}@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name=f"Skill Regression {token}",
            owner=self.owner,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="Skill Agent",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Skill Device",
            fingerprint=f"skill-regression-device-{token}",
        )


@pytest.mark.django_db(databases=["default", "postgresql"])
class CreateUserSkillTest(SkillContextMixin, TransactionTestCase):
    databases = {"default", "postgresql"}

    def test_create_creates_skill_and_disabled_agent_link(self):
        skill = SkillService.create_user_skill(
            owner_user_id=self.owner.id,
            organization_id=self.organization.id,
            agent_id=self.agent.id,
            name="My Skill", slug="my-skill",
            skip_initial_publish=True,
        )
        self.assertEqual(skill.owner_user_id, self.owner.id)
        self.assertEqual(skill.slug, "my-skill")
        self.assertEqual(skill.visibility, Skill.VISIBILITY_PRIVATE)

        # 创建即进入“我的”能力库，但默认不注入当前 Agent。
        link = AgentSkillLink.objects.get(
            agent=self.agent,
            skill_canonical_key=skill.canonical_key,
        )
        self.assertFalse(link.enabled)
        self.assertFalse(SkillEnablement.objects.exists())

    def test_create_requires_owner_and_name(self):
        with self.assertRaises(SkillServiceError):
            SkillService.create_user_skill(
                owner_user_id=None, organization_id=self.organization.id, name="x",
            )
        with self.assertRaises(SkillServiceError):
            SkillService.create_user_skill(
                owner_user_id=self.owner.id, organization_id=self.organization.id, name="",
            )

@pytest.mark.django_db(databases=["default", "postgresql"])
class CreateUserSkillSlugConflictTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner_id = uuid.uuid4()
        self.organization_id = uuid.uuid4()

    def test_create_slug_conflict_defaults_to_suffix(self):
        first = SkillService.create_user_skill(
            owner_user_id=self.owner_id,
            organization_id=self.organization_id,
            name="Snapshot",
            slug="shared-snapshot",
            skip_initial_publish=True,
        )
        second = SkillService.create_user_skill(
            owner_user_id=self.owner_id,
            organization_id=self.organization_id,
            name="Snapshot",
            slug="shared-snapshot",
            skip_initial_publish=True,
        )

        self.assertEqual(first.slug, "shared-snapshot")
        self.assertEqual(second.slug, "shared-snapshot-2")

    def test_create_slug_conflict_can_be_rejected(self):
        SkillService.create_user_skill(
            owner_user_id=self.owner_id,
            organization_id=self.organization_id,
            name="Snapshot",
            slug="strict-snapshot",
            skip_initial_publish=True,
        )

        with self.assertRaisesRegex(SkillServiceError, "标识名已存在"):
            SkillService.create_user_skill(
                owner_user_id=self.owner_id,
                organization_id=self.organization_id,
                name="Snapshot",
                slug="strict-snapshot",
                slug_conflict_policy="reject",
                skip_initial_publish=True,
            )


@pytest.mark.django_db(databases=["default", "postgresql"])
class EnableDisableRegressionTest(SkillContextMixin, TransactionTestCase):
    databases = {"default", "postgresql"}

    def test_enable_unknown_user_skill_raises_not_found(self):
        with self.assertRaises(SkillNotFoundError):
            SkillService.enable_skill(
                user_id=self.owner.id,
                organization_id=self.organization.id,
                agent_id=self.agent.id,
                skill_canonical_key="user:never-existed",
            )

    def test_enable_disabled_re_enable_idempotent(self):
        skill = Skill.objects.create(
            owner_user_id=self.owner.id, slug="repeat", name="Repeat",
        )
        canonical = skill.canonical_key

        first = SkillService.enable_skill(
            user_id=self.owner.id,
            organization_id=self.organization.id,
            agent_id=self.agent.id,
            skill_canonical_key=canonical,
        )
        again = SkillService.enable_skill(
            user_id=self.owner.id,
            organization_id=self.organization.id,
            agent_id=self.agent.id,
            skill_canonical_key=canonical,
        )
        self.assertTrue(first.enabled)
        self.assertTrue(again.enabled)
        self.assertEqual(first.skill_id, again.skill_id)
        self.assertEqual(first.skill_canonical_key, canonical)
        self.assertEqual(again.skill_canonical_key, canonical)
        self.assertEqual(
            AgentSkillLink.objects.filter(
                agent=self.agent,
                skill_canonical_key=canonical,
            ).count(),
            1,
        )
        self.assertFalse(SkillEnablement.objects.exists())

    def test_organization_skill_enable_acquires_private_snapshot(self):
        """组织精选只负责分发；成员接入后 Agent 必须改挂自己的 Skill 快照。"""
        member = User.objects.create_user(
            email=f"skill-member-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=member,
            name="Member Agent",
        )
        shared = Skill.objects.create(
            owner_user_id=self.owner.id,
            slug="shared-snapshot",
            name="Shared Snapshot",
            description="organization distribution snapshot",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization.id,
            latest_version_seq=1,
            install_content_hash="snapshot-hash",
        )
        SkillPublishedVersion.objects.create(
            skill=shared,
            version_seq=1,
            version_label="1.0.0",
            bundle_sha256="snapshot-hash",
            local_content_hash="snapshot-hash",
            published_by=self.owner.id,
        )

        first = SkillService.enable_skill(
            user_id=member.id,
            organization_id=self.organization.id,
            agent_id=member_agent.id,
            skill_canonical_key=shared.canonical_key,
            acquire_as_copy=True,
        )
        again = SkillService.enable_skill(
            user_id=member.id,
            organization_id=self.organization.id,
            agent_id=member_agent.id,
            skill_canonical_key=shared.canonical_key,
            acquire_as_copy=True,
        )

        acquired = Skill.objects.get(skill_id=first.skill_id)
        self.assertEqual(acquired.skill_id, again.skill_id)
        self.assertEqual(str(acquired.owner_user_id), str(member.id))
        self.assertEqual(acquired.visibility, Skill.VISIBILITY_PRIVATE)
        self.assertNotEqual(acquired.canonical_key, shared.canonical_key)
        self.assertTrue(acquired.slug.startswith(f"{shared.slug}-copy"))
        self.assertEqual(acquired.copied_from_skill_id, shared.skill_id)
        self.assertEqual(acquired.latest_version_seq, 1)
        self.assertEqual(acquired.published_versions.count(), 1)
        self.assertFalse(AgentSkillLink.objects.filter(
            agent=member_agent,
            skill_id=shared.skill_id,
        ).exists())
        self.assertEqual(AgentSkillLink.objects.filter(
            agent=member_agent,
            skill_id=acquired.skill_id,
            skill_canonical_key=acquired.canonical_key,
        ).count(), 1)
        visible = SkillsRegistryService.list_user_skills_visible(
            user_id=str(member.id),
            organization_id=str(self.organization.id),
        )
        shared_entry = next(entry for entry in visible if entry["skill_id"] == str(shared.skill_id))
        self.assertEqual(shared_entry["acquired_copy_skill_id"], str(acquired.skill_id))
        self.assertEqual(shared_entry["acquired_copy_skill_key"], acquired.canonical_key)

        SkillService.delete_skill(
            owner_user_id=self.owner.id,
            skill_id=shared.skill_id,
        )
        acquired.refresh_from_db()
        self.assertIsNone(acquired.copied_from_skill_id)
        self.assertTrue(AgentSkillLink.objects.filter(
            agent=member_agent,
            skill_id=acquired.skill_id,
        ).exists())

    def test_delete_organization_snapshot_migrates_legacy_member_links(self):
        """历史引用式接入必须先转为成员副本，才能删除组织分发快照。"""
        member = User.objects.create_user(
            email=f"legacy-skill-member-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=member,
            name="Legacy Member Agent",
        )
        shared = Skill.objects.create(
            owner_user_id=self.owner.id,
            slug="legacy-shared",
            name="Legacy Shared",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization.id,
            latest_version_seq=1,
            install_content_hash="legacy-hash",
        )
        SkillPublishedVersion.objects.create(
            skill=shared,
            version_seq=1,
            version_label="1.0.0",
            bundle_sha256="legacy-hash",
            published_by=self.owner.id,
        )
        AgentSkillLink.objects.create(
            agent=member_agent,
            skill_id=shared.skill_id,
            skill_canonical_key=shared.canonical_key,
            source="user",
            enabled=False,
            config_json={"credential_id": "member-private-config"},
        )
        UserSkillPreference.objects.create(
            user_id=member.id,
            skill_canonical_key=shared.canonical_key,
            enabled=False,
        )

        SkillService.delete_skill(
            owner_user_id=self.owner.id,
            skill_id=shared.skill_id,
        )

        self.assertFalse(Skill.objects.filter(skill_id=shared.skill_id).exists())
        acquired = Skill.objects.get(owner_user_id=member.id, name=shared.name)
        self.assertIsNone(acquired.copied_from_skill_id)
        migrated_link = AgentSkillLink.objects.get(agent=member_agent)
        self.assertEqual(migrated_link.skill_id, acquired.skill_id)
        self.assertEqual(migrated_link.skill_canonical_key, acquired.canonical_key)
        self.assertFalse(migrated_link.enabled)
        self.assertEqual(
            migrated_link.config_json,
            {"credential_id": "member-private-config"},
        )
        self.assertFalse(UserSkillPreference.objects.get(
            user_id=member.id,
            skill_canonical_key=acquired.canonical_key,
        ).enabled)

    def test_history_backfill_covers_links_preferences_and_device_installs(self):
        """0023 必须覆盖三类历史接入事实，并可安全重复执行。"""
        users = [
            User.objects.create_user(
                email=f"skill-backfill-{kind}-{uuid.uuid4().hex}@example.com",
                password="test-password",
            )
            for kind in ("link", "preference", "device")
        ]
        for user in users:
            OrganizationMember.objects.get_or_create(
                organization=self.organization,
                user=user,
                defaults={"role": "viewer"},
            )

        link_user, preference_user, device_user = users
        link_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=link_user,
            name="Backfill Link Agent",
        )
        device = Device.objects.create(
            organization=self.organization,
            user=device_user,
            name="Backfill Device",
            fingerprint=f"skill-backfill-device-{uuid.uuid4().hex}",
        )
        shared = Skill.objects.create(
            owner_user_id=self.owner.id,
            slug="history-backfill",
            name="History Backfill",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization.id,
            latest_version_seq=1,
            install_content_hash="history-backfill-hash",
        )
        SkillPublishedVersion.objects.create(
            skill=shared,
            version_seq=1,
            version_label="1.0.0",
            bundle_sha256="history-backfill-hash",
            published_by=self.owner.id,
        )
        AgentSkillLink.objects.create(
            agent=link_agent,
            skill_id=shared.skill_id,
            skill_canonical_key=shared.canonical_key,
            source="user",
            enabled=False,
            config_json={"credential_id": "history-private"},
        )
        UserSkillPreference.objects.create(
            user_id=link_user.id,
            skill_canonical_key=shared.canonical_key,
            enabled=False,
        )
        UserSkillPreference.objects.create(
            user_id=preference_user.id,
            skill_canonical_key=shared.canonical_key,
            enabled=True,
        )
        SkillEnablement.objects.create(
            device=device,
            skill_id=shared.skill_id,
            skill_canonical_key=shared.canonical_key,
            source="user",
            installed_version_seq=1,
            install_content_hash="history-backfill-hash",
        )

        migration = importlib.import_module(
            "apps.skills.migrations.0023_backfill_organization_skill_acquisitions",
        )
        with connection.schema_editor() as schema_editor:
            migration.backfill_organization_skill_acquisitions(
                django_apps,
                schema_editor,
            )
        with connection.schema_editor() as schema_editor:
            migration.backfill_organization_skill_acquisitions(
                django_apps,
                schema_editor,
            )

        copies = Skill.objects.filter(
            copied_from_skill=shared,
            owner_user_id__in=[user.id for user in users],
        )
        self.assertEqual(copies.count(), 3)
        self.assertTrue(all(copy.published_versions.count() == 1 for copy in copies))

        link_copy = copies.get(owner_user_id=link_user.id)
        migrated_link = AgentSkillLink.objects.get(agent=link_agent)
        self.assertEqual(migrated_link.skill_id, link_copy.skill_id)
        self.assertFalse(migrated_link.enabled)
        self.assertEqual(
            migrated_link.config_json,
            {"credential_id": "history-private"},
        )
        self.assertFalse(UserSkillPreference.objects.get(
            user_id=link_user.id,
            skill_canonical_key=link_copy.canonical_key,
        ).enabled)

        preference_copy = copies.get(owner_user_id=preference_user.id)
        self.assertTrue(UserSkillPreference.objects.get(
            user_id=preference_user.id,
            skill_canonical_key=preference_copy.canonical_key,
        ).enabled)
        self.assertFalse(UserSkillPreference.objects.filter(
            skill_canonical_key=shared.canonical_key,
            user_id__in=[link_user.id, preference_user.id],
        ).exists())
        self.assertFalse(SkillEnablement.objects.filter(
            device=device,
            skill_id=shared.skill_id,
        ).exists())

    def test_delete_organization_snapshot_migrates_preference_and_device_only(self):
        """下架入口不能依赖 Agent link 才迁移历史接入事实。"""
        member = User.objects.create_user(
            email=f"skill-pref-device-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        OrganizationMember.objects.get_or_create(
            organization=self.organization,
            user=member,
            defaults={"role": "viewer"},
        )
        device = Device.objects.create(
            organization=self.organization,
            user=member,
            name="Preference Device",
            fingerprint=f"skill-pref-device-{uuid.uuid4().hex}",
        )
        shared = Skill.objects.create(
            owner_user_id=self.owner.id,
            slug="preference-device-only",
            name="Preference Device Only",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization.id,
            latest_version_seq=1,
        )
        SkillPublishedVersion.objects.create(
            skill=shared,
            version_seq=1,
            version_label="1.0.0",
            published_by=self.owner.id,
        )
        UserSkillPreference.objects.create(
            user_id=member.id,
            skill_canonical_key=shared.canonical_key,
            enabled=False,
        )
        SkillEnablement.objects.create(
            device=device,
            skill_id=shared.skill_id,
            skill_canonical_key=shared.canonical_key,
            source="user",
            installed_version_seq=1,
        )

        SkillService.delete_skill(
            owner_user_id=self.owner.id,
            skill_id=shared.skill_id,
        )

        acquired = Skill.objects.get(
            owner_user_id=member.id,
            name=shared.name,
        )
        self.assertIsNone(acquired.copied_from_skill_id)
        self.assertFalse(UserSkillPreference.objects.get(
            user_id=member.id,
            skill_canonical_key=acquired.canonical_key,
        ).enabled)
        self.assertFalse(UserSkillPreference.objects.filter(
            user_id=member.id,
            skill_canonical_key=shared.canonical_key,
        ).exists())
        self.assertFalse(SkillEnablement.objects.filter(device=device).exists())

    def test_owner_can_delete_private_skill_even_if_other_user_carries_it(self):
        """别人还在用，也不影响 owner 删除自己的原件。"""
        member = User.objects.create_user(
            email=f"skill-other-carrier-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=member,
            name="Other Carrier Agent",
        )
        skill = Skill.objects.create(
            owner_user_id=self.owner.id,
            slug="new-skill-code",
            name="new-skill-code",
            visibility=Skill.VISIBILITY_PRIVATE,
        )
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
        )
        AgentSkillLink.objects.create(
            agent=member_agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
        )

        SkillService.delete_skill(
            owner_user_id=self.owner.id,
            skill_id=skill.skill_id,
        )

        self.assertFalse(Skill.objects.filter(skill_id=skill.skill_id).exists())
        self.assertFalse(AgentSkillLink.objects.filter(skill_id=skill.skill_id).exists())

    def test_owner_can_discard_draft_even_if_other_user_carries_it(self):
        member = User.objects.create_user(
            email=f"skill-discard-carrier-{uuid.uuid4().hex}@example.com",
            password="test-password",
        )
        member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=member,
            name="Discard Carrier Agent",
        )
        skill = Skill.objects.create(
            owner_user_id=self.owner.id,
            slug="draft-skill-code",
            name="draft-skill-code",
            visibility=Skill.VISIBILITY_PRIVATE,
        )
        AgentSkillLink.objects.create(
            agent=member_agent,
            skill_id=skill.skill_id,
            skill_canonical_key=skill.canonical_key,
            source="user",
            enabled=True,
        )

        SkillService.discard_draft(
            owner_user_id=self.owner.id,
            skill_id=skill.skill_id,
        )

        self.assertFalse(Skill.objects.filter(skill_id=skill.skill_id).exists())
        self.assertFalse(AgentSkillLink.objects.filter(skill_id=skill.skill_id).exists())

    def test_disable_keeps_agent_link_and_device_install_fact(self):
        """停用只关闭用户总闸，Agent 携带与设备安装事实保持不变。"""
        link = AgentSkillLink.objects.create(
            agent=self.agent,
            skill_canonical_key="device:cli-x",
            source="device",
        )
        SkillEnablement.objects.create(
            device_id=self.device.id,
            skill_canonical_key="device:cli-x", source="device",
        )
        self.assertTrue(SkillService.disable_skill(
            user_id=self.owner.id,
            skill_canonical_key="device:cli-x",
        ))
        link.refresh_from_db()
        self.assertTrue(link.enabled)
        self.assertFalse(UserSkillPreference.objects.get(
            user_id=self.owner.id,
            skill_canonical_key="device:cli-x",
        ).enabled)
        self.assertTrue(SkillEnablement.objects.filter(
            device_id=self.device.id,
            skill_canonical_key="device:cli-x",
        ).exists())
        # 不存在的 key 也视为已达到关闭状态，保持幂等成功。
        self.assertTrue(SkillService.disable_skill(
            user_id=self.owner.id,
            skill_canonical_key="device:never",
        ))

    def test_disable_with_remove_deletes_link_only(self):
        """摘除 Agent 携带关系也不能替设备伪造卸载事实。"""
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_canonical_key="device:cli-x",
            source="device",
        )
        SkillEnablement.objects.create(
            device_id=self.device.id,
            skill_canonical_key="device:cli-x", source="device",
        )
        self.assertTrue(SkillService.disable_skill(
            user_id=self.owner.id,
            skill_canonical_key="device:cli-x", remove=True,
        ))
        self.assertFalse(AgentSkillLink.objects.filter(
            agent=self.agent,
            skill_canonical_key="device:cli-x",
        ).exists())
        self.assertTrue(SkillEnablement.objects.filter(
            device_id=self.device.id,
            skill_canonical_key="device:cli-x",
        ).exists())

    def test_remove_with_forget_deletes_user_acquisition(self):
        """从「我的」删除已获取 Skill 时，移除用户接入记录与 Agent 携带关系。"""
        key = "user:team-skill"
        UserSkillPreference.objects.create(
            user_id=self.owner.id,
            skill_canonical_key=key,
            enabled=True,
        )
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_canonical_key=key,
            source="user",
        )

        self.assertTrue(SkillService.disable_skill(
            user_id=self.owner.id,
            skill_canonical_key=key,
            remove=True,
            forget_acquisition=True,
        ))

        self.assertFalse(UserSkillPreference.objects.filter(
            user_id=self.owner.id,
            skill_canonical_key=key,
        ).exists())
        self.assertFalse(AgentSkillLink.objects.filter(
            agent=self.agent,
            skill_canonical_key=key,
        ).exists())


@pytest.mark.django_db(databases=["default", "postgresql"])
class RegistryListUserSkillsTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def test_list_user_skills_owned_returns_only_owner_skills(self):
        alice = uuid.uuid4()
        bob = uuid.uuid4()
        Skill.objects.create(owner_user_id=alice, slug="a1", name="A1")
        Skill.objects.create(owner_user_id=alice, slug="a2", name="A2")
        Skill.objects.create(owner_user_id=bob, slug="b1", name="B1")

        result = SkillsRegistryService.list_user_skills_owned(user_id=str(alice))
        slugs = sorted(entry["slug"] for entry in result)
        self.assertEqual(slugs, ["a1", "a2"])

    def test_list_user_skills_visible_includes_organization(self):
        alice = uuid.uuid4()
        bob = uuid.uuid4()
        organization = uuid.uuid4()
        Skill.objects.create(
            owner_user_id=alice, slug="team-skill", name="Team",
            visibility=Skill.VISIBILITY_ORGANIZATION, organization_id=organization,
        )
        result = SkillsRegistryService.list_user_skills_visible(
            user_id=str(bob), organization_id=str(organization),
        )
        slugs = [entry["slug"] for entry in result]
        self.assertIn("team-skill", slugs)

    def test_list_user_skills_visible_scopes_owner_organization_skills(self):
        """组织精选始终按当前组织隔离；只有 private 原件跟 owner 跨组织走。"""
        alice = uuid.uuid4()
        org_a = uuid.uuid4()
        org_b = uuid.uuid4()
        Skill.objects.create(
            owner_user_id=alice, slug="shared-to-a", name="Shared A",
            visibility=Skill.VISIBILITY_ORGANIZATION, organization_id=org_a,
        )
        Skill.objects.create(
            owner_user_id=alice, slug="shared-to-b", name="Shared B",
            visibility=Skill.VISIBILITY_ORGANIZATION, organization_id=org_b,
        )
        Skill.objects.create(
            owner_user_id=alice, slug="alice-private", name="Private",
            visibility=Skill.VISIBILITY_PRIVATE,
        )

        in_org_a = SkillsRegistryService.list_user_skills_visible(
            user_id=str(alice), organization_id=str(org_a),
        )
        slugs_a = sorted(entry["slug"] for entry in in_org_a)
        self.assertEqual(slugs_a, ["alice-private", "shared-to-a"])

        in_org_b = SkillsRegistryService.list_user_skills_visible(
            user_id=str(alice), organization_id=str(org_b),
        )
        slugs_b = sorted(entry["slug"] for entry in in_org_b)
        self.assertEqual(slugs_b, ["alice-private", "shared-to-b"])

        outsider = uuid.uuid4()
        other_org = uuid.uuid4()
        as_outsider = SkillsRegistryService.list_user_skills_visible(
            user_id=str(outsider), organization_id=str(other_org),
        )
        outsider_slugs = [entry["slug"] for entry in as_outsider]
        self.assertNotIn("shared-to-a", outsider_slugs)
        self.assertNotIn("shared-to-b", outsider_slugs)

    def test_visible_api_does_not_return_another_organization_skill(self):
        """HTTP 契约保留原 envelope，但 skills 只含当前组织货架。"""
        from types import SimpleNamespace
        from unittest.mock import patch

        from apps.skills.api import list_visible_skills

        alice = uuid.uuid4()
        org_a = uuid.uuid4()
        org_b = uuid.uuid4()
        Skill.objects.create(
            owner_user_id=alice,
            slug="shared-to-a",
            name="Shared A",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=org_a,
        )
        Skill.objects.create(
            owner_user_id=alice,
            slug="shared-to-b",
            name="Shared B",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=org_b,
        )

        request = SimpleNamespace(auth=SimpleNamespace(id=alice), GET={})
        with patch(
            "apps.skills.api._check_organization_member",
            return_value=True,
        ), patch.object(
            SkillsRegistryService,
            "list_platform_skills",
            return_value=[],
        ), patch.object(
            SkillsRegistryService,
            "list_app_skills",
            return_value=[],
        ), patch.object(
            SkillsRegistryService,
            "list_device_skills",
            return_value=[],
        ):
            body = list_visible_skills(
                request,
                organization_id=str(org_a),
                agent_id=None,
            )

        self.assertTrue(body["success"])
        self.assertIn("user_gates", body["data"])
        slugs = sorted(skill["slug"] for skill in body["data"]["skills"])
        self.assertEqual(slugs, ["shared-to-a"])

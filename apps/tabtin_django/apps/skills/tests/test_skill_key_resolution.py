"""Wave 1 重写（W0 决策 3 V2）：``user:<slug>`` 三档解析回归。

``SkillService._resolve_user_skill`` 的安全约束（review P0）：``user:<slug>``
canonical key 在库内唯一性是 ``(owner_user_id, slug)``，全局 slug 不唯一。
必须按可见范围解析：

1. owner = requesting_user → 直接返回
2. visibility = organization 且 organization 匹配 → 团队可见
3. visibility = public 且最新版 review_status=approved → 公开可见

不允许 ``Skill.objects.filter(slug=slug).first()`` 全局查找——会跨 owner 串单。
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from django.test import TransactionTestCase

from apps.skills.models import Skill, SkillPublishedVersion
from apps.skills.services.skill_service import SkillService, SkillServiceError


@pytest.mark.django_db(databases=["default", "postgresql"])
class ResolveUserSkillBySlugTest(TransactionTestCase):
    """W0 决策 3 V2：slug 解析按 owner / organization / public+approved 三档。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.alice = uuid.uuid4()
        self.bob = uuid.uuid4()
        self.organization_a = uuid.uuid4()
        self.space_a = uuid.uuid4()
        self.space_b = uuid.uuid4()

    def _resolve(
        self,
        *,
        slug: str,
        requester: uuid.UUID,
        space_id: uuid.UUID,
        organization_id: uuid.UUID | None = None,
    ):
        #  兼容：旧测试沿用 space_id 变量名标示 workspace 上下文；实际
        # ``_resolve_user_skill`` 只按 organization_id 做团队解析（`user:<slug>`
        # 走 owner → org → public+approved 三档），此处忽略 space_id。
        return SkillService._resolve_user_skill(
            slug=slug,
            requesting_user_id=requester,
            organization_id=organization_id,
        )

    def test_owner_resolves_own_private_skill(self):
        own = Skill.objects.create(
            owner_user_id=self.alice,
            slug="hello",
            name="Hello",
            visibility=Skill.VISIBILITY_PRIVATE,
        )
        resolved = self._resolve(slug="hello", requester=self.alice, space_id=self.space_a)
        self.assertEqual(resolved.skill_id, own.skill_id)

    def test_non_owner_cannot_see_private(self):
        Skill.objects.create(
            owner_user_id=self.alice,
            slug="hello",
            name="Hello",
            visibility=Skill.VISIBILITY_PRIVATE,
        )
        resolved = self._resolve(slug="hello", requester=self.bob, space_id=self.space_a)
        self.assertIsNone(resolved)

    def test_same_slug_different_owner_does_not_cross(self):
        """关键安全：alice 的 slug 'utils' 不能被 bob 通过 user:utils 解析到。"""
        Skill.objects.create(
            owner_user_id=self.alice, slug="utils", name="Alice Utils",
            visibility=Skill.VISIBILITY_PRIVATE,
        )
        bob_own = Skill.objects.create(
            owner_user_id=self.bob, slug="utils", name="Bob Utils",
            visibility=Skill.VISIBILITY_PRIVATE,
        )
        resolved = self._resolve(slug="utils", requester=self.bob, space_id=self.space_b)
        self.assertEqual(resolved.skill_id, bob_own.skill_id)

    def test_public_unapproved_is_invisible(self):
        skill = Skill.objects.create(
            owner_user_id=self.alice, slug="public-draft", name="Draft",
            visibility=Skill.VISIBILITY_PUBLIC,
            latest_version_seq=1,
        )
        SkillPublishedVersion.objects.create(
            skill=skill,
            version_seq=1,
            published_by=self.alice,
            review_status=SkillPublishedVersion.REVIEW_PENDING,
        )
        resolved = self._resolve(slug="public-draft", requester=self.bob, space_id=self.space_b)
        self.assertIsNone(resolved)

    def test_public_approved_is_visible_to_others(self):
        skill = Skill.objects.create(
            owner_user_id=self.alice, slug="public-approved", name="Pub",
            visibility=Skill.VISIBILITY_PUBLIC,
            latest_version_seq=1,
        )
        SkillPublishedVersion.objects.create(
            skill=skill,
            version_seq=1,
            published_by=self.alice,
            review_status=SkillPublishedVersion.REVIEW_APPROVED,
        )
        resolved = self._resolve(slug="public-approved", requester=self.bob, space_id=self.space_b)
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.skill_id, skill.skill_id)

    def _make_agent_context(self, *, owner_user_id, organization_id, space_id):
        from apps.agent.models import Agent
        from apps.skills.services.space_context import SkillSpaceContext
        from apps.tabtinspace.models import Organization
        from apps.users.auth.models import User

        # User.pk 是 CharField；Skill.owner_user_id 是 UUID 软引用
        user_pk = str(owner_user_id)
        user, _ = User.objects.get_or_create(
            id=user_pk,
            defaults={
                "email": f"{user_pk[:8]}@example.com",
                "username": f"u-{user_pk[:8]}",
            },
        )
        org, _ = Organization.objects.get_or_create(
            id=organization_id,
            defaults={"name": f"Org {str(organization_id)[:8]}", "owner": user},
        )
        agent = Agent.objects.create(
            organization=org,
            owner_user=user,
            name=f"Agent {user_pk[:6]}",
        )
        return SkillSpaceContext(
            space_id=space_id,
            agent_id=agent.id,
            organization_id=organization_id,
            device_id=None,
        )

    def test_organization_teammate_cannot_enable_unpublished_skill(self):
        """#2664 / ：队友可见 organization 草稿，但无已发布版本时不允许启用。"""
        from apps.skills.services.agent_link_writer import AgentSkillLinkWriter

        team_skill = Skill.objects.create(
            owner_user_id=self.alice,
            slug="team-draft",
            name="Team Draft",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization_a,
            latest_version_seq=None,
        )
        resolved = self._resolve(
            slug="team-draft",
            requester=self.bob,
            space_id=self.space_a,
            organization_id=self.organization_a,
        )
        self.assertEqual(resolved.skill_id, team_skill.skill_id)

        with self.assertRaises(SkillServiceError) as ctx:
            SkillService.enable_skill(
                user_id=self.bob,
                organization_id=self.organization_a,
                skill_canonical_key=team_skill.canonical_key,
            )
        self.assertIn("尚未发布", str(ctx.exception))
        with self.assertRaises(Exception) as writer_ctx:
            AgentSkillLinkWriter.require_runnable_for_non_owner(
                skill=team_skill, requesting_user_id=self.bob,
            )
        self.assertEqual(str(ctx.exception), str(writer_ctx.exception))

    def test_organization_owner_can_enable_unpublished_skill(self):
        """#2664：owner 启用自己的 organization 草稿仍合法（本地 sandbox 有文件）。"""
        team_skill = Skill.objects.create(
            owner_user_id=self.alice,
            slug="team-own-draft",
            name="Own Draft",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization_a,
            latest_version_seq=None,
        )
        row = SkillService.enable_skill(
            user_id=self.alice,
            organization_id=self.organization_a,
            skill_canonical_key=team_skill.canonical_key,
        )
        self.assertTrue(row.enabled)
        self.assertIsNone(getattr(row, "installed_version_seq", None))

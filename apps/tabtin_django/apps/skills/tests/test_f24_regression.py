"""Wave 1 重写：F24 类（跨上下文权限/可见性）回归。

旧 F24 测的是 ``TriggerGoalTool`` 跨 organization 拒绝（goal_tools 已迁移到
GoalService._ensure_permission，不再有独立 Tool 类）。本期等价的"跨上下文
串单防护"测试是 Skill 启用时的可见性安全：

- 私有 skill 不能被非 owner 启用
- organization skill 不能被其他 organization 成员启用
- public 未审核 skill 不能被非 owner 启用

#7118：Skill HTTP 已切到 ``(organization_id, agent_id)``；跨组织可见性隔离
现在直接靠传入的 ``organization_id`` 决定，不再需要通过 Space 反查。
"""
from __future__ import annotations

import uuid

import pytest
from django.test import TransactionTestCase

from apps.skills.models import Skill, SkillPublishedVersion
from apps.skills.services.skill_service import SkillNotFoundError, SkillService


@pytest.mark.django_db(databases=["default", "postgresql"])
class CrossOwnerEnableBlockedTest(TransactionTestCase):
    """非 owner 启用 user 来源 skill 必须按 visibility 过滤。"""

    databases = {"default", "postgresql"}

    def test_other_cannot_enable_private(self):
        alice = uuid.uuid4()
        bob = uuid.uuid4()
        skill = Skill.objects.create(
            owner_user_id=alice, slug="alice-private", name="Private",
            visibility=Skill.VISIBILITY_PRIVATE,
        )
        with self.assertRaises(SkillNotFoundError):
            SkillService.enable_skill(
                user_id=bob,
                organization_id=uuid.uuid4(),
                skill_canonical_key=skill.canonical_key,
            )

    def test_organization_skill_blocked_for_other_organization(self):
        alice = uuid.uuid4()
        bob = uuid.uuid4()
        team_a = uuid.uuid4()
        team_b = uuid.uuid4()

        skill = Skill.objects.create(
            owner_user_id=alice, slug="team-only", name="Team",
            visibility=Skill.VISIBILITY_ORGANIZATION, organization_id=team_a,
        )

        with self.assertRaises(SkillNotFoundError):
            SkillService.enable_skill(
                user_id=bob,
                organization_id=team_b,
                skill_canonical_key=skill.canonical_key,
            )

    def test_public_unapproved_blocked_for_others(self):
        alice = uuid.uuid4()
        bob = uuid.uuid4()
        skill = Skill.objects.create(
            owner_user_id=alice, slug="public-pending", name="Pending",
            visibility=Skill.VISIBILITY_PUBLIC,
            latest_version_seq=1,
        )
        SkillPublishedVersion.objects.create(
            skill=skill,
            version_seq=1,
            published_by=alice,
            review_status=SkillPublishedVersion.REVIEW_PENDING,
        )
        with self.assertRaises(SkillNotFoundError):
            SkillService.enable_skill(
                user_id=bob,
                organization_id=uuid.uuid4(),
                skill_canonical_key=skill.canonical_key,
            )

    def test_public_approved_allowed_for_others(self):
        alice = uuid.uuid4()
        bob = uuid.uuid4()
        skill = Skill.objects.create(
            owner_user_id=alice, slug="public-approved", name="Pub",
            visibility=Skill.VISIBILITY_PUBLIC,
            latest_version_seq=1,
        )
        SkillPublishedVersion.objects.create(
            skill=skill,
            version_seq=1,
            published_by=alice,
            review_status=SkillPublishedVersion.REVIEW_APPROVED,
        )
        row = SkillService.enable_skill(
            user_id=bob,
            organization_id=uuid.uuid4(),
            skill_canonical_key=skill.canonical_key,
        )
        self.assertEqual(row.skill_canonical_key, skill.canonical_key)
        self.assertEqual(row.skill_id, skill.skill_id)

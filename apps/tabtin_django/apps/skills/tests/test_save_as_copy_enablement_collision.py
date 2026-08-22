"""回归：组织共享 Skill 另存副本时 Agent 携带 key 冲突。"""

from __future__ import annotations

import uuid

import pytest
from django.db import IntegrityError
from django.test import SimpleTestCase, TransactionTestCase

from apps.agent.models import Agent
from apps.skills.models import AgentSkillLink, Skill, SkillEnablement
from apps.skills.services.skill_service import SkillService
from apps.skills.services.slug_utils import slugify_skill_name
from apps.tabtinspace.models import Organization
from apps.users.auth.models import User


class TestForkSlugCollisionUnit(SimpleTestCase):
    def test_chinese_copy_suffix_stripped_to_source_slug(self):
        source = "tabtin-recruit-evaluator"
        self.assertEqual(slugify_skill_name(f"{source}(我的副本)"), source)


@pytest.mark.requires_pg_native
class TestSaveAsCopyEnablementCollision(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        token = uuid.uuid4().hex
        self.owner = User.objects.create_user(
            email=f"skill-owner-{token}@example.com",
            password="test-password",
        )
        self.copier = User.objects.create_user(
            email=f"skill-copier-{token}@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name=f"Skill Copy {token}",
            owner=self.owner,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.copier,
            name="Copy Agent",
        )
        # ：Skill 归属 Agent；save_as_copy 不再需要 Space / Workspace 上下文。

    def create_source(self, slug: str) -> Skill:
        return Skill.objects.create(
            owner_user_id=self.owner.id,
            slug=slug,
            name=slug,
            description="org shared",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization.id,
            source=Skill.SOURCE_USER,
        )

    def carry_source(self, source: Skill) -> None:
        AgentSkillLink.objects.create(
            agent=self.agent,
            skill_id=source.skill_id,
            skill_canonical_key=source.canonical_key,
            source="user",
            enabled=True,
        )

    def test_save_as_copy_of_enabled_org_skill_must_not_500(self):
        source = self.create_source("tabtin-recruit-evaluator")
        self.carry_source(source)

        try:
            fork = SkillService.save_as_copy(
                source_skill_id=source.skill_id,
                user_id=self.copier.id,
                agent_id=self.agent.id,
            )
        except IntegrityError as exc:
            self.fail(f"save_as_copy 因 Agent 携带 key 冲突抛 IntegrityError: {exc}")

        self.assertNotEqual(fork.skill_id, source.skill_id)
        self.assertEqual(fork.owner_user_id, self.copier.id)
        self.assertNotEqual(fork.canonical_key, source.canonical_key)
        self.assertTrue(fork.slug.endswith("-copy") or "-copy-" in fork.slug)
        self.assertTrue(AgentSkillLink.objects.filter(
            agent=self.agent,
            skill_id=fork.skill_id,
            skill_canonical_key=fork.canonical_key,
        ).exists())
        self.assertTrue(AgentSkillLink.objects.filter(
            agent=self.agent,
            skill_id=source.skill_id,
            skill_canonical_key=source.canonical_key,
        ).exists())
        self.assertFalse(SkillEnablement.objects.exists())

    def test_save_as_copy_twice_is_idempotent(self):
        source = self.create_source("shared-skill")
        self.carry_source(source)

        first = SkillService.save_as_copy(
            source_skill_id=source.skill_id,
            user_id=self.copier.id,
            agent_id=self.agent.id,
        )
        second = SkillService.save_as_copy(
            source_skill_id=source.skill_id,
            user_id=self.copier.id,
            agent_id=self.agent.id,
        )

        self.assertEqual(first.skill_id, second.skill_id)
        self.assertEqual(first.slug, second.slug)
        self.assertEqual(Skill.objects.filter(
            owner_user_id=self.copier.id,
            name=f"{source.name}(我的副本)",
        ).count(), 1)
        self.assertEqual(AgentSkillLink.objects.filter(
            agent=self.agent,
            skill_id=first.skill_id,
        ).count(), 1)

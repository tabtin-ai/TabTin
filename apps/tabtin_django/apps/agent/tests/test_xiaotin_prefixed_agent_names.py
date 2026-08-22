"""未改名模板分身 →「小Tin xxx版」重命名。"""
from __future__ import annotations

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase, override_settings

from apps.agent.models import Agent
from apps.agent.services.xiaotin_prefixed_agent_names import (
    rename_unchanged_legacy_template_agents,
)
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class XiaotinPrefixedAgentNamesTests(TestCase):
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
            username=f"xiaotin-rename-{suffix}",
            email=f"xiaotin-rename-{suffix}@tabtin.test",
            password="TabTinTest#2026",
        )
        self.organization = Organization.objects.create(
            name=f"Rename Org {suffix}",
            owner=self.user,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role="owner",
        )

    def _create_agent(self, *, name: str, template_id: str = "code-engineer", **kwargs):
        return Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=name,
            type="bot",
            template_id=template_id,
            **kwargs,
        )

    def test_dry_run_matches_legacy_factory_names_only(self):
        unchanged = self._create_agent(name="代码版", template_id="code-engineer")
        renamed_by_user = self._create_agent(
            name="进宝专属代码号",
            template_id="code-engineer",
        )
        historical_owner_prefix = self._create_agent(
            name="小明代码版",
            template_id="code-engineer",
        )
        default_xiaotin = self._create_agent(
            name="小Tin",
            template_id="general-assistant",
            is_default=True,
        )
        already_new = self._create_agent(
            name="小Tin 文书版",
            template_id="doc-writer",
        )
        daily_legacy = self._create_agent(
            name="日常版",
            template_id="general-assistant",
        )

        stats = rename_unchanged_legacy_template_agents(dry_run=True)

        matched_ids = {m.agent_id for m in stats.matches}
        self.assertIn(unchanged.id, matched_ids)
        self.assertIn(daily_legacy.id, matched_ids)
        self.assertNotIn(renamed_by_user.id, matched_ids)
        self.assertNotIn(historical_owner_prefix.id, matched_ids)
        self.assertNotIn(default_xiaotin.id, matched_ids)
        self.assertNotIn(already_new.id, matched_ids)
        self.assertEqual(stats.updated, 0)
        unchanged.refresh_from_db()
        self.assertEqual(unchanged.name, "代码版")

    def test_execute_renames_and_is_idempotent(self):
        agent = self._create_agent(name="冲浪版", template_id="web-researcher")
        custom = self._create_agent(name="我的冲浪号", template_id="web-researcher")

        stats = rename_unchanged_legacy_template_agents(dry_run=False)
        agent.refresh_from_db()
        custom.refresh_from_db()

        self.assertEqual(agent.name, "小Tin 冲浪版")
        self.assertEqual(custom.name, "我的冲浪号")
        self.assertEqual(stats.updated, 1)

        again = rename_unchanged_legacy_template_agents(dry_run=False)
        self.assertEqual(again.matched, 0)
        self.assertEqual(again.updated, 0)

"""#7456：默认 Agent 的 platform / app skill 不可关闭或收回。"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.db.models.signals import post_save
from django.test import Client, TransactionTestCase, override_settings
from django.utils import timezone

from apps.agent.models import Agent
from apps.skills.api import update_skill_config
from apps.skills.models import AgentSkillLink
from apps.skills.schemas import SkillConfigUpdateRequest
from apps.skills.services.agent_link_service import (
    AgentSkillLinkLockedError,
    AgentSkillLinkService,
)
from apps.skills.services.agent_link_writer import (
    AgentSkillLinkLockedError as WriterSkillLockedError,
    AgentSkillLinkWriter,
    DEFAULT_AGENT_SKILL_LOCKED_CODE,
)
from apps.skills.services.default_agent_skill_seed import default_agent_skills_need_repair
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import User, UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token


@pytest.mark.django_db(databases=["default", "postgresql"])
@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class DefaultAgentSkillLock7456Test(TransactionTestCase):
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
        token = uuid.uuid4().hex[:10]
        self.owner = User.objects.create_user(
            email=f"lock7456-{token}@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name=f"Lock7456 {token}",
            owner=self.owner,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.default_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="Default Tin",
            type="bot",
            is_default=True,
        )
        self.custom_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="Custom Tin",
            type="bot",
            is_default=False,
        )
        self.platform_key = "platform:demo-skill"
        self.app_key = "app:tabdoc/demo"
        self.user_key = f"user:custom-{token}"

        for agent, key, source in (
            (self.default_agent, self.platform_key, "platform"),
            (self.default_agent, self.app_key, "app"),
            (self.default_agent, self.user_key, "user"),
            (self.custom_agent, self.platform_key, "platform"),
        ):
            AgentSkillLink.objects.create(
                agent_id=agent.id,
                skill_canonical_key=key,
                source=source,
                enabled=True,
            )

        session_key = f"lock7456-{uuid.uuid4().hex}"
        UserSession.objects.create(
            user=self.owner,
            session_key=SessionManager.hash_session_key(session_key),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="lock7456-test",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=1),
            is_active=True,
        )
        token_jwt = generate_jwt_token(
            self.owner,
            expire_hours=1,
            token_type="access",
            session_key=session_key,
        )
        self.client = Client()
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {token_jwt}"}

    def test_writer_rejects_disable_and_detach_on_default_platform_app(self):
        with self.assertRaises(WriterSkillLockedError) as ctx:
            AgentSkillLinkWriter.merge_config(
                agent_id=self.default_agent.id,
                skill_canonical_key=self.platform_key,
                requesting_user_id=self.owner.id,
                enabled=False,
            )
        self.assertEqual(ctx.exception.code, DEFAULT_AGENT_SKILL_LOCKED_CODE)

        with self.assertRaises(WriterSkillLockedError):
            AgentSkillLinkWriter.detach(
                agent_id=self.default_agent.id,
                skill_canonical_key=self.app_key,
            )

        # user skill 仍可关 / 收回
        AgentSkillLinkWriter.merge_config(
            agent_id=self.default_agent.id,
            skill_canonical_key=self.user_key,
            requesting_user_id=self.owner.id,
            enabled=False,
        )
        self.assertFalse(
            AgentSkillLink.objects.get(
                agent_id=self.default_agent.id,
                skill_canonical_key=self.user_key,
            ).enabled
        )

    def test_non_default_agent_can_still_disable_platform(self):
        AgentSkillLinkWriter.merge_config(
            agent_id=self.custom_agent.id,
            skill_canonical_key=self.platform_key,
            requesting_user_id=self.owner.id,
            enabled=False,
        )
        self.assertFalse(
            AgentSkillLink.objects.get(
                agent_id=self.custom_agent.id,
                skill_canonical_key=self.platform_key,
            ).enabled
        )

    def test_core_template_skill_is_locked_even_when_marketplace_distributed(self):
        specialist = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="Tin Data",
            type="bot",
            template_id="data-analyst",
        )
        locked_key = "app:tabdata/table-modeling"
        mutable_key = "app:tabtin-writing-tools-pack/humanizer-zh"
        locked_link = AgentSkillLink.objects.create(
            agent=specialist,
            skill_canonical_key=locked_key,
            source="app",
            enabled=False,
            config_json={"distribution": "marketplace"},
        )
        AgentSkillLink.objects.create(
            agent=specialist,
            skill_canonical_key=mutable_key,
            source="app",
            enabled=True,
            config_json={"distribution": "marketplace"},
        )

        items = AgentSkillLinkService.list_links(
            specialist,
            requesting_user_id=self.owner.id,
        )
        by_key = {item["skill_canonical_key"]: item for item in items}
        self.assertTrue(by_key[locked_key]["locked"])
        self.assertTrue(by_key[locked_key]["enabled"])
        self.assertFalse(by_key[mutable_key]["locked"])
        locked_link.refresh_from_db()
        self.assertTrue(locked_link.enabled)

        with self.assertRaises(WriterSkillLockedError):
            AgentSkillLinkWriter.merge_config(
                agent_id=specialist.id,
                skill_canonical_key=locked_key,
                requesting_user_id=self.owner.id,
                enabled=False,
            )
        with self.assertRaises(WriterSkillLockedError):
            AgentSkillLinkWriter.detach(
                agent_id=specialist.id,
                skill_canonical_key=locked_key,
            )

        AgentSkillLinkWriter.merge_config(
            agent_id=specialist.id,
            skill_canonical_key=locked_key,
            requesting_user_id=self.owner.id,
            config_patch={"tone": "concise"},
        )
        self.assertEqual(
            AgentSkillLink.objects.get(
                agent=specialist,
                skill_canonical_key=locked_key,
            ).config_json["tone"],
            "concise",
        )

        AgentSkillLinkWriter.detach(
            agent_id=specialist.id,
            skill_canonical_key=mutable_key,
        )

    def test_marketplace_recommended_pack_remains_mutable_on_default_agent(self):
        """推荐货架 pack（app + distribution=marketplace）可关闭/收回，不被  锁死。"""
        market_key = "app:tabtin-writing-tools-pack/humanizer-zh"
        AgentSkillLink.objects.create(
            agent_id=self.default_agent.id,
            skill_canonical_key=market_key,
            source="app",
            enabled=True,
            config_json={"app_id": "tabtin-writing-tools-pack", "distribution": "marketplace"},
        )

        # 携带行已记 distribution=marketplace；写/读路径都应视为可变更。
        self.assertFalse(
            AgentSkillLinkWriter.is_default_agent_locked_skill(
                skill_canonical_key=market_key,
                source="app",
                distribution="marketplace",
            )
        )
        # 未显式传 distribution 时，也应从 app registry / 元数据识别推荐 pack。
        self.assertFalse(
            AgentSkillLinkWriter.is_default_agent_locked_skill(
                skill_canonical_key=market_key,
                source="app",
            )
        )

        AgentSkillLinkWriter.merge_config(
            agent_id=self.default_agent.id,
            skill_canonical_key=market_key,
            requesting_user_id=self.owner.id,
            enabled=False,
        )
        self.assertFalse(
            AgentSkillLink.objects.get(
                agent_id=self.default_agent.id,
                skill_canonical_key=market_key,
            ).enabled
        )

        items = AgentSkillLinkService.list_links(
            self.default_agent,
            requesting_user_id=self.owner.id,
        )
        by_key = {item["skill_canonical_key"]: item for item in items}
        self.assertFalse(by_key[market_key]["locked"])
        self.assertFalse(by_key[market_key]["enabled"])

        AgentSkillLinkWriter.detach(
            agent_id=self.default_agent.id,
            skill_canonical_key=market_key,
        )
        self.assertFalse(
            AgentSkillLink.objects.filter(
                agent_id=self.default_agent.id,
                skill_canonical_key=market_key,
            ).exists()
        )

    def test_need_repair_ignores_marketplace_pack_missing_or_disabled(self):
        """组织已装 marketplace pack：缺携带 / 已关掉都不应触发 seed repair。"""
        market_key = "app:tabtin-writing-tools-pack/humanizer-zh"

        with patch(
            "apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService.get_installed_app_ids",
            return_value={"tabdoc", "tabtin-writing-tools-pack"},
        ), patch(
            "apps.skills.services.registry_service.SkillsRegistryService.list_platform_skills",
            return_value=[{"skill_key": self.platform_key}],
        ), patch(
            "apps.skills.services.registry_service.SkillsRegistryService.list_app_skills",
            return_value=[
                {
                    "skill_key": self.app_key,
                    "app_id": "tabdoc",
                    "distribution": "builtin",
                },
                {
                    "skill_key": market_key,
                    "app_id": "tabtin-writing-tools-pack",
                    "distribution": "marketplace",
                },
            ],
        ):
            from apps.skills.services.default_agent_skill_seed import (
                _expected_default_skill_keys,
            )

            expected = _expected_default_skill_keys(self.default_agent)
            self.assertEqual(set(expected), {self.platform_key, self.app_key})
            self.assertFalse(default_agent_skills_need_repair(self.default_agent))

            AgentSkillLink.objects.create(
                agent_id=self.default_agent.id,
                skill_canonical_key=market_key,
                source="app",
                enabled=False,
                config_json={
                    "app_id": "tabtin-writing-tools-pack",
                    "distribution": "marketplace",
                },
            )
            self.assertFalse(default_agent_skills_need_repair(self.default_agent))

    def test_service_detach_maps_locked_error(self):
        with self.assertRaises(AgentSkillLinkLockedError) as ctx:
            AgentSkillLinkService.detach_skill(
                self.default_agent,
                skill_canonical_key=self.platform_key,
            )
        self.assertEqual(ctx.exception.err_code, DEFAULT_AGENT_SKILL_LOCKED_CODE)

    def test_service_update_link_maps_locked_error(self):
        with self.assertRaises(AgentSkillLinkLockedError) as ctx:
            AgentSkillLinkService.update_link(
                self.default_agent,
                skill_canonical_key=self.platform_key,
                requesting_user_id=self.owner.id,
                enabled=False,
            )
        self.assertEqual(ctx.exception.err_code, DEFAULT_AGENT_SKILL_LOCKED_CODE)

    def test_list_links_heals_disabled_locked_and_marks_locked(self):
        from apps.skills.models import UserSkillPreference

        UserSkillPreference.objects.create(
            user_id=self.owner.id,
            skill_canonical_key=self.platform_key,
            enabled=False,
        )
        link = AgentSkillLink.objects.get(
            agent_id=self.default_agent.id,
            skill_canonical_key=self.platform_key,
        )
        link.enabled = False
        link.save(update_fields=["enabled", "updated_at"])

        items = AgentSkillLinkService.list_links(
            self.default_agent,
            requesting_user_id=self.owner.id,
        )
        by_key = {item["skill_canonical_key"]: item for item in items}

        self.assertTrue(by_key[self.platform_key]["locked"])
        self.assertTrue(by_key[self.platform_key]["enabled"])
        self.assertTrue(by_key[self.platform_key]["user_enabled"])
        self.assertTrue(by_key[self.app_key]["locked"])
        self.assertFalse(by_key[self.user_key]["locked"])

        link.refresh_from_db()
        self.assertTrue(link.enabled)

    def test_need_repair_true_when_missing_key_despite_orphan_equal_count(self):
        """缺新期望 key + 多一个孤儿时仍需 repair（不能只比数量）。"""
        from apps.skills.services import default_agent_skill_seed as seed_mod

        orphan_key = "platform:orphan-legacy"
        AgentSkillLink.objects.create(
            agent_id=self.default_agent.id,
            skill_canonical_key=orphan_key,
            source="platform",
            enabled=True,
        )
        # 已有 platform + app + orphan = 3；期望也是 3，但缺 collect-to-table
        expected = [
            self.platform_key,
            self.app_key,
            "app:tabdata/collect-to-table",
        ]
        with patch.object(
            seed_mod,
            "_expected_default_skill_keys",
            return_value=expected,
        ):
            self.assertTrue(default_agent_skills_need_repair(self.default_agent))

        # 期望全集都在（多出孤儿不影响）→ 不需要 repair
        with patch.object(
            seed_mod,
            "_expected_default_skill_keys",
            return_value=[self.platform_key, self.app_key],
        ):
            self.assertFalse(default_agent_skills_need_repair(self.default_agent))

    def test_dirty_source_still_locks_by_canonical_key_prefix(self):
        """source 脏数据时仍按 key 前缀锁定（与 Writer 写路径同口径）。"""
        dirty_key = "platform:dirty-source-skill"
        AgentSkillLink.objects.create(
            agent_id=self.default_agent.id,
            skill_canonical_key=dirty_key,
            source="user",  # 脏：key 是 platform，source 误写成 user
            enabled=False,
        )

        self.assertTrue(
            AgentSkillLinkWriter.is_default_agent_locked_skill(
                skill_canonical_key=dirty_key,
                source="user",
            )
        )
        self.assertTrue(default_agent_skills_need_repair(self.default_agent))

        items = AgentSkillLinkService.list_links(
            self.default_agent,
            requesting_user_id=self.owner.id,
        )
        by_key = {item["skill_canonical_key"]: item for item in items}
        self.assertTrue(by_key[dirty_key]["locked"])
        self.assertTrue(by_key[dirty_key]["enabled"])

        dirty = AgentSkillLink.objects.get(
            agent_id=self.default_agent.id,
            skill_canonical_key=dirty_key,
        )
        self.assertTrue(dirty.enabled)

        from apps.skills.services.registry_service import SkillsRegistryService

        state = SkillsRegistryService.resolve_agent_skill_state(
            agent_id=str(self.default_agent.id),
            user_id=str(self.owner.id),
        )
        self.assertTrue(state[dirty_key]["enabled"])

        with self.assertRaises(WriterSkillLockedError):
            AgentSkillLinkWriter.merge_config(
                agent_id=self.default_agent.id,
                skill_canonical_key=dirty_key,
                requesting_user_id=self.owner.id,
                enabled=False,
            )

    def test_resolve_state_ignores_user_gate_for_locked_default_skills(self):
        from apps.skills.models import UserSkillPreference
        from apps.skills.services.registry_service import SkillsRegistryService

        UserSkillPreference.objects.create(
            user_id=self.owner.id,
            skill_canonical_key=self.platform_key,
            enabled=False,
        )
        link = AgentSkillLink.objects.get(
            agent_id=self.default_agent.id,
            skill_canonical_key=self.platform_key,
        )
        link.enabled = False
        link.save(update_fields=["enabled", "updated_at"])

        state = SkillsRegistryService.resolve_agent_skill_state(
            agent_id=str(self.default_agent.id),
            user_id=str(self.owner.id),
        )
        self.assertTrue(state[self.platform_key]["enabled"])
        self.assertTrue(state[self.platform_key]["agent_enabled"])
        self.assertTrue(state[self.platform_key]["user_enabled"])

        # 非默认 Agent 仍受总闸约束
        custom_state = SkillsRegistryService.resolve_agent_skill_state(
            agent_id=str(self.custom_agent.id),
            user_id=str(self.owner.id),
        )
        self.assertFalse(custom_state[self.platform_key]["enabled"])

    def test_agent_api_patch_and_delete_return_locked_code(self):
        patched = self.client.patch(
            f"/api/agents/{self.default_agent.id}/skills/{self.platform_key}",
            data={"enabled": False},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(patched.status_code, 400)
        self.assertEqual(patched.json()["code"], DEFAULT_AGENT_SKILL_LOCKED_CODE)

        deleted = self.client.delete(
            f"/api/agents/{self.default_agent.id}/skills/{self.app_key}",
            **self.auth,
        )
        self.assertEqual(deleted.status_code, 400)
        self.assertEqual(deleted.json()["code"], DEFAULT_AGENT_SKILL_LOCKED_CODE)

        self.assertTrue(
            AgentSkillLink.objects.filter(
                agent_id=self.default_agent.id,
                skill_canonical_key=self.app_key,
            ).exists()
        )

    def test_skills_config_api_returns_locked_code(self):
        request = SimpleNamespace(auth=self.owner)
        with patch("apps.skills.api._check_organization_member", return_value=True):
            response = update_skill_config(
                request,
                self.platform_key,
                SkillConfigUpdateRequest(
                    organization_id=str(self.organization.id),
                    agent_id=str(self.default_agent.id),
                    enabled=False,
                ),
            )
        self.assertEqual(response.status_code, 400)
        payload = json.loads(response.content)
        self.assertEqual(payload["code"], DEFAULT_AGENT_SKILL_LOCKED_CODE)

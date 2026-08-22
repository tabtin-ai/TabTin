"""#7219：默认 Agent 自动携带 platform + 已装 App skill。"""

from __future__ import annotations

import inspect
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, TestCase

from apps.agent.models import Agent
from apps.skills.models import AgentSkillLink, UserSkillPreference
from apps.skills.services.agent_link_service import AgentSkillLinkService
from apps.skills.services.agent_link_writer import AgentSkillLinkWriter
from apps.skills.services.default_agent_skill_seed import (
    attach_app_skills_to_org_default_agents,
    is_default_skill_baseline_agent,
    iter_app_skill_keys,
    iter_platform_skill_keys,
    run_default_agent_skill_seed_safe,
    seed_default_agent_skills,
)
from apps.skills.services.registry_service import SOURCE_PLATFORM
from apps.tabtinspace.models import Organization
from apps.tabtinspace.services.onboarding_defaults import (
    LEGACY_SPACE_EXECUTION_AGENT_NAME,
)
from apps.users.auth.models import User


class IterSkillKeysTests(SimpleTestCase):
    @patch(
        "apps.skills.services.registry_service.SkillsRegistryService.list_platform_skills",
        return_value=[
            {"skill_key": "platform:foo"},
            {"skill_key": "platform:bar"},
            {"skill_key": ""},
        ],
    )
    def test_iter_platform_skill_keys(self, _mock):
        self.assertEqual(
            iter_platform_skill_keys(),
            ["platform:foo", "platform:bar"],
        )

    @patch(
        "apps.skills.services.registry_service.SkillsRegistryService.list_app_skills",
        return_value=[
            {"skill_key": "app:tabdoc/op", "app_id": "tabdoc"},
            {"skill_key": "app:tabdata/op", "app_id": "tabdata"},
            {"skill_key": "app:other/op", "app_id": "other"},
        ],
    )
    def test_iter_app_skill_keys_filters_installed(self, _mock):
        self.assertEqual(
            iter_app_skill_keys(app_ids={"tabdoc", "tabdata"}),
            ["app:tabdoc/op", "app:tabdata/op"],
        )

    @patch(
        "apps.skills.services.registry_service.SkillsRegistryService.list_app_skills",
        return_value=[
            {"skill_key": "app:tabdoc/op", "app_id": "tabdoc", "distribution": "builtin"},
            {
                "skill_key": "app:tabtin-writing-tools-pack/humanizer-zh",
                "app_id": "tabtin-writing-tools-pack",
                "distribution": "marketplace",
            },
            {"skill_key": "app:legacy/op", "app_id": "legacy"},
        ],
    )
    def test_iter_app_skill_keys_excludes_marketplace_by_default(self, _mock):
        self.assertEqual(
            iter_app_skill_keys(app_ids={
                "tabdoc",
                "tabtin-writing-tools-pack",
                "legacy",
            }),
            ["app:tabdoc/op", "app:legacy/op"],
        )
        self.assertEqual(
            iter_app_skill_keys(
                app_ids={"tabtin-writing-tools-pack"},
                include_marketplace=True,
            ),
            ["app:tabtin-writing-tools-pack/humanizer-zh"],
        )


class SeedDefaultAgentSkillsTests(SimpleTestCase):
    def test_legacy_space_execution_agent_is_default_skill_baseline(self):
        agent = SimpleNamespace(
            name=LEGACY_SPACE_EXECUTION_AGENT_NAME,
            type="bot",
            template_id="",
            is_default=False,
        )
        self.assertTrue(is_default_skill_baseline_agent(agent))

    def test_custom_bot_is_not_default_skill_baseline(self):
        agent = SimpleNamespace(
            name="自建分身",
            type="bot",
            template_id="",
            is_default=False,
        )
        self.assertFalse(is_default_skill_baseline_agent(agent))

    @patch("apps.skills.services.default_agent_skill_seed.AgentSkillLinkWriter.attach")
    @patch(
        "apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService.get_installed_app_ids",
        return_value={"tabdoc"},
    )
    @patch(
        "apps.skills.services.registry_service.SkillsRegistryService.list_app_skills",
        return_value=[
            {"skill_key": "app:tabdoc/op", "app_id": "tabdoc"},
            {"skill_key": "app:tabdata/op", "app_id": "tabdata"},
        ],
    )
    @patch(
        "apps.skills.services.registry_service.SkillsRegistryService.list_platform_skills",
        return_value=[{"skill_key": "platform:memory"}],
    )
    def test_seed_attaches_platform_and_installed_app_only(
        self,
        _platform,
        _app,
        _installed,
        mock_attach,
    ):
        agent_id = uuid.uuid4()
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        agent = SimpleNamespace(
            id=agent_id,
            organization_id=org_id,
            is_default=True,
            owner_user_id=user_id,
        )
        user = SimpleNamespace(id=user_id)

        result = seed_default_agent_skills(agent, user)

        self.assertEqual(result["attached"], 2)
        self.assertEqual(result["skipped"], 0)
        keys = {c.kwargs["skill_canonical_key"] for c in mock_attach.call_args_list}
        self.assertEqual(keys, {"platform:memory", "app:tabdoc/op"})
        for call in mock_attach.call_args_list:
            self.assertEqual(call.kwargs["agent_id"], agent_id)
            self.assertEqual(call.kwargs["organization_id"], org_id)
            self.assertEqual(call.kwargs["requesting_user_id"], user_id)
            self.assertIsNone(call.kwargs["sync_space_id"])

    @patch("apps.skills.services.default_agent_skill_seed.AgentSkillLinkWriter.attach")
    @patch(
        "apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService.get_installed_app_ids",
        return_value={"tabdoc"},
    )
    @patch(
        "apps.skills.services.registry_service.SkillsRegistryService.list_app_skills",
        return_value=[{"skill_key": "app:tabdoc/op", "app_id": "tabdoc"}],
    )
    @patch(
        "apps.skills.services.registry_service.SkillsRegistryService.list_platform_skills",
        return_value=[{"skill_key": "platform:memory"}],
    )
    def test_seed_attaches_legacy_space_execution_agent(
        self,
        _platform,
        _app,
        _installed,
        mock_attach,
    ):
        agent_id = uuid.uuid4()
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        agent = SimpleNamespace(
            id=agent_id,
            organization_id=org_id,
            is_default=False,
            name="默认 Space 执行身份",
            type="bot",
            template_id="",
            owner_user_id=user_id,
        )

        result = seed_default_agent_skills(agent, SimpleNamespace(id=user_id))

        self.assertEqual(result["attached"], 2)
        keys = {c.kwargs["skill_canonical_key"] for c in mock_attach.call_args_list}
        self.assertEqual(keys, {"platform:memory", "app:tabdoc/op"})

    def test_seed_skips_non_default_agent(self):
        agent = SimpleNamespace(
            id=uuid.uuid4(),
            is_default=False,
            name="自建分身",
            type="bot",
            template_id="",
        )
        result = seed_default_agent_skills(agent, SimpleNamespace(id=uuid.uuid4()))
        self.assertEqual(result["errors"], ["not_default_skill_baseline_agent"])

    def test_legacy_space_execution_agent_platform_skill_is_locked(self):
        agent = SimpleNamespace(
            name=LEGACY_SPACE_EXECUTION_AGENT_NAME,
            type="bot",
            template_id="",
            is_default=False,
        )

        self.assertTrue(
            AgentSkillLinkWriter.is_agent_skill_locked(
                agent=agent,
                skill_canonical_key="platform:memory",
                source=SOURCE_PLATFORM,
            )
        )


class LegacyDefaultAgentEnablementTests(TestCase):
    def test_legacy_space_execution_agent_locked_skill_ignores_user_gate(self):
        token = uuid.uuid4().hex[:10]
        owner = User.objects.create_user(
            email=f"legacy-default-{token}@example.com",
            password="test-password",
        )
        organization = Organization.objects.create(
            name=f"Legacy Default {token}",
            owner=owner,
        )
        agent = Agent.objects.create(
            organization=organization,
            owner_user=owner,
            name=LEGACY_SPACE_EXECUTION_AGENT_NAME,
            type="bot",
            template_id="",
            is_default=False,
        )
        AgentSkillLink.objects.create(
            agent=agent,
            skill_canonical_key="platform:memory",
            source=SOURCE_PLATFORM,
            enabled=False,
        )
        UserSkillPreference.objects.create(
            user_id=owner.id,
            skill_canonical_key="platform:memory",
            enabled=False,
        )

        with patch(
            "apps.skills.services.default_agent_skill_seed.repair_default_agent_skills_if_needed",
            return_value={"attached": 0, "skipped": 0, "errors": [], "repaired": False},
        ):
            links = AgentSkillLinkService.list_links(
                agent,
                requesting_user_id=owner.id,
            )

        self.assertEqual(len(links), 1)
        self.assertTrue(links[0]["locked"])
        self.assertTrue(links[0]["agent_enabled"])
        self.assertTrue(links[0]["user_enabled"])
        self.assertTrue(links[0]["enabled"])
        self.assertTrue(
            AgentSkillLink.objects.get(
                agent=agent,
                skill_canonical_key="platform:memory",
            ).enabled
        )


class AttachAppSkillsToDefaultsTests(SimpleTestCase):
    @patch("apps.skills.services.default_agent_skill_seed.AgentSkillLinkWriter.attach")
    @patch(
        "apps.skills.services.registry_service.SkillsRegistryService.list_app_skills",
        return_value=[
            {"skill_key": "app:lark/mail", "app_id": "lark"},
            {"skill_key": "app:tabdoc/op", "app_id": "tabdoc"},
        ],
    )
    @patch("apps.agent.models.Agent.objects.filter")
    def test_attach_only_target_app_to_all_default_agents(
        self,
        mock_filter,
        _apps,
        mock_attach,
    ):
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        a1 = SimpleNamespace(
            id=uuid.uuid4(),
            organization_id=org_id,
            owner_user_id=user_id,
            is_default=True,
        )
        a2 = SimpleNamespace(
            id=uuid.uuid4(),
            organization_id=org_id,
            owner_user_id=uuid.uuid4(),
            is_default=True,
        )
        base_qs = MagicMock()
        baseline_qs = MagicMock()
        baseline_qs.only.return_value = [a1, a2]
        base_qs.filter.return_value = baseline_qs
        mock_filter.return_value = base_qs

        result = attach_app_skills_to_org_default_agents(
            organization_id=org_id,
            app_id="lark",
            user=SimpleNamespace(id=user_id),
        )

        self.assertEqual(result["agents"], 2)
        self.assertEqual(result["attached"], 2)
        self.assertEqual(result["skill_keys"], ["app:lark/mail"])
        agent_ids = {c.kwargs["agent_id"] for c in mock_attach.call_args_list}
        self.assertEqual(agent_ids, {a1.id, a2.id})
        for call in mock_attach.call_args_list:
            self.assertEqual(call.kwargs["skill_canonical_key"], "app:lark/mail")


class RunSafeTests(SimpleTestCase):
    def test_run_safe_returns_action_result(self):
        self.assertEqual(
            run_default_agent_skill_seed_safe(lambda: {"ok": 1}, event="t"),
            {"ok": 1},
        )

    def test_run_safe_swallows_exception(self):
        def boom():
            raise RuntimeError("seed boom")

        self.assertIsNone(
            run_default_agent_skill_seed_safe(
                boom,
                event="default_agent_skill_seed.test",
                agent="x",
            )
        )


class WiringGuardTests(SimpleTestCase):
    """轻量接线守卫：install_app / ensure_default 路径别被静默拆掉。"""

    # install_app 进入 atomic 时会 ensure_connection；声明后允许探测连接。
    databases = {"default"}

    @patch(
        "apps.skills.services.default_agent_skill_seed.attach_app_skills_to_org_default_agents",
        return_value={"agents": 1, "attached": 1},
    )
    @patch(
        "apps.tabtinspace.services.app_catalog_service.OrganizationAppInstall.objects.update_or_create",
    )
    @patch(
        "apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._invalidate_cache",
    )
    @patch(
        "apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._build_install_metadata",
        return_value={},
    )
    @patch(
        "apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._get_user_id",
        return_value=uuid.uuid4(),
    )
    @patch(
        "apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._is_organization_admin",
        return_value=True,
    )
    @patch(
        "apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._get_tinapp_or_raise",
    )
    def test_install_app_wires_attach(
        self,
        mock_app_def,
        _admin,
        _uid,
        _meta,
        _cache,
        mock_upsert,
        mock_attach,
    ):
        from apps.tabtinspace.services.app_catalog_service import (
            OrganizationAppCatalogService,
        )

        org_id = uuid.uuid4()
        user = SimpleNamespace(id=uuid.uuid4())
        mock_app_def.return_value = SimpleNamespace(
            install_scope="organization",
            id="cowart",
        )
        mock_upsert.return_value = (
            SimpleNamespace(id=uuid.uuid4(), app_id="cowart"),
            True,
        )

        OrganizationAppCatalogService.install_app(org_id, "cowart", user=user)

        mock_attach.assert_called_once()
        self.assertEqual(mock_attach.call_args.kwargs["organization_id"], org_id)
        self.assertEqual(mock_attach.call_args.kwargs["app_id"], "cowart")
        self.assertEqual(mock_attach.call_args.kwargs["user"], user)

    def test_ensure_default_seeds_create_resurrect_and_active_repair(self):
        """#7456 / ：创建 / 复活 / 活跃纠偏灌 skill；不再 promote 迁移 bot。"""
        from apps.tabtinspace.services.agent_service import AgentService

        src = inspect.getsource(AgentService.ensure_default_agent)
        self.assertIn("default_agent_skill_seed.ensure_create", src)
        self.assertIn("default_agent_skill_seed.ensure_resurrect", src)
        self.assertIn("default_agent_skill_seed.ensure_active", src)
        self.assertIn("repair_default_agent_skills_if_needed", src)
        self.assertIn("seed_default_agent_skills", src)
        self.assertIn("run_default_agent_skill_seed_safe", src)
        # ：禁止再把 Space 迁移分身提升为默认
        self.assertNotIn("default_agent_skill_seed.ensure_promote", src)
        self.assertNotIn("oldest_active.is_default = True", src)
        self.assertIn("_demote_non_system_default_agents", src)

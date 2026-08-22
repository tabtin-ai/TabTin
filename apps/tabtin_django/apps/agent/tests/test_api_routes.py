"""Agent 身份正典路由与限时 legacy alias 回归。"""

from datetime import timedelta
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.models.signals import post_save
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.agent.models import Agent
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.services.onboarding_defaults import (
    AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY,
    DEFAULT_ONBOARDING_AGENT_NAME,
    STARTER_AGENT_ROSTER_VERSION,
    build_system_default_agent_settings,
)
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token


User = get_user_model()


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class AgentApiRouteCompatibilityTests(TestCase):
    databases = {"default"}

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
            username=f"agent-route-{suffix}",
            email=f"agent-route-{suffix}@tabtin.test",
            password="TabTinTest#2026",
        )
        self.organization = Organization.objects.create(
            name=f"Agent Route {suffix}",
            owner=self.user,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role="owner",
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="Route Agent",
            type="bot",
        )
        session_key = f"agent-route-{uuid4().hex}"
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(session_key),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="agent-route-test",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=1),
            is_active=True,
        )
        token = generate_jwt_token(
            self.user,
            expire_hours=1,
            token_type="access",
            session_key=session_key,
        )
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    @staticmethod
    def _data(response):
        payload = response.json()
        return payload.get("data", payload)

    def test_legacy_detail_matches_canonical_and_announces_sunset(self):
        canonical = self.client.get(
            f"/api/agents/{self.agent.id}",
            **self.auth,
        )
        legacy = self.client.get(
            f"/api/context/agents/{self.agent.id}",
            **self.auth,
        )

        self.assertEqual(canonical.status_code, 200)
        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(self._data(legacy), self._data(canonical))
        self.assertEqual(legacy.headers["Deprecation"], "true")
        self.assertIn("/api/agents", legacy.headers["Link"])
        self.assertIn("2026", legacy.headers["Sunset"])

    def test_legacy_organization_list_matches_canonical_query(self):
        canonical = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )
        legacy = self.client.get(
            f"/api/context/organizations/{self.organization.id}/agents",
            **self.auth,
        )

        self.assertEqual(canonical.status_code, 200)
        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(self._data(legacy), self._data(canonical))

    def test_legacy_update_delegates_to_canonical_handler(self):
        response = self.client.put(
            f"/api/context/agents/{self.agent.id}",
            data={"name": "Renamed Agent"},
            content_type="application/json",
            **self.auth,
        )

        self.assertEqual(response.status_code, 200)
        self.agent.refresh_from_db()
        self.assertEqual(self.agent.name, "Renamed Agent")

    def test_legacy_create_preserves_canonical_201_status(self):
        response = self.client.post(
            "/api/context/agents",
            data={
                "organization_id": str(self.organization.id),
                "name": "Legacy Created Agent",
                "type": "bot",
            },
            content_type="application/json",
            **self.auth,
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.headers["Deprecation"], "true")
        self.assertTrue(
            Agent.objects.filter(
                organization=self.organization,
                owner_user=self.user,
                name="Legacy Created Agent",
            ).exists()
        )

    def test_template_list_and_instantiation_use_canonical_agent_api(self):
        templates = self.client.get("/api/agents/templates", **self.auth)
        self.assertEqual(templates.status_code, 200)
        template_items = self._data(templates)["templates"]
        self.assertIn(
            "general-assistant",
            {item["id"] for item in template_items},
        )
        general_template = next(
            item for item in template_items
            if item["id"] == "general-assistant"
        )
        self.assertEqual(
            general_template["avatar_key"],
            "general-assistant",
        )

        created = self.client.post(
            "/api/agents",
            data={
                "organization_id": str(self.organization.id),
                "template_id": "general-assistant",
            },
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(created.status_code, 201)
        created_data = self._data(created)
        self.assertEqual(created_data["template_id"], "general-assistant")
        self.assertTrue(created_data["template_version"])
        self.assertEqual(
            created_data["settings"]["avatar_key"],
            "general-assistant",
        )
        self.assertEqual(created_data["name"], "小Tin 日常版")
        self.assertEqual(created_data["display_name"], "小Tin 日常版")
        self.assertEqual(
            created_data["custom_rules"],
            "处理通用任务时先理解目标，再直接推进；遇到明显的专项任务，可以建议交给对应分身。",
        )
        self.assertNotIn("{owner}", created_data["display_name"])

    def test_custom_agent_can_choose_bundled_avatar_key(self):
        created = self.client.post(
            "/api/agents",
            data={
                "organization_id": str(self.organization.id),
                "name": "Custom Researcher",
                "avatar_key": "web-researcher",
            },
            content_type="application/json",
            **self.auth,
        )

        self.assertEqual(created.status_code, 201)
        created_data = self._data(created)
        self.assertEqual(created_data["template_id"], "")
        self.assertEqual(
            created_data["settings"]["avatar_key"],
            "web-researcher",
        )

    def test_custom_agent_can_choose_additive_function_avatar_key(self):
        created = self.client.post(
            "/api/agents",
            data={
                "organization_id": str(self.organization.id),
                "name": "Function Researcher",
                "avatar_key": "function-web-researcher",
            },
            content_type="application/json",
            **self.auth,
        )

        self.assertEqual(created.status_code, 201)
        created_data = self._data(created)
        self.assertEqual(
            created_data["settings"]["avatar_key"],
            "function-web-researcher",
        )

    def test_custom_agent_rejects_unknown_avatar_key(self):
        response = self.client.post(
            "/api/agents",
            data={
                "organization_id": str(self.organization.id),
                "name": "Invalid Avatar",
                "avatar_key": "not-a-real-avatar",
            },
            content_type="application/json",
            **self.auth,
        )

        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertEqual(
            payload.get("code") or payload.get("error_code"),
            "AGENT_AVATAR_INVALID",
        )

    def test_legacy_templates_list_matches_canonical_and_announces_sunset(self):
        """Electron 仍打 /context/agents/templates；不得被 {agent_id} 当成 UUID。"""
        canonical = self.client.get("/api/agents/templates", **self.auth)
        legacy = self.client.get("/api/context/agents/templates", **self.auth)

        self.assertEqual(canonical.status_code, 200)
        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(self._data(legacy), self._data(canonical))
        self.assertIn(
            "general-assistant",
            {item["id"] for item in self._data(legacy)["templates"]},
        )
        self.assertEqual(legacy.headers["Deprecation"], "true")
        self.assertIn("/api/agents", legacy.headers["Link"])
        self.assertIn("2026", legacy.headers["Sunset"])

    def test_agent_skill_link_crud(self):
        attached = self.client.post(
            f"/api/agents/{self.agent.id}/skills",
            data={"skill_canonical_key": "platform:files/generation"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(attached.status_code, 200)
        self.assertTrue(self._data(attached)["enabled"])

        listed = self.client.get(
            f"/api/agents/{self.agent.id}/skills",
            **self.auth,
        )
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(self._data(listed)["total"], 1)

        updated = self.client.patch(
            f"/api/agents/{self.agent.id}/skills/platform:files/generation",
            data={"enabled": False, "config_json": {"tone": "concise"}},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(updated.status_code, 200)
        self.assertFalse(self._data(updated)["enabled"])

        detached = self.client.delete(
            f"/api/agents/{self.agent.id}/skills/platform:files/generation",
            **self.auth,
        )
        self.assertEqual(detached.status_code, 200)
        self.assertTrue(self._data(detached)["found"])

    def test_list_organization_agents_query_count_is_constant(self):
        """#6337: 列表不应逐行调 resolve_personal_rules_by_owner_id 形成 N+1。"""
        # 预置系统默认，让列表走纯读快路径；否则首次 GET 会补建小Tin，total 变成 2。
        Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_default=True,
            settings=build_system_default_agent_settings(
                {
                    AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY:
                        STARTER_AGENT_ROSTER_VERSION,
                }
            ),
        )

        with CaptureQueriesContext(connection) as ctx_before:
            baseline = self.client.get(
                f"/api/agents?organization_id={self.organization.id}",
                **self.auth,
            )
        self.assertEqual(baseline.status_code, 200)
        self.assertEqual(self._data(baseline)["total"], 2)

        for i in range(9):
            Agent.objects.create(
                organization=self.organization,
                owner_user=self.user,
                name=f"Bulk Agent {i}",
                type="bot",
            )

        with CaptureQueriesContext(connection) as ctx_after:
            grown = self.client.get(
                f"/api/agents?organization_id={self.organization.id}",
                **self.auth,
            )
        self.assertEqual(grown.status_code, 200)
        self.assertEqual(self._data(grown)["total"], 11)

        self.assertEqual(
            len(ctx_before.captured_queries),
            len(ctx_after.captured_queries),
            "Agent 列表查询数应与 Agent 数量无关（N+1 回归）："
            f"{len(ctx_before.captured_queries)} vs {len(ctx_after.captured_queries)}",
        )

    def test_list_organization_agents_summary_omits_detail_only_fields(self):
        """列表摘要不含 personal_rules / agent_config；保留 custom_rules 给人设副行。"""
        self.agent.custom_rules = "用你好开头说话"
        self.agent.save(update_fields=["custom_rules", "updated_at"])
        response = self.client.get(
            f"/api/agents?organization_id={self.organization.id}",
            **self.auth,
        )
        self.assertEqual(response.status_code, 200)
        item = self._data(response)["agents"][0]
        self.assertNotIn("personal_rules", item)
        self.assertNotIn("agent_config", item)
        self.assertNotIn("suggested_prompts", item)
        self.assertNotIn("preferred_model_id", item)
        self.assertEqual(item["custom_rules"], "用你好开头说话")
        self.assertEqual(item["id"], str(self.agent.id))
        self.assertEqual(item["name"], self.agent.name)

    def test_update_preferred_model_accepts_platform_uuid(self):
        model_id = str(uuid4())
        response = self.client.patch(
            f"/api/agents/{self.agent.id}/preferred-model",
            data={"model_id": model_id},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._data(response)["preferred_model_id"], model_id)
        self.agent.refresh_from_db()
        self.assertEqual(self.agent.preferred_model_id, model_id)

    def test_update_preferred_model_rejects_local_codex_id(self):
        """#7872：本机 Codex id 不得污染 Agent.preferred_model_id。"""
        response = self.client.patch(
            f"/api/agents/{self.agent.id}/preferred-model",
            data={"model_id": "gpt-5.6-sol"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertEqual(payload.get("code") or payload.get("error_code"), "INVALID_PREFERRED_MODEL")
        self.agent.refresh_from_db()
        self.assertEqual(self.agent.preferred_model_id, "")

    def test_update_preferred_model_allows_clear(self):
        self.agent.preferred_model_id = str(uuid4())
        self.agent.save(update_fields=["preferred_model_id", "updated_at"])
        response = self.client.patch(
            f"/api/agents/{self.agent.id}/preferred-model",
            data={"model_id": ""},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(response.status_code, 200)
        self.agent.refresh_from_db()
        self.assertEqual(self.agent.preferred_model_id, "")

    def test_update_agent_avatar_url_set_and_clear(self):
        """#7764: avatar_url 写入 settings；空串清除；未传不动。"""
        set_resp = self.client.put(
            f"/api/agents/{self.agent.id}",
            data={"avatar_url": "https://cdn.example.com/agent-a.png"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(set_resp.status_code, 200)
        self.agent.refresh_from_db()
        self.assertEqual(
            self.agent.settings.get("avatar_url"),
            "https://cdn.example.com/agent-a.png",
        )
        self.assertEqual(
            self._data(set_resp)["settings"].get("avatar_url"),
            "https://cdn.example.com/agent-a.png",
        )

        # 未传 avatar_url 时保留原值
        rename = self.client.put(
            f"/api/agents/{self.agent.id}",
            data={"name": "Still Has Avatar"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(rename.status_code, 200)
        self.agent.refresh_from_db()
        self.assertEqual(self.agent.name, "Still Has Avatar")
        self.assertEqual(
            self.agent.settings.get("avatar_url"),
            "https://cdn.example.com/agent-a.png",
        )

        clear_resp = self.client.put(
            f"/api/agents/{self.agent.id}",
            data={"avatar_url": ""},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(clear_resp.status_code, 200)
        self.agent.refresh_from_db()
        self.assertNotIn("avatar_url", self.agent.settings or {})

        bad = self.client.put(
            f"/api/agents/{self.agent.id}",
            data={"avatar_url": "javascript:alert(1)"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(bad.status_code, 400)

    def test_update_agent_avatar_key_uses_bundled_preset_and_clears_upload(self):
        self.agent.settings = {
            "avatar_key": "general-assistant",
            "avatar_url": "https://cdn.example.com/legacy-upload.png",
        }
        self.agent.save(update_fields=["settings", "updated_at"])

        updated = self.client.put(
            f"/api/agents/{self.agent.id}",
            data={"avatar_key": "function-web-researcher"},
            content_type="application/json",
            **self.auth,
        )

        self.assertEqual(updated.status_code, 200)
        self.agent.refresh_from_db()
        self.assertEqual(
            self.agent.settings.get("avatar_key"),
            "function-web-researcher",
        )
        self.assertNotIn("avatar_url", self.agent.settings)
        self.assertEqual(
            self._data(updated)["settings"].get("avatar_key"),
            "function-web-researcher",
        )

        invalid = self.client.put(
            f"/api/agents/{self.agent.id}",
            data={"avatar_key": "not-a-real-avatar"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(invalid.status_code, 400)
        payload = invalid.json()
        self.assertEqual(
            payload.get("code") or payload.get("error_code"),
            "AGENT_AVATAR_INVALID",
        )

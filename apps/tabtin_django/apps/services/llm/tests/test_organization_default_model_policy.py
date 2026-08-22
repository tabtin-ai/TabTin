from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings

from apps.services.llm.api_common import _serialize_organization_subagent_model_policy
from apps.services.llm.api import get_model_catalog
from apps.services.llm.api_config import (
    can_use_as_organization_default,
    can_use_as_user_default,
    set_organization_subagent_model,
    set_user_default_model,
    set_user_subagent_model,
)
from apps.services.llm.models import LLMModel, LLMProvider
from apps.services.llm.schemas import OrganizationSubagentModelRequest, UserDefaultModelRequest
from apps.users.auth.models import UserProfile

User = get_user_model()


class OrganizationDefaultModelPolicyTests(SimpleTestCase):
    def _organization(self, *, kind: str, owner_id: str = "user-1"):
        return SimpleNamespace(type=kind, owner_id=owner_id, id="org-1")

    def _model(
        self,
        *,
        scope: str,
        provider_user_id: str = "",
        provider_organization_id: str = "",
    ):
        provider = SimpleNamespace(
            scope=scope,
            user_id=provider_user_id or None,
            organization_id=provider_organization_id or None,
            routing_enabled=True,
        )
        return SimpleNamespace(
            provider=provider,
            capability_domain="chat",
            wave_status="ready",
        )

    def test_personal_workspace_accepts_official_and_same_user_byok(self):
        organization = self._organization(kind="personal")

        self.assertTrue(
            can_use_as_organization_default(
                organization,
                self._model(scope="global"),
                actor_user_id="user-1",
            )
        )
        self.assertTrue(
            can_use_as_organization_default(
                organization,
                self._model(scope="user", provider_user_id="user-1"),
                actor_user_id="user-1",
            )
        )
        self.assertFalse(
            can_use_as_organization_default(
                organization,
                self._model(scope="user", provider_user_id="user-2"),
                actor_user_id="user-1",
            )
        )

    def test_team_workspace_accepts_official_and_same_organization_byok(self):
        organization = self._organization(kind="team")

        self.assertTrue(
            can_use_as_organization_default(
                organization,
                self._model(scope="global"),
                actor_user_id="user-1",
            )
        )
        self.assertTrue(
            can_use_as_organization_default(
                organization,
                self._model(
                    scope="organization",
                    provider_organization_id="org-1",
                ),
                actor_user_id="user-1",
            )
        )
        self.assertFalse(
            can_use_as_organization_default(
                organization,
                self._model(scope="user", provider_user_id="user-1"),
                actor_user_id="user-1",
            )
        )
        self.assertFalse(
            can_use_as_organization_default(
                organization,
                self._model(
                    scope="organization",
                    provider_organization_id="org-2",
                ),
                actor_user_id="user-1",
            )
        )

    def test_non_ready_or_non_chat_model_is_rejected(self):
        organization = self._organization(kind="team")
        model = self._model(scope="global")
        model.wave_status = "w2_pending"
        self.assertFalse(
            can_use_as_organization_default(
                organization,
                model,
                actor_user_id="user-1",
            )
        )

    def test_user_default_accepts_personal_byok_inside_team_workspace(self):
        organization = self._organization(kind="team")

        self.assertTrue(
            can_use_as_user_default(
                organization,
                self._model(scope="global"),
                actor_user_id="user-1",
            )
        )
        self.assertTrue(
            can_use_as_user_default(
                organization,
                self._model(
                    scope="organization",
                    provider_organization_id="org-1",
                ),
                actor_user_id="user-1",
            )
        )
        self.assertTrue(
            can_use_as_user_default(
                organization,
                self._model(scope="user", provider_user_id="user-1"),
                actor_user_id="user-1",
            )
        )

    def test_user_default_rejects_other_users_or_other_organizations_byok(self):
        organization = self._organization(kind="team")

        self.assertFalse(
            can_use_as_user_default(
                organization,
                self._model(scope="user", provider_user_id="user-2"),
                actor_user_id="user-1",
            )
        )
        self.assertFalse(
            can_use_as_user_default(
                organization,
                self._model(
                    scope="organization",
                    provider_organization_id="org-2",
                ),
                actor_user_id="user-1",
            )
        )

        model = self._model(scope="global")
        model.wave_status = "ready"
        model.capability_domain = "vision"
        self.assertFalse(
            can_use_as_organization_default(
                organization,
                model,
                actor_user_id="user-1",
            )
        )


class OrganizationSubagentModelPolicyTests(SimpleTestCase):
    def test_missing_setting_projects_to_inherit(self):
        organization = SimpleNamespace(settings={})
        self.assertEqual(
            _serialize_organization_subagent_model_policy(organization),
            {
                "subagent_model_policy": "inherit",
                "subagent_model_id": None,
            },
        )

    def test_fixed_requires_model_id(self):
        with self.assertRaises(ValueError):
            OrganizationSubagentModelRequest(mode="fixed")

    @patch("apps.services.llm.api_config.OrganizationService.broadcast_organization_updated")
    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.api_config.OrganizationService.get_organization")
    def test_inherit_clears_fixed_model_and_broadcasts(
        self,
        get_organization,
        _ensure_permission,
        _invalidate_cache,
        broadcast_updated,
    ):
        organization = SimpleNamespace(
            settings={"llm_subagent_model_id": "model-1"},
            save=lambda **_kwargs: None,
        )
        get_organization.return_value = organization
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))

        response = set_organization_subagent_model(
            request,
            "org-1",
            OrganizationSubagentModelRequest(mode="inherit"),
        )

        self.assertTrue(response["success"])
        self.assertNotIn("llm_subagent_model_id", organization.settings)
        broadcast_updated.assert_called_once_with(organization)

    @patch("apps.services.llm.api_config.OrganizationService.broadcast_organization_updated")
    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.api_config.LLMModel.objects.select_related")
    @patch("apps.services.llm.api_config.OrganizationService.get_organization")
    def test_fixed_saves_accessible_chat_model(
        self,
        get_organization,
        select_related,
        _ensure_permission,
        _invalidate_cache,
        broadcast_updated,
    ):
        organization = SimpleNamespace(
            id="org-1",
            type="team",
            settings={},
            save=lambda **_kwargs: None,
        )
        model = SimpleNamespace(
            id="model-1",
            model_name="model-one",
            capability_domain="chat",
            wave_status="ready",
            provider=SimpleNamespace(
                scope="global",
                routing_enabled=True,
                user_id=None,
                organization_id=None,
            ),
        )
        get_organization.return_value = organization
        select_related.return_value.get.return_value = model
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))

        response = set_organization_subagent_model(
            request,
            "org-1",
            OrganizationSubagentModelRequest(mode="fixed", model_id="model-1"),
        )

        self.assertTrue(response["success"])
        self.assertEqual(organization.settings["llm_subagent_model_id"], "model-1")
        broadcast_updated.assert_called_once_with(organization)


class UserSubagentModelPolicyTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="user_subagent_model",
            email="user_subagent_model@example.com",
            password="pass",
        )
        self.organization = SimpleNamespace(id="org-1", type="team")
        self.request = SimpleNamespace(auth=self.user)
        self.provider = LLMProvider.objects.create(
            name="openai",
            provider_key="user-subagent-openai",
            display_name="OpenAI",
            scope="global",
            routing_enabled=True,
            capability_domains=["chat"],
        )
        self.model = LLMModel.objects.create(
            provider=self.provider,
            model_name="user-subagent-model",
            display_name="User Subagent Model",
            capability_domain="chat",
            wave_status="ready",
            context_window_tokens=8192,
        )

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.api_config.OrganizationService.get_organization")
    def test_user_subagent_fixed_saves_to_profile(
        self,
        get_organization,
        _ensure_permission,
        _invalidate_cache,
    ):
        get_organization.return_value = self.organization

        response = set_user_subagent_model(
            self.request,
            "org-1",
            OrganizationSubagentModelRequest(mode="fixed", model_id=str(self.model.id)),
        )

        self.assertTrue(response["success"])
        profile = UserProfile.objects.get(user=self.user)
        self.assertEqual(
            profile.ui_settings["llm_model_preferences"]["org-1"]["subagent_model_id"],
            str(self.model.id),
        )

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.api_config.OrganizationService.get_organization")
    def test_user_subagent_inherit_clears_profile_override(
        self,
        get_organization,
        _ensure_permission,
        _invalidate_cache,
    ):
        get_organization.return_value = self.organization
        set_user_subagent_model(
            self.request,
            "org-1",
            OrganizationSubagentModelRequest(mode="fixed", model_id=str(self.model.id)),
        )

        response = set_user_subagent_model(
            self.request,
            "org-1",
            OrganizationSubagentModelRequest(mode="inherit"),
        )

        self.assertTrue(response["success"])
        profile = UserProfile.objects.get(user=self.user)
        self.assertNotIn("llm_model_preferences", profile.ui_settings)

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.api_config.OrganizationService.get_organization")
    def test_user_subagent_inherit_main_persists_policy(
        self,
        get_organization,
        _ensure_permission,
        _invalidate_cache,
    ):
        get_organization.return_value = self.organization

        response = set_user_subagent_model(
            self.request,
            "org-1",
            OrganizationSubagentModelRequest(mode="inherit_main"),
        )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["user_subagent_model_policy"], "inherit_main")
        profile = UserProfile.objects.get(user=self.user)
        preferences = profile.ui_settings["llm_model_preferences"]["org-1"]
        self.assertEqual(preferences["subagent_model_policy"], "inherit_main")
        self.assertNotIn("subagent_model_id", preferences)

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.api_config.OrganizationService.get_organization")
    def test_user_default_empty_model_id_clears_profile_override(
        self,
        get_organization,
        _ensure_permission,
        _invalidate_cache,
    ):
        get_organization.return_value = self.organization
        set_user_default_model(
            self.request,
            "org-1",
            UserDefaultModelRequest(model_id=str(self.model.id)),
        )

        response = set_user_default_model(
            self.request,
            "org-1",
            UserDefaultModelRequest(model_id=None),
        )

        self.assertTrue(response["success"])
        profile = UserProfile.objects.get(user=self.user)
        self.assertNotIn("llm_model_preferences", profile.ui_settings)


class ModelCatalogSubagentPolicyTests(SimpleTestCase):
    def _model(self, model_id: str, name: str):
        return {
            "id": model_id,
            "name": name,
            "display_name": name,
            "provider": "openai",
            "provider_display_name": "OpenAI",
            "provider_scope": "global",
            "capability_domain": "chat",
            "billing_type": "free",
            "cost_per_1k_tokens": 0,
            "is_user_config": False,
            "wave_status": "ready",
        }

    @patch("apps.services.llm.api._get_platform_capabilities", return_value={})
    @patch("apps.services.llm.api._get_providers_metadata", return_value=[])
    @patch("apps.services.llm.api._resolve_default_model", return_value=None)
    @patch("apps.services.llm.api._read_user_subagent_model_policy", return_value="inherit")
    @patch("apps.services.llm.api._read_user_subagent_model_id", return_value="user-model")
    @patch("apps.services.llm.api._get_organization_subagent_model_policy")
    @patch("apps.services.llm.api._filter_models_by_member_policy")
    @patch("apps.services.llm.api.get_available_models")
    @patch("apps.services.llm.api._ensure_organization_permission")
    @patch("apps.services.llm.api._ensure_self_user_id", return_value="user-1")
    @override_settings(PROVIDER_CREDIT_UI_ENABLED=False)
    def test_catalog_effective_subagent_policy_prefers_user_override(
        self,
        _ensure_self,
        _ensure_permission,
        get_available_models,
        filter_models,
        get_organization_policy,
        _read_user_subagent,
        _read_user_subagent_policy,
        _resolve_default,
        _providers,
        _capabilities,
    ):
        models = [
            self._model("team-model", "Team Model"),
            self._model("user-model", "User Model"),
        ]
        get_available_models.return_value = models
        filter_models.return_value = models
        get_organization_policy.return_value = {
            "subagent_model_policy": "fixed",
            "subagent_model_id": "team-model",
        }
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))

        response = get_model_catalog.__wrapped__(
            request,
            organization_id="org-1",
            use_case="chat",
        )

        self.assertTrue(response["success"])
        data = response["data"]
        self.assertEqual(data["subagent_model_policy"], "fixed")
        self.assertEqual(data["subagent_model_id"], "user-model")
        self.assertEqual(data["organization_subagent_model_id"], "team-model")
        self.assertEqual(data["user_subagent_model_id"], "user-model")

    @patch("apps.services.llm.api._get_platform_capabilities", return_value={})
    @patch("apps.services.llm.api._get_providers_metadata", return_value=[])
    @patch("apps.services.llm.api._resolve_default_model", return_value=None)
    @patch("apps.services.llm.api._read_user_subagent_model_policy", return_value="inherit_main")
    @patch("apps.services.llm.api._read_user_subagent_model_id", return_value="")
    @patch("apps.services.llm.api._get_organization_subagent_model_policy")
    @patch("apps.services.llm.api._filter_models_by_member_policy")
    @patch("apps.services.llm.api.get_available_models")
    @patch("apps.services.llm.api._ensure_organization_permission")
    @patch("apps.services.llm.api._ensure_self_user_id", return_value="user-1")
    @override_settings(PROVIDER_CREDIT_UI_ENABLED=False)
    def test_catalog_user_inherit_main_bypasses_team_fixed_subagent_model(
        self,
        _ensure_self,
        _ensure_permission,
        get_available_models,
        filter_models,
        get_organization_policy,
        _read_user_subagent,
        _read_user_subagent_policy,
        _resolve_default,
        _providers,
        _capabilities,
    ):
        models = [self._model("team-model", "Team Model")]
        get_available_models.return_value = models
        filter_models.return_value = models
        get_organization_policy.return_value = {
            "subagent_model_policy": "fixed",
            "subagent_model_id": "team-model",
        }
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))

        response = get_model_catalog.__wrapped__(
            request,
            organization_id="org-1",
            use_case="chat",
        )

        self.assertTrue(response["success"])
        data = response["data"]
        self.assertEqual(data["subagent_model_policy"], "inherit")
        self.assertIsNone(data["subagent_model_id"])
        self.assertEqual(data["organization_subagent_model_id"], "team-model")
        self.assertEqual(data["user_subagent_model_policy"], "inherit_main")
        self.assertIsNone(data["user_subagent_model_id"])

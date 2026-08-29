import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.test import TestCase

from apps.services.llm.api_config import (
    create_organization_model,
    create_organization_provider,
    delete_organization_provider,
    list_organization_providers,
    probe_provider,
    update_organization_model,
    update_organization_provider,
)
from apps.services.llm.models import LLMModel, LLMProvider, LLMProviderKey
from apps.services.llm.schemas import (
    OrganizationModelCreateRequest,
    OrganizationModelUpdateRequest,
    OrganizationProviderCreateRequest,
    OrganizationProviderUpdateRequest,
)
from apps.services.llm.services import get_available_models
from apps.services.llm.services.runtime import probe_provider_health


class OrganizationProviderLifecycleTests(TestCase):
    def setUp(self) -> None:
        self.organization_id = str(uuid4())
        self.user_id = uuid4()
        self.request = SimpleNamespace(auth=SimpleNamespace(id=self.user_id))

    def _response_payload(self, response):
        if isinstance(response, dict):
            return response
        return json.loads(response.content)

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_create_provider_does_not_create_an_implicit_model(
        self,
        _ensure_permission,
        _invalidate_models_cache,
    ) -> None:
        payload = OrganizationProviderCreateRequest(
            provider_name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            base_url="https://api.example.com/v1",
            api_key="",
            scope="organization",
        )

        response = create_organization_provider.__wrapped__(
            self.request,
            self.organization_id,
            payload,
        )

        self.assertTrue(response["success"])
        provider = LLMProvider.objects.get(provider_key="custom-openai")
        self.assertEqual(provider.default_base_url, "https://api.example.com/v1")
        self.assertFalse(LLMModel.objects.filter(provider=provider).exists())

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_create_model_inherits_provider_default_base_url(
        self,
        _ensure_permission,
        _invalidate_models_cache,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            default_base_url="https://api.example.com/v1",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
        )
        payload = OrganizationModelCreateRequest(
            provider_id=str(provider.id),
            model_name="custom-model",
            display_name="Custom Model",
            context_window_tokens=8192,
        )

        response = create_organization_model.__wrapped__(
            self.request,
            self.organization_id,
            payload,
        )

        self.assertTrue(response["success"])
        model = LLMModel.objects.get(provider=provider, model_name="custom-model")
        self.assertEqual(model.base_url, "https://api.example.com/v1")
        self.assertTrue(model.capabilities_config["supports_json_mode"])
        self.assertEqual(
            model.capabilities_config["json_mode"]["modes"],
            ["json_object"],
        )

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_create_kimi_coding_model_persists_authoritative_wire_capability(
        self,
        _ensure_permission,
        _invalidate_models_cache,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="moonshot",
            provider_key="kimi_coding",
            display_name="Kimi For Coding",
            default_base_url="https://api.kimi.com/coding/v1",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
        )
        payload = OrganizationModelCreateRequest(
            provider_id=str(provider.id),
            model_name="kimi-for-coding",
            display_name="Kimi K2.7 Code",
            context_window_tokens=262_144,
            capabilities_config={
                "supports_streaming": True,
                "supports_vision": False,
            },
        )

        response = create_organization_model.__wrapped__(
            self.request,
            self.organization_id,
            payload,
        )

        self.assertTrue(response["success"])
        model = LLMModel.objects.get(provider=provider, model_name="kimi-for-coding")
        wire = model.capabilities_config["wire_adapter"]
        self.assertEqual(
            wire["wire"]["request_protocol"],
            "openai_chat_completions",
        )
        self.assertTrue(wire["tool"]["enabled"])
        self.assertIsNone(wire["reasoning"]["param_path"])

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_update_provider_default_base_url_does_not_overwrite_models(
        self,
        _ensure_permission,
        _invalidate_models_cache,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            default_base_url="https://default.example.com/v1",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="custom-model",
            display_name="Custom Model",
            capability_domain="chat",
            base_url="https://model.example.com/v1",
            context_window_tokens=8192,
        )

        response = update_organization_provider.__wrapped__(
            self.request,
            self.organization_id,
            str(provider.id),
            OrganizationProviderUpdateRequest(base_url="https://new-default.example.com/v1"),
        )

        self.assertTrue(response["success"])
        provider.refresh_from_db()
        model.refresh_from_db()
        self.assertEqual(provider.default_base_url, "https://new-default.example.com/v1")
        self.assertEqual(model.base_url, "https://model.example.com/v1")

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config._clear_organization_subagent_model_id")
    @patch("apps.services.llm.api_config._get_organization_subagent_model_policy")
    @patch("apps.services.llm.api_config._clear_organization_default_model_id")
    @patch("apps.services.llm.api_config._get_organization_default_model_id")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_disabling_provider_clears_default_model_references(
        self,
        _ensure_permission,
        _get_default_model_id,
        _clear_default_model_id,
        _get_subagent_model_policy,
        _clear_subagent_model_id,
        _invalidate_models_cache,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            default_base_url="https://default.example.com/v1",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
            routing_enabled=True,
        )
        default_model = LLMModel.objects.create(
            provider=provider,
            model_name="default-model",
            display_name="Default Model",
            capability_domain="chat",
            base_url="https://api.example.com/v1",
            context_window_tokens=8192,
        )
        subagent_model = LLMModel.objects.create(
            provider=provider,
            model_name="subagent-model",
            display_name="Subagent Model",
            capability_domain="chat",
            base_url="https://api.example.com/v1",
            context_window_tokens=8192,
        )
        _get_default_model_id.return_value = str(default_model.id)
        _get_subagent_model_policy.return_value = {
            "subagent_model_policy": "fixed",
            "subagent_model_id": str(subagent_model.id),
        }

        response = update_organization_provider.__wrapped__(
            self.request,
            self.organization_id,
            str(provider.id),
            OrganizationProviderUpdateRequest(routing_enabled=False),
        )

        self.assertTrue(response["success"])
        provider.refresh_from_db()
        self.assertFalse(provider.routing_enabled)
        _clear_default_model_id.assert_called_once_with(
            self.organization_id,
            str(default_model.id),
        )
        _clear_subagent_model_id.assert_called_once_with(
            self.organization_id,
            str(subagent_model.id),
        )

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_update_model_base_url_is_persisted_and_returned(
        self,
        _ensure_permission,
        _invalidate_models_cache,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            default_base_url="https://openrouter.ai/api/v1",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="custom-model",
            display_name="Custom Model",
            capability_domain="chat",
            base_url="https://openrouter.ai/api/v1",
            context_window_tokens=8192,
        )

        response = update_organization_model(
            self.request,
            self.organization_id,
            str(model.id),
            OrganizationModelUpdateRequest(base_url="https://openrouter.ai/api/v1/beta"),
        )

        self.assertTrue(response["success"])
        model.refresh_from_db()
        self.assertEqual(model.base_url, "https://openrouter.ai/api/v1/beta")
        self.assertTrue(model.capabilities_config["supports_json_mode"])
        self.assertEqual(
            model.capabilities_config["json_mode"]["modes"],
            ["json_object"],
        )
        available = get_available_models(
            user_id=str(self.user_id),
            organization_id=self.organization_id,
            include_inactive=True,
        )
        serialized = next(item for item in available if item["id"] == str(model.id))
        self.assertEqual(serialized["base_url"], "https://openrouter.ai/api/v1/beta")

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config._clear_organization_subagent_model_id")
    @patch("apps.services.llm.api_config._get_organization_subagent_model_policy")
    @patch("apps.services.llm.api_config._clear_organization_default_model_id")
    @patch("apps.services.llm.api_config._get_organization_default_model_id")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_delete_provider_deletes_all_of_its_models(
        self,
        _ensure_permission,
        _get_default_model_id,
        _clear_default_model_id,
        _get_subagent_model_policy,
        _clear_subagent_model_id,
        _invalidate_models_cache,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
        )
        models = [
            LLMModel.objects.create(
                provider=provider,
                model_name=f"model-{index}",
                display_name=f"Model {index}",
                capability_domain="chat",
                base_url="https://api.example.com/v1",
                context_window_tokens=8192,
            )
            for index in range(2)
        ]
        _get_default_model_id.return_value = str(models[0].id)
        _get_subagent_model_policy.return_value = {
            "subagent_model_policy": "fixed",
            "subagent_model_id": str(models[1].id),
        }

        response = delete_organization_provider.__wrapped__(
            self.request,
            self.organization_id,
            str(provider.id),
        )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["deleted_model_count"], 2)
        self.assertFalse(LLMProvider.objects.filter(id=provider.id).exists())
        self.assertFalse(LLMModel.objects.filter(provider_id=provider.id).exists())
        _clear_default_model_id.assert_called_once_with(
            self.organization_id,
            str(models[0].id),
        )
        _clear_subagent_model_id.assert_called_once_with(
            self.organization_id,
            str(models[1].id),
        )
        _invalidate_models_cache.assert_called_once_with(
            organization_id=self.organization_id,
            user_id=str(self.user_id),
        )

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_user_scoped_provider_is_visible_after_organization_switch(
        self,
        _ensure_permission,
        _invalidate_models_cache,
    ) -> None:
        """#7875：个人渠道在组织 A 创建后，组织 B 列表与选模仍可见。"""
        other_organization_id = str(uuid4())
        payload = OrganizationProviderCreateRequest(
            provider_name="openai",
            provider_key="personal-openai",
            display_name="Personal OpenAI",
            base_url="https://relay.example.com/v1",
            api_key="sk-test",
            scope="user",
        )

        create_response = create_organization_provider.__wrapped__(
            self.request,
            self.organization_id,
            payload,
        )
        self.assertTrue(create_response["success"])
        provider = LLMProvider.objects.get(provider_key="personal-openai")
        self.assertEqual(provider.scope, "user")
        self.assertIsNone(provider.organization_id)
        self.assertEqual(provider.user_id, str(self.user_id))

        LLMModel.objects.create(
            provider=provider,
            model_name="personal-model",
            display_name="Personal Model",
            capability_domain="chat",
            base_url="https://relay.example.com/v1",
            context_window_tokens=8192,
        )

        listed = list_organization_providers.__wrapped__(
            self.request,
            other_organization_id,
        )
        self.assertTrue(listed["success"])
        listed_ids = {item["id"] for item in listed["data"]["providers"]}
        self.assertIn(str(provider.id), listed_ids)

        available = get_available_models(
            user_id=str(self.user_id),
            organization_id=other_organization_id,
            include_inactive=True,
        )
        available_names = {item["model_name"] for item in available}
        self.assertIn("personal-model", available_names)

        # 存量：创建时绑过组织 A 的个人渠道，切到 B 也应可见
        legacy = LLMProvider.objects.create(
            name="openai",
            provider_key="legacy-personal-openai",
            display_name="Legacy Personal",
            default_base_url="https://legacy.example.com/v1",
            api_key="sk-legacy",
            scope="user",
            organization_id=self.organization_id,
            user_id=str(self.user_id),
            capability_domains=["chat"],
        )
        LLMModel.objects.create(
            provider=legacy,
            model_name="legacy-personal-model",
            display_name="Legacy Personal Model",
            capability_domain="chat",
            base_url="https://legacy.example.com/v1",
            context_window_tokens=8192,
        )
        listed_legacy = list_organization_providers.__wrapped__(
            self.request,
            other_organization_id,
        )
        legacy_ids = {item["id"] for item in listed_legacy["data"]["providers"]}
        self.assertIn(str(legacy.id), legacy_ids)

        # 已在组织 A 建过个人 key 时，组织 B 再创建同 key 应去重失败
        dup_response = create_organization_provider.__wrapped__(
            self.request,
            other_organization_id,
            OrganizationProviderCreateRequest(
                provider_name="openai",
                provider_key="personal-openai",
                display_name="Dup Personal",
                base_url="https://relay.example.com/v1",
                api_key="sk-dup",
                scope="user",
            ),
        )
        self.assertFalse(self._response_payload(dup_response)["success"])

        # 在组织 B 更新/删除个人渠道（创建于 A / null org）不应 404
        update_response = update_organization_provider.__wrapped__(
            self.request,
            other_organization_id,
            str(provider.id),
            OrganizationProviderUpdateRequest(display_name="Personal OpenAI Renamed"),
        )
        self.assertTrue(update_response["success"])
        provider.refresh_from_db()
        self.assertEqual(provider.display_name, "Personal OpenAI Renamed")

    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_provider_counts_are_not_multiplied_by_models_and_keys(
        self,
        _ensure_permission,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
        )
        for index in range(2):
            LLMModel.objects.create(
                provider=provider,
                model_name=f"model-{index}",
                display_name=f"Model {index}",
                capability_domain="chat",
                base_url="https://api.example.com/v1",
                context_window_tokens=8192,
            )
        for index in range(3):
            LLMProviderKey.objects.create(
                provider=provider,
                label=f"key-{index}",
            )

        response = list_organization_providers.__wrapped__(
            self.request,
            self.organization_id,
        )

        self.assertTrue(response["success"])
        listed_provider = response["data"]["providers"][0]
        self.assertEqual(listed_provider["model_count"], 2)
        self.assertEqual(listed_provider["key_count"], 3)

    def test_probe_without_models_is_skipped_without_changing_health(self) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
        )

        result = probe_provider_health(provider, check_type="manual")

        self.assertFalse(result["success"])
        self.assertTrue(result["skipped"])
        self.assertEqual(result["probe"]["reason"], "no_models")
        provider.refresh_from_db()
        self.assertEqual(provider.runtime_status, "unknown")
        self.assertEqual(provider.health_total_checks, 0)

    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.services.proxy_service.probe_upstream_chat")
    def test_manual_probe_rejects_provider_without_models(
        self,
        probe_upstream_chat,
        _ensure_permission,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
        )

        response = probe_provider.__wrapped__(
            self.request,
            self.organization_id,
            str(provider.id),
            level=1,
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(json.loads(response.content)["code"], "NO_MODELS")
        probe_upstream_chat.assert_not_called()

    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.services.proxy_service.probe_upstream_chat")
    def test_manual_probe_rejects_unknown_model_name(
        self,
        probe_upstream_chat,
        _ensure_permission,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            api_key="",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
        )
        LLMModel.objects.create(
            provider=provider,
            model_name="configured-model",
            display_name="Configured Model",
            capability_domain="chat",
            base_url="https://api.example.com/v1",
            context_window_tokens=8192,
        )

        response = probe_provider.__wrapped__(
            self.request,
            self.organization_id,
            str(provider.id),
            level=1,
            model_name="invented-model",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(json.loads(response.content)["code"], "MODEL_NOT_FOUND")
        probe_upstream_chat.assert_not_called()

    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.services.proxy_service.probe_upstream_chat")
    def test_manual_probe_failure_persists_runtime_feedback(
        self,
        probe_upstream_chat,
        _ensure_permission,
    ) -> None:
        """成员「测试连接」失败必须落库，供其他成员读到同一 runtime_status。"""
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            api_key="sk-test",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
            runtime_status="healthy",
            health_total_checks=10,
            health_success_checks=10,
        )
        LLMModel.objects.create(
            provider=provider,
            model_name="configured-model",
            display_name="Configured Model",
            capability_domain="chat",
            base_url="https://api.example.com/v1",
            context_window_tokens=8192,
        )
        probe_upstream_chat.return_value = {
            "valid": False,
            "level": 1,
            "error": "Authentication failed (HTTP 401)",
            "error_code": "unauthorized",
            "status_code": 401,
            "latency_ms": 120,
            "details": {},
        }

        response = probe_provider.__wrapped__(
            self.request,
            self.organization_id,
            str(provider.id),
            level=1,
        )

        self.assertTrue(response["success"])
        self.assertFalse(response["data"]["valid"])
        provider.refresh_from_db()
        self.assertEqual(provider.health_total_checks, 11)
        self.assertEqual(provider.health_consecutive_failures, 1)
        self.assertEqual(provider.health_success_rate, 90.91)
        self.assertEqual(provider.runtime_status, "degraded")
        self.assertIn("401", provider.health_last_error)

        listed = list_organization_providers.__wrapped__(
            self.request,
            self.organization_id,
        )
        listed_provider = listed["data"]["providers"][0]
        self.assertEqual(listed_provider["runtime_status"], "degraded")
        self.assertEqual(listed_provider["health_success_rate"], 90.91)
        self.assertIn("401", listed_provider["health_last_error"])

    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.services.proxy_service.probe_upstream_chat")
    def test_manual_probe_success_persists_healthy_runtime(
        self,
        probe_upstream_chat,
        _ensure_permission,
    ) -> None:
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="custom-openai",
            display_name="Custom OpenAI",
            api_key="sk-test",
            scope="organization",
            organization_id=self.organization_id,
            capability_domains=["chat"],
            runtime_status="unknown",
        )
        LLMModel.objects.create(
            provider=provider,
            model_name="configured-model",
            display_name="Configured Model",
            capability_domain="chat",
            base_url="https://api.example.com/v1",
            context_window_tokens=8192,
        )
        probe_upstream_chat.return_value = {
            "valid": True,
            "level": 1,
            "error": "",
            "latency_ms": 88,
            "details": {},
        }

        response = probe_provider.__wrapped__(
            self.request,
            self.organization_id,
            str(provider.id),
            level=1,
        )

        self.assertTrue(response["success"])
        self.assertTrue(response["data"]["valid"])
        provider.refresh_from_db()
        self.assertEqual(provider.runtime_status, "healthy")
        self.assertEqual(provider.health_total_checks, 1)
        self.assertEqual(provider.health_last_error, "")

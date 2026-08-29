import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.test import SimpleTestCase, TestCase

from apps.services.llm.api_common import validate_model_endpoint_host
from apps.services.llm.api_config import create_organization_model, update_organization_model
from apps.services.llm.models import LLMModel, LLMProvider
from apps.services.llm.schemas import OrganizationModelCreateRequest, OrganizationModelUpdateRequest


class _FakeModelQuery:
    def __init__(self, models):
        self._models = list(models)

    def exclude(self, **kwargs):
        remaining = []
        for model in self._models:
            skip = False
            for field, value in kwargs.items():
                if getattr(model, field, None) == value:
                    skip = True
                    break
            if not skip:
                remaining.append(model)
        return _FakeModelQuery(remaining)

    def only(self, *_args):
        return self

    def __iter__(self):
        return iter(self._models)


def _provider(*, default_base_url="", models=None):
    return SimpleNamespace(
        default_base_url=default_base_url,
        models=_FakeModelQuery(models or []),
    )


class ValidateModelEndpointHostTests(SimpleTestCase):
    def test_same_host_different_path_is_allowed(self):
        provider = _provider(
            default_base_url="https://dashscope.aliyuncs.com/v1",
            models=[SimpleNamespace(id="m1", base_url="https://dashscope.aliyuncs.com/v1")],
        )

        self.assertIsNone(
            validate_model_endpoint_host(
                provider,
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
            )
        )

    def test_different_host_is_rejected(self):
        provider = _provider(
            default_base_url="https://openrouter.ai/api/v1",
            models=[SimpleNamespace(id="m1", base_url="https://openrouter.ai/api/v1")],
        )

        message = validate_model_endpoint_host(
            provider,
            "https://api.siliconflow.cn/v1",
        )
        self.assertTrue(message)

    def test_default_host_alone_rejects_other_host(self):
        provider = _provider(default_base_url="https://openrouter.ai/api/v1", models=[])

        self.assertTrue(
            validate_model_endpoint_host(provider, "https://api.siliconflow.cn/v1")
        )

    def test_first_model_with_empty_default_is_allowed(self):
        provider = _provider(default_base_url="", models=[])

        self.assertIsNone(
            validate_model_endpoint_host(provider, "https://api.siliconflow.cn/v1")
        )

    def test_placeholder_url_is_ignored(self):
        provider = _provider(
            default_base_url="https://api.example.com/v1",
            models=[SimpleNamespace(id="m1", base_url="https://api.example.com/v1")],
        )

        self.assertIsNone(
            validate_model_endpoint_host(provider, "https://openrouter.ai/api/v1")
        )

    def test_update_to_another_host_is_rejected(self):
        provider = _provider(
            default_base_url="https://openrouter.ai/api/v1",
            models=[
                SimpleNamespace(id="m1", base_url="https://openrouter.ai/api/v1"),
                SimpleNamespace(id="m2", base_url="https://openrouter.ai/api/v1"),
            ],
        )

        message = validate_model_endpoint_host(
            provider,
            "https://api.siliconflow.cn/v1",
            exclude_model_id="m1",
        )
        self.assertIsNotNone(message)

    def test_candidate_placeholder_skips_check(self):
        provider = _provider(
            default_base_url="https://openrouter.ai/api/v1",
            models=[SimpleNamespace(id="m1", base_url="https://openrouter.ai/api/v1")],
        )

        self.assertIsNone(
            validate_model_endpoint_host(provider, "https://api.example.com/v1")
        )


class OrganizationModelEndpointHostApiTests(TestCase):
    def setUp(self) -> None:
        self.organization_id = str(uuid4())
        self.request = SimpleNamespace(auth=SimpleNamespace(id=uuid4()))

    def _payload(self, response):
        if isinstance(response, dict):
            return response
        return json.loads(response.content)

    def _create_provider(self, **kwargs):
        values = {
            "name": "openai",
            "provider_key": f"openai-{uuid4().hex[:8]}",
            "display_name": "Test Connection",
            "default_base_url": "",
            "api_key": "",
            "scope": "organization",
            "organization_id": self.organization_id,
            "capability_domains": ["chat"],
        }
        values.update(kwargs)
        return LLMProvider.objects.create(**values)

    def _create_model(self, provider, *, model_name, base_url):
        return LLMModel.objects.create(
            provider=provider,
            model_name=model_name,
            display_name=model_name,
            capability_domain="chat",
            base_url=base_url,
            context_window_tokens=8192,
        )

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_create_same_host_different_path(self, _perm, _cache):
        provider = self._create_provider(
            default_base_url="https://dashscope.aliyuncs.com/v1",
        )
        self._create_model(
            provider,
            model_name="qwen-plus",
            base_url="https://dashscope.aliyuncs.com/v1",
        )

        response = create_organization_model.__wrapped__(
            self.request,
            self.organization_id,
            OrganizationModelCreateRequest(
                provider_id=str(provider.id),
                model_name="qwen-vl",
                display_name="Qwen VL",
                base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
                context_window_tokens=8192,
            ),
        )

        self.assertTrue(self._payload(response)["success"])

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_create_different_host_is_rejected(self, _perm, _cache):
        provider = self._create_provider(
            default_base_url="https://openrouter.ai/api/v1",
        )
        self._create_model(
            provider,
            model_name="gpt-4o",
            base_url="https://openrouter.ai/api/v1",
        )

        response = create_organization_model.__wrapped__(
            self.request,
            self.organization_id,
            OrganizationModelCreateRequest(
                provider_id=str(provider.id),
                model_name="deepseek-v3",
                display_name="DeepSeek",
                base_url="https://api.siliconflow.cn/v1",
                context_window_tokens=8192,
            ),
        )

        payload = self._payload(response)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], "MODEL_ENDPOINT_HOST_MISMATCH")
        self.assertFalse(
            LLMModel.objects.filter(provider=provider, model_name="deepseek-v3").exists()
        )

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_first_model_any_host_succeeds(self, _perm, _cache):
        provider = self._create_provider(default_base_url="")

        response = create_organization_model.__wrapped__(
            self.request,
            self.organization_id,
            OrganizationModelCreateRequest(
                provider_id=str(provider.id),
                model_name="gpt-4o",
                display_name="GPT-4o",
                base_url="https://api.siliconflow.cn/v1",
                context_window_tokens=8192,
            ),
        )

        self.assertTrue(self._payload(response)["success"])

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_placeholder_sibling_does_not_block_real_host(self, _perm, _cache):
        provider = self._create_provider(
            default_base_url="https://api.example.com/v1",
        )
        self._create_model(
            provider,
            model_name="placeholder-model",
            base_url="https://api.example.com/v1",
        )

        response = create_organization_model.__wrapped__(
            self.request,
            self.organization_id,
            OrganizationModelCreateRequest(
                provider_id=str(provider.id),
                model_name="gpt-4o",
                display_name="GPT-4o",
                base_url="https://openrouter.ai/api/v1",
                context_window_tokens=8192,
            ),
        )

        self.assertTrue(self._payload(response)["success"])

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    def test_update_to_different_host_is_rejected(self, _perm, _cache):
        provider = self._create_provider(
            default_base_url="https://openrouter.ai/api/v1",
        )
        model = self._create_model(
            provider,
            model_name="gpt-4o",
            base_url="https://openrouter.ai/api/v1",
        )

        response = update_organization_model(
            self.request,
            self.organization_id,
            str(model.id),
            OrganizationModelUpdateRequest(base_url="https://api.siliconflow.cn/v1"),
        )

        payload = self._payload(response)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], "MODEL_ENDPOINT_HOST_MISMATCH")
        model.refresh_from_db()
        self.assertEqual(model.base_url, "https://openrouter.ai/api/v1")

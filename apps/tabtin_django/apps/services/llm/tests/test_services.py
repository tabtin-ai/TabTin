"""LLM服务测试（新版接口）。"""

from types import SimpleNamespace
from unittest.mock import Mock, patch
from decimal import Decimal

from billiard.exceptions import SoftTimeLimitExceeded
from django.core.cache import cache
from django.test import TestCase, override_settings

from ..interface import ProviderMetadata, ProviderModelDeclaration
from ..models import LLMProvider, LLMModel
from ..services.base import BaseLLMService
from ..services.factory import LLMServiceFactory, get_llm_service, get_available_models
from ..services.openai_service import OpenAIService
from ..services.gemini_service import GeminiService
from ..services.qwen_service import QwenService


def _to_provider_config(provider: LLMProvider, model: LLMModel) -> dict:
    """把 DB 里的 provider/model 组装成 service 构造参数。"""
    return {
        "name": provider.name,
        "api_key": provider.api_key,
        "base_url": model.base_url,
        "model_name": model.model_name,
        "max_retries": 0,
        "retry_delay": 0,
        "provider_obj": provider,
        "model_obj": model,
    }


class _DummyService(BaseLLMService):
    """用于测试 BaseLLMService 非抽象能力。"""

    def _do_chat(self, messages, **kwargs):
        return {"success": True, "content": "ok", "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}

    def chat_stream(self, messages, **kwargs):
        yield {"success": True, "content": "", "finished": True}

    def _validate_connection(self):
        return {"valid": True, "details": {}}


class BaseLLMServiceTestCase(TestCase):
    """基础LLM服务测试"""

    def setUp(self):
        self.provider = LLMProvider.objects.create(
            name="openai",
            display_name="OpenAI",
            base_url="https://api.openai.com/v1",
            api_key="sk-test-key",
        )
        self.model = LLMModel.objects.create(
            provider=self.provider,
            model_name="gpt-4",
            display_name="GPT-4",
            base_url="https://api.openai.com/v1",
            max_tokens=8000,
            billing_type="token",
            input_price_per_1k=Decimal("0.01"),
            output_price_per_1k=Decimal("0.03"),
            custom_billing_config={
                "cache_read_input_price_per_1k": "0.002",
                "cache_write_input_price_per_1k": "0.004",
            },
        )

    def test_base_service_abstract(self):
        with self.assertRaises(TypeError):
            BaseLLMService({})

    def test_calculate_cost_from_usage(self):
        service = _DummyService(_to_provider_config(self.provider, self.model))
        usage = {"input_tokens": 100, "output_tokens": 200, "total_tokens": 300}
        cost = service._calculate_cost_from_usage(usage)

        self.assertEqual(cost["input_cost"], Decimal("0.001"))
        self.assertEqual(cost["output_cost"], Decimal("0.006"))
        self.assertEqual(cost["total_cost"], Decimal("0.007"))

    def test_calculate_cost_from_usage_with_prompt_cache(self):
        service = _DummyService(_to_provider_config(self.provider, self.model))
        usage = {
            "input_tokens": 1000,
            "output_tokens": 0,
            "total_tokens": 1000,
            "cache_read_input_tokens": 200,
            "cache_creation_input_tokens": 100,
            "input_tokens_include_cache": True,
        }
        cost = service._calculate_cost_from_usage(usage)

        self.assertEqual(cost["input_cost"], Decimal("0.007"))
        self.assertEqual(cost["cache_read_cost"], Decimal("0.0004"))
        self.assertEqual(cost["cache_write_cost"], Decimal("0.0004"))
        self.assertEqual(cost["total_cost"], Decimal("0.0078"))

    def test_task_time_limit_errors_are_non_retryable_timeouts(self):
        service = _DummyService(_to_provider_config(self.provider, self.model))
        wrapped = RuntimeError("Connection error.")
        wrapped.__cause__ = SoftTimeLimitExceeded()

        result = service._build_error_result(wrapped, response_time=180)

        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "TIMEOUT")
        self.assertEqual(result["error_type"], "task_timeout")
        self.assertFalse(result["retryable"])
        self.assertFalse(service._is_transient_exception(wrapped))

    def test_non_retryable_timeout_result_is_not_retried(self):
        config = {
            **_to_provider_config(self.provider, self.model),
            "max_retries": 3,
            "retry_delay": 0,
        }
        service = _DummyService(config)
        timeout_result = {
            "success": False,
            "error": "模型上游响应超时，任务已停止。请稍后重试或换一个模型。",
            "error_code": "TIMEOUT",
            "error_type": "task_timeout",
            "retryable": False,
        }
        service._do_chat = Mock(return_value=timeout_result)

        result = service.chat([{"role": "user", "content": "Hello"}])

        self.assertEqual(result, timeout_result)
        service._do_chat.assert_called_once()


class OpenAIServiceTestCase(TestCase):
    """OpenAI服务测试"""

    def setUp(self):
        self.provider = LLMProvider.objects.create(
            name="openai",
            display_name="OpenAI",
            base_url="https://api.openai.com/v1",
            api_key="sk-test-key",
        )
        self.model = LLMModel.objects.create(
            provider=self.provider,
            model_name="gpt-4",
            display_name="GPT-4",
            base_url="https://api.openai.com/v1",
            max_tokens=8000,
            supports_streaming=True,
        )
        self.provider_config = _to_provider_config(self.provider, self.model)

    @patch("openai.OpenAI")
    def test_init_service(self, mock_openai):
        mock_openai.return_value = Mock()
        service = OpenAIService(self.provider_config)

        mock_openai.assert_called_once()
        call_kwargs = mock_openai.call_args.kwargs
        self.assertEqual(call_kwargs["api_key"], "sk-test-key")
        self.assertEqual(call_kwargs["base_url"], "https://api.openai.com/v1")
        self.assertEqual(call_kwargs["max_retries"], 0)
        self.assertEqual(call_kwargs["timeout"].read, 120)
        self.assertEqual(service.provider, self.provider)
        self.assertEqual(service.model, self.model)

    @patch("openai.OpenAI")
    def test_init_service_bounds_request_timeout_for_retry_budget(self, mock_openai):
        mock_openai.return_value = Mock()
        provider_config = {
            **self.provider_config,
            "max_retries": 3,
            "retry_delay": 1,
        }

        with patch.dict("os.environ", {"TABTIN_LLM_TASK_HARD_LIMIT_SECONDS": "180"}):
            OpenAIService(provider_config)

        timeout = mock_openai.call_args.kwargs["timeout"]
        self.assertLessEqual(timeout.read, 36)

    @patch("openai.OpenAI")
    def test_chat_success(self, mock_openai):
        mock_response = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Hello! I'm ChatGPT."), finish_reason="stop")],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=20, total_tokens=30),
            model="gpt-4",
        )
        mock_client = Mock()
        mock_client.chat.completions.create.return_value = mock_response
        mock_openai.return_value = mock_client

        service = OpenAIService(self.provider_config)
        result = service.chat([{"role": "user", "content": "Hello"}])

        self.assertTrue(result["success"])
        self.assertEqual(result["content"], "Hello! I'm ChatGPT.")
        self.assertEqual(result["usage"]["input_tokens"], 10)
        self.assertEqual(result["usage"]["output_tokens"], 20)
        self.assertEqual(result["usage"]["total_tokens"], 30)

    @patch("openai.OpenAI")
    def test_chat_api_error(self, mock_openai):
        mock_client = Mock()
        mock_client.chat.completions.create.side_effect = Exception("API Error")
        mock_openai.return_value = mock_client

        service = OpenAIService(self.provider_config)
        result = service.chat([{"role": "user", "content": "Hello"}])

        self.assertFalse(result["success"])
        self.assertIn("API Error", result["error"])
        self.assertEqual(result["error_code"], "SERVICE_ERROR")

    @patch("openai.OpenAI")
    def test_chat_stream(self, mock_openai):
        chunk_1 = SimpleNamespace(
            choices=[SimpleNamespace(delta=SimpleNamespace(content="Hello", tool_calls=None), finish_reason=None)]
        )
        chunk_2 = SimpleNamespace(
            choices=[SimpleNamespace(delta=SimpleNamespace(content=" World", tool_calls=None), finish_reason="stop")],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15),
        )
        mock_client = Mock()
        mock_client.chat.completions.create.return_value = [chunk_1, chunk_2]
        mock_openai.return_value = mock_client

        service = OpenAIService(self.provider_config)
        chunks = list(service.chat_stream([{"role": "user", "content": "Hello"}]))

        self.assertEqual(chunks[0]["content"], "Hello")
        self.assertEqual(chunks[1]["content"], " World")
        self.assertTrue(chunks[-1]["finished"])
        self.assertEqual(chunks[-1]["usage"]["total_tokens"], 15)


class QwenServiceTestCase(TestCase):
    """通义千问服务测试"""

    def setUp(self):
        self.provider = LLMProvider.objects.create(
            name="qwen",
            display_name="通义千问",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            api_key="sk-test-key",
        )
        self.model = LLMModel.objects.create(
            provider=self.provider,
            model_name="qwen3-coder-flash",
            display_name="通义千问Plus",
            max_tokens=6000,
        )
        self.compatible_config = _to_provider_config(self.provider, self.model)
        self.native_config = {
            **self.compatible_config,
            "base_url": "https://dashscope.aliyuncs.com/api/v1",
        }

    @patch("openai.OpenAI")
    def test_init_compatible_mode(self, mock_openai):
        mock_openai.return_value = Mock()
        service = QwenService(self.compatible_config)
        self.assertTrue(service.is_compatible_mode)

    def test_init_native_mode(self):
        service = QwenService(self.native_config)
        self.assertFalse(service.is_compatible_mode)

    @patch("openai.OpenAI")
    def test_compatible_mode_chat(self, mock_openai):
        mock_response = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="你好！我是通义千问。"), finish_reason="stop")],
            usage=SimpleNamespace(prompt_tokens=5, completion_tokens=10, total_tokens=15),
            model="qwen3-coder-flash",
        )
        mock_client = Mock()
        mock_client.chat.completions.create.return_value = mock_response
        mock_openai.return_value = mock_client

        service = QwenService(self.compatible_config)
        result = service.chat([{"role": "user", "content": "你好"}])

        self.assertTrue(result["success"])
        self.assertEqual(result["content"], "你好！我是通义千问。")
        self.assertEqual(result["usage"]["total_tokens"], 15)

    @patch("requests.post")
    def test_native_mode_chat(self, mock_post):
        mock_response = Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {
            "output": {
                "choices": [
                    {
                        "message": {"content": "你好！我是通义千问。"},
                        "finish_reason": "stop",
                    }
                ]
            },
            "usage": {"input_tokens": 5, "output_tokens": 10, "total_tokens": 15},
            "model": "qwen3-coder-flash",
        }
        mock_post.return_value = mock_response

        service = QwenService(self.native_config)
        result = service.chat([{"role": "user", "content": "你好"}])

        self.assertTrue(result["success"])
        self.assertEqual(result["content"], "你好！我是通义千问。")
        self.assertEqual(result["usage"]["total_tokens"], 15)


class LLMServiceFactoryTestCase(TestCase):
    """LLM服务工厂测试"""

    def setUp(self):
        self.openai_provider = LLMProvider.objects.create(
            name="openai",
            display_name="OpenAI",
            base_url="https://api.openai.com/v1",
            api_key="sk-test-key",
            scope="global",
            is_active=True,
        )
        self.openai_model = LLMModel.objects.create(
            provider=self.openai_provider,
            model_name="gpt-4",
            display_name="GPT-4",
            max_tokens=8000,
            is_active=True,
        )

        self.qwen_provider = LLMProvider.objects.create(
            name="qwen",
            display_name="通义千问",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            api_key="sk-test-key",
            scope="global",
            is_active=True,
        )
        self.qwen_model = LLMModel.objects.create(
            provider=self.qwen_provider,
            model_name="qwen3-coder-flash",
            display_name="通义千问Plus",
            max_tokens=6000,
            is_active=True,
        )

    @patch("openai.OpenAI")
    def test_get_llm_service_openai(self, mock_openai):
        mock_openai.return_value = Mock()
        service = get_llm_service(provider_name="openai")

        self.assertIsInstance(service, OpenAIService)
        self.assertEqual(service.model.model_name, "gpt-4")

    @patch("openai.OpenAI")
    def test_get_llm_service_qwen(self, mock_openai):
        mock_openai.return_value = Mock()
        service = get_llm_service(provider_name="qwen")

        self.assertIsInstance(service, QwenService)
        self.assertEqual(service.model.model_name, "qwen3-coder-flash")

    @patch("openai.OpenAI")
    def test_get_llm_service_user_provider(self, mock_openai):
        mock_openai.return_value = Mock()
        user_provider = LLMProvider.objects.create(
            name="openai",
            display_name="OpenAI (用户)",
            base_url="https://api.openai.com/v1",
            api_key="sk-user-key",
            scope="user",
            user_id="user123",
            is_active=True,
        )
        LLMModel.objects.create(
            provider=user_provider,
            model_name="gpt-4o",
            display_name="GPT-4o (用户)",
            max_tokens=8000,
            is_active=True,
        )

        service = get_llm_service(provider_name="openai", user_id="user123")

        self.assertIsInstance(service, OpenAIService)
        self.assertEqual(service.provider.user_id, "user123")
        self.assertEqual(str(service.provider.id), str(user_provider.id))

    @patch("openai.OpenAI")
    def test_get_llm_service_skips_non_llm_organization_provider(self, mock_openai):
        mock_openai.return_value = Mock()
        bytedance_provider = LLMProvider.objects.create(
            name="bytedance",
            display_name="字节跳动语音",
            base_url="https://openspeech.bytedance.com",
            api_key="tts-test-key",
            scope="organization",
            organization_id="ws-title",
            is_active=True,
        )
        LLMModel.objects.create(
            provider=bytedance_provider,
            model_name="seed-tts-2.0",
            display_name="Seed TTS",
            mode="audio_speech",
            max_tokens=0,
            is_active=True,
        )

        service = get_llm_service(organization_id="ws-title")

        self.assertIsInstance(service, OpenAIService)
        self.assertEqual(str(service.provider.id), str(self.openai_provider.id))

    def test_get_llm_service_rejects_non_llm_provider(self):
        with self.assertRaisesMessage(ValueError, "Provider 'bytedance' 不支持 LLM 能力"):
            get_llm_service(provider_name="bytedance")

    @override_settings(
        OPENAI_API_KEY="sk-fallback",
        OPENAI_BASE_URL="https://api.openai.com/v1",
        OPENAI_MODEL="gpt-4o",
    )
    @patch("openai.OpenAI")
    def test_get_llm_service_fallback_skips_non_llm_default_provider(self, mock_openai):
        """v0.1 合规：fallback 兜底固定 openai，不再读 LLM_DEFAULT_PROVIDER env。

        显式传 provider_name='bytedance' 时仍走 capability_guard 拒绝；fallback
        路径（DB 空 + provider_name 为空）固定降级到 openai。
        """
        mock_openai.return_value = Mock()
        LLMModel.objects.all().delete()
        LLMProvider.objects.all().delete()

        service = get_llm_service()

        self.assertIsInstance(service, OpenAIService)
        self.assertEqual(service.provider_name, "openai")
        self.assertEqual(service.model_name, "gpt-4o")

    def test_get_llm_service_model_not_found(self):
        with self.assertRaises(ValueError):
            get_llm_service(provider_name="openai", model_name="non-existent-model")

    def test_get_available_models(self):
        models = get_available_models()
        model_names = [item["model_name"] for item in models]
        self.assertIn("gpt-4", model_names)
        self.assertIn("qwen3-coder-flash", model_names)

    def test_get_available_models_excludes_non_ready_models_unless_requested(self):
        cache.clear()
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="openai_staged_catalog_test",
            display_name="OpenAI Staged",
            scope="global",
            routing_enabled=True,
            capability_domains=["chat"],
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="staged-model-not-sendable",
            display_name="Staged Model",
            capability_domain="chat",
            wave_status="staged",
            context_window_tokens=8192,
        )

        available_ids = {item["id"] for item in get_available_models()}
        configured_ids = {
            item["id"] for item in get_available_models(include_inactive=True)
        }

        self.assertNotIn(str(model.id), available_ids)
        self.assertIn(str(model.id), configured_ids)

    def test_get_available_models_excludes_declared_models_by_default(self):
        cache.clear()
        declared_meta = ProviderMetadata(
            name="openai",
            display_name="OpenAI",
            service_class_path="apps.services.llm.services.openai_service.OpenAIService",
            static_models=(
                ProviderModelDeclaration(
                    model_name="gpt-not-in-db",
                    display_name="GPT Not In DB",
                ),
            ),
        )

        with patch("apps.services.llm.registry.ProviderRegistry._providers", {"openai": declared_meta}):
            models = get_available_models()

        model_names = [item["model_name"] for item in models]
        self.assertIn("gpt-4", model_names)
        self.assertNotIn("gpt-not-in-db", model_names)

    def test_get_available_models_can_include_declared_models_for_catalog_display(self):
        cache.clear()
        declared_meta = ProviderMetadata(
            name="openai",
            display_name="OpenAI",
            service_class_path="apps.services.llm.services.openai_service.OpenAIService",
            static_models=(
                ProviderModelDeclaration(
                    model_name="gpt-not-in-db",
                    display_name="GPT Not In DB",
                ),
            ),
        )

        with patch("apps.services.llm.registry.ProviderRegistry._providers", {"openai": declared_meta}):
            models = get_available_models(include_declared=True)
            db_only_models = get_available_models()

        declared = next(item for item in models if item["model_name"] == "gpt-not-in-db")
        self.assertEqual(declared["id"], "declared:openai:gpt-not-in-db")
        self.assertEqual(declared["source"], "provider_declared")
        self.assertNotIn("gpt-not-in-db", [item["model_name"] for item in db_only_models])

    def test_get_available_models_user_specific(self):
        user_provider = LLMProvider.objects.create(
            name="openai",
            provider_key="openai_user_1",
            display_name="OpenAI (用户)",
            base_url="https://api.openai.com/v1",
            api_key="sk-user-key",
            scope="user",
            user_id="user123",
            is_active=True,
        )
        LLMModel.objects.create(
            provider=user_provider,
            model_name="gpt-4-turbo",
            display_name="GPT-4 Turbo (用户)",
            max_tokens=128000,
            is_active=True,
        )

        models = get_available_models(user_id="user123")
        model_names = [item["model_name"] for item in models]
        self.assertIn("gpt-4", model_names)
        self.assertIn("gpt-4-turbo", model_names)

    def test_get_available_models_orders_global_providers_before_user_byok(self):
        """同 priority 时 global 先于 user，避免新建自定义渠道把平台组顶到前面。"""
        cache.clear()

        older_global = LLMProvider.objects.create(
            name="moonshot",
            provider_key="sort_moonshot_global",
            display_name="Moonshot Sort",
            scope="global",
            priority=0,
            capability_domains=["chat"],
        )
        newer_global = LLMProvider.objects.create(
            name="volcengine",
            provider_key="sort_volcengine_global",
            display_name="火山引擎 Sort",
            scope="global",
            priority=0,
            capability_domains=["chat"],
        )
        newest_user = LLMProvider.objects.create(
            name="moonshot",
            provider_key="sort_moonshot_user_byok",
            display_name="Moonshot User Sort",
            scope="user",
            user_id="user-byok-sort",
            priority=0,
            capability_domains=["chat"],
        )
        LLMModel.objects.create(
            provider=older_global,
            model_name="sort-kimi-k2.6",
            display_name="Kimi K2.6 Sort",
            capability_domain="chat",
            max_tokens=8000,
        )
        LLMModel.objects.create(
            provider=newer_global,
            model_name="sort-doubao-seed-evolving",
            display_name="Doubao Seed Evolving Sort",
            capability_domain="chat",
            max_tokens=8000,
        )
        LLMModel.objects.create(
            provider=newest_user,
            model_name="sort-k3-256k",
            display_name="K3-256K Sort",
            capability_domain="chat",
            max_tokens=8000,
        )

        model_names = [
            item["model_name"]
            for item in get_available_models(user_id="user-byok-sort")
        ]
        doubao_idx = model_names.index("sort-doubao-seed-evolving")
        kimi_idx = model_names.index("sort-kimi-k2.6")
        byok_idx = model_names.index("sort-k3-256k")
        self.assertLess(doubao_idx, kimi_idx)
        self.assertLess(kimi_idx, byok_idx)

    @patch("openai.OpenAI")
    def test_factory_create_service(self, mock_openai):
        mock_openai.return_value = Mock()
        factory = LLMServiceFactory()

        openai_service = factory.create_service("openai", _to_provider_config(self.openai_provider, self.openai_model))
        qwen_service = factory.create_service("qwen", _to_provider_config(self.qwen_provider, self.qwen_model))

        self.assertIsInstance(openai_service, OpenAIService)
        self.assertIsInstance(qwen_service, QwenService)

    @patch("openai.OpenAI")
    def test_factory_unknown_provider_graceful_degradation(self, mock_openai):
        """FAC-1 回归：未注册 provider 应降级到 OpenAIService 而非抛异常"""
        mock_openai.return_value = Mock()
        service = LLMServiceFactory.create_service(
            "local",
            {
                "name": "local",
                "api_key": "test-key",
                "base_url": "https://localhost:8080/v1",
            },
        )
        self.assertIsInstance(service, OpenAIService)

    def test_get_supported_providers_excludes_non_llm_provider(self):
        providers = LLMServiceFactory.get_supported_providers()
        self.assertIn("openai", providers)
        self.assertNotIn("bytedance", providers)


# ── Cache 方法单元测试 ──


class ExtractCacheTokensTestCase(TestCase):
    """_extract_cache_tokens / _extract_cache_tokens_from_dict 测试"""

    def test_openai_chat_completions_format(self):
        """prompt_tokens_details.cached_tokens（SDK 对象属性）"""
        usage = SimpleNamespace(
            prompt_tokens=500,
            completion_tokens=200,
            total_tokens=700,
            prompt_tokens_details=SimpleNamespace(cached_tokens=150, cache_creation_input_tokens=50),
            cache_read_input_tokens=0,
        )
        read, creation = BaseLLMService._extract_cache_tokens(usage)
        self.assertEqual(read, 150)
        self.assertEqual(creation, 50)

    def test_openai_responses_api_format(self):
        """input_tokens_details.cached_tokens"""
        usage = SimpleNamespace(
            input_tokens=1000,
            output_tokens=300,
            total_tokens=1300,
            prompt_tokens_details=None,
            input_tokens_details=SimpleNamespace(cached_tokens=400, cache_creation_input_tokens=100),
            cache_read_input_tokens=0,
        )
        read, creation = BaseLLMService._extract_cache_tokens(usage)
        self.assertEqual(read, 400)
        self.assertEqual(creation, 100)

    def test_anthropic_format(self):
        """顶层 cache_read_input_tokens / cache_creation_input_tokens"""
        usage = SimpleNamespace(
            input_tokens=800,
            output_tokens=200,
            cache_read_input_tokens=300,
            cache_creation_input_tokens=100,
        )
        read, creation = BaseLLMService._extract_cache_tokens(usage)
        self.assertEqual(read, 300)
        self.assertEqual(creation, 100)

    def test_gemini_format_nested(self):
        """usage_metadata.cached_content_token_count"""
        usage = SimpleNamespace(
            prompt_tokens=600,
            completion_tokens=200,
            total_tokens=800,
            usage_metadata=SimpleNamespace(cached_content_token_count=250),
        )
        read, creation = BaseLLMService._extract_cache_tokens(usage)
        self.assertEqual(read, 250)
        self.assertEqual(creation, 0)

    def test_gemini_format_flat(self):
        """顶层 cached_content_token_count"""
        usage = SimpleNamespace(
            prompt_tokens=600,
            completion_tokens=200,
            cached_content_token_count=180,
        )
        read, creation = BaseLLMService._extract_cache_tokens(usage)
        self.assertEqual(read, 180)
        self.assertEqual(creation, 0)

    def test_empty_usage(self):
        usage = SimpleNamespace()
        read, creation = BaseLLMService._extract_cache_tokens(usage)
        self.assertEqual(read, 0)
        self.assertEqual(creation, 0)

    def test_none_and_zero_values(self):
        usage = SimpleNamespace(
            prompt_tokens_details=SimpleNamespace(cached_tokens=None, cache_creation_input_tokens=0),
            cache_read_input_tokens=None,
        )
        read, creation = BaseLLMService._extract_cache_tokens(usage)
        self.assertEqual(read, 0)
        self.assertEqual(creation, 0)


class ExtractCacheTokensFromDictTestCase(TestCase):
    """_extract_cache_tokens_from_dict 测试"""

    def test_openai_chat_dict(self):
        data = {
            "prompt_tokens": 500,
            "prompt_tokens_details": {"cached_tokens": 150, "cache_creation_input_tokens": 50},
        }
        read, creation = BaseLLMService._extract_cache_tokens_from_dict(data)
        self.assertEqual(read, 150)
        self.assertEqual(creation, 50)

    def test_responses_api_dict(self):
        data = {
            "input_tokens": 1000,
            "input_tokens_details": {"cached_tokens": 400, "cache_creation_input_tokens": 100},
        }
        read, creation = BaseLLMService._extract_cache_tokens_from_dict(data)
        self.assertEqual(read, 400)
        self.assertEqual(creation, 100)

    def test_anthropic_dict(self):
        data = {
            "input_tokens": 800,
            "cache_read_input_tokens": 300,
            "cache_creation_input_tokens": 100,
        }
        read, creation = BaseLLMService._extract_cache_tokens_from_dict(data)
        self.assertEqual(read, 300)
        self.assertEqual(creation, 100)

    def test_gemini_dict(self):
        data = {
            "prompt_tokens": 600,
            "cached_content_token_count": 180,
        }
        read, creation = BaseLLMService._extract_cache_tokens_from_dict(data)
        self.assertEqual(read, 180)
        self.assertEqual(creation, 0)

    def test_empty_dict(self):
        read, creation = BaseLLMService._extract_cache_tokens_from_dict({})
        self.assertEqual(read, 0)
        self.assertEqual(creation, 0)


class EnrichUsageWithCacheTestCase(TestCase):
    """_enrich_usage_with_cache 测试"""

    def test_both_nonzero(self):
        usage = {"input_tokens": 100}
        BaseLLMService._enrich_usage_with_cache(usage, 50, 20)
        self.assertEqual(usage["cache_read_input_tokens"], 50)
        self.assertEqual(usage["cache_creation_input_tokens"], 20)

    def test_zeros_not_written(self):
        usage = {"input_tokens": 100}
        BaseLLMService._enrich_usage_with_cache(usage, 0, 0)
        self.assertNotIn("cache_read_input_tokens", usage)
        self.assertNotIn("cache_creation_input_tokens", usage)

    def test_partial(self):
        usage = {}
        BaseLLMService._enrich_usage_with_cache(usage, 30, 0)
        self.assertEqual(usage["cache_read_input_tokens"], 30)
        self.assertNotIn("cache_creation_input_tokens", usage)


class InjectPromptCachePayloadTestCase(TestCase):
    """_inject_prompt_cache_payload 测试"""

    def test_kwargs_take_precedence(self):
        result = BaseLLMService._inject_prompt_cache_payload(
            {"prompt_cache_key": "old"},
            {"prompt_cache_key": "new"},
        )
        self.assertEqual(result["prompt_cache_key"], "new")

    def test_fallback_to_extra_body(self):
        result = BaseLLMService._inject_prompt_cache_payload(
            {"prompt_cache_key": "from_body"},
            {},
        )
        self.assertEqual(result["prompt_cache_key"], "from_body")

    def test_empty_key_stripped(self):
        result = BaseLLMService._inject_prompt_cache_payload(
            {"prompt_cache_key": "will_be_removed"},
            {"prompt_cache_key": "  "},
        )
        self.assertNotIn("prompt_cache_key", result)

    def test_retention_forwarded(self):
        result = BaseLLMService._inject_prompt_cache_payload(
            {},
            {"prompt_cache_retention": "300"},
        )
        self.assertEqual(result["prompt_cache_retention"], "300")

    def test_empty_retention_stripped(self):
        result = BaseLLMService._inject_prompt_cache_payload(
            {"prompt_cache_retention": "old"},
            {"prompt_cache_retention": ""},
        )
        self.assertNotIn("prompt_cache_retention", result)

    def test_no_cache_params(self):
        result = BaseLLMService._inject_prompt_cache_payload(
            {"some_other": "value"},
            {"temperature": 0.7},
        )
        self.assertEqual(result, {"some_other": "value"})
        self.assertNotIn("prompt_cache_key", result)
        self.assertNotIn("prompt_cache_retention", result)

    def test_none_extra_body(self):
        result = BaseLLMService._inject_prompt_cache_payload(
            None,
            {"prompt_cache_key": "abc"},
        )
        self.assertEqual(result["prompt_cache_key"], "abc")


class ExtractCacheTokensFromDictGeminiMetadataTestCase(TestCase):
    """Gemini dict 嵌套 usage_metadata 格式"""

    def test_gemini_usage_metadata_dict(self):
        data = {
            "prompt_tokens": 600,
            "usage_metadata": {"cached_content_token_count": 200},
        }
        read, creation = BaseLLMService._extract_cache_tokens_from_dict(data)
        self.assertEqual(read, 200)
        self.assertEqual(creation, 0)

    def test_flat_takes_precedence_over_nested(self):
        data = {
            "cached_content_token_count": 150,
            "usage_metadata": {"cached_content_token_count": 200},
        }
        read, _ = BaseLLMService._extract_cache_tokens_from_dict(data)
        self.assertEqual(read, 150)


class EstimateStreamUsageTestCase(TestCase):
    """_estimate_stream_usage 测试"""

    def setUp(self):
        self.provider = LLMProvider.objects.create(
            name="openai",
            display_name="OpenAI",
            base_url="https://api.openai.com/v1",
            api_key="sk-test",
        )
        self.model = LLMModel.objects.create(
            provider=self.provider,
            model_name="gpt-4",
            display_name="GPT-4",
            max_tokens=8000,
        )

    def test_basic_estimation(self):
        service = _DummyService(_to_provider_config(self.provider, self.model))
        messages = [{"role": "user", "content": "Hello, how are you?"}]
        result = service._estimate_stream_usage(messages, "I'm doing well, thank you!")
        self.assertIsNotNone(result)
        self.assertGreater(result["input_tokens"], 0)
        self.assertGreater(result["output_tokens"], 0)
        self.assertEqual(result["total_tokens"], result["input_tokens"] + result["output_tokens"])
        self.assertTrue(result["estimated"])

    def test_empty_content(self):
        service = _DummyService(_to_provider_config(self.provider, self.model))
        messages = [{"role": "user", "content": "Hello"}]
        result = service._estimate_stream_usage(messages, "")
        self.assertIsNotNone(result)
        self.assertGreater(result["input_tokens"], 0)
        self.assertEqual(result["output_tokens"], 0)

    def test_returns_none_for_empty_messages(self):
        service = _DummyService(_to_provider_config(self.provider, self.model))
        result = service._estimate_stream_usage([], "")
        self.assertIsNone(result)


class CapabilitiesUtilsTestCase(TestCase):
    """capabilities.py 工具函数测试"""

    def test_normalize_service_capabilities(self):
        from ..utils.capabilities import normalize_service_capabilities
        caps = {
            "streaming": True,
            "vision": False,
            "prompt_caching": True,
            "tool_calling": True,
            "structured_output": True,
        }
        normalized = normalize_service_capabilities(caps)
        self.assertTrue(normalized["supports_streaming"])
        self.assertFalse(normalized["supports_vision"])
        self.assertTrue(normalized["supports_prompt_caching"])
        self.assertTrue(normalized["supports_function_calling"])
        self.assertTrue(normalized["supports_json_mode"])

    def test_get_capability_flag_with_service_capabilities(self):
        from ..utils.capabilities import get_capability_flag
        model = LLMModel.objects.create(
            provider=LLMProvider.objects.create(
                name="test", display_name="Test",
                base_url="https://test.com", api_key="k",
            ),
            model_name="test-model",
            display_name="Test",
            max_tokens=1000,
        )
        svc_caps = {"prompt_caching": True, "vision": False}
        self.assertTrue(get_capability_flag(model, "supports_prompt_caching", service_capabilities=svc_caps))
        self.assertFalse(get_capability_flag(model, "supports_vision", service_capabilities=svc_caps))

    def test_db_overrides_service_capabilities(self):
        from ..utils.capabilities import get_capability_flag
        model = LLMModel.objects.create(
            provider=LLMProvider.objects.create(
                name="test2", display_name="Test2",
                base_url="https://test.com", api_key="k",
            ),
            model_name="test-model-2",
            display_name="Test 2",
            max_tokens=1000,
            capabilities_config={"supports_prompt_caching": False},
        )
        svc_caps = {"prompt_caching": True}
        self.assertFalse(get_capability_flag(model, "supports_prompt_caching", service_capabilities=svc_caps))


class GeminiServicePromptCachingTestCase(TestCase):
    """PROV-3 回归：Gemini prompt_caching 必须为 False，且缓存字段不注入请求。"""

    def test_capabilities_prompt_caching_is_false(self):
        self.assertFalse(GeminiService.CAPABILITIES.get("prompt_caching"))

    def test_inject_strips_anthropic_cache_fields_from_extra_body(self):
        extra_body = {"prompt_cache_key": "abc", "prompt_cache_retention": "300", "other": 1}
        result = GeminiService._inject_prompt_cache_payload(extra_body, {})
        self.assertNotIn("prompt_cache_key", result)
        self.assertNotIn("prompt_cache_retention", result)
        self.assertEqual(result["other"], 1)

    def test_inject_strips_anthropic_cache_fields_from_kwargs(self):
        result = GeminiService._inject_prompt_cache_payload(
            {},
            {"prompt_cache_key": "abc", "prompt_cache_retention": "300"},
        )
        self.assertNotIn("prompt_cache_key", result)
        self.assertNotIn("prompt_cache_retention", result)

    def test_inject_preserves_unrelated_fields(self):
        extra_body = {"thinking": {"budget_tokens": 1024}, "some_flag": True}
        result = GeminiService._inject_prompt_cache_payload(extra_body, {"temperature": 0.5})
        self.assertEqual(result["thinking"], {"budget_tokens": 1024})
        self.assertTrue(result["some_flag"])

    def test_inject_with_none_extra_body(self):
        result = GeminiService._inject_prompt_cache_payload(None, {"prompt_cache_key": "k"})
        self.assertNotIn("prompt_cache_key", result)
        self.assertIsInstance(result, dict)

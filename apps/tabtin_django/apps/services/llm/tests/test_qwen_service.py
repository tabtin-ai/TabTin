"""Qwen Service P0 回归测试 (PROV-4, PROV-5)"""

from unittest.mock import patch, MagicMock
from django.test import SimpleTestCase

from ..services.qwen_service import QwenService, QWEN_DEFAULT_BASE_URL


class QwenServicePROV4RegressionTest(SimpleTestCase):
    """PROV-4: base_url 为 None 时不应崩溃，应使用默认值。"""

    @patch("openai.OpenAI")
    def test_none_base_url_uses_default(self, mock_openai):
        config = {
            "name": "qwen",
            "api_key": "sk-test",
            "base_url": None,
        }
        service = QwenService(config)

        self.assertEqual(service.base_url, QWEN_DEFAULT_BASE_URL)
        mock_openai.assert_called_once_with(
            api_key="sk-test",
            base_url=QWEN_DEFAULT_BASE_URL,
        )

    @patch("openai.OpenAI")
    def test_empty_string_base_url_uses_default(self, mock_openai):
        config = {
            "name": "qwen",
            "api_key": "sk-test",
            "base_url": "",
        }
        service = QwenService(config)

        self.assertEqual(service.base_url, QWEN_DEFAULT_BASE_URL)

    @patch("openai.OpenAI")
    def test_missing_base_url_key_uses_default(self, mock_openai):
        config = {
            "name": "qwen",
            "api_key": "sk-test",
        }
        service = QwenService(config)

        self.assertEqual(service.base_url, QWEN_DEFAULT_BASE_URL)

    @patch("openai.OpenAI")
    def test_explicit_base_url_preserved(self, mock_openai):
        custom_url = "https://custom.endpoint.com/v1"
        config = {
            "name": "qwen",
            "api_key": "sk-test",
            "base_url": custom_url,
        }
        service = QwenService(config)

        self.assertEqual(service.base_url, custom_url)
        mock_openai.assert_called_once_with(
            api_key="sk-test",
            base_url=custom_url,
        )


class QwenServicePROV5RegressionTest(SimpleTestCase):
    """PROV-5: 原生模式已删除，仅保留 OpenAI 兼容模式。"""

    @patch("openai.OpenAI")
    def test_no_is_compatible_mode_attribute(self, mock_openai):
        config = {
            "name": "qwen",
            "api_key": "sk-test",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        }
        service = QwenService(config)

        self.assertFalse(hasattr(service, "is_compatible_mode"))

    @patch("openai.OpenAI")
    def test_no_native_mode_methods(self, mock_openai):
        config = {
            "name": "qwen",
            "api_key": "sk-test",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        }
        service = QwenService(config)

        self.assertFalse(hasattr(service, "_chat_native_mode"))
        self.assertFalse(hasattr(service, "_chat_stream_native_mode"))
        self.assertFalse(hasattr(service, "_prepare_native_params"))
        self.assertFalse(hasattr(service, "_process_native_response"))
        self.assertFalse(hasattr(service, "_process_native_stream_chunk"))

    @patch("openai.OpenAI")
    def test_no_headers_attribute(self, mock_openai):
        """原生模式移除后，不再需要 self.headers。"""
        config = {
            "name": "qwen",
            "api_key": "sk-test",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        }
        service = QwenService(config)

        self.assertFalse(hasattr(service, "headers"))

    @patch("openai.OpenAI")
    def test_client_always_created(self, mock_openai):
        """无论 base_url 是否含 compatible-mode，client 都应被创建。"""
        for url in [
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "https://custom-proxy.example.com/v1",
            None,
        ]:
            mock_openai.reset_mock()
            config = {
                "name": "qwen",
                "api_key": "sk-test",
                "base_url": url,
            }
            service = QwenService(config)

            self.assertTrue(hasattr(service, "client"))
            mock_openai.assert_called_once()

    @patch("openai.OpenAI")
    def test_supports_structured_output_without_compatible_mode_check(self, mock_openai):
        """supports_structured_output 不再依赖 is_compatible_mode 判断。"""
        config = {
            "name": "qwen",
            "api_key": "sk-test",
            "base_url": "https://some-non-compatible-url.com/v1",
        }
        service = QwenService(config)

        result = service.supports_structured_output()
        self.assertTrue(result)

"""#6643: provider_key / base_url 校验应返回业务 i18n，而非英文 detail。"""

from django.test import SimpleTestCase
from ninja.errors import HttpError

from apps.services.llm.api_common import _normalize_base_url, _normalize_provider_key


class NormalizeBaseUrlTests(SimpleTestCase):
    def test_accepts_http_https(self):
        self.assertEqual(_normalize_base_url(" https://api.openai.com/v1/ "), "https://api.openai.com/v1")
        self.assertEqual(_normalize_base_url("http://127.0.0.1:9/v1"), "http://127.0.0.1:9/v1")

    def test_rejects_empty(self):
        with self.assertRaises(HttpError) as ctx:
            _normalize_base_url("  ")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertNotIn("base_url cannot be empty", str(ctx.exception))
        self.assertNotIn("provider_create_failed", str(ctx.exception).lower())

    def test_rejects_api_key_mistaken_as_url(self):
        with self.assertRaises(HttpError) as ctx:
            _normalize_base_url("sk-invalid-6133-test")
        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertNotIn("base_url must be a valid", message)
        self.assertNotIn("创建配置失败", message)
        # zh-CN default locale in tests
        self.assertIn("http/https", message)


class NormalizeProviderKeyTests(SimpleTestCase):
    def test_accepts_normalized_key(self):
        self.assertEqual(_normalize_provider_key("OpenAI-Test"), "openai-test")

    def test_rejects_invalid_key_with_i18n(self):
        with self.assertRaises(HttpError) as ctx:
            _normalize_provider_key("A")
        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertNotIn("must contain only lowercase", message)

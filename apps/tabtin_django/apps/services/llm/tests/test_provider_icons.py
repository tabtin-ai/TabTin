"""Provider 品牌图标 URL 解析与公开下载。"""

from django.test import SimpleTestCase, Client

from apps.services.llm.provider_icons import (
    PROVIDER_ICON_URL_PREFIX,
    build_provider_icon_url,
    resolve_icon_file,
    resolve_provider_icon_key,
)


class ProviderIconTests(SimpleTestCase):
    def test_resolve_known_provider(self):
        self.assertEqual(resolve_provider_icon_key("openai"), "openai")
        self.assertEqual(resolve_provider_icon_key("moonshot"), "kimi")
        self.assertEqual(resolve_provider_icon_key("volcengine"), "doubao")
        self.assertEqual(resolve_provider_icon_key("claude"), "claude")
        self.assertEqual(resolve_provider_icon_key("azure"), "azure")

    def test_resolve_missing_asset_returns_empty(self):
        self.assertEqual(resolve_provider_icon_key("fal"), "")
        self.assertEqual(resolve_provider_icon_key("zhipu"), "")
        self.assertEqual(resolve_provider_icon_key("unknown-vendor"), "")

    def test_explicit_key_overrides_mapping(self):
        self.assertEqual(resolve_provider_icon_key("custom", "claude"), "claude")

    def test_build_url_uses_api_prefix(self):
        url = build_provider_icon_url("openai")
        self.assertEqual(url, f"{PROVIDER_ICON_URL_PREFIX}/openai")
        self.assertEqual(build_provider_icon_url("fal"), "")

    def test_resolve_icon_file_exists(self):
        for key in ("openai", "claude", "gemini", "deepseek", "kimi", "minimax", "doubao", "qwen", "azure"):
            path = resolve_icon_file(key)
            self.assertTrue(path.is_file(), key)
            self.assertTrue(path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))


class ProviderIconEndpointTests(SimpleTestCase):
    """走完整 URL 配置；需加载 Django urls。"""

    def test_public_png_endpoint(self):
        client = Client()
        response = client.get("/api/services/llm/provider-icons/openai")
        self.assertEqual(response.status_code, 200)
        self.assertIn("image/png", response["Content-Type"])
        body = b"".join(response.streaming_content) if response.streaming else response.content
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_unknown_key_404(self):
        client = Client()
        response = client.get("/api/services/llm/provider-icons/not-a-real-icon")
        self.assertEqual(response.status_code, 404)

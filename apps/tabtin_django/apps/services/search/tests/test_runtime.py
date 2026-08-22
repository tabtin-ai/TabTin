from __future__ import annotations

from django.test import SimpleTestCase, override_settings

from apps.services.search.models import SearchProvider
from apps.services.search.services.runtime import SearchProviderRuntime


class SearchProviderRuntimeTests(SimpleTestCase):
    @override_settings(DOUBAO_SEARCH_API_KEY="env-doubao-key")
    def test_doubao_api_key_ignores_database_override(self):
        provider = SearchProvider(
            provider_type="doubao",
            provider_key="doubao",
            display_name="豆包搜索 Custom 版",
            base_url="https://open.feedcoopapi.com/search_api/web_search",
            api_key="database-key-should-be-ignored",
            api_key_env_name="DOUBAO_SEARCH_API_KEY",
        )

        api_key, source = SearchProviderRuntime.resolve_api_key(provider)

        self.assertEqual(api_key, "env-doubao-key")
        self.assertEqual(source, "env:DOUBAO_SEARCH_API_KEY")

    @override_settings(DOUBAO_SEARCH_API_KEY="")
    def test_mask_api_key_preserves_doubao_env_source_when_unset(self):
        provider = SearchProvider(
            provider_type="doubao",
            provider_key="doubao",
            display_name="豆包搜索 Custom 版",
            base_url="https://open.feedcoopapi.com/search_api/web_search",
            api_key="database-key-should-be-ignored",
            api_key_env_name="CUSTOM_DOUBAO_KEY_SHOULD_BE_IGNORED",
        )

        masked, source = SearchProviderRuntime.mask_api_key(provider)

        self.assertEqual(masked, "未配置")
        self.assertEqual(source, "env:DOUBAO_SEARCH_API_KEY")

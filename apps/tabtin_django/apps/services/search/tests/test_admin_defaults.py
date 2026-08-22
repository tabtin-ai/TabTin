from __future__ import annotations

from django.test import SimpleTestCase, TestCase, override_settings

from apps.services.search.admin_api import _defaults_for_provider_type, create_search_provider
from apps.services.search.admin_schemas import SearchProviderUpsertSchema
from apps.services.search.models import SearchProvider


class SearchAdminDefaultsTests(SimpleTestCase):
    def test_doubao_defaults_use_env_key_and_custom_endpoint(self):
        base_url, env_name = _defaults_for_provider_type("doubao")

        self.assertEqual(base_url, "https://open.feedcoopapi.com/search_api/web_search")
        self.assertEqual(env_name, "DOUBAO_SEARCH_API_KEY")


class SearchAdminProviderSafetyTests(TestCase):
    databases = {"default"}

    @override_settings(DOUBAO_SEARCH_API_KEY="")
    def test_create_doubao_provider_ignores_database_key_and_serializes_env_source(self):
        payload = SearchProviderUpsertSchema(
            provider_type="doubao",
            provider_key="doubao-admin-test",
            display_name="豆包搜索 Custom 版",
            api_key="must-not-be-stored",
            api_key_env_name="CUSTOM_DOUBAO_KEY_SHOULD_BE_IGNORED",
        )

        result = create_search_provider(None, payload)

        provider = SearchProvider.objects.get(provider_key="doubao-admin-test")
        self.assertEqual(provider.base_url, "https://open.feedcoopapi.com/search_api/web_search")
        self.assertEqual(provider.api_key, "")
        self.assertEqual(provider.api_key_env_name, "DOUBAO_SEARCH_API_KEY")
        self.assertEqual(provider.extra_config["variant"], "custom")
        self.assertEqual(result.api_key_source, "env:DOUBAO_SEARCH_API_KEY")
        self.assertEqual(result.api_key_masked, "未配置")

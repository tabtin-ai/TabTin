"""回归：AdminDash 创建 provider 的 type 下拉必须以注册表全量为准。

修复前 ``/admin/provider-types`` 与创建校验都走运行时 DB-first 口径
（``LLMServiceFactory.get_supported_providers()``），导致：DB 里已有 provider 行时，
下拉被框死在现存类型上，新注册但未落库的 provider 类型无法从 UI 创建（鸡生蛋）。
"""

from __future__ import annotations

import inspect
import json
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.llm import api_admin_providers as mod
from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.schemas import AdminProviderCreateRequest


class AdminProviderTypesCatalogTest(SimpleTestCase):
    def test_lists_full_registry_catalog_not_db_first(self):
        expected = set(ProviderRegistry.all_metadata().keys())
        self.assertGreater(len(expected), 2, "注册表应已自动加载多个 provider")

        # 即便运行时 DB-first 口径被人为收窄，创建下拉仍应返回注册表全量。
        with patch(
            "apps.services.llm.services.factory.LLMServiceFactory.get_supported_providers",
            return_value=["moonshot"],
        ):
            resp = mod.admin_list_provider_types(MagicMock())

        names = {item["name"] for item in resp["data"]["provider_types"]}
        self.assertEqual(names, expected)

    def test_normalizes_registry_capabilities_to_public_domains(self):
        """创建表单只能收到可直接保存的公共能力域，不暴露注册表内部别名。"""
        with (
            patch.object(
                ProviderRegistry,
                "all_metadata",
                return_value={
                    "synthetic": {
                        "display_name": "Synthetic",
                        "capability_domains": [
                            "image_gen",
                            "llm",
                            "bgm",
                            "audio_generation",
                            "unknown",
                        ],
                    },
                },
            ),
            patch.object(mod, "list_provider_profiles", return_value=[]),
        ):
            resp = mod.admin_list_provider_types(MagicMock())

        item = resp["data"]["provider_types"][0]
        self.assertEqual(
            item["capability_domains"],
            ["image_gen", "llm", "bgm", "audio_generation", "unknown"],
        )
        self.assertEqual(
            item["recommended_capability_domains"],
            ["chat", "image_gen", "audio_gen"],
        )

    def test_create_validation_gates_on_registry(self):
        """创建校验用 ProviderRegistry 判定类型合法性，而非 DB-first 列表。"""
        source = inspect.getsource(mod.admin_create_provider)
        self.assertIn("ProviderRegistry.is_registered", source)
        self.assertNotIn("get_supported_providers", source)

    def test_create_rejects_same_type_and_endpoint_in_same_scope(self):
        provider_key_query = MagicMock()
        provider_key_query.exists.return_value = False
        endpoint_query = MagicMock()
        endpoint_query.exists.return_value = True
        payload = AdminProviderCreateRequest(
            name="qwen",
            provider_key="qwen-relay-2",
            display_name="Qwen relay 2",
            base_url="https://relay.example.com/v1/",
            api_key="synthetic-test-key",
            capability_domains=["chat"],
            scope="global",
        )

        with (
            patch.object(ProviderRegistry, "is_registered", return_value=True),
            patch.object(
                mod.LLMProvider.objects,
                "filter",
                side_effect=[provider_key_query, endpoint_query],
            ) as filter_mock,
        ):
            response = mod.admin_create_provider(MagicMock(), payload)

        self.assertEqual(response.status_code, 400)
        body = json.loads(response.content)
        self.assertIn("相同服务类型和 API 地址", body["message"])
        endpoint_kwargs = filter_mock.call_args_list[1].kwargs
        self.assertEqual(endpoint_kwargs["name"], "qwen")
        self.assertEqual(endpoint_kwargs["default_base_url"], "https://relay.example.com/v1")

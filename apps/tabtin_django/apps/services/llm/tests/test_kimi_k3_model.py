"""kimi-k3 模型注册与参数适配回归。"""

from __future__ import annotations

from django.test import SimpleTestCase, TestCase

from apps.services.llm.models import LLMModel
from apps.services.llm.utils.param_adaptor import requires_kimi_temperature_one


class KimiK3CatalogTests(TestCase):
    def test_global_moonshot_has_kimi_k3(self):
        model = LLMModel.objects.filter(
            provider__provider_key="moonshot",
            provider__scope="global",
            model_name="kimi-k3",
        ).first()
        self.assertIsNotNone(model)
        self.assertEqual(model.display_name, "Kimi K3")
        self.assertEqual(model.capability_domain, "chat")
        self.assertEqual(model.wave_status, "ready")
        self.assertTrue(model.base_url)


class KimiK3ParamAdaptorTests(SimpleTestCase):
    def test_requires_temperature_one(self):
        self.assertTrue(requires_kimi_temperature_one("kimi-k3"))
        self.assertTrue(requires_kimi_temperature_one("moonshot/kimi-k3"))
        self.assertFalse(requires_kimi_temperature_one("gpt-4o"))

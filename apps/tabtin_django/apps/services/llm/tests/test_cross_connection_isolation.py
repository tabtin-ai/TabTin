"""PR4：两套同协议连接并存时的隔离回归（只测，不改运行时）。"""

from types import SimpleNamespace

from django.test import SimpleTestCase

from ..adapter_resolver import resolve_adapter_name, resolve_provider_adapter
from ..services.billing import _is_byok_provider
from ..services.openai_service import OpenAIService


class CrossConnectionAdapterTests(SimpleTestCase):
    def test_two_openai_compatible_connections_share_openai_adapter(self):
        openrouter = SimpleNamespace(provider_key="openai-openrouter", name="openai")
        siliconflow = SimpleNamespace(provider_key="openai-siliconflow", name="openai")

        self.assertEqual(resolve_adapter_name(openrouter), "openai")
        self.assertEqual(resolve_adapter_name(siliconflow), "openai")
        self.assertIs(resolve_provider_adapter(openrouter), OpenAIService)
        self.assertIs(resolve_provider_adapter(siliconflow), OpenAIService)

    def test_official_openai_key_still_resolves(self):
        provider = SimpleNamespace(provider_key="openai", name="openai")
        self.assertEqual(resolve_adapter_name(provider), "openai")

    def test_kimi_coding_keeps_registered_plan_adapter(self):
        provider = SimpleNamespace(provider_key="kimi_coding", name="moonshot")
        self.assertEqual(resolve_adapter_name(provider), "kimi_coding")


class CrossConnectionBillingTests(SimpleTestCase):
    def test_user_and_org_byok_are_exempt(self):
        user_model = SimpleNamespace(provider=SimpleNamespace(scope="user", provider_key="openai-openrouter"))
        org_model = SimpleNamespace(provider=SimpleNamespace(scope="organization", provider_key="openai-siliconflow"))
        platform = SimpleNamespace(provider=SimpleNamespace(scope="global", provider_key="openai"))

        self.assertTrue(_is_byok_provider(user_model))
        self.assertTrue(_is_byok_provider(org_model))
        self.assertFalse(_is_byok_provider(platform))


class CrossConnectionSourceAuditTests(SimpleTestCase):
    """用源码断言钉住已知旁路，避免下次审计重读整文件。"""

    def test_factory_degraded_switch_does_not_lock_provider(self):
        from pathlib import Path

        source = Path(__file__).resolve().parents[1].joinpath("services/factory.py").read_text()
        start = source.find("R5: degraded")
        self.assertGreater(start, 0)
        chunk = source[start:start + 500]
        self.assertIn("select_model_from_pool", chunk)
        self.assertIn("model_name=model.model_name", chunk)
        self.assertNotIn("provider_key=", chunk)
        self.assertNotIn("provider_id", chunk)

    def test_proxy_does_not_switch_on_health(self):
        from pathlib import Path

        source = Path(__file__).resolve().parents[1].joinpath("services/proxy_service.py").read_text()
        self.assertNotIn("select_model_from_pool", source)
        self.assertIn("def resolve_proxy_model", source)

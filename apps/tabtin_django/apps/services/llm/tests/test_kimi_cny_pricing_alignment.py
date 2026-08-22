"""Kimi 定价对齐验证（migration 0040）。

测试库由完整迁移链构建，因此这里的断言等价于验证：
0032/0034 写入的美元数字被 0040 纠正为国内站人民币牌价，
且 kimi-k2.7-code 已被转正为有代码基线的模型。

牌价来源 https://platform.kimi.com/（2026-07-13 核对）。
若 Kimi 官方调价，先改 0040 之后的新 migration / 后台价格，再同步本测试。
"""

from decimal import Decimal

from django.test import TestCase

from apps.services.llm.models import LLMModel


EXPECTED_PRICES = {
    # model_name: (input/1k, output/1k, cache_read/1k)
    "kimi-k2.5": (Decimal("0.004"), Decimal("0.021"), "0.0007"),
    "kimi-k2.6": (Decimal("0.0065"), Decimal("0.027"), "0.0011"),
    "kimi-k2.7-code": (Decimal("0.0065"), Decimal("0.027"), "0.0013"),
    # 0051：https://platform.kimi.com/docs/pricing/chat-k3.md（2026-07-31）
    "kimi-k3": (Decimal("0.02"), Decimal("0.1"), "0.002"),
}


class KimiCnyPricingAlignmentTests(TestCase):
    def _get_model(self, model_name: str) -> LLMModel:
        model = LLMModel.objects.filter(
            provider__provider_key="moonshot",
            provider__scope="global",
            model_name=model_name,
        ).first()
        self.assertIsNotNone(model, f"缺少全局 moonshot 模型 {model_name}")
        return model

    def test_prices_match_kimi_cn_list_prices(self):
        for model_name, (input_price, output_price, cache_price) in EXPECTED_PRICES.items():
            with self.subTest(model=model_name):
                model = self._get_model(model_name)
                self.assertEqual(
                    Decimal(model.input_price_per_1k), input_price,
                    f"{model_name} 输入价与国内站牌价不符",
                )
                self.assertEqual(
                    Decimal(model.output_price_per_1k), output_price,
                    f"{model_name} 输出价与国内站牌价不符",
                )
                self.assertEqual(
                    (model.custom_billing_config or {}).get(
                        "cache_read_input_price_per_1k"
                    ),
                    cache_price,
                    f"{model_name} 缓存命中价与国内站牌价不符",
                )

    def test_k27_code_inherits_k26_capabilities(self):
        k26 = self._get_model("kimi-k2.6")
        k27 = self._get_model("kimi-k2.7-code")
        self.assertEqual(k27.base_url, k26.base_url)
        self.assertTrue(k27.capabilities_config, "k2.7-code 能力声明不应为空")
        self.assertEqual(k27.capability_domain, "chat")
        self.assertEqual(k27.billing_type, "token")

    def test_kimi_k3_uses_reasoning_effort_not_thinking(self):
        k3 = self._get_model("kimi-k3")
        self.assertEqual(k3.context_window_tokens, 1_048_576)
        self.assertEqual(k3.max_output_tokens, 131_072)
        caps = k3.capabilities_config or {}
        wire = caps.get("wire_adapter") or {}
        reasoning = wire.get("reasoning") or {}
        self.assertEqual(reasoning.get("param_path"), "reasoning_effort")
        self.assertEqual(reasoning.get("budget_param"), "reasoning_effort")
        self.assertEqual(caps.get("reasoning_history_roundtrip"), "preserve")

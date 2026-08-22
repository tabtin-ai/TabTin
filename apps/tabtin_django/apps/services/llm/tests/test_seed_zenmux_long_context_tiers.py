"""seed_zenmux_long_context_tiers 命令的核心逻辑测试。

不走数据库与 management.call_command（避免 DB fixture 依赖），
直接对纯函数 _should_seed_model + _build_zenmux_long_context_tiers
做白盒测试。

覆盖：
  - 白名单匹配（sonnet-4-5 / sonnet-4.5 / sonnet-4-20*）
  - 黑名单覆盖白名单（4.6 / 4.7 即使匹配也跳过 — 1M GA 不需档位）
  - 大小写不敏感
  - 档位结构与 ZenMux 官方契约一致（standard 不带价、long_1m 带 beta header + over 单价）
  - over 单价 = base × 倍率（input ×2、output ×1.5）
"""

from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.services.llm.management.commands.seed_zenmux_long_context_tiers import (
    LONG_CONTEXT_BETA_HEADER_KEY,
    LONG_CONTEXT_BETA_HEADER_VALUE,
    ZENMUX_LONG_CONTEXT_OVER_RATIOS,
    _build_zenmux_long_context_tiers,
    _existing_tiers,
    _should_seed_model,
)


class TestShouldSeedModel(SimpleTestCase):
    """白名单 ∩ 非黑名单 的匹配规则。"""

    def test_matches_zenmux_sonnet_4_5_dot_naming(self):
        self.assertTrue(_should_seed_model("anthropic/claude-sonnet-4.5"))

    def test_matches_anthropic_native_sonnet_4_5_dash_naming(self):
        """Anthropic native model_name 用横线（claude-sonnet-4-5-20250929）。"""
        self.assertTrue(_should_seed_model("claude-sonnet-4-5-20250929"))

    def test_matches_legacy_sonnet_4_with_date_suffix(self):
        """Sonnet 4 版本号格式如 claude-sonnet-4-20250514。"""
        self.assertTrue(_should_seed_model("claude-sonnet-4-20250514"))
        self.assertTrue(_should_seed_model("zenmux/anthropic/claude-sonnet-4-20250514"))

    def test_excludes_sonnet_4_6_even_if_dot_matches(self):
        """Sonnet 4.6 / Opus 4.6 1M 已 GA → 强制跳过。
        这是本命令最重要的一条防御：避免给 GA 模型加上多余的档位机制。"""
        self.assertFalse(_should_seed_model("anthropic/claude-sonnet-4.6"))
        self.assertFalse(_should_seed_model("claude-sonnet-4-6-20260301"))
        self.assertFalse(_should_seed_model("anthropic/claude-opus-4.6"))
        self.assertFalse(_should_seed_model("claude-opus-4-6-20260210"))

    def test_excludes_future_4_7_models(self):
        """同理 Opus 4.7 / Sonnet 4.7 — 标准价覆盖 1M。"""
        self.assertFalse(_should_seed_model("anthropic/claude-opus-4.7"))
        self.assertFalse(_should_seed_model("claude-sonnet-4-7-20260415"))

    def test_skips_unrelated_models(self):
        self.assertFalse(_should_seed_model("anthropic/claude-haiku-4.5"))
        self.assertFalse(_should_seed_model("openai/gpt-4o"))
        self.assertFalse(_should_seed_model("claude-3.7-sonnet"))
        self.assertFalse(_should_seed_model(""))
        self.assertFalse(_should_seed_model(None))  # type: ignore[arg-type]

    def test_case_insensitive(self):
        self.assertTrue(_should_seed_model("Anthropic/Claude-Sonnet-4.5"))
        self.assertFalse(_should_seed_model("Anthropic/Claude-Sonnet-4.6"))


class TestBuildZenmuxLongContextTiers(SimpleTestCase):
    """档位结构与单价倍率必须严格对齐 ZenMux 官方协议。
    错一行就会让运营把账记错或让 1M 静默失效，所以这里盯紧每个字段。"""

    def _model(self, *, input_price: str, output_price: str) -> SimpleNamespace:
        return SimpleNamespace(
            input_price_per_1k=Decimal(input_price),
            output_price_per_1k=Decimal(output_price),
        )

    def test_standard_tier_is_default_with_no_explicit_price(self):
        """standard 档不写价格 → resolve_tiered_pricing 命中后会 fallback
        到模型基础单价。这是「单一价格源」的设计。"""
        tiers = _build_zenmux_long_context_tiers(
            self._model(input_price="0.003", output_price="0.015"),
        )
        std = tiers[0]
        self.assertEqual(std["id"], "standard")
        self.assertTrue(std["is_default"])
        self.assertEqual(std["max_input_tokens"], 200000)
        self.assertNotIn("input_price_per_1k", std)
        self.assertNotIn("output_price_per_1k", std)

    def test_long_1m_tier_has_beta_header_and_over_pricing(self):
        tiers = _build_zenmux_long_context_tiers(
            self._model(input_price="0.003", output_price="0.015"),
        )
        long_tier = tiers[1]
        self.assertEqual(long_tier["id"], "long_1m")
        self.assertNotIn("is_default", long_tier)
        self.assertEqual(long_tier["max_input_tokens"], 1000000)
        self.assertEqual(long_tier["tags"], ["beta"])

        # Beta header 必须就是 ZenMux 文档约定的那个 key/value 对，错一个字符 1M 就启不动
        self.assertEqual(
            long_tier["extra_headers"],
            {LONG_CONTEXT_BETA_HEADER_KEY: LONG_CONTEXT_BETA_HEADER_VALUE},
        )
        self.assertEqual(LONG_CONTEXT_BETA_HEADER_KEY, "anthropic-beta")
        self.assertEqual(LONG_CONTEXT_BETA_HEADER_VALUE, "context-1m-2025-08-07")

        # 档内分裂阈值 = 200K（ZenMux/Anthropic 官方）
        self.assertEqual(long_tier["applies_above_tokens"], 200000)

        # 倍率：input ×2 / output ×1.5
        self.assertEqual(ZENMUX_LONG_CONTEXT_OVER_RATIOS["input"], Decimal("2.0"))
        self.assertEqual(ZENMUX_LONG_CONTEXT_OVER_RATIOS["output"], Decimal("1.5"))
        self.assertEqual(
            Decimal(long_tier["over_input_price_per_1k"]),
            Decimal("0.006000"),  # 0.003 × 2
        )
        self.assertEqual(
            Decimal(long_tier["over_output_price_per_1k"]),
            Decimal("0.022500"),  # 0.015 × 1.5
        )

    def test_over_pricing_quantizes_to_six_decimals(self):
        """LLMModel.input_price_per_1k 是 decimal_places=6，
        我们写入的 over 单价也必须 ≤ 6 位，否则触发 DB 校验/截断。"""
        tiers = _build_zenmux_long_context_tiers(
            # 0.0033333 × 2 = 0.0066666 → 应被规整成 0.006667
            self._model(input_price="0.003333", output_price="0.011111"),
        )
        over_input = tiers[1]["over_input_price_per_1k"]
        # 6 位精度
        self.assertLessEqual(
            len(over_input.split(".")[-1] if "." in over_input else ""),
            6,
        )

    def test_handles_zero_base_price_without_crash(self):
        """新建模型未填基础价时 base_price=0，不能崩，over 单价应为 0。"""
        tiers = _build_zenmux_long_context_tiers(
            self._model(input_price="0", output_price="0"),
        )
        long_tier = tiers[1]
        self.assertEqual(Decimal(long_tier["over_input_price_per_1k"]), Decimal("0"))
        self.assertEqual(Decimal(long_tier["over_output_price_per_1k"]), Decimal("0"))


class TestExistingTiersDetection(SimpleTestCase):
    """_existing_tiers 用于幂等判断（已有 tiers 时不覆盖）。"""

    def test_returns_empty_for_missing_or_invalid(self):
        self.assertEqual(_existing_tiers({}), [])
        self.assertEqual(_existing_tiers({"tiered_pricing": None}), [])
        self.assertEqual(_existing_tiers({"tiered_pricing": "not-a-dict"}), [])
        self.assertEqual(_existing_tiers({"tiered_pricing": {"tiers": "not-list"}}), [])

    def test_returns_existing_tiers_list(self):
        existing = [{"id": "custom", "max_input_tokens": 500000}]
        self.assertEqual(
            _existing_tiers({"tiered_pricing": {"tiers": existing}}),
            existing,
        )

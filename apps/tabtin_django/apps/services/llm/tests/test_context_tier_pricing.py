"""上下文档位（Context Tier）解析与计费测试。

覆盖 long_context_tier 总控方案的核心计费契约：
  - resolve_tier_by_id / resolve_default_tier / resolve_tiered_pricing
    三条解析路径的优先级（显式 tier_id 优先 → 默认档 → 按 token 自动选档）
  - compute_tier_token_cost 的「档内分裂」（applies_above_tokens + over_*）
    保证 ≤ 阈值走标准价、> 阈值走加价，对齐 ZenMux 1M 计价协议

所有 tier 都是纯 dict，不依赖 DB / Django ORM，走 SimpleTestCase。

注：本文件独立于 test_billing_service.py，因为后者整文件在 conftest
的 _INFRA_DRIFT 名册内会被自动打 infra_drift marker 跳过，但这里的档位
计费逻辑是新近落地且需要 CI 常驻保护的。
"""

from decimal import Decimal

from django.test import SimpleTestCase

from apps.services.llm.services.billing import (
    compute_tier_token_cost,
    get_model_context_tiers,
    resolve_default_tier,
    resolve_tier_by_id,
    resolve_tiered_pricing,
)


class TestContextTierResolution(SimpleTestCase):
    """get_model_context_tiers / resolve_tier_by_id / resolve_default_tier /
    resolve_tiered_pricing 四条路径的语义验证。"""

    def _billing_with_tiers(self) -> dict:
        return {
            "tiered_pricing": {
                "tiers": [
                    {
                        "id": "standard",
                        "label": "标准 (200K)",
                        "is_default": True,
                        "max_input_tokens": 200000,
                        "input_price_per_1k": "0.015",
                        "output_price_per_1k": "0.075",
                    },
                    {
                        "id": "long_1m",
                        "label": "长上下文 (1M, Beta)",
                        "max_input_tokens": 1000000,
                        "input_price_per_1k": "0.015",
                        "output_price_per_1k": "0.075",
                        "applies_above_tokens": 200000,
                        "over_input_price_per_1k": "0.030",
                        "over_output_price_per_1k": "0.1125",
                        "extra_headers": {
                            "anthropic-beta": "context-1m-2025-08-07",
                        },
                        "tags": ["beta"],
                    },
                ],
            },
        }

    # ─── get_model_context_tiers ──────────────────────────────────────────

    def test_get_tiers_returns_empty_for_missing_config(self):
        self.assertEqual(get_model_context_tiers({}), [])
        self.assertEqual(get_model_context_tiers({"tiered_pricing": {}}), [])
        self.assertEqual(get_model_context_tiers(None), [])

    def test_get_tiers_normalizes_legacy_tiers_without_id(self):
        """旧数据 tiers 无 id/label 时：id 补 tier_N，label 根据 max_input_tokens
        智能生成（200K / 1M），而不是无意义的"档位 1"。

        这条断言是 2026-04 的真实用户反馈驱动的修正：旧阶梯计费数据
        （Gemini/Qwen/Claude 4.6 等）从未配过 label，以前用户看到一堆
        "档位 1 档位 2" 毫无意义。现在回退到 token 数智能 label。
        """
        config = {
            "tiered_pricing": {
                "tiers": [
                    {"max_input_tokens": 200000, "input_price_per_1k": "0.01"},
                    {"max_input_tokens": 1000000, "input_price_per_1k": "0.02"},
                ],
            },
        }
        tiers = get_model_context_tiers(config)
        self.assertEqual(len(tiers), 2)
        self.assertEqual(tiers[0]["id"], "tier_0")
        self.assertEqual(tiers[0]["label"], "200K")
        self.assertEqual(tiers[1]["id"], "tier_1")
        self.assertEqual(tiers[1]["label"], "1M")

    def test_get_tiers_smart_label_handles_non_round_tokens(self):
        """1048576 token ≈ 1M、131072 ≈ 128K（Gemini / Qwen 常见数字）
        要就近吸附到整数 M/K，否则用户会看到"1048K"这种丑怪值。"""
        config = {
            "tiered_pricing": {
                "tiers": [
                    {"max_input_tokens": 131072},
                    {"max_input_tokens": 262144},
                    {"max_input_tokens": 1048576},
                ],
            },
        }
        tiers = get_model_context_tiers(config)
        self.assertEqual([t["label"] for t in tiers], ["128K", "256K", "1M"])

    def test_get_tiers_smart_label_half_million_keeps_decimal(self):
        """500_000 tokens 应该显示 0.5M（或 500K，取哪种都行但不能变成无意义字符串）。
        当前实现选 500K（未达 1M 走 K 分支）。"""
        config = {
            "tiered_pricing": {
                "tiers": [
                    {"max_input_tokens": 500000},
                    {"max_input_tokens": 1500000},
                ],
            },
        }
        tiers = get_model_context_tiers(config)
        self.assertEqual(tiers[0]["label"], "500K")
        # 1.5M 非整数 M，应保留 1 位小数
        self.assertEqual(tiers[1]["label"], "1.5M")

    def test_get_tiers_smart_label_falls_back_when_max_tokens_missing(self):
        """max_input_tokens 缺失时才回退到"档位 N"——这是真正的最后兜底。"""
        config = {
            "tiered_pricing": {
                "tiers": [{"input_price_per_1k": "0.01"}],
            },
        }
        tiers = get_model_context_tiers(config)
        self.assertEqual(tiers[0]["label"], "档位 1")

    # ─── resolve_tier_by_id ───────────────────────────────────────────────

    def test_resolve_tier_by_id_hits(self):
        tier = resolve_tier_by_id(self._billing_with_tiers(), "long_1m")
        self.assertIsNotNone(tier)
        self.assertEqual(tier["id"], "long_1m")
        self.assertEqual(
            tier["extra_headers"], {"anthropic-beta": "context-1m-2025-08-07"},
        )

    def test_resolve_tier_by_id_miss_returns_none(self):
        self.assertIsNone(resolve_tier_by_id(self._billing_with_tiers(), "nope"))
        self.assertIsNone(resolve_tier_by_id(self._billing_with_tiers(), None))
        self.assertIsNone(resolve_tier_by_id(self._billing_with_tiers(), ""))

    # ─── resolve_default_tier ─────────────────────────────────────────────

    def test_resolve_default_tier_prefers_is_default_flag(self):
        tier = resolve_default_tier(self._billing_with_tiers())
        self.assertIsNotNone(tier)
        self.assertEqual(tier["id"], "standard")

    def test_resolve_default_tier_falls_back_to_first_when_no_flag(self):
        config = {
            "tiered_pricing": {
                "tiers": [
                    {"id": "a", "max_input_tokens": 100},
                    {"id": "b", "max_input_tokens": 1000},
                ],
            },
        }
        tier = resolve_default_tier(config)
        self.assertEqual(tier["id"], "a")

    def test_resolve_default_tier_returns_none_for_empty(self):
        self.assertIsNone(resolve_default_tier({}))

    # ─── resolve_tiered_pricing ───────────────────────────────────────────

    def test_resolve_tiered_pricing_explicit_id_wins_over_token_match(self):
        """用户主动锁档 long_1m 时，即便输入只有 5k tokens，也要走 long_1m 档。
        这是计费语义的第一条铁律：user intent > auto-selection。"""
        tier = resolve_tiered_pricing(
            self._billing_with_tiers(), total_input_tokens=5000, tier_id="long_1m",
        )
        self.assertIsNotNone(tier)
        self.assertEqual(tier["id"], "long_1m")

    def test_resolve_tiered_pricing_missed_id_falls_back_to_token_match(self):
        """tier_id 拼错时降级到按用量自动选档，保证计费链路不因脏数据崩溃。"""
        tier = resolve_tiered_pricing(
            self._billing_with_tiers(), total_input_tokens=50000, tier_id="typo_id",
        )
        self.assertIsNotNone(tier)
        self.assertEqual(tier["id"], "standard")

    def test_resolve_tiered_pricing_token_based_auto_selects_smallest_fit(self):
        tier = resolve_tiered_pricing(
            self._billing_with_tiers(), total_input_tokens=150000,
        )
        self.assertEqual(tier["id"], "standard")

        tier = resolve_tiered_pricing(
            self._billing_with_tiers(), total_input_tokens=500000,
        )
        self.assertEqual(tier["id"], "long_1m")

    def test_resolve_tiered_pricing_over_last_tier_returns_largest(self):
        """超过最大档位的请求也应回落到最大档，不能返回 None 导致计费塌方。"""
        tier = resolve_tiered_pricing(
            self._billing_with_tiers(), total_input_tokens=5_000_000,
        )
        self.assertEqual(tier["id"], "long_1m")

    def test_resolve_tiered_pricing_no_tiers_returns_none(self):
        self.assertIsNone(
            resolve_tiered_pricing({}, total_input_tokens=100, tier_id="long_1m"),
        )


class TestComputeTierTokenCost(SimpleTestCase):
    """compute_tier_token_cost 的档内分裂语义。

    ZenMux 风格：同档内 ≤ applies_above_tokens 按 input_price_per_1k，
    > applies_above_tokens 按 over_input_price_per_1k；输入/输出各自独立。
    """

    def _long_tier(self) -> dict:
        return {
            "id": "long_1m",
            "input_price_per_1k": "0.015",
            "output_price_per_1k": "0.075",
            "applies_above_tokens": 200000,
            "over_input_price_per_1k": "0.030",
            "over_output_price_per_1k": "0.1125",
        }

    def _assert_money_equal(self, actual: Decimal, expected: str) -> None:
        """按分对齐（4 位小数足够覆盖 LLM 计费精度需求）。"""
        self.assertEqual(
            actual.quantize(Decimal("0.0001")),
            Decimal(expected).quantize(Decimal("0.0001")),
        )

    def test_below_threshold_uses_base_price(self):
        """100K tokens 未超 200K 阈值 → 全量走 0.015 / 1K。"""
        cost = compute_tier_token_cost(
            self._long_tier(), 100_000, direction="input", fallback_price=Decimal("1"),
        )
        # 100_000 * 0.015 / 1000 = 1.5
        self._assert_money_equal(cost, "1.5")

    def test_above_threshold_splits_price(self):
        """300K tokens：前 200K 走 0.015（=3）、后 100K 走 0.030（=3），共 6.0。
        ZenMux 档内分裂计价的核心协议，错一分钱线上就会被吃穿。"""
        cost = compute_tier_token_cost(
            self._long_tier(), 300_000, direction="input", fallback_price=Decimal("1"),
        )
        # 200_000 * 0.015 / 1000 = 3.0
        # 100_000 * 0.030 / 1000 = 3.0
        self._assert_money_equal(cost, "6.0")

    def test_output_split_independent_from_input(self):
        """输出方向的档内分裂独立于输入，读取 over_output_price_per_1k。"""
        cost = compute_tier_token_cost(
            self._long_tier(), 250_000, direction="output", fallback_price=Decimal("1"),
        )
        # 200_000 * 0.075 / 1000 = 15.0
        # 50_000 * 0.1125 / 1000 = 5.625
        self._assert_money_equal(cost, "20.625")

    def test_without_over_price_stays_flat(self):
        """仅配 applies_above_tokens 没配 over 单价时退化为单一价（不分裂）。
        防御：避免运营漏填 over 单价后，300K 按 300K × 0.015 少收费。"""
        tier = {
            "id": "flat",
            "input_price_per_1k": "0.010",
            "applies_above_tokens": 200000,
        }
        cost = compute_tier_token_cost(
            tier, 300_000, direction="input", fallback_price=Decimal("1"),
        )
        # 300_000 * 0.010 / 1000 = 3.0 (整段按基础价)
        self._assert_money_equal(cost, "3.0")

    def test_zero_tokens_returns_zero(self):
        cost = compute_tier_token_cost(
            self._long_tier(), 0, direction="input", fallback_price=Decimal("1"),
        )
        self.assertEqual(cost, Decimal("0"))

    def test_falls_back_when_no_price(self):
        """档位未配 input_price_per_1k 时使用调用方传入的 fallback_price。
        计费链路的最后兜底，避免返回 0 导致平台倒贴。"""
        tier = {"id": "no_price"}
        cost = compute_tier_token_cost(
            tier, 1000, direction="input", fallback_price=Decimal("0.05"),
        )
        # 1000 * 0.05 / 1000 = 0.05
        self._assert_money_equal(cost, "0.05")

"""ChatSession 档位切换 API 的核心校验测试。

两个档位切换入口都会走 `_validate_context_tier_for_model`：
  - PUT /sessions/{sid}/model       （切模型同时锁档）
  - PUT /sessions/{sid}/context-tier（仅切档）

此函数是「档位 ID 是否合法」的唯一真相来源，逻辑出错就会让
用户切到不存在的档位、或拒绝掉合法档位，直接影响 1M 上下文是否启用。

这里用 SimpleNamespace mock model_instance，不走 DB / HTTP 层，
保证测试快且无 fixture 依赖。
"""

from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.chat.conversation.api.session import _validate_context_tier_for_model


def _model_with_tiers(tiers: list[dict] | None) -> SimpleNamespace:
    if tiers is None:
        return SimpleNamespace(model_name="m", custom_billing_config={})
    return SimpleNamespace(
        model_name="m",
        custom_billing_config={"tiered_pricing": {"tiers": tiers}},
    )


class TestValidateContextTierForModel(SimpleTestCase):
    def test_returns_tier_id_when_present(self):
        model = _model_with_tiers([
            {"id": "standard", "is_default": True, "max_input_tokens": 200000},
            {"id": "long_1m", "max_input_tokens": 1000000},
        ])
        self.assertEqual(
            _validate_context_tier_for_model(model, "long_1m"), "long_1m",
        )
        self.assertEqual(
            _validate_context_tier_for_model(model, "standard"), "standard",
        )

    def test_returns_none_when_id_missing(self):
        """tier_id 不存在 → API 回 400，避免脏数据写入 ChatSession。"""
        model = _model_with_tiers([
            {"id": "standard", "is_default": True, "max_input_tokens": 200000},
        ])
        self.assertIsNone(_validate_context_tier_for_model(model, "long_1m"))

    def test_returns_none_when_model_has_no_tiers(self):
        model = _model_with_tiers(None)
        self.assertIsNone(_validate_context_tier_for_model(model, "long_1m"))

    def test_handles_model_without_custom_billing_config(self):
        """老模型没有 custom_billing_config 属性时不崩。"""
        model = SimpleNamespace(model_name="legacy")
        self.assertIsNone(_validate_context_tier_for_model(model, "long_1m"))

    def test_matches_normalized_legacy_tier_id(self):
        """旧 tier 无 id 时会被 billing.get_model_context_tiers 补 tier_0，
        允许用户按补全后的 id 切档（否则会永远找不到）。"""
        model = _model_with_tiers([
            {"max_input_tokens": 200000, "input_price_per_1k": "0.01"},
            {"max_input_tokens": 1000000, "input_price_per_1k": "0.02"},
        ])
        self.assertEqual(
            _validate_context_tier_for_model(model, "tier_0"), "tier_0",
        )
        self.assertEqual(
            _validate_context_tier_for_model(model, "tier_1"), "tier_1",
        )

"""_serialize_context_tiers_for_client 的核心判断：is_user_selectable。

这是 2026-04 的用户反馈驱动测试：用户看到 Gemini / Qwen / Claude 4.6
这种**仅有阶梯计价但不该让用户切档**的模型也在 UI 上显示切档芯片，
芯片内容还是"档位 1 / 档位 2"，非常丢脸。

根因是客户端只要看到 context_tiers.length > 1 就画芯片，完全没区分：
  - 自动阶梯计价（Gemini/Qwen/旧 Claude 1M 价差）
  - 用户主动切档（ZenMux Claude Sonnet 4 / 4.5 的 1M Beta）

本文件固定 is_user_selectable 的判断契约，避免回归。
"""

from django.test import SimpleTestCase

from apps.services.llm.services.factory import (
    _compute_tiers_user_selectable,
    _serialize_context_tiers_for_client,
    _serialize_runtime_controls_for_client,
)


class TestIsUserSelectable(SimpleTestCase):
    """_compute_tiers_user_selectable 规则：
    ≥2 档 且（任一档有 extra_headers / tags / 显式 is_default=True）→ True。"""

    def test_single_tier_never_selectable(self):
        """单档没得选 → False。"""
        self.assertFalse(_compute_tiers_user_selectable([]))
        self.assertFalse(_compute_tiers_user_selectable([
            {"id": "only", "max_input_tokens": 200000},
        ]))

    def test_pure_auto_tier_hidden(self):
        """Gemini / Qwen / Claude 4.6 当前 DB 形态：两三档只有 max_input_tokens
        + 价格，没 extra_headers / tags / is_default → 必须判为不可切换。
        这是这次修复的核心 case。"""
        gemini_like = [
            {"max_input_tokens": 200000, "input_price_per_1k": "0.002"},
            {"max_input_tokens": 1048576, "input_price_per_1k": "0.004"},
        ]
        self.assertFalse(_compute_tiers_user_selectable(gemini_like))

    def test_extra_headers_marks_selectable(self):
        """ZenMux Claude Sonnet 4 的 1M Beta：long_1m 档有 anthropic-beta
        header → 整组可切换（用户需明确选）。"""
        tiers = [
            {"id": "standard", "is_default": True, "max_input_tokens": 200000},
            {
                "id": "long_1m",
                "max_input_tokens": 1000000,
                "extra_headers": {"anthropic-beta": "context-1m-2025-08-07"},
            },
        ]
        self.assertTrue(_compute_tiers_user_selectable(tiers))

    def test_tags_mark_selectable(self):
        """运营只打 tags=['beta'] 也算明确区分 → 可切换。"""
        tiers = [
            {"id": "stable", "max_input_tokens": 100000},
            {"id": "preview", "max_input_tokens": 100000, "tags": ["beta"]},
        ]
        self.assertTrue(_compute_tiers_user_selectable(tiers))

    def test_explicit_is_default_marks_selectable(self):
        """运营刻意配了 is_default=True（即使没 headers/tags）→ 可切换。
        这是"运营主动设计了默认档"的信号。"""
        tiers = [
            {"id": "cheap", "is_default": True, "max_input_tokens": 100000},
            {"id": "expensive", "max_input_tokens": 500000},
        ]
        self.assertTrue(_compute_tiers_user_selectable(tiers))

    def test_empty_tags_dont_mark_selectable(self):
        """tags=[] 不算配置，不应触发可切换。"""
        tiers = [
            {"id": "a", "max_input_tokens": 100000, "tags": []},
            {"id": "b", "max_input_tokens": 500000, "tags": []},
        ]
        self.assertFalse(_compute_tiers_user_selectable(tiers))

    def test_empty_extra_headers_dont_mark_selectable(self):
        """extra_headers={} 空 dict 不算配置。"""
        tiers = [
            {"id": "a", "max_input_tokens": 100000, "extra_headers": {}},
            {"id": "b", "max_input_tokens": 500000},
        ]
        self.assertFalse(_compute_tiers_user_selectable(tiers))


class TestSerializeContextTiersForClient(SimpleTestCase):
    """端到端：custom_billing_config → 下发给客户端的 tier dict 列表。"""

    def test_serialize_attaches_is_user_selectable_to_each_tier(self):
        """同组所有 tier 上的 is_user_selectable 值相同（整组一致）。
        客户端这样只看第一档就能决定是否渲染芯片。"""
        config = {
            "tiered_pricing": {
                "tiers": [
                    {"id": "standard", "is_default": True, "max_input_tokens": 200000},
                    {
                        "id": "long_1m",
                        "max_input_tokens": 1000000,
                        "extra_headers": {"anthropic-beta": "context-1m-2025-08-07"},
                        "tags": ["beta"],
                    },
                ],
            },
        }
        serialized = _serialize_context_tiers_for_client(config)
        self.assertEqual(len(serialized), 2)
        self.assertTrue(serialized[0]["is_user_selectable"])
        self.assertTrue(serialized[1]["is_user_selectable"])

    def test_serialize_marks_legacy_auto_tiers_not_selectable(self):
        """Gemini 真实 DB 形态：纯计价阶梯 → is_user_selectable=False。"""
        config = {
            "tiered_pricing": {
                "tiers": [
                    {"max_input_tokens": 200000, "input_price_per_1k": "0.002"},
                    {"max_input_tokens": 1048576, "input_price_per_1k": "0.004"},
                ],
            },
        }
        serialized = _serialize_context_tiers_for_client(config)
        self.assertEqual(len(serialized), 2)
        self.assertFalse(serialized[0]["is_user_selectable"])
        self.assertFalse(serialized[1]["is_user_selectable"])

    def test_serialize_smart_label_applied_when_label_missing(self):
        """旧数据没 label → 下发的 label 必须是 '200K' / '1M' 而不是 '档位 1'。
        即使前端因 is_user_selectable=False 不显示芯片，
        AdminDash 等其他界面可能仍会展示，label 不能脏。"""
        config = {
            "tiered_pricing": {
                "tiers": [
                    {"max_input_tokens": 200000, "input_price_per_1k": "0.002"},
                    {"max_input_tokens": 1000000, "input_price_per_1k": "0.004"},
                ],
            },
        }
        serialized = _serialize_context_tiers_for_client(config)
        self.assertEqual([t["label"] for t in serialized], ["200K", "1M"])

    def test_serialize_redacts_extra_headers(self):
        """安全：下发时不暴露 extra_headers 的 key/value，
        只留布尔 has_extra_headers。"""
        config = {
            "tiered_pricing": {
                "tiers": [
                    {"id": "a", "is_default": True, "max_input_tokens": 100000},
                    {
                        "id": "b",
                        "max_input_tokens": 500000,
                        "extra_headers": {"anthropic-beta": "context-1m-2025-08-07"},
                    },
                ],
            },
        }
        serialized = _serialize_context_tiers_for_client(config)
        for tier in serialized:
            self.assertNotIn("extra_headers", tier)
        self.assertFalse(serialized[0]["has_extra_headers"])
        self.assertTrue(serialized[1]["has_extra_headers"])

    def test_serialize_handles_empty_config(self):
        self.assertEqual(_serialize_context_tiers_for_client({}), [])
        self.assertEqual(_serialize_context_tiers_for_client({"tiered_pricing": {}}), [])


class TestSerializeRuntimeControlsForClient(SimpleTestCase):
    def test_configured_runtime_controls_win(self):
        controls = _serialize_runtime_controls_for_client(
            {
                "runtime_controls": [
                    {
                        "key": "verbosity",
                        "label": "详细程度",
                        "description": "控制回答展开程度。",
                        "kind": "select",
                        "options": [
                            {"value": None, "label": "默认"},
                            {
                                "value": "concise",
                                "label": "简洁",
                                "description": "更短的回答。",
                            },
                        ],
                    },
                ],
            },
            {},
        )

        self.assertEqual(controls[0]["key"], "verbosity")
        self.assertEqual(controls[0]["description"], "控制回答展开程度。")
        self.assertEqual(controls[0]["options"][1]["value"], "concise")
        self.assertEqual(controls[0]["options"][1]["description"], "更短的回答。")

    def test_non_select_runtime_controls_are_ignored(self):
        controls = _serialize_runtime_controls_for_client(
            {
                "runtime_controls": [
                    {
                        "key": "thinking_enabled",
                        "label": "思考",
                        "kind": "toggle",
                    },
                ],
            },
            {},
        )

        self.assertEqual(controls, [])

    def test_wire_adapter_reasoning_does_not_derive_runtime_controls(self):
        controls = _serialize_runtime_controls_for_client(
            {
                "supports_reasoning": True,
                "wire_adapter": {
                    "reasoning": {
                        "param_path": "reasoning_effort",
                    },
                },
            },
            {"supports_reasoning": True},
        )

        self.assertEqual(controls, [])

    def test_implicit_reasoning_has_no_clickable_control(self):
        controls = _serialize_runtime_controls_for_client(
            {
                "supports_reasoning": True,
                "wire_adapter": {
                    "reasoning": {
                        "param_path": None,
                    },
                },
            },
            {"supports_reasoning": True},
        )

        self.assertEqual(controls, [])

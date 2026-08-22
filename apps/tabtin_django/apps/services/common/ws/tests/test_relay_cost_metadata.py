"""
relay_message_writer 计费 metadata 提取（纯函数）测试。

背景：cost 是 per-turn（每次 runtime.query() 的 cost_usd），只活在 DONE 事件里；
历史上只在前端活态内存（renderer onDone）写过 metadata.credits_consumed，从没落库
→ 重开历史对话费用标注全部消失（ring tooltip 退化成「预估费用」）。

本文件只覆盖**纯函数** `_extract_billing_metadata_from_usage`（无 DB，本地 + CI 都跑）。
落库归属 / 幂等的 DB 测试在 `test_relay_cost_metadata_db.py`（需真 MySQL，本地 sqlite
跑不动 services_billing 的 MySQL-only DDL，已登记 conftest `_REQUIRES_PG_NATIVE`）。
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.ws.handlers.relay_message_writer import (  # noqa: E402
    _extract_billing_metadata_from_usage,
    _extract_per_call_usage_json_from_done,
)


class ExtractBillingMetadataTests(SimpleTestCase):
    """纯函数：从 DONE.usage 提取计费 metadata 子集。"""

    def test_extracts_credits_and_token_subset(self):
        out = _extract_billing_metadata_from_usage({
            "cost_usd": 29.3589,
            "charge_status": "success",
            "input_tokens": 78570,
            "output_tokens": 266,
            "cache_read_input_tokens": 100,
        })
        self.assertEqual(out["credits_consumed"], 29.3589)
        self.assertEqual(out["input_tokens"], 78570)
        self.assertEqual(out["output_tokens"], 266)
        self.assertEqual(out["cache_read_input_tokens"], 100)
        # success 不写 charge_failed / is_byok
        self.assertNotIn("charge_failed", out)
        self.assertNotIn("is_byok", out)

    def test_charge_failed_flag(self):
        out = _extract_billing_metadata_from_usage({"charge_status": "failed", "input_tokens": 10})
        self.assertTrue(out["charge_failed"])
        self.assertNotIn("credits_consumed", out)

    def test_byok_flag(self):
        out = _extract_billing_metadata_from_usage({"charge_status": "byok_exempt", "input_tokens": 10})
        self.assertTrue(out["is_byok"])

    def test_excludes_last_star_context_fields(self):
        # last_* 属于「上下文规模」维度，由 ChatMessage.usage_json 承载，不应进 metadata
        out = _extract_billing_metadata_from_usage({
            "cost_usd": 1.0,
            "last_input_tokens": 30517,
            "last_cache_read_input_tokens": 5,
            "last_cache_creation_input_tokens": 5,
        })
        self.assertNotIn("last_input_tokens", out)
        self.assertNotIn("last_cache_read_input_tokens", out)
        self.assertNotIn("last_cache_creation_input_tokens", out)

    def test_zero_cost_not_written(self):
        out = _extract_billing_metadata_from_usage({"cost_usd": 0, "input_tokens": 5})
        self.assertNotIn("credits_consumed", out)
        self.assertEqual(out["input_tokens"], 5)

    def test_bool_not_treated_as_number(self):
        # 防御：cost_usd=True 不应被当作金额（isinstance(True, int) 为 True 的坑）
        out = _extract_billing_metadata_from_usage({"cost_usd": True, "input_tokens": True})
        self.assertNotIn("credits_consumed", out)
        self.assertNotIn("input_tokens", out)

    def test_empty_usage(self):
        self.assertEqual(_extract_billing_metadata_from_usage({}), {})
        self.assertEqual(_extract_billing_metadata_from_usage(None), {})  # type: ignore[arg-type]


class ExtractPerCallUsageJsonTests(SimpleTestCase):
    """纯函数：从 DONE.usage 的 last_* 构建 per-call usage_json（ /  复发 回填用）。"""

    def test_builds_from_last_star_input_side_only(self):
        out = _extract_per_call_usage_json_from_done({
            "input_tokens": 358562,  # turn 累加，不应被取用
            "output_tokens": 266,    # output 不进上下文口径
            "last_input_tokens": 55000,
            "last_cache_read_input_tokens": 30720,
            "last_cache_creation_input_tokens": 100,
        })
        self.assertEqual(out, {
            "input_tokens": 55000,
            "cache_read_input_tokens": 30720,
            "cache_creation_input_tokens": 100,
        })

    def test_only_last_input_present(self):
        out = _extract_per_call_usage_json_from_done({"last_input_tokens": 72000})
        self.assertEqual(out, {"input_tokens": 72000})

    def test_zero_cache_fields_are_preserved_when_reported(self):
        out = _extract_per_call_usage_json_from_done({
            "last_input_tokens": 18104,
            "last_cache_read_input_tokens": 0,
            "last_cache_creation_input_tokens": 0,
        })
        self.assertEqual(out, {
            "input_tokens": 18104,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        })

    def test_no_last_input_returns_empty(self):
        # 只有 turn 累加 input_tokens、无 last_* → 不回填（避免把累加值当 per-call）
        self.assertEqual(_extract_per_call_usage_json_from_done({"input_tokens": 358562}), {})

    def test_zero_last_input_with_cache_hit_is_preserved(self):
        out = _extract_per_call_usage_json_from_done({
            "last_input_tokens": 0,
            "last_cache_read_input_tokens": 1500,
            "last_cache_creation_input_tokens": 0,
        })
        self.assertEqual(out, {
            "input_tokens": 0,
            "cache_read_input_tokens": 1500,
            "cache_creation_input_tokens": 0,
        })

    def test_zero_input_side_returns_empty(self):
        self.assertEqual(_extract_per_call_usage_json_from_done({
            "last_input_tokens": 0,
            "last_cache_read_input_tokens": 0,
            "last_cache_creation_input_tokens": 0,
        }), {})

    def test_bool_not_treated_as_number(self):
        self.assertEqual(_extract_per_call_usage_json_from_done({"last_input_tokens": True}), {})

    def test_empty_usage(self):
        self.assertEqual(_extract_per_call_usage_json_from_done({}), {})
        self.assertEqual(_extract_per_call_usage_json_from_done(None), {})  # type: ignore[arg-type]

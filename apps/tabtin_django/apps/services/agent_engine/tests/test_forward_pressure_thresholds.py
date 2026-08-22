"""
test_forward_pressure_thresholds.py —  第三波云端阈值下发覆盖。

钉死 forward 路径下发压缩分档阈值的不变量：

1. ``_resolve_pressure_threshold_fields`` 从 ``EngineRuntimeConfig`` 单例解出
   三档阈值并按语义映射（ctx_pressure_high → micro_compact_start、
   ctx_summary_trigger_fraction → llm_summary_start、ctx_pressure_critical →
   emergency_start）。
2. 校验口径与 runtime ``pressure-router`` 一致：三值均在 (0, 1] 且
   ``micro <= llm_summary < emergency``；非法配置 / DB 异常一律返回 ``{}``
   （宿主回落 env / runtime 默认，绝不阻断 forward）。

不连 DB（SimpleTestCase）：EngineRuntimeConfig.get_config 全部被 mock。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.agent_engine.services.prompt_forward_service import (
    _resolve_pressure_threshold_fields,
)


def _make_config(high=0.75, trigger=0.85, critical=0.95):
    cfg = MagicMock()
    cfg.ctx_pressure_high = high
    cfg.ctx_summary_trigger_fraction = trigger
    cfg.ctx_pressure_critical = critical
    return cfg


def _patch_runtime_config(cfg):
    """patch 函数内部惰性 import 的 EngineRuntimeConfig.get_config()。"""
    fake_cls = MagicMock()
    fake_cls.get_config.return_value = cfg
    return patch("apps.chat.conversation.models.EngineRuntimeConfig", fake_cls)


class ResolvePressureThresholdFieldsTests(SimpleTestCase):
    def test_maps_three_tier_semantics(self):
        with _patch_runtime_config(_make_config(0.75, 0.85, 0.95)):
            fields = _resolve_pressure_threshold_fields()
        self.assertEqual(
            fields,
            {
                "pressure_thresholds": {
                    "micro_compact_start": 0.75,
                    "llm_summary_start": 0.85,
                    "emergency_start": 0.95,
                }
            },
        )

    def test_micro_equal_to_summary_start_is_allowed(self):
        # micro == llmSummary 合法（微压缩区间收空），与 runtime 口径一致。
        with _patch_runtime_config(_make_config(0.85, 0.85, 0.95)):
            fields = _resolve_pressure_threshold_fields()
        self.assertEqual(fields["pressure_thresholds"]["micro_compact_start"], 0.85)

    def test_invalid_ordering_returns_empty(self):
        # 摘要档起点 >= 紧急档起点 → 非法，回落空。
        with _patch_runtime_config(_make_config(0.75, 0.95, 0.95)):
            self.assertEqual(_resolve_pressure_threshold_fields(), {})
        # 微压缩起点 > 摘要档起点 → 非法。
        with _patch_runtime_config(_make_config(0.9, 0.85, 0.95)):
            self.assertEqual(_resolve_pressure_threshold_fields(), {})

    def test_out_of_range_returns_empty(self):
        with _patch_runtime_config(_make_config(0.0, 0.85, 0.95)):
            self.assertEqual(_resolve_pressure_threshold_fields(), {})
        with _patch_runtime_config(_make_config(0.75, 0.85, 1.5)):
            self.assertEqual(_resolve_pressure_threshold_fields(), {})

    def test_db_exception_returns_empty(self):
        fake_cls = MagicMock()
        fake_cls.get_config.side_effect = RuntimeError("db down")
        with patch("apps.chat.conversation.models.EngineRuntimeConfig", fake_cls):
            self.assertEqual(_resolve_pressure_threshold_fields(), {})

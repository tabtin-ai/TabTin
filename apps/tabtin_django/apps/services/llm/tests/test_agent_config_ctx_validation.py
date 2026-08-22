"""
test_agent_config_ctx_validation.py —  review 修复（P1-3）覆盖。

钉死 AdminDash `PUT /admin/agent-config/context` 端点写入前的三档阈值校验
（`_validate_ctx_thresholds`）：排序 `micro <= summary < emergency`、范围
(0, 1]，与 admin_api._validate_cross_field / runtime pressure-router 同口径。
校验不过则不落库——否则会复活「AdminDash 显示的值 forward 静默拒发」的
调参失效问题。

不连 DB（SimpleTestCase）：直接对纯校验函数断言。
"""

from __future__ import annotations

from unittest.mock import MagicMock

from django.test import SimpleTestCase

from apps.services.llm.admin.agent_config_router import _validate_ctx_thresholds


def _make_config(high=0.75, trigger=0.85, critical=0.95):
    cfg = MagicMock()
    cfg.ctx_pressure_high = high
    cfg.ctx_summary_trigger_fraction = trigger
    cfg.ctx_pressure_critical = critical
    return cfg


class ValidateCtxThresholdsTests(SimpleTestCase):
    def test_default_ordering_passes(self):
        self.assertIsNone(_validate_ctx_thresholds(_make_config(0.75, 0.85, 0.95)))

    def test_micro_equal_to_trigger_is_allowed(self):
        # micro == trigger 合法（微压缩区间收空），与 runtime 口径一致。
        self.assertIsNone(_validate_ctx_thresholds(_make_config(0.85, 0.85, 0.95)))

    def test_micro_above_trigger_rejected(self):
        err = _validate_ctx_thresholds(_make_config(0.9, 0.85, 0.95))
        self.assertIsNotNone(err)
        self.assertIn("微压缩起点", err)

    def test_trigger_not_below_critical_rejected(self):
        err = _validate_ctx_thresholds(_make_config(0.75, 0.95, 0.95))
        self.assertIsNotNone(err)
        self.assertIn("紧急档起点", err)

    def test_out_of_range_rejected(self):
        self.assertIsNotNone(_validate_ctx_thresholds(_make_config(0.0, 0.85, 0.95)))
        self.assertIsNotNone(_validate_ctx_thresholds(_make_config(0.75, 0.85, 1.5)))

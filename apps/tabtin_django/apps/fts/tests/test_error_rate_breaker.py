"""R0-04 1min 滑窗错误率熔断验证。"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import apps.fts.tests.conftest  # noqa: F401


class RecordSearchOutcomeTests(unittest.TestCase):
    def test_success_increments_total_only(self):
        from apps.fts.client import record_search_outcome
        fake = MagicMock()
        fake.pipeline.return_value = fake
        with patch("apps.fts.client._get_redis_for_metrics", return_value=fake):
            record_search_outcome(success=True)
        # success 路径只 incr total + expire total（2 次）
        # incr 调用应 1 次（不计 errors）
        # 由于 pipeline 链式调用，验证 incr 次数 = 1
        incr_calls = [c for c in fake.method_calls if c[0] == "incr"]
        self.assertEqual(len(incr_calls), 1)

    def test_failure_increments_both(self):
        from apps.fts.client import record_search_outcome
        fake = MagicMock()
        fake.pipeline.return_value = fake
        with patch("apps.fts.client._get_redis_for_metrics", return_value=fake):
            record_search_outcome(success=False)
        incr_calls = [c for c in fake.method_calls if c[0] == "incr"]
        # 失败：incr total + incr errors = 2 次
        self.assertEqual(len(incr_calls), 2)

    def test_redis_unavailable_swallowed(self):
        from apps.fts.client import record_search_outcome
        with patch("apps.fts.client._get_redis_for_metrics", return_value=None):
            record_search_outcome(success=True)  # 不抛


class ShouldOpenCircuitTests(unittest.TestCase):
    def setUp(self):
        self._patch_settings = patch("apps.fts.client.settings")
        s = self._patch_settings.start()
        s.FTS_BREAKER_ERROR_RATE_THRESHOLD = 0.5

    def tearDown(self):
        self._patch_settings.stop()

    def test_no_redis_returns_false(self):
        from apps.fts.client import should_open_circuit
        with patch("apps.fts.client._get_redis_for_metrics", return_value=None):
            self.assertFalse(should_open_circuit())

    def test_below_min_sample_returns_false(self):
        from apps.fts.client import should_open_circuit, ERROR_RATE_MIN_SAMPLE
        fake = MagicMock()
        fake.get.side_effect = lambda k: b"5" if k.endswith(":total") else b"4"
        with patch("apps.fts.client._get_redis_for_metrics", return_value=fake):
            self.assertFalse(should_open_circuit())

    def test_above_threshold_opens(self):
        from apps.fts.client import should_open_circuit, ERROR_RATE_MIN_SAMPLE
        fake = MagicMock()
        # 50 / 100 == 0.5；阈值 > 严格 → 0.51 才触发
        fake.get.side_effect = lambda k: b"100" if k.endswith(":total") else b"60"
        with patch("apps.fts.client._get_redis_for_metrics", return_value=fake):
            self.assertTrue(should_open_circuit())

    def test_at_or_below_threshold_no_open(self):
        from apps.fts.client import should_open_circuit
        fake = MagicMock()
        # 50/100 == 0.5 == threshold，按 ">" 严格不触发
        fake.get.side_effect = lambda k: b"100" if k.endswith(":total") else b"50"
        with patch("apps.fts.client._get_redis_for_metrics", return_value=fake):
            self.assertFalse(should_open_circuit())


class BreakerRunRecordsOutcomeTests(unittest.TestCase):
    """breaker_run 包装：success/fail 都要走 record_search_outcome。"""

    def test_success_records_true(self):
        from apps.fts.client import breaker_run
        ok_fn = lambda: "ok"
        fake_breaker = MagicMock()
        fake_breaker.call.return_value = "ok"
        with patch("apps.fts.client.get_breaker", return_value=fake_breaker), \
             patch("apps.fts.client.record_search_outcome") as m_rec:
            breaker_run(ok_fn)
        m_rec.assert_called_once_with(success=True)

    def test_failure_records_false_then_raises(self):
        from apps.fts.client import breaker_run
        def boom():
            raise RuntimeError("nope")
        fake_breaker = MagicMock()
        fake_breaker.call.side_effect = RuntimeError("nope")
        with patch("apps.fts.client.get_breaker", return_value=fake_breaker), \
             patch("apps.fts.client.record_search_outcome") as m_rec:
            with self.assertRaises(RuntimeError):
                breaker_run(boom)
        m_rec.assert_called_once_with(success=False)


if __name__ == "__main__":
    unittest.main()

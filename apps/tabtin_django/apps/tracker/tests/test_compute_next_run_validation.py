"""Wave 2 收尾 P1-3：compute_next_run cron 回归覆盖。

背景：
  Wave 2 主实施轮删除 V1 多步骤测试时丢失了 ``test_compute_next_run_fail_loud_for_invalid_cron``
  等覆盖。本文件按 charter v1.8 §6.4 / §7.1 重新建立 ``compute_next_run_at`` 的回归保护，
  覆盖：
    1. 无效 cron 表达式：``fail_loud=True`` 必须抛 ValidationError；``fail_loud=False``
       静默返回 None（生产 Celery scan_due_trackers 路径用此模式）
    2. 有效 cron 表达式：返回未来时间 + 是 timezone-aware
    3. 时区参数：处理常见 IANA 时区（Asia/Shanghai / UTC）；非法时区 fail_loud 抛异常
    4. interval 触发：返回 now + seconds，timezone-aware
    5. at 触发：解析 ISO 字符串并返回 timezone-aware datetime
    6. 未知 trigger_type：返回 None（不抛异常）

charter §6.4 单 Skill 执行模型 + §7.1 trigger_type/trigger_config 终局形态。
"""

from __future__ import annotations

from datetime import datetime, timedelta

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase
from django.utils import timezone

from apps.tracker.utils import compute_next_run_at


class ComputeNextRunCronTest(SimpleTestCase):
    """cron 触发的 compute_next_run 行为契约。"""

    def test_invalid_cron_with_fail_loud_raises(self):
        """fail_loud=True 时无效 cron 抛 ValidationError，错误信息含表达式本身。"""
        with self.assertRaises(ValidationError) as ctx:
            compute_next_run_at(
                "cron",
                {"cron_expression": "this is not a cron"},
                fail_loud=True,
            )
        self.assertIn("Cron 表达式无效", str(ctx.exception))

    def test_invalid_cron_silent_returns_none(self):
        """fail_loud=False 时无效 cron 静默返回 None（Celery scan_due_trackers 兜底）。"""
        result = compute_next_run_at(
            "cron",
            {"cron_expression": "@invalid"},
            fail_loud=False,
        )
        self.assertIsNone(result)

    def test_valid_cron_returns_future_aware_datetime(self):
        """有效 cron 返回未来时间，且必须 timezone-aware。"""
        result = compute_next_run_at(
            "cron",
            {"cron_expression": "0 9 * * *", "timezone": "Asia/Shanghai"},
            fail_loud=True,
        )
        self.assertIsNotNone(result)
        self.assertIsInstance(result, datetime)
        self.assertFalse(timezone.is_naive(result), "返回值必须是 timezone-aware")
        self.assertGreater(result, timezone.now(), "返回值必须是未来时间")

    def test_cron_supports_legacy_expression_key(self):
        """兼容旧 key ``expression``（与新 key ``cron_expression`` 等价）。"""
        result = compute_next_run_at(
            "cron",
            {"expression": "0 9 * * *", "timezone": "UTC"},
        )
        self.assertIsNotNone(result)
        self.assertFalse(timezone.is_naive(result))

    def test_cron_missing_timezone_defaults_to_django_time_zone(self):
        """#2574：缺 timezone 时按 settings.TIME_ZONE（Asia/Shanghai）解析，不再默认 UTC。"""
        import pytz
        from django.conf import settings

        result = compute_next_run_at(
            "cron",
            {"cron_expression": "0 9 * * *"},
            fail_loud=True,
        )
        self.assertIsNotNone(result)
        product_tz = pytz.timezone(settings.TIME_ZONE)
        self.assertEqual(result.astimezone(product_tz).hour, 9)

    def test_ensure_cron_timezone_fills_missing(self):
        from apps.tracker.utils import ensure_cron_timezone

        filled = ensure_cron_timezone("cron", {"cron_expression": "0 9 * * *"})
        self.assertEqual(filled["timezone"], "Asia/Shanghai")
        kept = ensure_cron_timezone(
            "cron",
            {"cron_expression": "0 9 * * *", "timezone": "America/New_York"},
        )
        self.assertEqual(kept["timezone"], "America/New_York")
        untouched = ensure_cron_timezone("interval", {"interval_seconds": 60})
        self.assertNotIn("timezone", untouched)

    def test_cron_invalid_timezone_with_fail_loud(self):
        """非法时区在 fail_loud 模式下抛 ValidationError。"""
        with self.assertRaises(ValidationError):
            compute_next_run_at(
                "cron",
                {"cron_expression": "0 9 * * *", "timezone": "Mars/Olympus"},
                fail_loud=True,
            )

    def test_cron_empty_expression_returns_none(self):
        """空 cron 表达式返回 None（不抛即使 fail_loud=True）。"""
        result = compute_next_run_at("cron", {}, fail_loud=True)
        self.assertIsNone(result)


class ComputeNextRunIntervalTest(SimpleTestCase):
    """interval 触发的 compute_next_run 行为。"""

    def test_interval_returns_future_aware_datetime(self):
        before = timezone.now()
        result = compute_next_run_at(
            "interval",
            {"interval_seconds": 60},
        )
        after = timezone.now()
        self.assertIsNotNone(result)
        self.assertFalse(timezone.is_naive(result))
        # 60 秒后，但允许小幅时间漂移
        self.assertGreaterEqual(result, before + timedelta(seconds=59))
        self.assertLessEqual(result, after + timedelta(seconds=61))

    def test_interval_supports_legacy_seconds_key(self):
        """兼容旧 key ``seconds``。"""
        result = compute_next_run_at(
            "interval",
            {"seconds": 30},
        )
        self.assertIsNotNone(result)


class ComputeNextRunAtTest(SimpleTestCase):
    """at 触发的 compute_next_run 行为。"""

    def test_at_parses_iso_and_returns_aware(self):
        future = timezone.now() + timedelta(hours=2)
        result = compute_next_run_at(
            "at",
            {"at": future.isoformat()},
        )
        self.assertIsNotNone(result)
        self.assertFalse(timezone.is_naive(result))
        # 结果应接近输入（精度允许 1 秒漂移）
        self.assertAlmostEqual(
            result.timestamp(),
            future.timestamp(),
            delta=1.0,
        )

    def test_at_empty_returns_none(self):
        result = compute_next_run_at("at", {})
        self.assertIsNone(result)


class ComputeNextRunUnknownTriggerTest(SimpleTestCase):
    """未识别 trigger_type 不应抛异常，仅返回 None。"""

    def test_unknown_trigger_type_returns_none(self):
        for tt in ("manual", "extension_event", "table_event", "webhook", "tracker_completed"):
            self.assertIsNone(
                compute_next_run_at(tt, {}),
                f"trigger_type={tt} 应返回 None",
            )

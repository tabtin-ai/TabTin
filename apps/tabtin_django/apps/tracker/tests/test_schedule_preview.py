"""自动化未来执行点预览（schedule-preview）契约测试。

产品：只预览 active 的 cron / interval / at；occurrence 虚拟不落库。
纯函数层先钉调度展开；API 层再钉权限 / 窗口 / 响应 envelope。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

from django.test import SimpleTestCase
from django.utils import timezone


class IterScheduleOccurrencesIntervalTest(SimpleTestCase):
    """interval：以 next_run_at 为锚点按 seconds 步进。"""

    def test_interval_steps_from_next_run_at_anchor(self):
        from apps.tracker.utils import iter_schedule_occurrences

        now = timezone.now()
        anchor = now + timedelta(minutes=5)
        window_end = now + timedelta(hours=1)
        seconds = 600  # 10 分钟

        occs = list(
            iter_schedule_occurrences(
                "interval",
                {"interval_seconds": seconds},
                next_run_at=anchor,
                window_start=now,
                window_end=window_end,
                max_count=200,
            )
        )

        self.assertGreaterEqual(len(occs), 5)
        self.assertEqual(occs[0], anchor)
        for prev, cur in zip(occs, occs[1:]):
            self.assertEqual(cur - prev, timedelta(seconds=seconds))
        self.assertTrue(all(timezone.is_aware(dt) for dt in occs))
        self.assertTrue(all(now <= dt < window_end for dt in occs))

    def test_interval_supports_legacy_seconds_key(self):
        from apps.tracker.utils import iter_schedule_occurrences

        now = timezone.now()
        anchor = now + timedelta(seconds=30)
        occs = list(
            iter_schedule_occurrences(
                "interval",
                {"seconds": 60},
                next_run_at=anchor,
                window_start=now,
                window_end=now + timedelta(minutes=5),
                max_count=200,
            )
        )
        self.assertEqual(occs[0], anchor)
        self.assertEqual(occs[1] - occs[0], timedelta(seconds=60))


class IterScheduleOccurrencesAtTest(SimpleTestCase):
    """at：窗口内只返回一个点。"""

    def test_at_prefers_next_run_anchor_over_divergent_config(self):
        """next_run_at 是扫描器真相；config.at 陈旧时不能覆盖锚点。"""
        from apps.tracker.utils import iter_schedule_occurrences

        now = timezone.now()
        anchor = now + timedelta(hours=2)
        stale_config_at = now + timedelta(hours=5)
        occs = list(
            iter_schedule_occurrences(
                "at",
                {"at": stale_config_at.isoformat()},
                next_run_at=anchor,
                window_start=now,
                window_end=now + timedelta(days=1),
                max_count=200,
            )
        )
        self.assertEqual(occs, [anchor])

    def test_at_uses_config_only_when_anchor_missing(self):
        from apps.tracker.utils import iter_schedule_occurrences

        now = timezone.now()
        config_at = now + timedelta(hours=3)
        occs = list(
            iter_schedule_occurrences(
                "at",
                {"at": config_at.isoformat()},
                next_run_at=None,
                window_start=now,
                window_end=now + timedelta(days=1),
                max_count=200,
            )
        )
        self.assertEqual(len(occs), 1)
        self.assertAlmostEqual(occs[0].timestamp(), config_at.timestamp(), delta=1.0)

    def test_at_returns_single_point_in_window(self):
        from apps.tracker.utils import iter_schedule_occurrences

        now = timezone.now()
        at_dt = now + timedelta(hours=3)
        occs = list(
            iter_schedule_occurrences(
                "at",
                {"at": at_dt.isoformat()},
                next_run_at=at_dt,
                window_start=now,
                window_end=now + timedelta(days=1),
                max_count=200,
            )
        )
        self.assertEqual(len(occs), 1)
        self.assertAlmostEqual(occs[0].timestamp(), at_dt.timestamp(), delta=1.0)

    def test_at_outside_window_returns_empty(self):
        from apps.tracker.utils import iter_schedule_occurrences

        now = timezone.now()
        at_dt = now + timedelta(days=10)
        occs = list(
            iter_schedule_occurrences(
                "at",
                {"at": at_dt.isoformat()},
                next_run_at=at_dt,
                window_start=now,
                window_end=now + timedelta(days=1),
                max_count=200,
            )
        )
        self.assertEqual(occs, [])


class IterScheduleOccurrencesCronTest(SimpleTestCase):
    """cron：从锚点按表达式 / IANA 时区继续。"""

    def test_stale_minutely_anchor_fast_forwards_to_window_start(self):
        """一年前的每分钟锚点应直接快进，且 window_start 命中不能漏。"""
        import pytz
        from croniter import croniter as Croniter
        from apps.tracker.utils import iter_schedule_occurrences

        utc = pytz.UTC
        window_start = utc.localize(datetime(2026, 7, 22, 9, 0, 0))
        anchor = window_start - timedelta(days=365)
        original_get_next = Croniter.get_next
        calls = 0

        def guarded_get_next(iterator, *args, **kwargs):
            nonlocal calls
            calls += 1
            if calls > 20:
                raise RuntimeError("cron preview did not fast-forward")
            return original_get_next(iterator, *args, **kwargs)

        with patch.object(Croniter, "get_next", autospec=True, side_effect=guarded_get_next):
            occs = list(
                iter_schedule_occurrences(
                    "cron",
                    {"cron_expression": "* * * * *", "timezone": "UTC"},
                    next_run_at=anchor,
                    window_start=window_start,
                    window_end=window_start + timedelta(minutes=3),
                    max_count=200,
                )
            )

        self.assertEqual(
            occs,
            [
                window_start,
                window_start + timedelta(minutes=1),
                window_start + timedelta(minutes=2),
            ],
        )
        self.assertLessEqual(calls, 4)

    def test_cron_asia_shanghai_daily_nine_am(self):
        import pytz
        from apps.tracker.utils import iter_schedule_occurrences

        shanghai = pytz.timezone("Asia/Shanghai")
        # 锚定到下一个 09:00 Asia/Shanghai
        base_local = shanghai.localize(datetime(2026, 7, 22, 9, 0, 0))
        now = base_local - timedelta(hours=1)
        window_end = base_local + timedelta(days=3)

        occs = list(
            iter_schedule_occurrences(
                "cron",
                {"cron_expression": "0 9 * * *", "timezone": "Asia/Shanghai"},
                next_run_at=base_local,
                window_start=now,
                window_end=window_end,
                max_count=200,
            )
        )
        self.assertEqual(len(occs), 3)
        for dt in occs:
            local = dt.astimezone(shanghai)
            self.assertEqual(local.hour, 9)
            self.assertEqual(local.minute, 0)
        self.assertEqual(occs[0], base_local)

    def test_cron_supports_legacy_expression_key(self):
        from apps.tracker.utils import iter_schedule_occurrences

        now = timezone.now()
        anchor = now + timedelta(hours=1)
        occs = list(
            iter_schedule_occurrences(
                "cron",
                {"expression": "0 * * * *", "timezone": "UTC"},
                next_run_at=anchor,
                window_start=now,
                window_end=now + timedelta(hours=3),
                max_count=200,
            )
        )
        self.assertGreaterEqual(len(occs), 1)
        self.assertEqual(occs[0], anchor)

    def test_cron_dst_spring_forward_america_new_york(self):
        """DST 春令跳变：与 croniter+pytz 语义一致，不产生 naive 时间。"""
        import pytz
        from apps.tracker.utils import iter_schedule_occurrences

        ny = pytz.timezone("America/New_York")
        # 2026-03-08 02:00 跳到 03:00；锚定 08:00 EDT 前一天
        anchor = ny.localize(datetime(2026, 3, 7, 8, 0, 0))
        window_end = ny.localize(datetime(2026, 3, 10, 0, 0, 0))

        occs = list(
            iter_schedule_occurrences(
                "cron",
                {"cron_expression": "0 8 * * *", "timezone": "America/New_York"},
                next_run_at=anchor,
                window_start=anchor - timedelta(minutes=1),
                window_end=window_end,
                max_count=200,
            )
        )
        self.assertEqual(len(occs), 3)
        hours = [dt.astimezone(ny).hour for dt in occs]
        self.assertEqual(hours, [8, 8, 8])
        self.assertTrue(all(timezone.is_aware(dt) for dt in occs))


class IterScheduleOccurrencesLimitsTest(SimpleTestCase):
    """截断与未知触发类型。"""

    def test_per_tracker_max_count_truncates(self):
        from apps.tracker.utils import iter_schedule_occurrences

        now = timezone.now()
        anchor = now + timedelta(seconds=1)
        occs = list(
            iter_schedule_occurrences(
                "interval",
                {"interval_seconds": 1},
                next_run_at=anchor,
                window_start=now,
                window_end=now + timedelta(hours=1),
                max_count=5,
            )
        )
        self.assertEqual(len(occs), 5)

    def test_manual_and_webhook_yield_nothing(self):
        from apps.tracker.utils import iter_schedule_occurrences

        now = timezone.now()
        for tt in ("manual", "webhook", "table_event"):
            occs = list(
                iter_schedule_occurrences(
                    tt,
                    {},
                    next_run_at=now + timedelta(hours=1),
                    window_start=now,
                    window_end=now + timedelta(days=1),
                    max_count=200,
                )
            )
            self.assertEqual(occs, [], f"{tt} 不应产出 occurrence")


class ValidateSchedulePreviewWindowTest(SimpleTestCase):
    """[from,to) 校验：to>from、最长 42 个日历日。"""

    def test_rejects_to_not_after_from(self):
        from apps.tracker.utils import validate_schedule_preview_window

        now = timezone.now()
        with self.assertRaises(ValueError):
            validate_schedule_preview_window(now, now)
        with self.assertRaises(ValueError):
            validate_schedule_preview_window(now + timedelta(hours=1), now)

    def test_rejects_window_longer_than_42_days(self):
        from apps.tracker.utils import validate_schedule_preview_window

        now = timezone.now()
        with self.assertRaises(ValueError) as ctx:
            validate_schedule_preview_window(now, now + timedelta(days=43))
        self.assertIn("42", str(ctx.exception))

    def test_accepts_exactly_42_days(self):
        from apps.tracker.utils import validate_schedule_preview_window

        now = timezone.now()
        validate_schedule_preview_window(now, now + timedelta(days=42))

    def test_accepts_42_calendar_days_across_dst_fall_back(self):
        """本地 addDays(42) 跨回拨后绝对时长为 42 天 + 1 小时，仍应接受。"""
        from django.utils.dateparse import parse_datetime
        from apps.tracker.utils import validate_schedule_preview_window

        from_dt = parse_datetime("2026-10-25T04:00:00Z")
        to_dt = parse_datetime("2026-12-06T05:00:00Z")
        self.assertEqual(to_dt - from_dt, timedelta(days=42, hours=1))
        validate_schedule_preview_window(from_dt, to_dt)

    def test_accepts_london_42_local_days_with_preserved_offsets(self):
        """终审反例：保留 London offset 时按本地日期认定 42 日。"""
        from django.utils.dateparse import parse_datetime
        from apps.tracker.utils import (
            schedule_preview_window_calendar_days,
            validate_schedule_preview_window,
        )

        from_dt = parse_datetime("2026-10-05T00:00:00+01:00")
        to_dt = parse_datetime("2026-11-16T00:00:00+00:00")
        self.assertEqual(schedule_preview_window_calendar_days(from_dt, to_dt), 42)
        self.assertEqual(to_dt - from_dt, timedelta(days=42, hours=1))
        validate_schedule_preview_window(from_dt, to_dt)

    def test_accepts_42_calendar_days_across_dst_spring_forward(self):
        """本地 addDays(42) 跨前拨后绝对时长为 41 天 + 23 小时。"""
        from django.utils.dateparse import parse_datetime
        from apps.tracker.utils import validate_schedule_preview_window

        from_dt = parse_datetime("2026-02-22T05:00:00Z")
        to_dt = parse_datetime("2026-04-05T04:00:00Z")
        self.assertEqual(to_dt - from_dt, timedelta(days=41, hours=23))
        validate_schedule_preview_window(from_dt, to_dt)

    def test_rejects_43_calendar_dates_even_under_43_absolute_days(self):
        """日历日期跨 43 天，即使绝对时长不足 43 天也必须拒绝。"""
        from django.utils.dateparse import parse_datetime
        from apps.tracker.utils import validate_schedule_preview_window

        from_dt = parse_datetime("2026-01-01T00:30:00Z")
        to_dt = parse_datetime("2026-02-13T00:00:00Z")
        self.assertLess(to_dt - from_dt, timedelta(days=43))
        with self.assertRaises(ValueError) as ctx:
            validate_schedule_preview_window(from_dt, to_dt)
        self.assertIn("42", str(ctx.exception))

    def test_rejects_absolute_duration_over_43_days_despite_date_span(self):
        """恶意 offset 不能绕过绝对时长安全兜底。"""
        from django.utils.dateparse import parse_datetime
        from apps.tracker.utils import validate_schedule_preview_window

        from_dt = parse_datetime("2026-01-01T00:00:00+14:00")
        to_dt = parse_datetime("2026-02-12T00:00:00-14:00")
        self.assertEqual((to_dt.date() - from_dt.date()).days, 42)
        self.assertGreater(to_dt - from_dt, timedelta(days=43))
        with self.assertRaises(ValueError):
            validate_schedule_preview_window(from_dt, to_dt)

    def test_rejects_london_43_local_days_despite_shorter_absolute_duration(self):
        from django.utils.dateparse import parse_datetime
        from apps.tracker.utils import validate_schedule_preview_window

        from_dt = parse_datetime("2026-02-16T00:00:00+00:00")
        to_dt = parse_datetime("2026-03-31T00:00:00+01:00")
        self.assertEqual((to_dt.date() - from_dt.date()).days, 43)
        self.assertEqual(to_dt - from_dt, timedelta(days=42, hours=23))
        with self.assertRaises(ValueError):
            validate_schedule_preview_window(from_dt, to_dt)


class BuildSchedulePreviewTest(SimpleTestCase):
    """聚合层：只展开 active 时间触发；过滤 past；总量截断。"""

    def _tracker(
        self,
        *,
        trigger_type="interval",
        status="active",
        next_run_at=None,
        trigger_config=None,
        name="t",
    ):
        now = timezone.now()
        t = MagicMock()
        t.id = uuid4()
        t.name = name
        t.status = status
        t.trigger_type = trigger_type
        t.trigger_config = trigger_config or {"interval_seconds": 3600}
        t.next_run_at = next_run_at or (now + timedelta(hours=1))
        t.last_run_at = None
        t.created_at = None
        t.workspace_id = uuid4()
        workspace = MagicMock()
        workspace.name = "space-a"
        t.workspace = workspace
        return t

    def test_skips_non_active_and_non_time_triggers(self):
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        active_interval = self._tracker(name="keep")
        paused = self._tracker(status="paused", name="paused")
        manual = self._tracker(trigger_type="manual", name="manual", trigger_config={})

        result = build_schedule_preview(
            [paused, manual, active_interval],
            from_dt=now,
            to_dt=now + timedelta(days=1),
            now=now,
        )
        self.assertFalse(result["truncated"])
        ids = {o["tracker_id"] for o in result["occurrences"]}
        self.assertEqual(ids, {str(active_interval.id)})
        row = result["occurrences"][0]
        self.assertEqual(row["name"], "keep")
        self.assertEqual(row["status"], "active")
        self.assertEqual(row["trigger_type"], "interval")
        self.assertEqual(row["space_name"], "space-a")
        self.assertIn("scheduled_at", row)
        self.assertIn("timezone", row)
        self.assertNotIn("trigger_config", row)

    def test_window_includes_past_but_only_returns_after_now(self):
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        # 锚点在 30 分钟前；interval 1h → 下一拍约 30 分钟后
        anchor = now - timedelta(minutes=30)
        t = self._tracker(
            next_run_at=anchor,
            trigger_config={"interval_seconds": 3600},
        )
        result = build_schedule_preview(
            [t],
            from_dt=now - timedelta(days=1),
            to_dt=now + timedelta(days=1),
            now=now,
        )
        self.assertTrue(result["occurrences"])
        for occ in result["occurrences"]:
            scheduled = datetime.fromisoformat(occ["scheduled_at"])
            self.assertGreaterEqual(scheduled, now)

    def test_interval_and_at_timezone_defaults_to_utc(self):
        """非 cron 无规则时区时不能误标 Django 的 cron 默认时区。"""
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        interval = self._tracker(
            trigger_type="interval",
            next_run_at=now + timedelta(hours=1),
            trigger_config={"interval_seconds": 3600},
        )
        at = self._tracker(
            trigger_type="at",
            next_run_at=now + timedelta(hours=2),
            trigger_config={
                "at": (now + timedelta(hours=2)).isoformat(),
                "timezone": "Mars/Olympus",
            },
        )

        result = build_schedule_preview(
            [interval, at],
            from_dt=now,
            to_dt=now + timedelta(hours=3),
            now=now,
        )
        by_type = {row["trigger_type"]: row for row in result["occurrences"]}
        self.assertEqual(by_type["interval"]["timezone"], "UTC")
        self.assertEqual(by_type["at"]["timezone"], "UTC")

    def test_valid_explicit_timezone_is_preserved(self):
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        interval = self._tracker(
            next_run_at=now + timedelta(hours=1),
            trigger_config={
                "interval_seconds": 3600,
                "timezone": "Asia/Shanghai",
            },
        )
        result = build_schedule_preview(
            [interval],
            from_dt=now,
            to_dt=now + timedelta(hours=2),
            now=now,
        )
        self.assertEqual(result["occurrences"][0]["timezone"], "Asia/Shanghai")

    def test_cron_missing_timezone_reports_actual_scheduler_default(self):
        """cron 缺配置时按 compute_next_run_at 同一默认时区展开并标注。"""
        from django.conf import settings
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        cron = self._tracker(
            trigger_type="cron",
            next_run_at=now + timedelta(hours=1),
            trigger_config={"cron_expression": "0 * * * *"},
        )
        result = build_schedule_preview(
            [cron],
            from_dt=now,
            to_dt=now + timedelta(hours=2),
            now=now,
        )
        self.assertEqual(result["occurrences"][0]["timezone"], settings.TIME_ZONE)

    def test_queryset_candidates_use_streaming_iterator(self):
        """QuerySet 不得经 __iter__ 填满 result cache；候选首点应流式读取。"""
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        tracker = self._tracker(next_run_at=now + timedelta(hours=1))

        class QuerySetLike:
            def __iter__(self):
                raise AssertionError("QuerySet __iter__ would cache all rows")

            def iterator(self, *, chunk_size):
                self.chunk_size = chunk_size
                yield tracker

        candidates = QuerySetLike()
        result = build_schedule_preview(
            candidates,
            from_dt=now,
            to_dt=now + timedelta(hours=2),
            now=now,
        )
        self.assertEqual(len(result["occurrences"]), 1)
        self.assertLessEqual(candidates.chunk_size, 2000)

    def test_total_limit_sets_truncated(self):
        from apps.tracker.utils import (
            SCHEDULE_PREVIEW_TOTAL_LIMIT,
            build_schedule_preview,
        )

        now = timezone.now()
        # 两个高频任务，合计会超过总上限
        trackers = [
            self._tracker(
                name=f"t{i}",
                next_run_at=now + timedelta(seconds=1),
                trigger_config={"interval_seconds": 1},
            )
            for i in range(2)
        ]
        with patch(
            "apps.tracker.utils.SCHEDULE_PREVIEW_TOTAL_LIMIT",
            10,
        ), patch(
            "apps.tracker.utils.SCHEDULE_PREVIEW_PER_TRACKER_LIMIT",
            200,
        ):
            result = build_schedule_preview(
                trackers,
                from_dt=now,
                to_dt=now + timedelta(hours=1),
                now=now,
            )
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["occurrences"]), 10)
        # 确认常量本身仍是契约值（防误改）
        self.assertEqual(SCHEDULE_PREVIEW_TOTAL_LIMIT, 2000)

    def test_exact_total_limit_without_extra_is_not_truncated(self):
        """恰好 N 个且无第 N+1 个 occurrence 时不能误报截断。"""
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        tracker = self._tracker(
            next_run_at=now + timedelta(seconds=1),
            trigger_config={"interval_seconds": 1},
        )
        with patch("apps.tracker.utils.SCHEDULE_PREVIEW_TOTAL_LIMIT", 10):
            result = build_schedule_preview(
                [tracker],
                from_dt=now,
                to_dt=now + timedelta(seconds=11),
                now=now,
            )

        self.assertEqual(len(result["occurrences"]), 10)
        self.assertFalse(result["truncated"])

    def test_global_earliest_merge_prevents_first_tracker_starvation(self):
        """前一个高频任务不能吃完预算并遮住后一个更早 occurrence。"""
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        high_frequency_first = self._tracker(
            name="high-frequency",
            next_run_at=now + timedelta(seconds=10),
            trigger_config={"interval_seconds": 1},
        )
        earlier_second = self._tracker(
            name="earlier",
            trigger_type="at",
            next_run_at=now + timedelta(seconds=5),
            trigger_config={"at": (now + timedelta(hours=2)).isoformat()},
        )

        with patch("apps.tracker.utils.SCHEDULE_PREVIEW_TOTAL_LIMIT", 3):
            result = build_schedule_preview(
                [high_frequency_first, earlier_second],
                from_dt=now,
                to_dt=now + timedelta(minutes=1),
                now=now,
            )

        self.assertTrue(result["truncated"])
        self.assertEqual(
            [row["name"] for row in result["occurrences"]],
            ["earlier", "high-frequency", "high-frequency"],
        )
        scheduled = [
            datetime.fromisoformat(row["scheduled_at"])
            for row in result["occurrences"]
        ]
        self.assertEqual(scheduled, sorted(scheduled))

    def test_equal_times_are_stably_sorted_by_tracker_id(self):
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        high_id = self._tracker(
            trigger_type="at",
            next_run_at=now + timedelta(hours=1),
        )
        high_id.id = UUID("ffffffff-ffff-ffff-ffff-ffffffffffff")
        low_id = self._tracker(
            trigger_type="at",
            next_run_at=now + timedelta(hours=1),
        )
        low_id.id = UUID("00000000-0000-0000-0000-000000000001")

        result = build_schedule_preview(
            [high_id, low_id],
            from_dt=now,
            to_dt=now + timedelta(days=1),
            now=now,
        )
        self.assertEqual(
            [row["tracker_id"] for row in result["occurrences"]],
            [str(low_id.id), str(high_id.id)],
        )

    def test_global_earliest_scans_beyond_old_candidate_cap(self):
        """第 2001 个任务更早时也必须进入全局最早结果。"""
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        workspace = SimpleNamespace(name="space-a")
        trackers = [
            SimpleNamespace(
                id=uuid4(),
                name=f"later-{index}",
                status="active",
                trigger_type="at",
                trigger_config={},
                next_run_at=now + timedelta(seconds=10 + index),
                workspace_id=uuid4(),
                workspace=workspace,
            )
            for index in range(2000)
        ]
        earliest = SimpleNamespace(
            id=uuid4(),
            name="earliest-2001",
            status="active",
            trigger_type="at",
            trigger_config={},
            next_run_at=now + timedelta(seconds=5),
            workspace_id=uuid4(),
            workspace=workspace,
        )
        trackers.append(earliest)

        with patch("apps.tracker.utils.SCHEDULE_PREVIEW_TOTAL_LIMIT", 1):
            result = build_schedule_preview(
                trackers,
                from_dt=now,
                to_dt=now + timedelta(hours=1),
                now=now,
            )

        self.assertEqual(result["occurrences"][0]["tracker_id"], str(earliest.id))
        self.assertTrue(result["truncated"])

    def test_unprocessed_task_without_window_occurrence_does_not_truncate(self):
        """候选数量本身不等于 occurrence 截断。"""
        from apps.tracker.utils import build_schedule_preview

        now = timezone.now()
        workspace = SimpleNamespace(name="space-a")
        only_occurrence = SimpleNamespace(
            id=uuid4(),
            name="only",
            status="active",
            trigger_type="at",
            trigger_config={},
            next_run_at=now + timedelta(seconds=1),
            workspace_id=uuid4(),
            workspace=workspace,
        )
        outside_window = [
            SimpleNamespace(
                id=uuid4(),
                name=f"outside-{index}",
                status="active",
                trigger_type="at",
                trigger_config={},
                next_run_at=now + timedelta(days=2),
                workspace_id=uuid4(),
                workspace=workspace,
            )
            for index in range(2000)
        ]

        with patch("apps.tracker.utils.SCHEDULE_PREVIEW_TOTAL_LIMIT", 1):
            result = build_schedule_preview(
                [only_occurrence, *outside_window],
                from_dt=now,
                to_dt=now + timedelta(days=1),
                now=now,
            )

        self.assertEqual(len(result["occurrences"]), 1)
        self.assertFalse(result["truncated"])


class SchedulePreviewApiTest(SimpleTestCase):
    """GET /schedule-preview endpoint：权限、窗口、envelope。"""

    def _request(self):
        from django.http import HttpRequest

        req = MagicMock(spec=HttpRequest)
        req.auth = MagicMock()
        req.auth.id = uuid4()
        return req

    def test_permission_denied_when_list_trackers_raises(self):
        from apps.tracker.api import trackers as trackers_api

        mock_svc = MagicMock()
        mock_svc.list_trackers.side_effect = PermissionError("no org")
        with patch.object(trackers_api, "_tracker_service", return_value=mock_svc):
            resp = trackers_api.schedule_preview(
                self._request(),
                organization_id=str(uuid4()),
                space_id=None,
                from_=timezone.now().isoformat(),
                to= (timezone.now() + timedelta(days=1)).isoformat(),
            )
        self.assertEqual(resp.status_code, 403)

    def test_space_permission_denied(self):
        from apps.tracker.api import trackers as trackers_api

        mock_svc = MagicMock()
        mock_svc.list_trackers.side_effect = PermissionError("no space")
        with patch.object(trackers_api, "_tracker_service", return_value=mock_svc):
            resp = trackers_api.schedule_preview(
                self._request(),
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                from_=timezone.now().isoformat(),
                to=(timezone.now() + timedelta(days=1)).isoformat(),
            )
        self.assertEqual(resp.status_code, 403)

    def test_window_over_42_days_returns_400(self):
        from apps.tracker.api import trackers as trackers_api

        mock_svc = MagicMock()
        mock_svc.list_trackers.return_value = []
        now = timezone.now()
        with patch.object(trackers_api, "_tracker_service", return_value=mock_svc):
            resp = trackers_api.schedule_preview(
                self._request(),
                organization_id=str(uuid4()),
                space_id=None,
                from_=now.isoformat(),
                to=(now + timedelta(days=43)).isoformat(),
            )
        self.assertEqual(resp.status_code, 400)

    def test_date_only_window_returns_400(self):
        """契约明确要求 aware ISO datetime；YYYY-MM-DD 不得放宽。"""
        from apps.tracker.api import trackers as trackers_api

        mock_svc = MagicMock()
        with patch.object(trackers_api, "_tracker_service", return_value=mock_svc):
            resp = trackers_api.schedule_preview(
                self._request(),
                organization_id=str(uuid4()),
                space_id=None,
                from_="2026-07-22",
                to="2026-07-23",
            )
        self.assertEqual(resp.status_code, 400)
        mock_svc.list_trackers.assert_not_called()

    def test_invalid_iso_datetimes_return_400_instead_of_raising(self):
        from apps.tracker.api import trackers as trackers_api

        invalid_values = (
            "2026-13-01T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "not-a-datetime",
        )
        for invalid in invalid_values:
            with self.subTest(value=invalid):
                mock_svc = MagicMock()
                with patch.object(
                    trackers_api, "_tracker_service", return_value=mock_svc
                ):
                    resp = trackers_api.schedule_preview(
                        self._request(),
                        organization_id=str(uuid4()),
                        space_id=None,
                        from_=invalid,
                        to="2026-03-01T00:00:00Z",
                    )
                self.assertEqual(resp.status_code, 400)
                mock_svc.list_trackers.assert_not_called()

    def test_london_dst_window_with_preserved_offsets_succeeds(self):
        """API 必须按 query 中保留的 offset 接受 London 42 本地日窗口。"""
        from apps.tracker.api import trackers as trackers_api

        mock_qs = MagicMock()
        mock_qs.select_related.return_value = mock_qs
        mock_filtered = MagicMock()
        mock_qs.filter.return_value = mock_filtered
        mock_filtered.order_by.return_value = []
        mock_svc = MagicMock()
        mock_svc.list_trackers.return_value = mock_qs

        with patch.object(trackers_api, "_tracker_service", return_value=mock_svc):
            resp = trackers_api.schedule_preview(
                self._request(),
                organization_id=str(uuid4()),
                space_id=None,
                from_="2026-10-05T00:00:00+01:00",
                to="2026-11-16T00:00:00+00:00",
            )

        payload = resp[1] if isinstance(resp, tuple) else resp
        self.assertTrue(payload["success"])
        self.assertEqual(payload["data"], {"occurrences": [], "truncated": False})

    def test_aware_iso_window_returns_success_envelope(self):
        from apps.tracker.api import trackers as trackers_api

        now = timezone.now()
        t = MagicMock()
        t.id = uuid4()
        t.name = "daily"
        t.status = "active"
        t.trigger_type = "cron"
        t.trigger_config = {
            "cron_expression": "0 9 * * *",
            "timezone": "Asia/Shanghai",
        }
        t.next_run_at = now + timedelta(hours=2)
        t.last_run_at = None
        t.created_at = None
        t.workspace_id = uuid4()
        workspace = MagicMock()
        workspace.name = "ws"
        t.workspace = workspace

        mock_qs = MagicMock()
        mock_qs.select_related.return_value = mock_qs
        mock_filtered = MagicMock()
        mock_qs.filter.return_value = mock_filtered
        mock_filtered.order_by.return_value = [t]

        mock_svc = MagicMock()
        mock_svc.list_trackers.return_value = mock_qs

        with patch.object(trackers_api, "_tracker_service", return_value=mock_svc):
            resp = trackers_api.schedule_preview(
                self._request(),
                organization_id=str(uuid4()),
                space_id=None,
                from_=now.isoformat(),
                to=(now + timedelta(days=2)).isoformat(),
            )

        # success_response 返回 dict；错误路径才是 JsonResponse
        payload = resp[1] if isinstance(resp, tuple) else resp
        if hasattr(payload, "content"):
            import json

            payload = json.loads(payload.content)
        self.assertTrue(payload.get("success"))
        data = payload["data"]
        self.assertIn("occurrences", data)
        self.assertIn("truncated", data)
        self.assertIsInstance(data["truncated"], bool)
        self.assertTrue(data["occurrences"], "active cron 应产出至少 1 个点")
        occ = data["occurrences"][0]
        for key in (
            "tracker_id",
            "name",
            "space_id",
            "space_name",
            "scheduled_at",
            "status",
            "trigger_type",
            "timezone",
        ):
            self.assertIn(key, occ)
        self.assertNotIn("trigger_config", occ)
        self.assertEqual(occ["timezone"], "Asia/Shanghai")
        mock_filtered.order_by.assert_called_once_with("next_run_at", "id")

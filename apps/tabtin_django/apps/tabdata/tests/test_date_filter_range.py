"""日期过滤范围 resolve_date_filter_range 单元测试

覆盖:
- 全部 16 种 mode（today ~ dateRange）
- 无效时区回退 UTC
- 日期格式校验（非法格式抛 ValueError）
- dateRange swap（d_end < d_start 自动交换）
- pastDays/nextDays 边界值（min=1, max=365）
- exactDate/dateRange 缺少必填字段抛 ValueError
"""

from datetime import datetime, date, time, timedelta
from unittest.mock import patch, MagicMock
from zoneinfo import ZoneInfo

from django.test import SimpleTestCase

from apps.tabdata.services.view_filter_service import resolve_date_filter_range

_MODULE = 'apps.tabdata.services.view_filter_service'

TZ_SH = ZoneInfo('Asia/Shanghai')
TZ_UTC = ZoneInfo('UTC')

# 2025-06-18 (周三, weekday=2) 14:30 上海时间
FIXED_NOW = datetime(2025, 6, 18, 14, 30, 0, tzinfo=TZ_SH)


def _patch_now():
    mock_dt = MagicMock()
    mock_dt.now.return_value = FIXED_NOW
    mock_dt.combine = datetime.combine
    return patch(f'{_MODULE}.datetime', mock_dt)


def _utc_start(y, m, d, tz=TZ_SH):
    return datetime.combine(date(y, m, d), time.min, tzinfo=tz).astimezone(TZ_UTC)


def _utc_end(y, m, d, tz=TZ_SH):
    return datetime.combine(
        date(y, m, d), time(23, 59, 59, 999999), tzinfo=tz
    ).astimezone(TZ_UTC)


class TodayYesterdayTomorrowTests(SimpleTestCase):
    """today / yesterday / tomorrow"""

    def _call(self, mode):
        with _patch_now():
            return resolve_date_filter_range({
                'mode': mode, 'timeZone': 'Asia/Shanghai',
            })

    def test_today(self):
        start, end = self._call('today')
        self.assertEqual(start, _utc_start(2025, 6, 18))
        self.assertEqual(end, _utc_end(2025, 6, 18))

    def test_yesterday(self):
        start, end = self._call('yesterday')
        self.assertEqual(start, _utc_start(2025, 6, 17))
        self.assertEqual(end, _utc_end(2025, 6, 17))

    def test_tomorrow(self):
        start, end = self._call('tomorrow')
        self.assertEqual(start, _utc_start(2025, 6, 19))
        self.assertEqual(end, _utc_end(2025, 6, 19))


class WeekModeTests(SimpleTestCase):
    """thisWeek / lastWeek / nextWeek — 周一起始"""

    def _call(self, mode):
        with _patch_now():
            return resolve_date_filter_range({
                'mode': mode, 'timeZone': 'Asia/Shanghai',
            })

    def test_this_week(self):
        start, end = self._call('thisWeek')
        self.assertEqual(start, _utc_start(2025, 6, 16))
        self.assertEqual(end, _utc_end(2025, 6, 22))

    def test_last_week(self):
        start, end = self._call('lastWeek')
        self.assertEqual(start, _utc_start(2025, 6, 9))
        self.assertEqual(end, _utc_end(2025, 6, 15))

    def test_next_week(self):
        start, end = self._call('nextWeek')
        self.assertEqual(start, _utc_start(2025, 6, 23))
        self.assertEqual(end, _utc_end(2025, 6, 29))


class MonthModeTests(SimpleTestCase):
    """thisMonth / lastMonth / nextMonth"""

    def _call(self, mode):
        with _patch_now():
            return resolve_date_filter_range({
                'mode': mode, 'timeZone': 'Asia/Shanghai',
            })

    def test_this_month(self):
        start, end = self._call('thisMonth')
        self.assertEqual(start, _utc_start(2025, 6, 1))
        self.assertEqual(end, _utc_end(2025, 6, 30))

    def test_last_month(self):
        start, end = self._call('lastMonth')
        self.assertEqual(start, _utc_start(2025, 5, 1))
        self.assertEqual(end, _utc_end(2025, 5, 31))

    def test_next_month(self):
        start, end = self._call('nextMonth')
        self.assertEqual(start, _utc_start(2025, 7, 1))
        self.assertEqual(end, _utc_end(2025, 7, 31))


class YearModeTests(SimpleTestCase):
    """thisYear / lastYear / nextYear"""

    def _call(self, mode):
        with _patch_now():
            return resolve_date_filter_range({
                'mode': mode, 'timeZone': 'Asia/Shanghai',
            })

    def test_this_year(self):
        start, end = self._call('thisYear')
        self.assertEqual(start, _utc_start(2025, 1, 1))
        self.assertEqual(end, _utc_end(2025, 12, 31))

    def test_last_year(self):
        start, end = self._call('lastYear')
        self.assertEqual(start, _utc_start(2024, 1, 1))
        self.assertEqual(end, _utc_end(2024, 12, 31))

    def test_next_year(self):
        start, end = self._call('nextYear')
        self.assertEqual(start, _utc_start(2026, 1, 1))
        self.assertEqual(end, _utc_end(2026, 12, 31))


class PastDaysTests(SimpleTestCase):
    """pastDays 模式及边界值"""

    def _call(self, n=None):
        value = {'mode': 'pastDays', 'timeZone': 'Asia/Shanghai'}
        if n is not None:
            value['numberOfDays'] = n
        with _patch_now():
            return resolve_date_filter_range(value)

    def test_normal(self):
        start, end = self._call(7)
        self.assertEqual(start, _utc_start(2025, 6, 11))
        self.assertEqual(end, _utc_end(2025, 6, 18))

    def test_min_clamp_zero(self):
        start, _ = self._call(0)
        self.assertEqual(start, _utc_start(2025, 6, 17))

    def test_min_clamp_negative(self):
        start, _ = self._call(-10)
        self.assertEqual(start, _utc_start(2025, 6, 17))

    def test_max_clamp(self):
        start, _ = self._call(5000)
        expected = date(2025, 6, 18) - timedelta(days=365)
        self.assertEqual(start, _utc_start(expected.year, expected.month, expected.day))

    def test_none_defaults_to_1(self):
        start, _ = self._call(None)
        self.assertEqual(start, _utc_start(2025, 6, 17))


class NextDaysTests(SimpleTestCase):
    """nextDays 模式及边界值"""

    def _call(self, n=None):
        value = {'mode': 'nextDays', 'timeZone': 'Asia/Shanghai'}
        if n is not None:
            value['numberOfDays'] = n
        with _patch_now():
            return resolve_date_filter_range(value)

    def test_normal(self):
        start, end = self._call(7)
        self.assertEqual(start, _utc_start(2025, 6, 18))
        self.assertEqual(end, _utc_end(2025, 6, 25))

    def test_min_clamp_zero(self):
        _, end = self._call(0)
        self.assertEqual(end, _utc_end(2025, 6, 19))

    def test_min_clamp_negative(self):
        _, end = self._call(-5)
        self.assertEqual(end, _utc_end(2025, 6, 19))

    def test_max_clamp(self):
        _, end = self._call(10000)
        expected = date(2025, 6, 18) + timedelta(days=365)
        self.assertEqual(end, _utc_end(expected.year, expected.month, expected.day))

    def test_none_defaults_to_1(self):
        _, end = self._call(None)
        self.assertEqual(end, _utc_end(2025, 6, 19))


class ExactDateTests(SimpleTestCase):
    """exactDate 模式"""

    def test_valid_date(self):
        with _patch_now():
            start, end = resolve_date_filter_range({
                'mode': 'exactDate',
                'exactDate': '2025-01-15',
                'timeZone': 'Asia/Shanghai',
            })
        self.assertEqual(start, _utc_start(2025, 1, 15))
        self.assertEqual(end, _utc_end(2025, 1, 15))

    def test_date_with_time_suffix_ignored(self):
        with _patch_now():
            start, end = resolve_date_filter_range({
                'mode': 'exactDate',
                'exactDate': '2025-01-15T12:00:00Z',
                'timeZone': 'Asia/Shanghai',
            })
        self.assertEqual(start, _utc_start(2025, 1, 15))

    def test_missing_exact_date_raises(self):
        with _patch_now():
            with self.assertRaises(ValueError) as ctx:
                resolve_date_filter_range({
                    'mode': 'exactDate', 'timeZone': 'UTC',
                })
        self.assertIn('exactDate', str(ctx.exception))

    def test_invalid_format_raises(self):
        with _patch_now():
            with self.assertRaises(ValueError):
                resolve_date_filter_range({
                    'mode': 'exactDate',
                    'exactDate': 'not-a-date',
                    'timeZone': 'UTC',
                })


class DateRangeTests(SimpleTestCase):
    """dateRange 模式"""

    def test_normal_range(self):
        with _patch_now():
            start, end = resolve_date_filter_range({
                'mode': 'dateRange',
                'exactDate': '2025-03-01',
                'exactDateEnd': '2025-03-15',
                'timeZone': 'Asia/Shanghai',
            })
        self.assertEqual(start, _utc_start(2025, 3, 1))
        self.assertEqual(end, _utc_end(2025, 3, 15))

    def test_swap_when_end_before_start(self):
        with _patch_now():
            start, end = resolve_date_filter_range({
                'mode': 'dateRange',
                'exactDate': '2025-06-20',
                'exactDateEnd': '2025-06-10',
                'timeZone': 'Asia/Shanghai',
            })
        self.assertEqual(start, _utc_start(2025, 6, 10))
        self.assertEqual(end, _utc_end(2025, 6, 20))

    def test_same_date_range(self):
        with _patch_now():
            start, end = resolve_date_filter_range({
                'mode': 'dateRange',
                'exactDate': '2025-06-18',
                'exactDateEnd': '2025-06-18',
                'timeZone': 'Asia/Shanghai',
            })
        self.assertEqual(start, _utc_start(2025, 6, 18))
        self.assertEqual(end, _utc_end(2025, 6, 18))

    def test_missing_start_raises(self):
        with _patch_now():
            with self.assertRaises(ValueError):
                resolve_date_filter_range({
                    'mode': 'dateRange',
                    'exactDateEnd': '2025-06-30',
                    'timeZone': 'UTC',
                })

    def test_missing_end_raises(self):
        with _patch_now():
            with self.assertRaises(ValueError):
                resolve_date_filter_range({
                    'mode': 'dateRange',
                    'exactDate': '2025-06-01',
                    'timeZone': 'UTC',
                })

    def test_invalid_start_format_raises(self):
        with _patch_now():
            with self.assertRaises(ValueError):
                resolve_date_filter_range({
                    'mode': 'dateRange',
                    'exactDate': 'bad',
                    'exactDateEnd': '2025-06-30',
                    'timeZone': 'UTC',
                })

    def test_invalid_end_format_raises(self):
        with _patch_now():
            with self.assertRaises(ValueError):
                resolve_date_filter_range({
                    'mode': 'dateRange',
                    'exactDate': '2025-06-01',
                    'exactDateEnd': 'bad',
                    'timeZone': 'UTC',
                })


class InvalidTimezoneTests(SimpleTestCase):
    """无效时区回退到 UTC"""

    def test_invalid_tz_falls_back_to_utc(self):
        with _patch_now():
            start, end = resolve_date_filter_range({
                'mode': 'today', 'timeZone': 'Invalid/Timezone',
            })
        self.assertEqual(start, _utc_start(2025, 6, 18, tz=TZ_UTC))
        self.assertEqual(end, _utc_end(2025, 6, 18, tz=TZ_UTC))

    def test_empty_tz_uses_utc(self):
        with _patch_now():
            start, end = resolve_date_filter_range({
                'mode': 'today', 'timeZone': '',
            })
        self.assertEqual(start, _utc_start(2025, 6, 18, tz=TZ_UTC))

    def test_missing_tz_key_uses_utc(self):
        with _patch_now():
            start, end = resolve_date_filter_range({'mode': 'today'})
        self.assertEqual(start, _utc_start(2025, 6, 18, tz=TZ_UTC))


class MissingModeTests(SimpleTestCase):
    """mode 缺失或不支持"""

    def test_missing_mode_raises(self):
        with _patch_now():
            with self.assertRaises(ValueError) as ctx:
                resolve_date_filter_range({'timeZone': 'UTC'})
        self.assertIn('mode', str(ctx.exception))

    def test_unsupported_mode_raises(self):
        with _patch_now():
            with self.assertRaises(ValueError):
                resolve_date_filter_range({
                    'mode': 'biweekly', 'timeZone': 'UTC',
                })

    def test_empty_mode_raises(self):
        with _patch_now():
            with self.assertRaises(ValueError):
                resolve_date_filter_range({
                    'mode': '', 'timeZone': 'UTC',
                })


class TimezoneConversionTests(SimpleTestCase):
    """验证时区转换为 UTC 的正确性"""

    def test_shanghai_today_start_is_utc_minus_8(self):
        with _patch_now():
            start, _ = resolve_date_filter_range({
                'mode': 'today', 'timeZone': 'Asia/Shanghai',
            })
        self.assertEqual(start.tzinfo, TZ_UTC)
        self.assertEqual(start.hour, 16)
        self.assertEqual(start.day, 17)

    def test_utc_today_start_is_midnight(self):
        with _patch_now():
            start, _ = resolve_date_filter_range({
                'mode': 'today', 'timeZone': 'UTC',
            })
        self.assertEqual(start.hour, 0)
        self.assertEqual(start.minute, 0)
        self.assertEqual(start.day, 18)

    def test_result_always_utc(self):
        modes = ['today', 'yesterday', 'tomorrow', 'thisWeek', 'thisMonth', 'thisYear']
        for mode in modes:
            with _patch_now():
                start, end = resolve_date_filter_range({
                    'mode': mode, 'timeZone': 'Asia/Shanghai',
                })
            self.assertEqual(start.tzinfo, TZ_UTC, f'{mode} start not UTC')
            self.assertEqual(end.tzinfo, TZ_UTC, f'{mode} end not UTC')

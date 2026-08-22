"""
基建层 F1 修复回归测试 — INFRA-8(Redis key), INFRA-16/40(分批清理), INFRA-53(Backend重试)

纯单元测试（无 DB 依赖），通过 mock 验证修复逻辑。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/maintenance/tests/test_infra_f1_fixes.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

from unittest.mock import MagicMock, patch
import pytest

from django.test import override_settings
from django.utils import timezone


# ━━ INFRA-8: check_queue_health 读取正确的 Redis key ━━━━━━━━━━━━━

class TestINFRA8RedisKeyMapping:
    """default 队列应读取 Redis key 'default' 而非 'celery'。"""

    @patch("redis.from_url")
    def test_default_queue_reads_correct_redis_key(self, mock_from_url):
        """check_queue_health 中 default 队列必须使用 r.llen('default')"""
        from apps.maintenance.celery_health import CeleryHealthChecker

        mock_conn = MagicMock()
        mock_conn.llen.return_value = 0
        mock_from_url.return_value = mock_conn

        checker = CeleryHealthChecker()
        checker.check_queue_health()

        called_keys = [c[0][0] for c in mock_conn.llen.call_args_list]
        assert 'default' in called_keys, (
            f"应使用 r.llen('default') 而非 r.llen('celery')；实际: {called_keys}"
        )
        assert 'celery' not in called_keys, (
            "不应再使用 r.llen('celery') 读取 default 队列"
        )

    @patch("redis.from_url")
    def test_all_queues_use_matching_redis_keys(self, mock_from_url):
        """所有队列的 Redis key 应与队列名一致。"""
        mock_conn = MagicMock()
        mock_conn.llen.return_value = 5
        mock_from_url.return_value = mock_conn

        from apps.maintenance.celery_health import CeleryHealthChecker
        checker = CeleryHealthChecker()
        checker.check_queue_health()

        from django.conf import settings

        expected_keys = {
            'critical',
            'default',
            'realtime_delivery',
            'search_indexing',
            'rag_indexing',
            'tabdata_compute',
            'doc_merge',
            'heavy',
            'media',
            'docparse',
            'tabdata_conversion',
            'low_priority',
            settings.PPTX_IMPORT_OSS_QUEUE,
            settings.TRACKER_AGENT_QUEUE,
        }
        called_keys = {c[0][0] for c in mock_conn.llen.call_args_list}
        assert called_keys == expected_keys, (
            f"Redis key 应与队列名一一对应；期望: {expected_keys}，实际: {called_keys}"
        )

    @override_settings(TRACKER_AGENT_QUEUE="tracker_agent_desktop_test")
    @patch("redis.from_url")
    def test_tracker_queue_uses_configured_isolated_key(self, mock_from_url):
        """本地 remote infra 隔离队列下，健康检查应读取配置队列而非旧通用队列。"""
        mock_conn = MagicMock()
        mock_conn.llen.return_value = 5
        mock_from_url.return_value = mock_conn

        from apps.maintenance.celery_health import CeleryHealthChecker
        checker = CeleryHealthChecker()
        result = checker.check_queue_health()

        called_keys = {c[0][0] for c in mock_conn.llen.call_args_list}
        assert 'tracker_agent_desktop_test' in called_keys
        assert 'tracker_agent' not in called_keys
        assert 'tracker_agent_desktop_test' in result["queues"]

    @patch("redis.from_url")
    def test_queue_backlog_detected_on_default(self, mock_from_url):
        """default 队列堆积时应能正确检测到（修复前永远为 0）。"""
        mock_conn = MagicMock()
        mock_conn.llen.side_effect = lambda key: 200 if key == 'default' else 0
        mock_from_url.return_value = mock_conn

        from apps.maintenance.celery_health import CeleryHealthChecker
        checker = CeleryHealthChecker()
        result = checker.check_queue_health()

        assert not result["healthy"], "default 堆积 200 应判定不健康"
        assert any("default" in issue for issue in result["issues"])


# ━━ INFRA-16/40: cleanup_celery_results 分批删除 ━━━━━━━━━━━━━━━━

class TestINFRA16_40BatchCleanup:
    """cleanup_celery_results 应分批删除而非单次全量 delete()。"""

    @patch("apps.maintenance.tasks.timezone")
    def test_batch_deletion_multiple_rounds(self, mock_tz):
        """当记录数 > batch_size 时，应分多轮删除。"""
        mock_tz.now.return_value = timezone.now()

        batches = [[1, 2, 3], [4, 5], []]

        with patch("django_celery_results.models.TaskResult") as MockTaskResult:
            call_count = [0]

            class FakeSliceable:
                def __getitem__(self, key):
                    idx = min(call_count[0], len(batches) - 1)
                    call_count[0] += 1
                    return batches[idx]

            mock_filter_main = MagicMock()
            mock_filter_main.values_list.return_value = FakeSliceable()

            def objects_filter(**kwargs):
                if 'date_done__lt' in kwargs:
                    return mock_filter_main
                elif 'id__in' in kwargs:
                    deleted = len(kwargs['id__in'])
                    m = MagicMock()
                    m.delete.return_value = (deleted, {})
                    return m
                return MagicMock()

            MockTaskResult.objects.filter = objects_filter

            from apps.maintenance.tasks import cleanup_celery_results
            result = cleanup_celery_results(batch_size=3)

            assert result["success"] is True
            assert result["cleaned_results"] == 5, (
                f"应删除 5 条（3+2），实际: {result['cleaned_results']}"
            )

    @patch("apps.maintenance.tasks.timezone")
    def test_empty_results_no_deletion(self, mock_tz):
        """没有过期记录时不应执行任何删除。"""
        mock_tz.now.return_value = timezone.now()

        with patch("django_celery_results.models.TaskResult") as MockTaskResult:
            class EmptySliceable:
                def __getitem__(self, key):
                    return []

            mock_filter = MagicMock()
            mock_filter.values_list.return_value = EmptySliceable()
            MockTaskResult.objects.filter.return_value = mock_filter

            from apps.maintenance.tasks import cleanup_celery_results
            result = cleanup_celery_results(batch_size=1000)

            assert result["success"] is True
            assert result["cleaned_results"] == 0

    def test_cleanup_schedule_frequency(self):
        """cleanup-celery-results 调度频率应为每 6 小时。"""
        from apps.maintenance.tasks import MAINTENANCE_SCHEDULE
        entry = MAINTENANCE_SCHEDULE['cleanup-celery-results']
        schedule = entry['schedule']
        assert schedule.hour == set(range(0, 24, 6)), (
            f"应每 6 小时执行，实际 hour={schedule.hour}"
        )


# ━━ INFRA-53: django-db backend 重试配置 ━━━━━━━━━━━━━━━━━━━━━━━━

class TestINFRA53ResultBackendConfig:
    """验证 CELERY_RESULT_BACKEND_MAX_RETRIES 已正确配置。"""

    def test_result_backend_max_retries_configured(self):
        """settings 中应显式设置 CELERY_RESULT_BACKEND_MAX_RETRIES。"""
        from django.conf import settings
        assert hasattr(settings, 'CELERY_RESULT_BACKEND_MAX_RETRIES'), (
            "CELERY_RESULT_BACKEND_MAX_RETRIES 未配置"
        )
        assert settings.CELERY_RESULT_BACKEND_MAX_RETRIES >= 1, (
            "应 >= 1 以提供重试保护"
        )

    def test_result_backend_is_django_db(self):
        """确认 Result Backend 使用 django-db。"""
        from django.conf import settings
        assert settings.CELERY_RESULT_BACKEND == 'django-db'

    def test_result_expires_matches_cleanup_window(self):
        """CELERY_RESULT_EXPIRES 应与 cleanup_celery_results 的 7 天窗口一致。"""
        from django.conf import settings
        assert settings.CELERY_RESULT_EXPIRES == 86400 * 7

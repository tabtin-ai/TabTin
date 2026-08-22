"""
F6 数据层 P0 回归测试 — DATA-8/9/12/13/14/15/29/32

纯单元测试（无 DB 依赖），通过 mock 验证修复逻辑。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/tabdata/tests/test_data_p0_f6.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

from datetime import timedelta
from unittest.mock import MagicMock, Mock, patch, call
import pytest


# ━━ DATA-9: 连接器同步分布式锁 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestConnectorSyncLock:
    """验证同一 mapping_id 并发执行时，第二个任务被跳过。"""

    @patch("apps.tabdata.tasks.connector_tasks._release_sync_lock")
    @patch("apps.tabdata.tasks.connector_tasks._acquire_sync_lock", return_value=False)
    def test_skips_when_lock_held(self, mock_acquire, mock_release):
        from apps.tabdata.tasks.connector_tasks import sync_connector_table
        result = sync_connector_table("mapping-123")
        assert result == {'status': 'skipped', 'reason': 'lock_held'}
        mock_acquire.assert_called_once_with("mapping-123")
        mock_release.assert_not_called()

    @patch("apps.tabdata.tasks.connector_tasks._release_sync_lock")
    @patch("apps.tabdata.tasks.connector_tasks._acquire_sync_lock", return_value=True)
    def test_releases_lock_on_success(self, mock_acquire, mock_release):
        from apps.tabdata.tasks.connector_tasks import sync_connector_table

        _DoesNotExist = type('DoesNotExist', (Exception,), {})
        with patch("apps.tabdata.models_connector.ConnectorTableMapping") as MockCTM:
            MockCTM.DoesNotExist = _DoesNotExist
            MockCTM.objects.using.return_value.get.side_effect = _DoesNotExist
            sync_connector_table("mapping-456")

        mock_release.assert_called_once_with("mapping-456")

    @patch("apps.tabdata.tasks.connector_tasks._release_sync_lock")
    @patch("apps.tabdata.tasks.connector_tasks._acquire_sync_lock", return_value=True)
    @patch("apps.tabdata.tasks.connector_tasks._persist_mapping_status")
    def test_releases_lock_on_exception(self, mock_persist, mock_acquire, mock_release):
        from apps.tabdata.tasks.connector_tasks import sync_connector_table

        _DoesNotExist = type('DoesNotExist', (Exception,), {})
        with patch("apps.tabdata.models_connector.ConnectorTableMapping") as MockCTM:
            mapping = MagicMock()
            mapping.connector.status = 'connected'
            mapping.connector.created_by = MagicMock()
            MockCTM.objects.using.return_value.get.return_value = mapping
            MockCTM.DoesNotExist = _DoesNotExist

            with patch("apps.tabdata.services.connector_service.ConnectorService") as MockSvc:
                instance = MagicMock()
                MockSvc.return_value._get_connector_instance.return_value = instance

                with patch("apps.tabdata.tasks.connector_tasks._do_mirror_sync", side_effect=RuntimeError("boom")):
                    try:
                        sync_connector_table("mapping-789")
                    except Exception:
                        pass

        mock_release.assert_called_once_with("mapping-789")


# ━━ DATA-8: 失败状态持久化 + 失败不推进 last_sync_at ━━━━━━━━━━━━━━━

class TestConnectorFailurePersistence:
    """验证同步失败时：错误状态被持久化到 DB，且 last_sync_at 不被推进。"""

    @patch("apps.tabdata.tasks.connector_tasks._release_sync_lock")
    @patch("apps.tabdata.tasks.connector_tasks._acquire_sync_lock", return_value=True)
    @patch("apps.tabdata.tasks.connector_tasks._persist_mapping_status")
    def test_failure_persists_error_without_advancing_sync_at(self, mock_persist, mock_acquire, mock_release):
        """验证失败时 _persist_mapping_status 被调用且 update_sync_at=False。"""
        from apps.tabdata.tasks.connector_tasks import sync_connector_table

        _DoesNotExist = type('DoesNotExist', (Exception,), {})
        with patch("apps.tabdata.models_connector.ConnectorTableMapping") as MockCTM:
            mapping = MagicMock()
            mapping.connector.status = 'connected'
            mapping.connector.created_by = MagicMock()
            MockCTM.objects.using.return_value.get.return_value = mapping
            MockCTM.DoesNotExist = _DoesNotExist

            with patch("apps.tabdata.services.connector_service.ConnectorService") as MockSvc:
                instance = MagicMock()
                MockSvc.return_value._get_connector_instance.return_value = instance
                instance.close = MagicMock()

                with patch("apps.tabdata.tasks.connector_tasks._do_mirror_sync", side_effect=RuntimeError("db down")):
                    try:
                        sync_connector_table("m-1")
                    except Exception:
                        pass

            assert mapping.last_sync_status == 'error'
            assert 'db down' in mapping.last_sync_error

            mock_persist.assert_called()
            _, kwargs = mock_persist.call_args
            assert kwargs.get('update_sync_at') is False

    @patch("apps.tabdata.tasks.connector_tasks._release_sync_lock")
    @patch("apps.tabdata.tasks.connector_tasks._acquire_sync_lock", return_value=True)
    @patch("apps.tabdata.tasks.connector_tasks._persist_mapping_status")
    def test_success_advances_sync_at(self, mock_persist, mock_acquire, mock_release):
        """验证成功时 _persist_mapping_status 被调用且 update_sync_at=True。"""
        from apps.tabdata.tasks.connector_tasks import sync_connector_table

        _DoesNotExist = type('DoesNotExist', (Exception,), {})
        with patch("apps.tabdata.models_connector.ConnectorTableMapping") as MockCTM:
            mapping = MagicMock()
            mapping.connector.status = 'connected'
            mapping.connector.created_by = MagicMock()
            MockCTM.objects.using.return_value.get.return_value = mapping
            MockCTM.DoesNotExist = _DoesNotExist

            with patch("apps.tabdata.services.connector_service.ConnectorService") as MockSvc:
                instance = MagicMock()
                MockSvc.return_value._get_connector_instance.return_value = instance
                instance.close = MagicMock()

                with patch("apps.tabdata.tasks.connector_tasks._do_mirror_sync"):
                    sync_connector_table("m-2")

            assert mapping.last_sync_status == 'success'
            mock_persist.assert_called_once()
            _, kwargs = mock_persist.call_args
            assert kwargs.get('update_sync_at') is True


# ━━ DATA-12/13: Webhook 拆分子任务 + 重试增强 ━━━━━━━━━━━━━━━━━━━━━

class TestWebhookSubtaskSplit:
    """验证 deliver_webhook_event 将每个 webhook 拆为独立子任务。"""

    @patch("apps.tabdata.tasks.webhook_tasks.deliver_single_webhook")
    def test_dispatches_subtasks(self, mock_single):
        from apps.tabdata.tasks.webhook_tasks import deliver_webhook_event

        wh1, wh2 = MagicMock(id="wh-1"), MagicMock(id="wh-2")

        with patch("apps.tabdata.services.webhook_service.WebhookDeliveryService") as MockSvc:
            MockSvc.find_matching_webhooks.return_value = [wh1, wh2]
            MockSvc.build_payload.return_value = {'event': 'record.created'}

            result = deliver_webhook_event("sp-1", "record.created", "tbl-1", {"key": "val"})

        assert result['count'] == 2
        assert mock_single.delay.call_count == 2

    @patch("apps.tabdata.tasks.webhook_tasks.deliver_single_webhook")
    def test_no_webhooks_returns_zero(self, mock_single):
        from apps.tabdata.tasks.webhook_tasks import deliver_webhook_event

        with patch("apps.tabdata.services.webhook_service.WebhookDeliveryService") as MockSvc:
            MockSvc.find_matching_webhooks.return_value = []

            result = deliver_webhook_event("sp-1", "record.created")

        assert result['count'] == 0
        mock_single.delay.assert_not_called()


class TestWebhookRetryConfig:
    """验证 Webhook 任务的重试配置（原 max_retries=1，修复后 ≥4）。"""

    def test_deliver_event_max_retries_increased(self):
        from apps.tabdata.tasks.webhook_tasks import deliver_webhook_event
        assert deliver_webhook_event.max_retries >= 4, \
            f"deliver_webhook_event 应至少 4 次重试，实际 {deliver_webhook_event.max_retries}"

    def test_deliver_single_max_retries_increased(self):
        from apps.tabdata.tasks.webhook_tasks import deliver_single_webhook
        assert deliver_single_webhook.max_retries >= 4, \
            f"deliver_single_webhook 应至少 4 次重试，实际 {deliver_single_webhook.max_retries}"

    def test_deliver_single_acks_late(self):
        from apps.tabdata.tasks.webhook_tasks import deliver_single_webhook
        assert deliver_single_webhook.acks_late is True


# ━━ DATA-14: Link 完整性检查 time_limit ━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestLinkIntegrityTimeLimit:
    """验证 Link 完整性检查的 time_limit 已提升。"""

    def test_check_link_integrity_time_limit(self):
        from apps.tabdata.tasks.link_integrity_tasks import check_link_integrity
        assert check_link_integrity.time_limit == 1800

    def test_check_link_integrity_soft_time_limit(self):
        from apps.tabdata.tasks.link_integrity_tasks import check_link_integrity
        assert check_link_integrity.soft_time_limit == 1740

    def test_dry_run_time_limit(self):
        from apps.tabdata.tasks.link_integrity_tasks import check_link_integrity_dry_run
        assert check_link_integrity_dry_run.time_limit == 1800


# ━━ DATA-15: History cleanup expires ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestHistoryCleanupExpires:
    """验证 cleanup_record_history Beat 配置中 expires >= time_limit。"""

    def test_expires_gte_time_limit(self):
        from apps.tabdata.tasks.history_tasks import (
            TABDATA_HISTORY_BEAT_SCHEDULE,
            cleanup_record_history,
        )
        schedule_opts = TABDATA_HISTORY_BEAT_SCHEDULE["tabdata-cleanup-history"]["options"]
        assert schedule_opts["expires"] >= cleanup_record_history.time_limit


# ━━ DATA-29: backfill_history_ttl 按计划级别分配 ━━━━━━━━━━━━━━━━━━━

class TestBackfillHistoryTtlPlanLevel:
    """验证 backfill 根据计划级别设置不同 TTL。"""

    def test_resolve_history_ttl_free(self):
        from apps.tabdata.tasks.history_tasks import _resolve_history_ttl, HISTORY_TTL_FREE

        with patch("apps.tabdata.tasks.history_tasks.timezone"):
            with patch("apps.users.membership.models.OrganizationMembership") as MockWS:
                MockWS.objects.select_related.return_value.filter.return_value.first.return_value = None
                result = _resolve_history_ttl("ws-1")
        assert result == HISTORY_TTL_FREE

    def test_resolve_history_ttl_pro(self):
        from apps.tabdata.tasks.history_tasks import _resolve_history_ttl, HISTORY_TTL_PRO

        tier_mock = MagicMock()
        tier_mock.tier_type = "pro"
        ws_mock = MagicMock()
        ws_mock.tier = tier_mock
        ws_mock.end_date = None

        with patch("apps.users.membership.models.OrganizationMembership") as MockWS:
            MockWS.objects.select_related.return_value.filter.return_value.first.return_value = ws_mock
            result = _resolve_history_ttl("ws-2")
        assert result == HISTORY_TTL_PRO

    def test_resolve_history_ttl_enterprise(self):
        from apps.tabdata.tasks.history_tasks import _resolve_history_ttl, HISTORY_TTL_TEAM

        tier_mock = MagicMock()
        tier_mock.tier_type = "enterprise"
        ws_mock = MagicMock()
        ws_mock.tier = tier_mock
        ws_mock.end_date = None

        with patch("apps.users.membership.models.OrganizationMembership") as MockWS:
            MockWS.objects.select_related.return_value.filter.return_value.first.return_value = ws_mock
            result = _resolve_history_ttl("ws-3")
        assert result == HISTORY_TTL_TEAM

    def test_resolve_history_ttl_none_organization(self):
        from apps.tabdata.tasks.history_tasks import _resolve_history_ttl, HISTORY_TTL_FREE
        assert _resolve_history_ttl(None) == HISTORY_TTL_FREE


# ━━ DATA-32: daily summary 清理 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestCleanupDailySummary:
    """验证 cleanup_old_api_logs 包含 daily summary 清理。"""

    @patch("apps.tabdata.tasks.api_log_tasks.timezone")
    def test_cleans_daily_summaries(self, mock_tz):
        from apps.tabdata.tasks.api_log_tasks import cleanup_old_api_logs
        from datetime import datetime

        now = MagicMock()
        now.__sub__ = lambda self, other: timedelta(days=0)
        mock_tz.now.return_value = now

        with patch("apps.tabdata.models_api_log.ApiCallLog") as MockLog:
            log_qs = MagicMock()
            log_qs.values_list.return_value.__getitem__ = MagicMock(return_value=[])
            MockLog.objects.using.return_value.filter.return_value = log_qs

            with patch("apps.tabdata.models_api_log.ApiUsageSummary") as MockSummary:
                summary_qs = MagicMock()
                summary_qs.values_list.return_value.__getitem__ = MagicMock(return_value=[])
                MockSummary.objects.using.return_value.filter.return_value = summary_qs

                cleanup_old_api_logs()

                filter_calls = MockSummary.objects.using.return_value.filter.call_args_list
                period_types_cleaned = set()
                for c in filter_calls:
                    kwargs = c[1] if c[1] else {}
                    if 'period_type' in kwargs:
                        period_types_cleaned.add(kwargs['period_type'])

                assert 'day' in period_types_cleaned, \
                    "cleanup_old_api_logs must clean daily summaries (period_type='day')"
                assert 'hour' in period_types_cleaned

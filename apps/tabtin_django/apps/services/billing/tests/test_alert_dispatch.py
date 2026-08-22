from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.db.models.signals import post_save
from django.test import TestCase

from apps.services.billing.models import BillingAnomalyAlert
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import User
from apps.services.billing.tests.org_test_utils import org_id_for


def _immediate_on_commit(func, using=None):
    """让 on_commit 回调立即执行，绕过 TestCase 事务不提交的限制。"""
    func()


class AlertAutoDispatchTests(TestCase):
    """验证 critical 级 BillingAnomalyAlert 自动投递 webhook。"""

    databases = {"default"}

    def setUp(self):
        post_save.disconnect(create_default_organization, sender=User)
        self.addCleanup(lambda: post_save.connect(create_default_organization, sender=User))
        cache.clear()
        self.addCleanup(cache.clear)

    def _make_alert(self, *, severity="critical", alert_type="spike"):
        return BillingAnomalyAlert.objects.create(
            alert_type=alert_type,
            severity=severity,
            organization_id=org_id_for("ws_test_alert"),
            metric_name="test_metric",
            current_value=100,
            baseline_value=10,
            message="test alert message",
        )

    @patch("apps.services.billing.tasks._dispatch_billing_alert")
    @patch("django.db.connection.on_commit", side_effect=_immediate_on_commit)
    def test_critical_alert_dispatches_via_signal(self, _mock_on_commit, mock_dispatch):
        """BillingAnomalyAlert.objects.create(severity='critical') 应触发 _dispatch_billing_alert。"""
        alert = self._make_alert(severity="critical")

        mock_dispatch.assert_called_once()
        call_args = mock_dispatch.call_args
        self.assertEqual(call_args[0][0], "spike")
        self.assertEqual(call_args[0][1], "critical")
        self.assertEqual(call_args[0][2], "test alert message")
        self.assertEqual(call_args[1]["organization_id"], org_id_for("ws_test_alert"))
        self.assertEqual(call_args[1]["extra"]["alert_id"], str(alert.id))

    @patch("apps.services.billing.tasks._dispatch_billing_alert")
    @patch("django.db.connection.on_commit", side_effect=_immediate_on_commit)
    def test_non_critical_alert_does_not_dispatch(self, _mock_on_commit, mock_dispatch):
        """severity='warning' 不应触发自动投递。"""
        self._make_alert(severity="warning")
        mock_dispatch.assert_not_called()

    @patch("apps.services.billing.tasks.logger")
    @patch("django.db.connection.on_commit", side_effect=_immediate_on_commit)
    def test_dedup_prevents_double_dispatch(self, _mock_on_commit, mock_logger):
        """同一 alert_id 的 signal 投递 + 显式投递只实际执行一次日志/webhook。"""
        from apps.services.billing.tasks import _dispatch_billing_alert

        alert = self._make_alert(severity="critical")
        alert_id = str(alert.id)

        critical_call_count = sum(
            1 for c in mock_logger.critical.call_args_list
            if alert_id in str(c)
        )
        self.assertEqual(critical_call_count, 1, "signal 触发应产生恰好一次 critical 日志")

        mock_logger.critical.reset_mock()
        _dispatch_billing_alert(
            "spike", "critical", "test alert message",
            organization_id=org_id_for("ws_test_alert"),
            extra={"alert_id": alert_id},
        )
        self.assertFalse(
            mock_logger.critical.called,
            "重复 alert_id 的显式调用不应再次产生 critical 日志",
        )

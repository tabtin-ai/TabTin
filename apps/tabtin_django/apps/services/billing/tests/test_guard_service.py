from datetime import timedelta
from unittest.mock import patch

from django.core.cache import cache
from django.db.models.signals import post_save
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.i18n.language import SupportedLanguage, clear_user_language, set_user_language
from apps.services.billing.models import BillingAnomalyAlert, BillingBudgetPolicy
from apps.services.billing.services.guard_service import (
    BillingBlockedError,
    BillingGuardService,
)
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import User
from apps.users.membership.models import MembershipTier, OrganizationMembership
from apps.services.billing.tests.org_test_utils import org_id_for


class BillingGuardServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        post_save.disconnect(create_default_organization, sender=User)
        self.addCleanup(lambda: post_save.connect(create_default_organization, sender=User))
        cache.clear()
        self.addCleanup(clear_user_language)
        self.ws_id = org_id_for("ws_guard_test_001")
        self.tier = MembershipTier.objects.create(
            tier_type="guard_test_tier",
            name="Guard Test Tier",
        )

    def _create_policy(self, *, block_on_critical=True, is_active=True):
        return BillingBudgetPolicy.objects.create(
            organization_id=self.ws_id,
            block_on_critical=block_on_critical,
            is_active=is_active,
        )

    def _create_critical_alert(self, *, age_minutes=30, is_resolved=False, metric_name="test_metric"):
        alert = BillingAnomalyAlert.objects.create(
            alert_type="spike",
            severity="critical",
            organization_id=self.ws_id,
            metric_name=metric_name,
            current_value=100,
            baseline_value=10,
            message="Test critical alert",
            is_resolved=is_resolved,
        )
        if age_minutes != 30:
            target_time = timezone.now() - timedelta(minutes=age_minutes)
            BillingAnomalyAlert.objects.filter(id=alert.id).update(created_at=target_time)
            alert.refresh_from_db()
        return alert

    def _create_membership(self, *, status="active", end_delta_hours=-1):
        now = timezone.now()
        return OrganizationMembership.objects.create(
            organization_id=self.ws_id,
            tier=self.tier,
            status=status,
            start_date=now - timedelta(days=30),
            end_date=now + timedelta(hours=end_delta_hours),
            auto_renew=False,
        )

    def test_no_policy_passes(self):
        result = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNone(result)

    def test_policy_block_off_passes(self):
        self._create_policy(block_on_critical=False)
        self._create_critical_alert()
        result = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNone(result)

    def test_policy_block_on_no_alert_passes(self):
        self._create_policy(block_on_critical=True)
        result = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNone(result)

    def test_policy_block_on_with_critical_alert_blocks(self):
        self._create_policy(block_on_critical=True)
        self._create_critical_alert(age_minutes=30)
        result = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNotNone(result)
        self.assertIn("critical", result)

    @override_settings(BILLING_GUARD_ALERT_LOOKBACK_HOURS=1)
    def test_alert_outside_lookback_passes(self):
        self._create_policy(block_on_critical=True)
        self._create_critical_alert(age_minutes=120)
        result = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNone(result)

    def test_raise_on_block_true_raises(self):
        self._create_policy(block_on_critical=True)
        self._create_critical_alert(age_minutes=30)
        with self.assertRaises(BillingBlockedError) as ctx:
            BillingGuardService.check_organization_billing_guard(
                self.ws_id, raise_on_block=True,
            )
        self.assertEqual(ctx.exception.organization_id, self.ws_id)

    def test_raise_on_block_false_returns_reason(self):
        self._create_policy(block_on_critical=True)
        self._create_critical_alert(age_minutes=30)
        result = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsInstance(result, str)
        self.assertIn("block_on_critical", result)

    def test_cache_pass_survives_new_alert(self):
        """放行结果被缓存 30s，期间新建 critical alert 不影响结果"""
        from django.core.cache import cache

        self._create_policy(block_on_critical=True)
        result1 = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNone(result1)

        self._create_critical_alert(age_minutes=5)
        result2 = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNone(result2)

        cache.delete(f"billing:guard:{self.ws_id}")
        result3 = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNotNone(result3)

    def test_cache_block_cleared_on_resolve(self):
        """阻断缓存被手动清除后立即恢复放行"""
        from django.core.cache import cache

        self._create_policy(block_on_critical=True)
        alert = self._create_critical_alert(age_minutes=5)
        result1 = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNotNone(result1)

        alert.is_resolved = True
        alert.save(update_fields=["is_resolved"])
        cache.delete(f"billing:guard:{self.ws_id}")

        result2 = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNone(result2)

    def test_guard_blocks_media_and_speech_pattern(self):
        """验证 guard 阻断后 media/speech 入口的预检模式可正常工作"""
        from django.core.cache import cache
        cache.delete(f"billing:guard:{self.ws_id}")

        self._create_policy(block_on_critical=True)
        self._create_critical_alert(age_minutes=5)

        reason = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )
        self.assertIsNotNone(reason)

        cache.delete(f"billing:guard:{self.ws_id}")
        with self.assertRaises(BillingBlockedError):
            BillingGuardService.check_organization_billing_guard(
                self.ws_id, raise_on_block=True,
            )

    def test_membership_expired_reason_uses_i18n(self):
        set_user_language(SupportedLanguage.EN_US)
        self._create_membership(status="expired")

        result = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )

        self.assertEqual(
            result,
            "This organization membership has expired (status=expired). Please renew before continuing.",
        )

    def test_critical_alert_reason_uses_i18n(self):
        set_user_language(SupportedLanguage.EN_US)
        self._create_policy(block_on_critical=True)
        self._create_critical_alert(age_minutes=5)

        result = BillingGuardService.check_organization_billing_guard(
            self.ws_id, raise_on_block=False,
        )

        self.assertIn("unresolved critical billing alerts", result)
        self.assertIn("block_on_critical", result)

    def test_clear_guard_cache_no_billing_unblocked_when_remaining_critical(self):
        """残留不可 auto_resolve 的 critical（如 charge_failed）时不应推送 billing_unblocked。"""
        guard_key = f"{BillingGuardService.CACHE_KEY_PREFIX}{self.ws_id}"
        cache.set(guard_key, {"t": "billing_guard_alert", "rk": "billing.guard_critical_alert_blocked", "rp": {}})

        self._create_critical_alert(metric_name="budget_critical", age_minutes=5)
        self._create_critical_alert(metric_name="charge_failed", age_minutes=5)

        with patch.object(BillingGuardService, "_publish_event_with_dedup") as mock_pub:
            BillingGuardService.clear_guard_cache(self.ws_id)
            event_types = [call.args[1] for call in mock_pub.call_args_list]
        self.assertNotIn("billing_unblocked", event_types)

    def test_clear_guard_cache_publishes_billing_unblocked_when_no_remaining_critical(self):
        """仅存在白名单 critical 且已全部 auto_resolve 时应推送 billing_unblocked。"""
        guard_key = f"{BillingGuardService.CACHE_KEY_PREFIX}{self.ws_id}"
        cache.set(guard_key, {"t": "billing_guard_alert", "rk": "billing.guard_critical_alert_blocked", "rp": {}})

        self._create_critical_alert(metric_name="budget_critical", age_minutes=5)

        with patch.object(BillingGuardService, "_publish_event_with_dedup") as mock_pub:
            BillingGuardService.clear_guard_cache(self.ws_id)
            event_types = [call.args[1] for call in mock_pub.call_args_list]
        self.assertIn("billing_unblocked", event_types)

"""
财务 P0 回归测试 — 会员模块（FIN-3, FIN-4, FIN-5）
"""

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch, MagicMock

from django.test import TestCase
from django.utils import timezone

from apps.users.membership.models import MembershipTier, OrganizationMembership


def _create_tier(tier_type="pro", name="专业版", price="99.00", **kwargs):
    defaults = {
        "tier_type": tier_type,
        "name": name,
        "description": "",
        "price": Decimal(price),
        "duration_months": 1,
        "included_storage_bytes": 10737418240,
        "included_llm_credits_monthly": Decimal("100"),
        "is_active": True,
    }
    defaults.update(kwargs)
    return MembershipTier.objects.create(**defaults)


def _create_free_tier():
    return _create_tier(
        tier_type="free",
        name="免费版",
        price="0",
        included_storage_bytes=0,
        included_llm_credits_monthly=Decimal("0"),
    )


class FIN3OnCommitDelayTests(TestCase):
    """FIN-3: _sync_entitlement 中 delay() 必须通过 on_commit 调用，
    避免主事务回滚后补偿任务仍执行。"""

    databases = {"default"}

    @patch("apps.services.billing.services.OrganizationEntitlementSyncService")
    @patch("apps.services.billing.models.OrganizationBillingPolicy")
    def test_retry_delay_not_called_inside_transaction(self, mock_policy, mock_sync_svc):
        """当 _sync_entitlement 两次均失败时，retry_sync_entitlement.delay 应通过 on_commit 注册，
        而非在事务内直接调用。"""
        mock_sync_svc.sync_organization_entitlement.side_effect = Exception("sync failed")
        mock_policy.objects = MagicMock()

        tier = _create_tier()

        from apps.users.membership.services.organization_membership_service import OrganizationMembershipService

        service = OrganizationMembershipService()

        with patch("apps.users.membership.tasks.retry_sync_entitlement") as mock_retry:
            with patch("django.db.transaction.on_commit") as mock_on_commit:
                with patch("apps.services.billing.models.BillingAnomalyAlert") as mock_alert:
                    mock_alert.objects = MagicMock()
                    service._sync_entitlement("ws-fin3-test", tier)

                    mock_retry.delay.assert_not_called()
                    mock_on_commit.assert_called_once()

                    on_commit_fn = mock_on_commit.call_args[0][0]
                    on_commit_fn()
                    mock_retry.delay.assert_called_once_with("ws-fin3-test", str(tier.id))


class FIN4AtomicDowngradeTests(TestCase):
    """FIN-4: downgrade_expired_entitlements 的状态写入 + entitlement 降级
    必须在同一事务中，步骤 B 失败时步骤 A 也应回滚。"""

    databases = {"default"}

    def setUp(self):
        self.free_tier = _create_free_tier()
        self.pro_tier = _create_tier()

    @patch("apps.services.billing.services.OrganizationEntitlementSyncService")
    def test_status_rollback_when_sync_fails(self, mock_sync_svc):
        """entitlement 同步失败时，membership.status 不应变为 expired（事务回滚）。"""
        mock_sync_svc.sync_organization_entitlement.side_effect = Exception("DB connection lost")

        wm = OrganizationMembership.objects.create(
            organization_id="ws-fin4-test",
            tier=self.pro_tier,
            status="active",
            start_date=timezone.now() - timedelta(days=40),
            end_date=timezone.now() - timedelta(days=5),
        )

        from apps.users.membership.tasks import downgrade_expired_entitlements
        result = downgrade_expired_entitlements()

        wm.refresh_from_db()
        self.assertEqual(wm.status, "active",
                         "entitlement 同步失败时 status 不应被修改（事务应回滚）")
        self.assertEqual(result["errors"], 1)

    @patch("apps.services.billing.services.OrganizationEntitlementSyncService")
    def test_both_steps_succeed_atomically(self, mock_sync_svc):
        """正常路径：状态和 entitlement 都应成功更新。"""
        mock_ent = MagicMock()
        mock_ent.included_storage_bytes = 0
        mock_ent.included_llm_credits_monthly = Decimal("0")
        mock_ent.purchased_storage_bytes = 0
        mock_sync_svc.sync_organization_entitlement.return_value = mock_ent

        wm = OrganizationMembership.objects.create(
            organization_id="ws-fin4-ok",
            tier=self.pro_tier,
            status="active",
            start_date=timezone.now() - timedelta(days=40),
            end_date=timezone.now() - timedelta(days=5),
        )

        from apps.users.membership.tasks import downgrade_expired_entitlements
        result = downgrade_expired_entitlements()

        wm.refresh_from_db()
        self.assertEqual(wm.status, "expired")
        self.assertGreaterEqual(result["downgraded"] + result["skipped"], 1)


class FIN5RetrySyncValidationTests(TestCase):
    """FIN-5: retry_sync_entitlement 执行前必须校验 status==active 且 tier_id 匹配。"""

    databases = {"default"}

    def setUp(self):
        self.pro_tier = _create_tier()
        self.basic_tier = _create_tier(
            tier_type="basic", name="基础版", price="49.00",
        )

    def test_skip_when_membership_expired(self):
        """会员已过期时，补偿任务应跳过而非恢复旧权益。"""
        OrganizationMembership.objects.create(
            organization_id="ws-fin5-expired",
            tier=self.pro_tier,
            status="expired",
            start_date=timezone.now() - timedelta(days=40),
            end_date=timezone.now() - timedelta(days=5),
        )

        from apps.users.membership.tasks import retry_sync_entitlement
        result = retry_sync_entitlement("ws-fin5-expired", str(self.pro_tier.id))

        self.assertEqual(result["error"], "organization_membership_not_active")

    def test_skip_when_tier_changed(self):
        """会员 tier 已变更时，补偿任务应跳过避免用旧 tier 覆盖新权益。"""
        OrganizationMembership.objects.create(
            organization_id="ws-fin5-tier-changed",
            tier=self.basic_tier,
            status="active",
            start_date=timezone.now() - timedelta(days=5),
            end_date=timezone.now() + timedelta(days=25),
        )

        from apps.users.membership.tasks import retry_sync_entitlement
        result = retry_sync_entitlement("ws-fin5-tier-changed", str(self.pro_tier.id))

        self.assertEqual(result["error"], "tier_mismatch")
        self.assertEqual(result["expected"], str(self.pro_tier.id))
        self.assertEqual(result["actual"], str(self.basic_tier.id))

    def test_skip_when_membership_not_found(self):
        """不存在任何会员记录时应安全跳过。"""
        from apps.users.membership.tasks import retry_sync_entitlement
        result = retry_sync_entitlement("ws-fin5-nonexist", str(self.pro_tier.id))

        self.assertEqual(result["error"], "organization_membership_not_active")

    @patch("apps.services.billing.services.OrganizationEntitlementSyncService")
    @patch("apps.services.billing.models.OrganizationBillingPolicy")
    def test_proceed_when_status_active_and_tier_match(self, mock_policy, mock_sync_svc):
        """状态为 active 且 tier 匹配时，补偿任务应正常执行。"""
        mock_policy.objects = MagicMock()
        mock_sync_svc.sync_organization_entitlement.return_value = MagicMock()

        OrganizationMembership.objects.create(
            organization_id="ws-fin5-ok",
            tier=self.pro_tier,
            status="active",
            start_date=timezone.now() - timedelta(days=5),
            end_date=timezone.now() + timedelta(days=25),
        )

        from apps.users.membership.tasks import retry_sync_entitlement
        result = retry_sync_entitlement("ws-fin5-ok", str(self.pro_tier.id))

        self.assertEqual(result["success"], True)

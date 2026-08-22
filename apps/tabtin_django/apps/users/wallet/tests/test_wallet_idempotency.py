"""
WAL-01 / WAL-02 修复验证测试

WAL-01: consume_credits 幂等检查使用 DB 唯一约束（原子性），替代 exists() TOCTOU
WAL-02: OrganizationWallet 扣款用 savepoint 包裹；异常向上抛出（organization-only）
"""

from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, override_settings

from apps.services.billing.models import BillingUsageEvent
from apps.users.auth.models import User
from apps.users.wallet.exceptions import InsufficientCreditsError
from apps.users.wallet.models import OrganizationWallet, WalletTransaction
from apps.users.wallet.services.credits_service import CreditsService


@override_settings(BILLING_LEGACY_NON_LLM_CONSUME_ENABLED=True)
class ConsumeCreditsIdempotencyTests(TestCase):
    """WAL-01: 验证 consume_credits 幂等性基于 DB 唯一约束"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="idem_test@test.com",
            password="test-pass-123",
        )
        from apps.tabtinspace.models import Organization
        self.organization_id = str(Organization.objects.create(
            name="wallet-idem-org",
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        OrganizationWallet.objects.create(
            organization_id=self.organization_id,
            credits=1000,
            credits_precise=Decimal("1000.0000"),
        )

    def _make_kwargs(self, idempotency_key="", biz_id="sp_001", **overrides):
        base = dict(
            user_id=str(self.user.id),
            organization_id=self.organization_id,
            meter_key="speech.chars",
            quantity=Decimal("1000"),
            unit="chars",
            unit_price=Decimal("0.01"),
            description="语音合成",
            biz_type="speech",
            biz_id=biz_id,
            idempotency_key=idempotency_key,
        )
        base.update(overrides)
        return base

    def test_idempotent_key_prevents_double_charge(self):
        """同一 idempotency_key 第二次调用应返回 idempotent_hit 且不重复扣款"""
        kwargs = self._make_kwargs(idempotency_key="idem-wal01-test-001")

        r1 = CreditsService.consume_credits(**kwargs)
        self.assertTrue(r1["charged"])
        self.assertEqual(r1["amount"], Decimal("10.0000"))

        r2 = CreditsService.consume_credits(**kwargs)
        self.assertFalse(r2["charged"])
        self.assertEqual(r2["reason"], "idempotent_hit")

        ws = OrganizationWallet.objects.get(organization_id=self.organization_id)
        self.assertEqual(ws.credits_precise, Decimal("990.0000"))

        events = BillingUsageEvent.objects.filter(idempotency_key="idem-wal01-test-001")
        self.assertEqual(events.count(), 1)

    def test_idempotent_key_creates_event_before_deduction(self):
        """幂等键存在时 BillingUsageEvent 应在扣款前创建（与扣款在同一事务中）"""
        kwargs = self._make_kwargs(idempotency_key="idem-wal01-test-pre")
        r = CreditsService.consume_credits(**kwargs)
        self.assertTrue(r["charged"])

        event = BillingUsageEvent.objects.get(idempotency_key="idem-wal01-test-pre")
        self.assertEqual(event.amount, Decimal("10.0000"))
        self.assertEqual(event.meter_key, "speech.chars")

    def test_different_idempotent_keys_charge_independently(self):
        """不同 idempotency_key 应各自独立扣款"""
        r1 = CreditsService.consume_credits(
            **self._make_kwargs(idempotency_key="idem-key-a", biz_id="a"),
        )
        r2 = CreditsService.consume_credits(
            **self._make_kwargs(idempotency_key="idem-key-b", biz_id="b"),
        )

        self.assertTrue(r1["charged"])
        self.assertTrue(r2["charged"])

        ws = OrganizationWallet.objects.get(organization_id=self.organization_id)
        self.assertEqual(ws.credits_precise, Decimal("980.0000"))

    def test_no_idempotent_key_still_charges(self):
        """无 idempotency_key 时正常扣款（兼容性）"""
        r = CreditsService.consume_credits(**self._make_kwargs())
        self.assertTrue(r["charged"])

        ws = OrganizationWallet.objects.get(organization_id=self.organization_id)
        self.assertEqual(ws.credits_precise, Decimal("990.0000"))


@override_settings(BILLING_LEGACY_NON_LLM_CONSUME_ENABLED=True)
class OrganizationWalletFallbackSavepointTests(TestCase):
    """WAL-02 / organization-only：团队钱包扣款、余额不足与流水异常行为"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="fallback_test@test.com",
            password="test-pass-123",
        )
        from apps.tabtinspace.models import Organization
        self.organization_id = str(Organization.objects.create(
            name="wallet-fallback-org",
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        self.ws_wallet = OrganizationWallet.objects.create(
            organization_id=self.organization_id,
            credits=50,
            credits_precise=Decimal("50.0000"),
        )

    def test_ws_wallet_success_charges_only_organization_wallet(self):
        """OrganizationWallet 扣款成功时只影响团队钱包"""
        r = CreditsService.consume_credits(
            user_id=str(self.user.id),
            organization_id=self.organization_id,
            meter_key="speech.chars",
            quantity=Decimal("500"),
            unit="chars",
            unit_price=Decimal("0.01"),
            biz_type="speech",
            biz_id="sp_ok_001",
        )
        self.assertTrue(r["charged"])

        self.ws_wallet.refresh_from_db()
        self.assertEqual(self.ws_wallet.credits_precise, Decimal("45.0000"))

    def test_ws_wallet_insufficient_raises(self):
        """OrganizationWallet 余额不足时 organization-only：抛出 InsufficientCreditsError"""
        with self.assertRaises(InsufficientCreditsError):
            CreditsService.consume_credits(
                user_id=str(self.user.id),
                organization_id=self.organization_id,
                meter_key="speech.chars",
                quantity=Decimal("10000"),
                unit="chars",
                unit_price=Decimal("0.01"),
                biz_type="speech",
                biz_id="sp_insuf_001",
            )

        self.ws_wallet.refresh_from_db()
        self.assertEqual(
            self.ws_wallet.credits_precise, Decimal("50.0000"),
            "OrganizationWallet 余额不足不应被扣款",
        )

    def test_ws_wallet_tx_failure_rollback_raises(self):
        """团队流水写入失败时 savepoint 回滚 ws_wallet，异常向上抛出"""
        original_create = WalletTransaction.objects.create
        call_count = {"n": 0}

        def create_interceptor(**kwargs):
            call_count["n"] += 1
            if kwargs.get("organization_wallet") is not None and call_count["n"] == 1:
                raise RuntimeError("模拟 WalletTransaction 写入失败")
            return original_create(**kwargs)

        with patch.object(
            type(WalletTransaction.objects), "create",
            side_effect=create_interceptor, autospec=False,
        ):
            with self.assertRaises(RuntimeError):
                CreditsService.consume_credits(
                    user_id=str(self.user.id),
                    organization_id=self.organization_id,
                    meter_key="speech.chars",
                    quantity=Decimal("500"),
                    unit="chars",
                    unit_price=Decimal("0.01"),
                    biz_type="speech",
                    biz_id="sp_txfail_001",
                )

        self.ws_wallet.refresh_from_db()
        self.assertEqual(
            self.ws_wallet.credits_precise, Decimal("50.0000"),
            "OrganizationWallet 扣款应被 savepoint 回滚",
        )

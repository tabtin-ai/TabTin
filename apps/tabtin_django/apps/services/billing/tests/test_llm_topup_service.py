"""
LLM 点券自动补充服务测试（ 重构后）

覆盖新的不变量：
- quota_only 扣费瀑布：会员月度配额 → 持久点券钱包 OrganizationWallet
- 自动补充：现金钱包（人民币）扣款 → 入账 OrganizationWallet
  （不再写 budget.topup_credits，避免随月度配额清零而丢失）
- 月上限按当月 llm_auto_topup 现金流水求和（真实出账口径）
- 触发口径：月度配额剩余 + 钱包可用 组合低于预警阈值才补充
- 预检链路：配额尽但钱包有余 → 直接放行（不补充）；两池皆空 + 现金充足 →
  补充放行；现金不足 / 未开启 → 阻断并带 topup_reason
"""

from decimal import Decimal
from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase

from apps.services.billing.models import (
    OrganizationBillingEntitlement,
    OrganizationBillingPolicy,
    OrganizationLlmMonthlyBudget,
)
from apps.services.billing.services import OrganizationLlmBudgetService
from apps.services.billing.services.low_balance_alert_service import LowBalanceAlertService
from apps.services.billing.services.llm_topup_service import (
    LlmQuotaTopupService,
    REASON_DISABLED,
    REASON_MONTHLY_CAP,
    REASON_NOT_NEEDED,
    REASON_WALLET_INSUFFICIENT,
)
from apps.users.wallet.models import (
    CashWalletTransaction,
    OrganizationCashWallet,
    OrganizationWallet,
    WalletTransaction,
)
from apps.services.billing.tests.org_test_utils import org_id_for

ORG = ""


def _make_wallet(credits: str) -> OrganizationWallet:
    value = Decimal(credits)
    return OrganizationWallet.objects.create(
        organization_id=ORG,
        credits=int(value),
        credits_precise=value,
    )


def _make_cash_wallet(yuan: str) -> OrganizationCashWallet:
    return OrganizationCashWallet.objects.create(
        organization_id=ORG,
        balance_cny=Decimal(yuan),
    )


def _make_policy(**overrides) -> OrganizationBillingPolicy:
    defaults = dict(
        organization_id=ORG,
        llm_billing_mode="quota_only",
        auto_topup_enabled=True,
        auto_topup_spend_yuan=Decimal("1"),
        auto_topup_threshold_credits=Decimal("0"),
        auto_topup_monthly_cap_yuan=Decimal("3"),
        is_active=True,
    )
    defaults.update(overrides)
    return OrganizationBillingPolicy.objects.create(**defaults)


def _zero_wallet() -> None:
    wallet = OrganizationWallet.objects.get(organization_id=ORG)
    wallet.credits_precise = Decimal("0")
    wallet.sync_display_balances()
    wallet.save(update_fields=["credits_precise", "credits", "updated_at"])


class LlmQuotaTopupServiceTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        global ORG
        ORG = org_id_for("ws_llm_topup_001")
        cache.delete(f"billing:low_bal_cfg:{ORG}")
        OrganizationBillingEntitlement.objects.create(
            organization_id=ORG,
            included_storage_bytes=0,
            purchased_storage_bytes=0,
            included_llm_credits_monthly=Decimal("10"),
            is_active=True,
        )

    def _exhaust_quota(self):
        OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=ORG,
            requested_credits=Decimal("10"),
            llm_billing_mode="quota_only",
        )

    # ── 自动补充主流程：现金 → 入账 OrganizationWallet ──

    def test_topup_success_deducts_cash_and_credits_wallet(self):
        credits_wallet = _make_wallet("0")
        cash_wallet = _make_cash_wallet("5.00")
        _make_policy()
        self._exhaust_quota()

        result = LlmQuotaTopupService.try_auto_topup(ORG)

        self.assertTrue(result["topped_up"])
        self.assertEqual(result["credits"], Decimal("100"))
        # 现金按元 1:1 扣款
        cash_wallet.refresh_from_db()
        self.assertEqual(cash_wallet.balance_cny, Decimal("4.00"))
        # 点券入账到持久钱包（而非 budget.topup_credits）
        credits_wallet.refresh_from_db()
        self.assertEqual(credits_wallet.credits_precise, Decimal("100"))
        budget = OrganizationLlmMonthlyBudget.objects.get(organization_id=ORG)
        self.assertEqual(budget.topup_credits, Decimal("0"))
        # 钱包留下 recharge 流水，现金留下 llm_auto_topup 流水
        self.assertTrue(
            WalletTransaction.objects.filter(
                organization_id=ORG, transaction_type="recharge",
            ).exists()
        )
        cash_tx = CashWalletTransaction.objects.get(organization_id=ORG)
        self.assertEqual(cash_tx.transaction_type, "llm_auto_topup")
        self.assertEqual(cash_tx.amount_cny, Decimal("-1.00"))
        self.assertIn("自动补充", cash_tx.description)
        self.assertEqual(cash_tx.metadata.get("credits"), "100.0000")

    def test_topup_credits_land_in_wallet_available(self):
        _make_wallet("0")
        _make_cash_wallet("5.00")
        _make_policy()
        self._exhaust_quota()
        LlmQuotaTopupService.try_auto_topup(ORG)

        wallet = OrganizationWallet.objects.get(organization_id=ORG)
        self.assertEqual(wallet.get_available_credits_precise(), Decimal("100"))

    # ── 触发口径：组合余额（配额 + 钱包）──

    def test_topup_not_needed_when_quota_remaining(self):
        _make_cash_wallet("5.00")
        _make_policy()
        LowBalanceAlertService.set_thresholds(
            ORG, warning_credits=Decimal("0"), critical_credits=Decimal("0"),
        )
        result = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertFalse(result["topped_up"])
        self.assertEqual(result["reason"], REASON_NOT_NEEDED)
        self.assertFalse(CashWalletTransaction.objects.filter(organization_id=ORG).exists())

    def test_topup_not_needed_when_wallet_has_balance(self):
        # 配额已尽但钱包仍有余额 → 组合余额 > 阈值，无需补充
        _make_wallet("50")
        _make_cash_wallet("5.00")
        _make_policy()
        self._exhaust_quota()
        result = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertFalse(result["topped_up"])
        self.assertEqual(result["reason"], REASON_NOT_NEEDED)
        self.assertFalse(CashWalletTransaction.objects.filter(organization_id=ORG).exists())

    # ── 零头死区（ 回归）：组合余额 > 阈值但 < 本次请求成本 ──

    def test_topup_triggers_when_dust_below_request_cost(self):
        # 零头 0.5 > 阈值 0，但 < 本次请求成本 1.0 → 应补充（消除死区），而非 not_needed
        _make_wallet("0.5")
        _make_cash_wallet("5.00")
        _make_policy()
        self._exhaust_quota()
        result = LlmQuotaTopupService.try_auto_topup(ORG, required_credits=Decimal("1.0"))
        self.assertTrue(result["topped_up"])
        wallet = OrganizationWallet.objects.get(organization_id=ORG)
        self.assertEqual(wallet.get_available_credits_precise(), Decimal("100.5"))

    def test_topup_not_needed_when_dust_covers_request(self):
        # 预警阈值 0、零头 5 >= 本次请求成本 1.0 → 无需补充
        _make_wallet("5")
        _make_cash_wallet("5.00")
        _make_policy()
        LowBalanceAlertService.set_thresholds(
            ORG, warning_credits=Decimal("0"), critical_credits=Decimal("0"),
        )
        self._exhaust_quota()
        result = LlmQuotaTopupService.try_auto_topup(ORG, required_credits=Decimal("1.0"))
        self.assertFalse(result["topped_up"])
        self.assertEqual(result["reason"], REASON_NOT_NEEDED)

    def test_topup_when_below_warning_threshold(self):
        _make_wallet("20")
        _make_cash_wallet("5.00")
        _make_policy()
        LowBalanceAlertService.set_thresholds(
            ORG, warning_credits=Decimal("50"), critical_credits=Decimal("10"),
        )
        self._exhaust_quota()
        result = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertTrue(result["topped_up"])
        wallet = OrganizationWallet.objects.get(organization_id=ORG)
        self.assertEqual(wallet.get_available_credits_precise(), Decimal("120"))

    # ── 边界：开关 / 模式 / 月上限 / 现金不足 ──

    def test_topup_disabled_by_default(self):
        _make_wallet("0")
        _make_cash_wallet("5.00")
        _make_policy(auto_topup_enabled=False)
        self._exhaust_quota()
        result = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertFalse(result["topped_up"])
        self.assertEqual(result["reason"], REASON_DISABLED)

    def test_topup_disabled_when_no_policy_row(self):
        _make_wallet("0")
        _make_cash_wallet("5.00")
        self._exhaust_quota()
        result = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertFalse(result["topped_up"])
        self.assertEqual(result["reason"], REASON_DISABLED)

    def test_topup_only_applies_to_quota_only_mode(self):
        _make_wallet("0")
        _make_cash_wallet("5.00")
        _make_policy(llm_billing_mode="quota_then_paygo")
        self._exhaust_quota()
        result = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertFalse(result["topped_up"])
        self.assertEqual(result["reason"], REASON_DISABLED)

    def test_topup_monthly_cap_via_cash_flow_sum(self):
        _make_wallet("0")
        cash_wallet = _make_cash_wallet("100.00")
        _make_policy(
            auto_topup_spend_yuan=Decimal("2"),
            auto_topup_monthly_cap_yuan=Decimal("3"),
        )
        self._exhaust_quota()

        first = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertTrue(first["topped_up"])

        # 花掉钱包补充量制造组合余额=0 再次触发；本月已补 2 元，+2 > 3 → 拒绝
        _zero_wallet()
        second = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertFalse(second["topped_up"])
        self.assertEqual(second["reason"], REASON_MONTHLY_CAP)
        # 仅扣了第一档的 2 元
        cash_wallet.refresh_from_db()
        self.assertEqual(cash_wallet.balance_cny, Decimal("98.00"))

    def test_topup_cash_insufficient(self):
        _make_wallet("0")
        cash_wallet = _make_cash_wallet("0.50")
        _make_policy(auto_topup_spend_yuan=Decimal("1"))
        self._exhaust_quota()

        result = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertFalse(result["topped_up"])
        self.assertEqual(result["reason"], REASON_WALLET_INSUFFICIENT)
        # 无部分状态：现金未扣、钱包未加
        cash_wallet.refresh_from_db()
        self.assertEqual(cash_wallet.balance_cny, Decimal("0.50"))
        wallet = OrganizationWallet.objects.get(organization_id=ORG)
        self.assertEqual(wallet.credits_precise, Decimal("0"))

    def test_topup_cash_wallet_missing_treated_as_insufficient(self):
        """组织从未建现金钱包行：按 0 余额处理，归类为 wallet_insufficient。"""
        _make_wallet("0")
        _make_policy(auto_topup_spend_yuan=Decimal("1"))
        self._exhaust_quota()

        result = LlmQuotaTopupService.try_auto_topup(ORG)
        self.assertFalse(result["topped_up"])
        self.assertEqual(result["reason"], REASON_WALLET_INSUFFICIENT)

    # ── 预检链路整合 ──

    def test_balance_precheck_allows_when_wallet_has_balance(self):
        from apps.services.llm.services.billed_call import check_balance_before_request

        _make_wallet("50")
        _make_cash_wallet("5.00")
        _make_policy()
        self._exhaust_quota()

        blocked = check_balance_before_request("user_x", ORG)
        self.assertIsNone(blocked)
        # 钱包够用，不应触发现金补充
        self.assertFalse(CashWalletTransaction.objects.filter(organization_id=ORG).exists())

    def test_balance_precheck_allows_after_auto_topup(self):
        from apps.services.llm.services.billed_call import check_balance_before_request

        _make_wallet("0")
        _make_cash_wallet("5.00")
        _make_policy()
        self._exhaust_quota()

        blocked = check_balance_before_request("user_x", ORG)
        self.assertIsNone(blocked)
        wallet = OrganizationWallet.objects.get(organization_id=ORG)
        self.assertEqual(wallet.credits_precise, Decimal("100"))

    def test_balance_precheck_blocks_with_topup_reason_when_cash_insufficient(self):
        from apps.services.llm.services.billed_call import check_balance_before_request

        _make_wallet("0")
        _make_cash_wallet("0.50")
        _make_policy(auto_topup_spend_yuan=Decimal("1"))
        self._exhaust_quota()

        blocked = check_balance_before_request("user_x", ORG)
        self.assertIsNotNone(blocked)
        self.assertEqual(blocked["error_code"], "ORGANIZATION_INSUFFICIENT_CREDITS")
        self.assertEqual(blocked["topup_reason"], REASON_WALLET_INSUFFICIENT)

    def test_balance_precheck_blocks_with_disabled_reason(self):
        from apps.services.llm.services.billed_call import check_balance_before_request

        _make_wallet("0")
        _make_cash_wallet("5.00")
        _make_policy(auto_topup_enabled=False)
        self._exhaust_quota()

        blocked = check_balance_before_request("user_x", ORG)
        self.assertIsNotNone(blocked)
        self.assertEqual(blocked["topup_reason"], REASON_DISABLED)

    def test_topup_exception_does_not_trigger_failopen(self):
        """补充服务内部异常应表现为拦截（topup_error），不得让预检 fail-open 放行。"""
        from apps.services.llm.services.billed_call import check_balance_before_request

        _make_wallet("0")
        _make_cash_wallet("5.00")
        _make_policy()
        self._exhaust_quota()

        with patch.object(
            LlmQuotaTopupService, "_do_topup", side_effect=RuntimeError("boom"),
        ):
            blocked = check_balance_before_request("user_x", ORG)
        self.assertIsNotNone(blocked)
        self.assertEqual(blocked["topup_reason"], "topup_error")

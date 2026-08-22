"""
LLM 点券自动补充服务

quota_only 模式的配套能力：会员月度配额 + 持久点券钱包（OrganizationWallet）
均不足时，从组织现金钱包（人民币，OrganizationCashWallet）按管理员预设的金额
（元）扣款购买补充量，**入账到持久点券钱包 OrganizationWallet**
（1 元 = CREDITS_PER_YUAN 点券）。

设计不变量（ 重构后）：
- 补充的点券落入 ``OrganizationWallet``，不写月度预算池 ``topup_credits``——
  月度池按月清零重置，用户花现金买到的点券不应随月清零。
- 现金出账只发生在"显式购买"（本服务的自动补充 / 后台购买点券包）。
- 有界：本月自动补充累计花费不超过 auto_topup_monthly_cap_yuan；
  「本月已补充」按当月 llm_auto_topup 现金流水求和（真实出账口径，不漂移）。
- 触发口径：月度配额剩余 + 钱包可用 一起看，组合余额 ≤ 阈值才补充。
- 并发幂等：当月预算行 select_for_update 串行化补充动作（锁顺序
  budget → cash → wallet，与结算路径一致）；现金 spend 与钱包 recharge
  共用同一 related_order_id，两侧各自幂等。
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Dict, Optional

from django.db import transaction

logger = logging.getLogger(__name__)

# try_auto_topup 返回的 reason 取值
REASON_TOPPED_UP = "topped_up"
REASON_NOT_NEEDED = "not_needed"            # 锁内复查发现配额仍有剩余（缓存过期等），无需购买
REASON_DISABLED = "auto_topup_disabled"     # 未开启自动补充 / 模式不适用 / 档位为 0
REASON_MONTHLY_CAP = "monthly_cap_reached"  # 本月自动补充已达上限
REASON_WALLET_INSUFFICIENT = "wallet_insufficient"  # 现金钱包余额不足一档
REASON_ERROR = "topup_error"                # 系统异常（调用方按拦截处理，不 fail-open）


class LlmQuotaTopupService:
    """LLM 点券自动补充：钱包 → 当月预算池"""

    @classmethod
    def try_auto_topup(
        cls,
        organization_id: str,
        *,
        trigger: str = "precheck",
        required_credits: Optional[Decimal] = None,
    ) -> Dict[str, Any]:
        """尝试为组织自动补充一档 LLM 点券。

        任何异常都不向上抛：调用方位于余额预检 fail-open 的 try 块内，
        补充失败应表现为"拦截 + 原因"，而不是触发预检 fail-open 放行。

        Args:
            required_credits: 本次请求需要覆盖的点券量。预检/结算在“组合余额
                不足以支撑本次请求”时调用本方法，故即便组合余额仍 > 静态阈值，
                只要 < required_credits 也应补充——否则会卡在「零头 > 阈值但
                不够付一次请求」的死区，反复拦截且不补充（ 回归）。
                不传时按旧口径（只看静态阈值），向后兼容。

        Returns:
            {"topped_up": bool, "reason": str, "credits": Decimal, ...}
        """
        if not (organization_id or "").strip():
            return {"topped_up": False, "reason": REASON_DISABLED}
        try:
            return cls._do_topup(
                organization_id, trigger=trigger, required_credits=required_credits,
            )
        except Exception as exc:
            from apps.users.wallet.services.organization_cash_wallet_service import (
                InsufficientCashBalance,
            )

            if isinstance(exc, InsufficientCashBalance):
                logger.info(
                    "[LlmTopup] 现金钱包余额不足，自动补充失败: organization=%s", organization_id,
                )
                return {"topped_up": False, "reason": REASON_WALLET_INSUFFICIENT}
            logger.warning(
                "[LlmTopup] 自动补充异常: organization=%s trigger=%s err=%s",
                organization_id, trigger, exc,
            )
            return {"topped_up": False, "reason": REASON_ERROR}

    @classmethod
    @transaction.atomic
    def _do_topup(
        cls,
        organization_id: str,
        *,
        trigger: str,
        required_credits: Optional[Decimal] = None,
    ) -> Dict[str, Any]:
        from apps.services.billing.services.llm_budget_service import OrganizationLlmBudgetService
        from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
        from apps.users.wallet.services.organization_cash_wallet_service import (
            OrganizationCashWalletService,
        )
        from apps.users.wallet.services import OrganizationWalletService
        from apps.users.wallet.models import OrganizationWallet
        from django.conf import settings

        policy = OrganizationBillingPolicyService.get_effective_policy(organization_id)
        if policy.get("llm_billing_mode") != "quota_only" or not policy.get("auto_topup_enabled"):
            return {"topped_up": False, "reason": REASON_DISABLED}

        quant = OrganizationLlmBudgetService._quantize
        credits_rate = Decimal(str(getattr(settings, "CREDITS_PER_YUAN", 100)))
        spend_yuan = quant(policy.get("auto_topup_spend_yuan", 0))
        amount = quant(spend_yuan * credits_rate)
        if amount <= 0:
            return {"topped_up": False, "reason": REASON_DISABLED}
        threshold = quant(policy.get("auto_topup_threshold_credits", 0))
        monthly_cap_yuan = quant(policy.get("auto_topup_monthly_cap_yuan", 0))

        # 行锁串行化：锁当月预算行（锁顺序 budget → cash → wallet，与结算路径一致，
        # 避免交叉死锁）。并发触发时后到者在此等待，锁内复查组合余额后决定是否购买。
        budget = OrganizationLlmBudgetService.get_or_create_monthly_budget_locked(organization_id)
        quota_remaining = max(
            Decimal("0"),
            quant(budget.included_credits)
            + quant(budget.topup_credits)
            - quant(budget.consumed_credits),
        )
        wallet = OrganizationWallet.objects.filter(organization_id=organization_id).first()
        wallet_available = wallet.get_available_credits_precise() if wallet else Decimal("0")
        combined_remaining = quant(quota_remaining) + quant(wallet_available)
        # 触发口径：月度配额剩余 + 钱包可用 的组合余额，同时看两条线——
        # ① 高于静态阈值（buffer）② 足以支撑本次请求（required_credits）。
        # 只有两者都满足才判定“无需补充”，否则购买一档。这样消除
        # 「零头 > 阈值 但 < 单次请求成本」的死区（否则既不补充又一直拦，反复弹窗）。
        required = quant(required_credits or 0)
        covers_request = required <= 0 or combined_remaining >= required
        if combined_remaining > threshold and covers_request:
            return {"topped_up": False, "reason": REASON_NOT_NEEDED, "remaining": combined_remaining}

        # 本月自动补充上限：按当月 llm_auto_topup 现金流水求和（真实出账口径，不漂移）
        already_yuan = cls._current_month_auto_topup_yuan(organization_id, budget.cycle_month)
        if monthly_cap_yuan > 0 and already_yuan + spend_yuan > monthly_cap_yuan:
            return {
                "topped_up": False,
                "reason": REASON_MONTHLY_CAP,
                "topup_yuan": already_yuan,
                "monthly_cap_yuan": monthly_cap_yuan,
            }

        # 从组织现金钱包按元扣款（不足抛 InsufficientCashBalance，由 try_auto_topup 归类）。
        # 幂等 order_id 以「本月已补充金额」为 seq，行锁内串行保证唯一递增；
        # 现金 spend 与钱包 recharge 共用同一 order_id，两侧各自幂等。
        cycle_label = budget.cycle_month.isoformat()[:7]
        order_id = f"llm-auto-topup:{organization_id}:{cycle_label}:{already_yuan}"

        cash_tx = OrganizationCashWalletService().spend(
            organization_id=organization_id,
            amount_cny=spend_yuan,
            transaction_type="llm_auto_topup",
            description=f"LLM 点券自动补充（{cycle_label}，触发方式：{trigger}）",
            related_order_id=order_id,
            metadata={
                "cycle_month": budget.cycle_month.isoformat(),
                "trigger": trigger,
                "credits": str(amount),
                "credits_per_yuan": str(credits_rate),
            },
        )

        # 入账到持久点券钱包 OrganizationWallet（不写 budget.topup_credits，
        # 避免随月度配额清零而丢失用户花现金买到的点券）。recharge 会顺带
        # 发 credits_recharged WS 事件 + 解除 guard 阻断，前端钱包余额自动刷新。
        OrganizationWalletService().recharge(
            organization_id=organization_id,
            credits_amount=amount,
            order_id=order_id,
            description=f"LLM 点券自动补充（{cycle_label}）",
        )
        OrganizationLlmBudgetService._invalidate_quota_remaining_cache(
            organization_id, budget.cycle_month,
        )

        result = {
            "topped_up": True,
            "reason": REASON_TOPPED_UP,
            "credits": amount,
            "spend_yuan": spend_yuan,
            "topup_yuan": already_yuan + spend_yuan,
            "monthly_cap_yuan": monthly_cap_yuan,
            "cycle_month": budget.cycle_month.isoformat(),
            "cash_tx_id": str(getattr(cash_tx, "id", "")),
        }

        logger.info(
            "[LlmTopup] 自动补充成功（入账钱包）: organization=%s spend_yuan=%s amount=%s "
            "month_topup_yuan=%s cap_yuan=%s trigger=%s",
            organization_id, spend_yuan, amount, result["topup_yuan"], monthly_cap_yuan, trigger,
        )

        transaction.on_commit(lambda: cls._notify_topup(organization_id, result))
        return result

    @staticmethod
    def _current_month_auto_topup_yuan(organization_id: str, cycle_month) -> Decimal:
        """本月已自动补充的现金金额（元），按 llm_auto_topup 现金流水求和。

        取代旧的「读 budget.topup_credits 累计」口径：补充点券已改为入账
        OrganizationWallet（混入充值/赠送、且会被 LLM 扣减），无法从钱包余额
        反推本月自动补充量，故直接对当月现金出账流水求和作为月上限的真源。
        """
        from django.db.models import Sum
        from apps.users.wallet.models import CashWalletTransaction
        from apps.services.billing.services.llm_budget_service import OrganizationLlmBudgetService

        agg = CashWalletTransaction.objects.filter(
            organization_id=str(organization_id),
            transaction_type="llm_auto_topup",
            created_at__date__gte=cycle_month,
        ).aggregate(total=Sum("amount_cny"))
        total = agg.get("total") or Decimal("0")
        # amount_cny 为负（spend 记负值），本月已花现金 = -total
        return OrganizationLlmBudgetService._quantize(-total)

    @classmethod
    def _notify_topup(cls, organization_id: str, result: Dict[str, Any]) -> None:
        try:
            from apps.services.billing.ws_events import publish_billing_event

            publish_billing_event(organization_id, "quota_topup", {
                "credits": str(result.get("credits", Decimal("0"))),
                "spend_yuan": str(result.get("spend_yuan", Decimal("0"))),
                "topup_yuan": str(result.get("topup_yuan", Decimal("0"))),
                "monthly_cap_yuan": str(result.get("monthly_cap_yuan", Decimal("0"))),
                "cycle_month": result.get("cycle_month", ""),
            })
        except Exception as exc:
            logger.warning(
                "[LlmTopup] 发送 quota_topup 事件失败（不阻断）: organization=%s err=%s",
                organization_id, exc,
            )

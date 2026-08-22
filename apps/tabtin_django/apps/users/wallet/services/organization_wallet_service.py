"""
组织钱包服务

继承 BaseWalletService，绑定 OrganizationWallet 模型。
覆盖 _resolve_tx_organization_id 使交易记录的 organization_id 始终为自身 owner_id。
"""

import logging
from typing import Optional, Dict, Any
from decimal import Decimal

from django.db import transaction

from ..models import OrganizationWallet, WalletTransaction
from .base_wallet_service import BaseWalletService

logger = logging.getLogger(__name__)


class OrganizationWalletService(BaseWalletService):
    """
    组织钱包服务

    职责：
    1. 组织点券充值
    2. 组织点券消费
    3. 交易记录（绑定 organization_wallet）
    4. 余额查询
    """

    wallet_model = OrganizationWallet
    lookup_field = 'organization_id'
    tx_wallet_field = 'organization_wallet'

    def _resolve_tx_organization_id(self, owner_id, organization_id=None):
        """组织钱包的交易记录 organization_id 始终为 owner_id 自身"""
        return owner_id

    # ── 签名适配层：保持外部调用方的参数名不变 ──

    def recharge(
        self,
        organization_id: str,
        credits_amount: Decimal | int | float | str,
        order_id: Optional[str] = None,
        user_id: Optional[str] = None,
        description: str = '点券充值',
    ) -> WalletTransaction:
        tx = super().recharge(
            organization_id, credits_amount,
            order_id=order_id, description=description,
            operator_user_id=user_id or '',
        )
        self._schedule_balance_increase_side_effects(
            organization_id=organization_id,
            credits_amount=credits_amount,
            order_id=order_id,
            transaction_id=str(tx.id),
            trigger="recharge",
        )
        return tx

    def _schedule_balance_increase_side_effects(
        self,
        *,
        organization_id: str,
        credits_amount,
        order_id: Optional[str],
        transaction_id: str,
        trigger: str,
    ) -> None:
        """余额增加后统一刷新前端、解除 Guard 阻断，并消掉过期余额警示。"""
        transaction.on_commit(
            lambda wid=organization_id, ca=credits_amount, oid=order_id, tid=transaction_id:
                self._try_notify_credits_recharged(wid, ca, oid, tid)
        )
        transaction.on_commit(
            lambda wid=organization_id, tr=trigger:
                self._try_unblock_after_balance_increase(wid, tr)
        )
        transaction.on_commit(
            lambda wid=organization_id:
                self._try_resolve_low_balance_alert(wid)
        )

    @staticmethod
    def _try_notify_credits_recharged(
        organization_id: str,
        credits_amount,
        order_id: Optional[str],
        transaction_id: str,
    ) -> None:
        """充值成功后发送 credits_recharged WS 通知，让前端实时刷新余额。"""
        if not organization_id:
            return
        try:
            from apps.services.billing.ws_events import publish_billing_event
            publish_billing_event(organization_id, "credits_recharged", {
                "amount": str(credits_amount),
                "order_id": order_id or "",
                "transaction_id": transaction_id,
            })
        except Exception as exc:
            logger.warning(
                "[OrganizationWallet] 发送 credits_recharged 事件失败（不影响充值）: organization=%s, error=%s",
                organization_id, exc,
            )

    @staticmethod
    def _try_unblock_after_balance_increase(organization_id: str, trigger: str) -> None:
        """余额增加成功后自动解除 Guard 阻断。

        委托给 BillingGuardService.clear_guard_cache() 统一清理缓存、
        resolve alerts、发送 WS 事件和 budget_resolved 通知。
        """
        if not organization_id:
            return
        try:
            from apps.services.billing.services.guard_service import BillingGuardService
            BillingGuardService.clear_guard_cache(organization_id, trigger=trigger)
        except Exception as exc:
            logger.warning(
                "[OrganizationWallet] 余额增加后解除阻断失败（不影响入账）: "
                "organization=%s, trigger=%s, error=%s",
                organization_id, trigger, exc,
            )

    @staticmethod
    def _try_resolve_low_balance_alert(organization_id: str) -> None:
        """余额增加后若已高于预警阈值，清除未读 balance_low 铃铛。"""
        if not organization_id:
            return
        try:
            from apps.services.billing.services.low_balance_alert_service import (
                LowBalanceAlertService,
            )

            LowBalanceAlertService.resolve_if_healthy(organization_id)
        except Exception as exc:
            logger.warning(
                "[OrganizationWallet] 余额增加后消警失败（不影响入账）: "
                "organization=%s, error=%s",
                organization_id,
                exc,
            )

    @transaction.atomic
    def refund(
        self,
        owner_id,
        credits_amount,
        description: str = '账单退款',
        related_order_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        operator_user_id: str = '',
    ) -> WalletTransaction:
        tx = super().refund(
            owner_id, credits_amount, description,
            related_order_id, organization_id, operator_user_id,
        )
        resolved_wt_id = organization_id or owner_id
        transaction.on_commit(
            lambda: self._try_unblock_after_balance_increase(resolved_wt_id, "refund")
        )
        return tx

    def consume(
        self,
        organization_id: str,
        credits_amount: Decimal | int | float | str,
        description: str = '点券消费',
        related_order_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> WalletTransaction:
        return super().consume(
            organization_id, credits_amount,
            description=description, related_order_id=related_order_id,
            operator_user_id=user_id or '',
        )

    def grant_credits(
        self,
        organization_id: str,
        credits_amount: Decimal | int | float | str,
        description: str = '系统赠送',
        user_id: Optional[str] = None,
    ) -> WalletTransaction:
        tx = super().grant_credits(
            organization_id, credits_amount,
            description=description,
            operator_user_id=user_id or '',
        )
        self._schedule_balance_increase_side_effects(
            organization_id=organization_id,
            credits_amount=credits_amount,
            order_id=None,
            transaction_id=str(tx.id),
            trigger="grant",
        )
        return tx

    def get_wallet_info(self, organization_id: str) -> Dict[str, Any]:
        """组织钱包信息额外返回 organization_id 字段"""
        info = super().get_wallet_info(organization_id)
        info['organization_id'] = organization_id
        return info

    def get_transaction_history(
        self,
        organization_id: str,
        transaction_type: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
        *,
        created_after: Optional[str] = None,
        created_before: Optional[str] = None,
        search: Optional[str] = None,
        order_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        return super().get_transaction_history(
            organization_id,
            transaction_type=transaction_type,
            limit=limit,
            offset=offset,
            created_after=created_after,
            created_before=created_before,
            search=search,
            order_by=order_by,
        )

    def get_or_create_wallet(self, organization_id: str) -> OrganizationWallet:
        return super().get_or_create_wallet(organization_id)

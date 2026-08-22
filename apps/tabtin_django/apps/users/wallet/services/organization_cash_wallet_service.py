"""Organization RMB cash wallet service."""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Dict, Optional

from django.db import IntegrityError, transaction

from apps.users.wallet.models import CashWalletTransaction, OrganizationCashWallet

logger = logging.getLogger(__name__)


class InsufficientCashBalance(ValueError):
    pass


class DuplicateCashTransactionOrder(ValueError):
    pass


def serialize_cash_transaction(tx: CashWalletTransaction) -> Dict[str, Any]:
    """面向成员的现金钱包流水序列化。

    与后台 admin_api._serialize_cash_transaction 的区别：不外显 operator_user_id
    （操作人属审计信息，不在用户侧账单中心展示），其余字段一致。metadata 原样带出，
    供前端展示「买到的点券数 / 套餐名」等明细。
    """
    return {
        "id": tx.id,
        "transaction_type": tx.transaction_type,
        "amount_cny": str(tx.amount_cny),
        "balance_before_cny": str(tx.balance_before_cny),
        "balance_after_cny": str(tx.balance_after_cny),
        "description": tx.description or "",
        "related_order_id": tx.related_order_id or "",
        "metadata": tx.metadata or {},
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
    }


class OrganizationCashWalletService:
    """Maintain organization cash balance in CNY.

    Cash balance is 1:1 with RMB and is used to purchase credits packages and
    entitlement add-on packages. It is intentionally separate from the credits
    wallet used by LLM calls.
    """

    @staticmethod
    def _to_cny(value) -> Decimal:
        return OrganizationCashWallet.quantize_cny(value)

    def get_or_create_wallet(self, organization_id: str) -> OrganizationCashWallet:
        wallet, _created = OrganizationCashWallet.objects.get_or_create(
            organization_id=str(organization_id),
            defaults={"balance_cny": Decimal("0.00"), "frozen_cny": Decimal("0.00")},
        )
        return wallet

    def get_transaction_history(
        self,
        organization_id: str,
        *,
        transaction_type: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """按组织分页查询现金钱包流水（倒序）。

        账单中心「现金钱包」子视图数据源。付款/退款那套支付生命周期不适用于现金
        钱包（现金动作即时完成），故按 transaction_type 过滤而非支付状态。
        """
        qs = CashWalletTransaction.objects.filter(organization_id=str(organization_id))
        if transaction_type:
            qs = qs.filter(transaction_type=transaction_type)
        total = qs.count()
        offset = max(offset, 0)
        limit = max(limit, 0)
        transactions = list(qs.order_by("-created_at")[offset:offset + limit])
        return {
            "total": total,
            "transactions": [serialize_cash_transaction(tx) for tx in transactions],
        }

    def _get_locked_wallet(self, organization_id: str) -> OrganizationCashWallet:
        wallet = OrganizationCashWallet.objects.select_for_update().filter(
            organization_id=str(organization_id),
        ).first()
        if wallet:
            return wallet
        try:
            OrganizationCashWallet.objects.create(organization_id=str(organization_id))
        except IntegrityError:
            pass
        return OrganizationCashWallet.objects.select_for_update().get(
            organization_id=str(organization_id),
        )

    @staticmethod
    def _try_publish_cash_recharged_ws(
        organization_id: str,
        amount_cny: str,
        order_id: str,
    ) -> None:
        """组织级 billing WS：客户端刷新余额（不承载铃铛文案）。"""
        try:
            from apps.services.billing.ws_events import publish_billing_event

            publish_billing_event(organization_id, "cash_recharged", {
                "amount_cny": amount_cny,
                "order_id": order_id,
            })
        except Exception as exc:
            logger.warning(
                "[OrganizationCashWallet] 发送 cash_recharged WS 失败（不影响充值）: "
                "organization=%s, error=%s",
                organization_id, exc,
            )

    @staticmethod
    def _try_notify_cash_recharged(
        organization_id: str,
        amount_cny,
        order_id: str,
    ) -> None:
        """现金钱包真实入账后的副作用：WS 刷新并由统一账户适配器写入铃铛。"""
        if not organization_id:
            return
        amount_text = str(amount_cny)
        order_text = order_id or ""
        OrganizationCashWalletService._try_publish_cash_recharged_ws(
            organization_id, amount_text, order_text,
        )

    def _schedule_cash_recharged_notify(
        self,
        *,
        organization_id: str,
        amount_cny,
        order_id: str,
    ) -> None:
        transaction.on_commit(
            lambda wid=str(organization_id), amt=amount_cny, oid=order_id or "":
                self._try_notify_cash_recharged(wid, amt, oid)
        )

    @transaction.atomic
    def recharge(
        self,
        *,
        organization_id: str,
        amount_cny,
        description: str = "人民币钱包充值",
        operator_user_id: str = "",
        related_order_id: str = "",
        reject_duplicate: bool = False,
    ) -> CashWalletTransaction:
        amount = self._to_cny(amount_cny)
        if amount <= 0:
            raise ValueError("recharge amount must be positive")
        order_id = (related_order_id or "").strip()
        if order_id:
            existing = CashWalletTransaction.objects.filter(
                organization_id=str(organization_id),
                transaction_type="recharge",
                related_order_id=order_id,
            ).first()
            if existing:
                if reject_duplicate:
                    raise DuplicateCashTransactionOrder(order_id)
                return existing
        wallet = self._get_locked_wallet(organization_id)
        if order_id:
            existing = CashWalletTransaction.objects.filter(
                organization_id=str(organization_id),
                transaction_type="recharge",
                related_order_id=order_id,
            ).first()
            if existing:
                if reject_duplicate:
                    raise DuplicateCashTransactionOrder(order_id)
                return existing
        before = wallet.balance_cny
        new_balance = self._to_cny(wallet.balance_cny + amount)
        try:
            # 嵌套 savepoint：create 撞唯一约束时只回滚本段余额变更，不毒化外层事务。
            with transaction.atomic():
                wallet.balance_cny = new_balance
                wallet.save(update_fields=["balance_cny", "updated_at"])
                tx = CashWalletTransaction.objects.create(
                    cash_wallet=wallet,
                    organization_id=str(organization_id),
                    transaction_type="recharge",
                    amount_cny=amount,
                    balance_before_cny=before,
                    balance_after_cny=new_balance,
                    operator_user_id=operator_user_id or "",
                    related_order_id=order_id,
                    description=description or "人民币钱包充值",
                )
            # 仅真实入账时通知；幂等命中已有流水不重复推送。
            self._schedule_cash_recharged_notify(
                organization_id=str(organization_id),
                amount_cny=amount,
                order_id=order_id,
            )
            return tx
        except IntegrityError:
            if not order_id:
                raise
            existing = CashWalletTransaction.objects.filter(
                organization_id=str(organization_id),
                transaction_type="recharge",
                related_order_id=order_id,
            ).first()
            if existing:
                if reject_duplicate:
                    raise DuplicateCashTransactionOrder(order_id)
                return existing
            raise

    @transaction.atomic
    def spend(
        self,
        *,
        organization_id: str,
        amount_cny,
        transaction_type: str,
        description: str,
        operator_user_id: str = "",
        related_order_id: str = "",
        related_wallet_transaction_id: str = "",
        related_addon_entitlement_id: str = "",
        metadata: Optional[dict] = None,
    ) -> CashWalletTransaction:
        amount = self._to_cny(amount_cny)
        if amount <= 0:
            raise ValueError("spend amount must be positive")
        order_id = (related_order_id or "").strip()
        wallet = self._get_locked_wallet(organization_id)
        if order_id:
            existing = CashWalletTransaction.objects.filter(
                organization_id=str(organization_id),
                transaction_type=transaction_type,
                related_order_id=order_id,
            ).first()
            if existing:
                return existing
        before = wallet.balance_cny
        if wallet.get_available_cny() < amount:
            raise InsufficientCashBalance("人民币钱包余额不足")
        wallet.balance_cny = self._to_cny(wallet.balance_cny - amount)
        wallet.save(update_fields=["balance_cny", "updated_at"])
        return CashWalletTransaction.objects.create(
            cash_wallet=wallet,
            organization_id=str(organization_id),
            transaction_type=transaction_type,
            amount_cny=-amount,
            balance_before_cny=before,
            balance_after_cny=wallet.balance_cny,
            operator_user_id=operator_user_id or "",
            related_order_id=order_id,
            related_wallet_transaction_id=related_wallet_transaction_id or "",
            related_addon_entitlement_id=related_addon_entitlement_id or "",
            description=description,
            metadata=metadata or {},
        )

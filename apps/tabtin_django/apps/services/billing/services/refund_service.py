"""
账单退款服务

D10 决策：退款回原支付平台。微信异步/支付宝同步。
支持全额退款和部分退款（部分退款按原交易金额比例拆分）。
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Dict, List, Optional

from django.db import transaction
from django.utils import timezone

try:
    import sentry_sdk
    _has_sentry = True
except ImportError:
    _has_sentry = False

try:
    from apps.services.billing.services.billing_metrics import billing_refunds_total as REFUND_TOTAL
except Exception:
    REFUND_TOTAL = None

logger = logging.getLogger(__name__)


class BillingRefundService:
    """账单退款服务：支持全额退款和部分退款，集成支付平台退款（D10）"""

    @staticmethod
    def _to_decimal(value) -> Decimal:
        return Decimal(str(value or 0))

    @staticmethod
    def _find_payment_order(invoice):
        """从 invoice metadata 中找到关联的 PaymentOrder"""
        metadata = dict(invoice.metadata or {})
        order_id = str(
            metadata.get("order_id")
            or metadata.get("related_order_id")
            or ""
        ).strip()

        if not order_id:
            return None

        from apps.services.payment.models import PaymentOrder
        return PaymentOrder.objects.filter(id=order_id).first()

    @staticmethod
    def _sync_payment_order_status(invoice, invoice_status: str) -> None:
        """XM-14: 退款时同步 PaymentOrder 状态，避免订单仍显示 completed/paid。"""
        try:
            metadata = dict(invoice.metadata or {})
            order_id = str(
                metadata.get("order_id")
                or metadata.get("related_order_id")
                or ""
            ).strip()
            if not order_id:
                return

            from apps.services.payment.models import PaymentOrder
            order = PaymentOrder.objects.filter(id=order_id).first()
            if not order:
                return

            new_status = "refunded" if invoice_status == "refunded" else "partially_refunded"
            if order.status not in ("paid", "completed", "partially_refunded"):
                logger.warning(
                    "XM-14: PaymentOrder 状态非 paid/completed，跳过同步: "
                    "order=%s current_status=%s", order.order_no, order.status,
                )
                return

            order.status = new_status
            order.save(update_fields=["status", "updated_at"])
            logger.info(
                "XM-14: PaymentOrder 状态已同步: order=%s -> %s",
                order.order_no, new_status,
            )
        except Exception as exc:
            logger.warning(
                "XM-14: PaymentOrder 状态同步失败（不阻断退款）: invoice=%s err=%s",
                invoice.id, exc,
            )

    @classmethod
    def _revoke_entitlements(
        cls,
        invoice,
        refund_amount: Decimal,
        new_status: str,
    ) -> List[str]:
        """
        全额退款后撤回关联的权益（存储套餐 / 会员）。
        部分退款时不主动取消订阅或会员。

        PAY-04: 此方法必须在 @transaction.atomic 内调用。
        异常向上传播以触发事务回滚，防止"钱退了但权益仍有效"的不一致状态。
        entitlement 同步已移至 refund_invoice 的 transaction.on_commit。

        返回已撤回的权益标识列表，用于日志记录。
        """
        organization_id = invoice.organization_id
        if not organization_id:
            return []

        is_full_refund = new_status == "refunded"
        metadata = dict(invoice.metadata or {})
        revoked: List[str] = []

        # PAY-33: 部分退款（partially_refunded）当前不主动撤回任何权益（会员/存储套餐）。
        if is_full_refund:
            order_id = str(
                metadata.get("order_id")
                or metadata.get("related_order_id")
                or ""
            ).strip()
            business_type = str(metadata.get("business_type") or "").strip()

            revoked += cls._try_cancel_storage_subscriptions(
                invoice, organization_id, order_id, business_type,
            )
            revoked += cls._try_expire_memberships(
                invoice, organization_id, order_id, business_type,
            )

        return revoked

    @classmethod
    def _try_cancel_storage_subscriptions(
        cls,
        invoice,
        organization_id: str,
        order_id: str,
        business_type: str,
    ) -> List[str]:
        revoked: List[str] = []
        try:
            from apps.services.billing.models import OrganizationStorageSubscription

            qs = OrganizationStorageSubscription.objects.filter(
                organization_id=organization_id,
                status="active",
            )
            if order_id and business_type == "storage_package":
                qs = qs.filter(order_id=order_id)
            elif business_type and business_type != "storage_package":
                return revoked
            else:
                sub_id = str(
                    (dict(invoice.metadata or {}).get("subscription_id") or "")
                ).strip()
                if sub_id:
                    qs = qs.filter(id=sub_id)
                else:
                    return revoked

            for sub in qs.select_for_update():
                sub.status = "cancelled"
                sub.save(update_fields=["status", "updated_at"])
                revoked.append(f"storage_subscription:{sub.id}")
                logger.info(
                    "退款撤回存储套餐: invoice=%s subscription=%s organization=%s",
                    invoice.id, sub.id, organization_id,
                )
        except Exception as exc:
            logger.error(
                "退款撤回存储套餐失败(将触发事务回滚): invoice=%s organization=%s err=%s",
                invoice.id, organization_id, exc, exc_info=True,
            )
            raise
        return revoked

    @classmethod
    def _try_expire_memberships(
        cls,
        invoice,
        organization_id: str,
        order_id: str,
        business_type: str,
    ) -> List[str]:
        revoked: List[str] = []
        try:
            from apps.users.membership.models import OrganizationMembership

            qs = OrganizationMembership.objects.filter(
                organization_id=organization_id,
                status="active",
            )
            if order_id and business_type == "membership":
                qs = qs.filter(related_order_id=order_id)
            elif business_type and business_type != "membership":
                return revoked
            else:
                mem_id = str(
                    (dict(invoice.metadata or {}).get("membership_id") or "")
                ).strip()
                if mem_id:
                    qs = qs.filter(id=mem_id)
                else:
                    return revoked

            for mem in qs.select_for_update():
                mem.status = "expired"
                mem.save(update_fields=["status", "updated_at"])
                revoked.append(f"membership:{mem.id}")
                logger.info(
                    "退款撤回会员权益: invoice=%s membership=%s organization=%s",
                    invoice.id, mem.id, organization_id,
                )

            if revoked:
                cls._reduce_llm_monthly_budget(organization_id, invoice)

        except Exception as exc:
            logger.error(
                "退款撤回会员权益失败(将触发事务回滚): invoice=%s organization=%s err=%s",
                invoice.id, organization_id, exc, exc_info=True,
            )
            raise
        return revoked

    @classmethod
    def _reduce_llm_monthly_budget(cls, organization_id: str, invoice):
        """PAY-18: 退款撤回会员后，将当月 LLM 预算降至已消耗额度"""
        try:
            from apps.services.billing.models import OrganizationLlmMonthlyBudget

            now = timezone.now()
            cycle_month = now.date().replace(day=1)

            budget = OrganizationLlmMonthlyBudget.objects.select_for_update().filter(
                organization_id=organization_id,
                cycle_month=cycle_month,
            ).first()

            if budget and budget.included_credits > budget.consumed_credits:
                old_included = budget.included_credits
                budget.included_credits = budget.consumed_credits
                budget.save(update_fields=["included_credits", "updated_at"])
                logger.info(
                    "退款后调整 LLM 月度预算: invoice=%s organization=%s cycle=%s "
                    "included: %s -> %s",
                    invoice.id, organization_id, cycle_month,
                    old_included, budget.included_credits,
                )
        except Exception as exc:
            logger.error(
                "退款后调整 LLM 月度预算失败(将触发事务回滚): "
                "invoice=%s organization=%s err=%s",
                invoice.id, organization_id, exc, exc_info=True,
            )
            raise

    @classmethod
    def _sync_entitlement(
        cls,
        invoice,
        organization_id: str,
        revoked: List[str],
        is_full_refund: bool,
    ):
        try:
            from apps.services.billing.services.entitlement_service import (
                OrganizationEntitlementSyncService,
            )
            metadata_updates = {
                "last_refund_sync_at": timezone.now().isoformat(),
                "last_refund_invoice_id": str(invoice.id),
            }
            if revoked:
                metadata_updates["last_revoked_items"] = revoked
            if is_full_refund:
                metadata_updates["last_full_refund_at"] = timezone.now().isoformat()

            OrganizationEntitlementSyncService.sync_organization_entitlement(
                organization_id,
                metadata_updates=metadata_updates,
            )
            logger.info(
                "退款后 entitlement 同步完成: invoice=%s organization=%s revoked=%s",
                invoice.id, organization_id, revoked,
            )
        except Exception as exc:
            logger.error(
                "退款后 entitlement 同步失败: invoice=%s organization=%s err=%s",
                invoice.id, organization_id, exc, exc_info=True,
            )
            raise

    # ── 支付平台退款（D10） ──────────────────────────────────────

    @classmethod
    def _initiate_platform_refund(
        cls,
        payment_order,
        invoice,
        refund_amount_credits: Decimal,
        reason: str,
        operator_user_id: str,
    ) -> Dict:
        """
        发起支付平台退款。

        - 支付宝：同步返回 refund_status='refunded'
        - 微信：异步返回 refund_status='refunding'，需等待回调
        - 失败：refund_status='refund_failed'

        退款金额为 PaymentOrder.paid_amount（全额退 CNY），
        与 Credits 退款金额分开追踪。
        """
        from apps.services.payment.models import RefundRecord

        refund_record = RefundRecord.objects.create(
            payment_order=payment_order,
            invoice_id=str(invoice.id),
            refund_amount=payment_order.paid_amount,
            refund_status='refunding',
            payment_method=payment_order.payment_method,
            operator_user_id=operator_user_id,
            reason=reason,
            metadata={
                'invoice_no': invoice.invoice_no,
                'credits_refund_amount': str(refund_amount_credits),
                'order_no': payment_order.order_no,
            },
        )

        try:
            from apps.services.payment.services.factory import PaymentServiceFactory
            service = PaymentServiceFactory.get_service(payment_order.payment_method)

            if not hasattr(service, 'refund'):
                logger.warning(
                    "支付服务 %s 尚未实现 refund 方法，跳过平台退款（需并行 agent 完成）: "
                    "order=%s", payment_order.payment_method, payment_order.order_no,
                )
                refund_record.refund_status = 'refund_failed'
                refund_record.failure_reason = (
                    f'{payment_order.payment_method} 服务尚未实现 refund 方法'
                )
                refund_record.save(update_fields=[
                    'refund_status', 'failure_reason', 'updated_at',
                ])
                return {
                    'refund_status': 'refund_failed',
                    'refund_record_id': str(refund_record.id),
                    'failure_reason': refund_record.failure_reason,
                }

            result = service.refund(
                order_no=payment_order.order_no,
                refund_no=refund_record.refund_no,
                total_amount=payment_order.paid_amount,
                refund_amount=payment_order.paid_amount,
                refund_reason=reason or f"账单退款：{invoice.invoice_no}",
            )

            if not result.success:
                refund_record.refund_status = 'refund_failed'
                refund_record.failure_reason = (
                    result.error_message or f"平台退款失败: status={result.status}"
                )[:500]
                refund_record.save(update_fields=['refund_status', 'failure_reason', 'updated_at'])
                logger.error(
                    "支付平台退款业务失败: invoice=%s order=%s method=%s status=%s msg=%s",
                    invoice.id, payment_order.order_no, payment_order.payment_method,
                    result.status, result.error_message,
                )
                if _has_sentry:
                    sentry_sdk.capture_message(
                        f"[退款平台失败] invoice={invoice.invoice_no} "
                        f"method={payment_order.payment_method} "
                        f"status={result.status} msg={result.error_message}",
                        level="error",
                    )
                return {
                    'refund_status': 'refund_failed',
                    'refund_record_id': str(refund_record.id),
                    'failure_reason': refund_record.failure_reason,
                }

            refund_status = result.status or 'refunding'
            refund_record.refund_status = refund_status
            refund_record.third_party_refund_no = result.refund_id

            if refund_status == 'refunded':
                refund_record.refunded_at = timezone.now()

            refund_record.save(update_fields=[
                'refund_status', 'third_party_refund_no', 'refunded_at', 'updated_at',
            ])

            logger.info(
                "支付平台退款发起成功: invoice=%s order=%s method=%s status=%s "
                "refund_no=%s amount_cny=%s",
                invoice.id, payment_order.order_no, payment_order.payment_method,
                refund_status, refund_record.refund_no, payment_order.paid_amount,
            )

            return {
                'refund_status': refund_status,
                'refund_record_id': str(refund_record.id),
                'refund_no': refund_record.refund_no,
                'refund_amount_cny': str(payment_order.paid_amount),
                'third_party_refund_no': result.refund_id,
            }

        except Exception as exc:
            logger.error(
                "支付平台退款失败: invoice=%s order=%s method=%s err=%s",
                invoice.id, payment_order.order_no, payment_order.payment_method,
                exc, exc_info=True,
            )
            refund_record.refund_status = 'refund_failed'
            refund_record.failure_reason = f"platform_error:{type(exc).__name__}: {str(exc)[:200]}"
            refund_record.save(update_fields=[
                'refund_status', 'failure_reason', 'updated_at',
            ])

            if _has_sentry:
                sentry_sdk.capture_exception(exc)

            return {
                'refund_status': 'refund_failed',
                'refund_record_id': str(refund_record.id),
                'failure_reason': f"platform_error:{type(exc).__name__}",
            }

    # ── 退款主入口 ──────────────────────────────────────────────

    @classmethod
    def refund_invoice(
        cls,
        invoice_id: str,
        amount: Optional[Decimal] = None,
        reason: str = "",
        operator_user_id: str = "",
    ) -> Dict:
        """
        退款主入口。

        D10 流程：
        1. 预校验账单状态和金额
        2. 如有关联的真实支付订单且是全额退款 → 先发起平台退款
           - 支付宝同步成功 → 继续内部退款
           - 微信异步 → 返回 refunding，等回调后完成内部退款
           - 平台退款失败 → 返回错误，不做内部退款
        3. 无真实支付或部分退款 → 仅做内部 Credits 退款（保持向后兼容）
        """
        import uuid as _uuid
        from django_redis import get_redis_connection
        _redis = get_redis_connection("default")
        lock_key = f"refund:lock:{invoice_id}"
        lock_value = _uuid.uuid4().hex
        if not _redis.set(lock_key, lock_value, nx=True, ex=600):
            raise ValueError("该账单正在处理退款，请稍后重试")
        try:
            from apps.services.billing.models import BillingInvoice

            invoice = BillingInvoice.objects.get(id=invoice_id)

            if invoice.status not in ("paid", "partially_refunded"):
                raise ValueError(
                    f"账单状态为 {invoice.status}，仅 paid / partially_refunded 状态可退款"
                )

            total = cls._to_decimal(invoice.total_amount)
            already_refunded = cls._to_decimal(invoice.refunded_amount)
            refundable = total - already_refunded

            if amount is not None:
                refund_amount = cls._to_decimal(amount)
            else:
                refund_amount = refundable

            if refund_amount <= 0:
                raise ValueError("退款金额必须大于 0")
            if refund_amount > refundable:
                raise ValueError(
                    f"退款金额 {refund_amount} 超过可退金额 {refundable}"
                )

            is_full_refund = (refund_amount >= refundable)

            # ── Phase 1: 支付平台退款（D10）──
            # 在数据库事务外执行，避免长事务锁住 invoice 行
            payment_order = cls._find_payment_order(invoice)
            platform_result = None

            if (
                payment_order
                and payment_order.payment_method in ('wechat', 'alipay')
                and payment_order.status in ('paid', 'completed')
            ):
                if is_full_refund:
                    platform_result = cls._initiate_platform_refund(
                        payment_order, invoice, refund_amount,
                        reason, operator_user_id,
                    )

                    if platform_result['refund_status'] == 'refund_failed':
                        if REFUND_TOTAL:
                            REFUND_TOTAL.labels(result="platform_failed").inc()
                        return {
                            'invoice_id': str(invoice.id),
                            'invoice_no': invoice.invoice_no,
                            'status': 'refund_failed',
                            'platform_refund_error': platform_result.get('failure_reason', ''),
                            'refund_record_id': platform_result.get('refund_record_id', ''),
                        }

                    if platform_result['refund_status'] == 'refunding':
                        if REFUND_TOTAL:
                            REFUND_TOTAL.labels(result="platform_refunding").inc()
                        return {
                            'invoice_id': str(invoice.id),
                            'invoice_no': invoice.invoice_no,
                            'status': 'refunding',
                            'refund_record_id': platform_result['refund_record_id'],
                            'refund_no': platform_result['refund_no'],
                            'refund_amount_cny': platform_result.get('refund_amount_cny', ''),
                            'payment_method': payment_order.payment_method,
                            'message': '微信退款已发起，等待平台回调确认后完成内部退款和权益撤回',
                        }
                else:
                    logger.info(
                        "部分退款不触发支付平台退款(D10暂不支持部分退款): "
                        "invoice=%s amount=%s",
                        invoice.id, refund_amount,
                    )

            # ── Phase 2: 内部 Credits 退款 + 权益撤回 ──
            if platform_result and platform_result.get('refund_status') == 'refunded':
                try:
                    return cls._execute_internal_refund(
                        invoice_id, refund_amount, reason, operator_user_id,
                        platform_refund_result=platform_result,
                    )
                except Exception as exc:
                    logger.critical(
                        "PAY-SAFETY: 支付宝退款已成功但内部退款失败，需人工介入: "
                        "invoice=%s amount=%s err=%s",
                        invoice_id, refund_amount, exc, exc_info=True,
                    )
                    refund_record_id = platform_result.get('refund_record_id', '')
                    if refund_record_id:
                        from apps.services.payment.models import RefundRecord
                        try:
                            record = RefundRecord.objects.get(id=refund_record_id)
                            record.metadata = {
                                **(record.metadata or {}),
                                'internal_refund_error': f"{type(exc).__name__}: {str(exc)[:300]}",
                                'internal_refund_failed_at': timezone.now().isoformat(),
                            }
                            record.save(update_fields=['metadata', 'updated_at'])
                        except Exception:
                            pass
                    if _has_sentry:
                        sentry_sdk.capture_exception(exc)
                    if REFUND_TOTAL:
                        REFUND_TOTAL.labels(result="partial_failure").inc()
                    try:
                        from apps.services.billing.ws_events import publish_billing_event
                        if invoice.organization_id:
                            publish_billing_event(invoice.organization_id, "refund_partial_failure", {
                                "invoice_id": str(invoice.id),
                                "invoice_no": invoice.invoice_no,
                                "refund_amount": str(refund_amount),
                                "error_type": type(exc).__name__,
                            })
                    except Exception:
                        logger.debug("partial_failure WS 推送失败（非关键）", exc_info=True)
                    return {
                        'invoice_id': str(invoice.id),
                        'invoice_no': invoice.invoice_no,
                        'status': 'partial_failure',
                        'message': '支付平台退款成功，但内部退款失败，已自动调度补偿任务',
                        'refund_record_id': refund_record_id,
                        'error': f"internal_refund_failed:{type(exc).__name__}",
                    }

            return cls._execute_internal_refund(
                invoice_id, refund_amount, reason, operator_user_id,
                platform_refund_result=platform_result,
            )
        finally:
            _UNLOCK_SCRIPT = (
                "if redis.call('get',KEYS[1])==ARGV[1] "
                "then return redis.call('del',KEYS[1]) "
                "else return 0 end"
            )
            try:
                _redis.eval(_UNLOCK_SCRIPT, 1, lock_key, lock_value)
            except Exception:
                logger.warning("Redis 原子解锁失败，锁将在 TTL 后自动过期: key=%s", lock_key)

    @classmethod
    @transaction.atomic
    def _execute_internal_refund(
        cls,
        invoice_id: str,
        refund_amount: Optional[Decimal] = None,
        reason: str = "",
        operator_user_id: str = "",
        platform_refund_result: Optional[Dict] = None,
    ) -> Dict:
        """
        执行内部 Credits 退款 + 权益撤回（事务内）。

        由 refund_invoice 在平台退款成功/不需要平台退款时调用，
        也由 complete_platform_refund 在微信异步回调成功后调用。
        """
        from apps.services.billing.models import BillingInvoice

        invoice = BillingInvoice.objects.select_for_update().get(id=invoice_id)

        if invoice.status not in ("paid", "partially_refunded"):
            raise ValueError(
                f"账单状态为 {invoice.status}，仅 paid / partially_refunded 状态可退款"
            )

        total = cls._to_decimal(invoice.total_amount)
        already_refunded = cls._to_decimal(invoice.refunded_amount)
        refundable = total - already_refunded

        if refund_amount is None or refund_amount <= 0:
            refund_amount = refundable

        if refund_amount > refundable:
            raise ValueError(
                f"退款金额 {refund_amount} 超过可退金额 {refundable}"
            )

        metadata = dict(invoice.metadata or {})
        collection = dict(metadata.get("collection") or {})
        last_wallet_tx_id = str(collection.get("last_wallet_tx_id") or "").strip()

        organization_wallet_id = None

        if last_wallet_tx_id:
            from apps.users.wallet.models import WalletTransaction

            try:
                original_tx = WalletTransaction.objects.get(id=last_wallet_tx_id)
            except WalletTransaction.DoesNotExist:
                raise ValueError(f"原扣款交易 {last_wallet_tx_id} 不存在")

            organization_wallet_id = getattr(original_tx, "organization_wallet_id", None)
        else:
            logger.warning(
                "账单缺少 last_wallet_tx_id，使用降级退款路径: invoice=%s",
                invoice_id,
            )

        refund_tx = None
        if organization_wallet_id:
            from apps.users.wallet.models import OrganizationWallet
            from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService

            ws_wallet = OrganizationWallet.objects.get(id=organization_wallet_id)
            svc = OrganizationWalletService()
            refund_tx = svc.refund(
                owner_id=ws_wallet.organization_id,
                credits_amount=refund_amount,
                description=f"账单退款：{invoice.invoice_no}",
                related_order_id=str(invoice.id),
                organization_id=ws_wallet.organization_id,
                operator_user_id=operator_user_id,
            )
        elif invoice.organization_id:
            from apps.users.wallet.models import OrganizationWallet
            from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService

            try:
                ws_wallet = OrganizationWallet.objects.get(
                    organization_id=invoice.organization_id
                )
            except OrganizationWallet.DoesNotExist:
                raise ValueError(
                    f"账单缺少原扣款记录且组织({invoice.organization_id})无钱包，"
                    f"无法自动退款，请人工处理"
                )
            svc = OrganizationWalletService()
            refund_tx = svc.refund(
                owner_id=invoice.organization_id,
                credits_amount=refund_amount,
                description=f"账单退款（降级路径）：{invoice.invoice_no}",
                related_order_id=str(invoice.id),
                organization_id=invoice.organization_id,
                operator_user_id=operator_user_id,
            )
            logger.info(
                "PAY-15 降级退款成功: invoice=%s organization=%s amount=%s",
                invoice.id, invoice.organization_id, refund_amount,
            )
        else:
            raise ValueError(
                "无法确定退款目标：账单缺少 last_wallet_tx_id 且无 organization_id，请人工处理"
            )

        now = timezone.now()
        new_refunded = already_refunded + refund_amount
        invoice.refunded_amount = new_refunded
        invoice.refunded_at = now

        if new_refunded >= total:
            invoice.status = "refunded"
        else:
            invoice.status = "partially_refunded"

        refund_record = {
            "refund_amount": str(refund_amount),
            "refund_tx_id": str(refund_tx.id),
            "reason": reason,
            "refunded_at": now.isoformat(),
            "operator_user_id": operator_user_id,
        }

        if platform_refund_result:
            refund_record["platform_refund"] = {
                "refund_record_id": platform_refund_result.get("refund_record_id", ""),
                "refund_no": platform_refund_result.get("refund_no", ""),
                "refund_amount_cny": platform_refund_result.get("refund_amount_cny", ""),
                "refund_status": platform_refund_result.get("refund_status", ""),
            }

        refund_history = metadata.get("refund_history", [])
        if not isinstance(refund_history, list):
            refund_history = []
        refund_history.append(refund_record)
        metadata["refund"] = refund_record
        metadata["refund_history"] = refund_history
        invoice.metadata = metadata

        invoice.save(update_fields=[
            "refunded_amount", "refunded_at", "status", "metadata", "updated_at",
        ])

        logger.info(
            "账单退款成功: invoice=%s amount=%s status=%s tx=%s platform=%s",
            invoice.id, refund_amount, invoice.status, refund_tx.id,
            "yes" if platform_refund_result else "no",
        )

        if REFUND_TOTAL:
            REFUND_TOTAL.labels(result="success").inc()

        try:
            with transaction.atomic():
                cls._sync_payment_order_status(invoice, invoice.status)
        except Exception as exc:
            logger.warning(
                "XM-14: PaymentOrder 状态同步失败（已隔离，不影响退款事务）: invoice=%s err=%s",
                invoice.id, exc,
            )

        revoked_items = cls._revoke_entitlements(invoice, refund_amount, invoice.status)

        has_platform_refund = bool(
            platform_refund_result
            and platform_refund_result.get('refund_status') == 'refunded'
        )
        if not has_platform_refund:
            _platform_warning = (
                f"退款 {refund_amount} Credits 仅退还内部余额。"
                f"如涉及真实支付（支付宝/微信），需管理员在对应支付平台手动操作原路退款。"
                f" invoice={invoice.invoice_no} invoice_id={invoice.id}"
            )
            logger.warning("[PAY-03] %s", _platform_warning)
            if _has_sentry:
                sentry_sdk.capture_message(
                    f"[退款需人工处理] {_platform_warning}",
                    level="warning",
                )

        _inv = invoice
        _ws_id = invoice.organization_id
        _revoked = list(revoked_items)
        _is_full = invoice.status == "refunded"

        def _deferred_entitlement_sync():
            try:
                cls._sync_entitlement(_inv, _ws_id, _revoked, _is_full)
            except Exception:
                logger.error(
                    "退款后 entitlement 同步失败(on_commit)，需人工介入: invoice=%s",
                    _inv.id, exc_info=True,
                )

        transaction.on_commit(_deferred_entitlement_sync)

        try:
            from apps.services.billing.ws_events import publish_billing_event
            publish_billing_event(invoice.organization_id, "invoice_refunded", {
                "invoice_id": str(invoice.id),
                "invoice_no": invoice.invoice_no,
                "refund_amount": str(refund_amount),
                "status": invoice.status,
                "platform_refunded": has_platform_refund,
            })
        except Exception:
            logger.debug("退款 WS 事件推送失败（非关键）", exc_info=True)

        result = {
            "invoice_id": str(invoice.id),
            "invoice_no": invoice.invoice_no,
            "refund_amount": str(refund_amount),
            "refunded_amount_total": str(new_refunded),
            "status": invoice.status,
            "refund_tx_id": str(refund_tx.id),
        }
        if has_platform_refund:
            result["platform_refund"] = {
                "refund_record_id": platform_refund_result.get("refund_record_id", ""),
                "refund_no": platform_refund_result.get("refund_no", ""),
                "refund_amount_cny": platform_refund_result.get("refund_amount_cny", ""),
            }
        else:
            result["platform_refund_warning"] = (
                "退款仅退还内部 Credits。如涉及真实支付，需在支付平台手动操作原路退款。"
            )
        if revoked_items:
            result["revoked_entitlements"] = revoked_items
        return result

    # ── 微信退款回调完成 ────────────────────────────────────────

    @classmethod
    def complete_platform_refund(
        cls,
        refund_record_id: str,
        success: bool = True,
        third_party_refund_no: str = "",
        failure_reason: str = "",
    ) -> Dict:
        """
        微信退款回调后调用：更新退款记录状态，成功则完成内部 Credits 退款和权益撤回。

        由 PaymentCallbackHandler（并行 agent 实现）在接收到微信退款回调时调用。
        """
        from apps.services.payment.models import RefundRecord

        try:
            record = RefundRecord.objects.get(id=refund_record_id)
        except RefundRecord.DoesNotExist:
            logger.error("退款记录不存在: refund_record_id=%s", refund_record_id)
            return {'status': 'error', 'message': '退款记录不存在'}

        if record.refund_status != 'refunding':
            logger.warning(
                "RefundRecord 状态非 refunding，跳过: id=%s status=%s",
                refund_record_id, record.refund_status,
            )
            return {'status': record.refund_status, 'message': '退款记录状态不正确'}

        if not success:
            record.refund_status = 'refund_failed'
            record.failure_reason = failure_reason or '支付平台回调通知退款失败'
            record.save(update_fields=['refund_status', 'failure_reason', 'updated_at'])

            logger.error(
                "平台退款回调失败: refund_record=%s reason=%s",
                refund_record_id, record.failure_reason,
            )

            if REFUND_TOTAL:
                REFUND_TOTAL.labels(result="platform_callback_failed").inc()

            try:
                from apps.services.billing.ws_events import publish_billing_event
                from apps.services.billing.models import BillingInvoice
                invoice = BillingInvoice.objects.filter(id=record.invoice_id).first()
                if invoice:
                    publish_billing_event(invoice.organization_id, "platform_refund_failed", {
                        "invoice_id": record.invoice_id,
                        "refund_record_id": str(record.id),
                        "refund_no": record.refund_no,
                        "failure_reason": record.failure_reason,
                        "amount": str(record.refund_amount),
                        "currency": "CNY",
                    })
            except Exception:
                logger.debug("退款失败 WS 事件推送失败（非关键）", exc_info=True)

            return {'status': 'refund_failed', 'failure_reason': record.failure_reason}

        record.refund_status = 'refunded'
        record.refunded_at = timezone.now()
        if third_party_refund_no:
            record.third_party_refund_no = third_party_refund_no
        record.save(update_fields=[
            'refund_status', 'refunded_at', 'third_party_refund_no', 'updated_at',
        ])

        logger.info(
            "平台退款回调成功，开始执行内部退款: refund_record=%s invoice=%s",
            refund_record_id, record.invoice_id,
        )

        credits_amount_str = (record.metadata or {}).get('credits_refund_amount', '0')
        credits_amount = Decimal(str(credits_amount_str))

        platform_result = {
            'refund_status': 'refunded',
            'refund_record_id': str(record.id),
            'refund_no': record.refund_no,
            'refund_amount_cny': str(record.refund_amount),
        }

        try:
            result = cls._execute_internal_refund(
                invoice_id=record.invoice_id,
                refund_amount=credits_amount if credits_amount > 0 else None,
                reason=record.reason,
                operator_user_id=record.operator_user_id,
                platform_refund_result=platform_result,
            )
        except Exception as exc:
            # 平台退款已成功但内部退款失败 → 需人工介入
            logger.critical(
                "平台退款已成功但内部 Credits 退款失败，需人工介入: "
                "refund_record=%s invoice=%s err=%s",
                refund_record_id, record.invoice_id, exc, exc_info=True,
            )
            record.metadata = {
                **(record.metadata or {}),
                'internal_refund_error': f"{type(exc).__name__}: {str(exc)[:300]}",
                'internal_refund_failed_at': timezone.now().isoformat(),
            }
            record.save(update_fields=['metadata', 'updated_at'])

            if _has_sentry:
                sentry_sdk.capture_exception(exc)

            try:
                from apps.services.billing.ws_events import publish_billing_event
                from apps.services.billing.models import BillingInvoice as _BI
                _inv = _BI.objects.filter(id=record.invoice_id).values_list('organization_id', flat=True).first()
                if _inv:
                    publish_billing_event(_inv, "refund_partial_failure", {
                        "invoice_id": record.invoice_id,
                        "refund_record_id": str(record.id),
                        "refund_no": record.refund_no,
                        "error_type": type(exc).__name__,
                    })
            except Exception:
                logger.debug("partial_failure WS 推送失败（非关键）", exc_info=True)

            return {
                'status': 'partial_failure',
                'message': '支付平台退款成功，但内部退款失败，已自动调度补偿任务',
                'refund_record_id': str(record.id),
                'error': f"internal_refund_failed:{type(exc).__name__}",
            }

        try:
            from apps.services.billing.ws_events import publish_billing_event
            from apps.services.billing.models import BillingInvoice
            invoice = BillingInvoice.objects.filter(id=record.invoice_id).first()
            if invoice:
                publish_billing_event(invoice.organization_id, "platform_refund_completed", {
                    "invoice_id": record.invoice_id,
                    "refund_record_id": str(record.id),
                    "refund_no": record.refund_no,
                    "status": "refunded",
                    "refund_result": result,
                })
        except Exception:
            logger.debug("退款完成 WS 事件推送失败（非关键）", exc_info=True)

        return result

    # ── 退款状态查询 ────────────────────────────────────────────

    @classmethod
    def get_refund_status(cls, invoice_id: str) -> Dict:
        """查询账单关联的平台退款记录状态"""
        from apps.services.payment.models import RefundRecord

        records = RefundRecord.objects.filter(
            invoice_id=invoice_id,
        ).order_by('-created_at')

        items = []
        for r in records:
            items.append({
                'refund_record_id': str(r.id),
                'refund_no': r.refund_no,
                'refund_amount_cny': str(r.refund_amount),
                'refund_status': r.refund_status,
                'payment_method': r.payment_method,
                'third_party_refund_no': r.third_party_refund_no,
                'failure_reason': r.failure_reason,
                'refunded_at': r.refunded_at.isoformat() if r.refunded_at else None,
                'created_at': r.created_at.isoformat() if r.created_at else None,
            })

        return {
            'invoice_id': invoice_id,
            'refund_records': items,
            'has_pending_refund': any(
                r.refund_status in ('pending', 'refunding') for r in records
            ),
        }

"""
账单自动扣款与补偿服务
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Dict, List

from django.conf import settings
from django.db import DatabaseError, transaction
from django.utils import timezone

from apps.i18n import _
from apps.services.billing.models import BillingInvoice
from apps.services.billing.ws_events import publish_billing_event
from apps.services.billing.services.billing_metrics import (
    billing_charges_total,
    billing_charge_amount_credits,
)
from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
from apps.users.wallet.exceptions import InsufficientCreditsError, WalletException
from apps.users.wallet.models import WalletTransaction
from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


class BillingCollectionService:
    """账单自动扣款服务（仅从 OrganizationWallet 扣款）"""

    MAX_COLLECTION_ATTEMPTS = 10

    # 指数退避冷却时间（小时），10 次尝试分散在 ~12 天内 (INV-A13-003)
    _BACKOFF_HOURS = [1, 2, 4, 8, 24, 24, 48, 48, 72, 72]

    @staticmethod
    def _to_decimal(value) -> Decimal:
        return Decimal(str(value or 0))

    @classmethod
    def _cooldown_seconds(cls, attempt_count: int) -> int:
        idx = min(max(attempt_count - 1, 0), len(cls._BACKOFF_HOURS) - 1)
        return cls._BACKOFF_HOURS[idx] * 3600

    @classmethod
    def _is_collection_cooling_down(cls, invoice: BillingInvoice, now=None) -> bool:
        """判断账单是否仍在退避冷却期内。

        last_attempt_at 由 _mark_collection_failed 写入，格式为
        timezone.now().isoformat()（Django USE_TZ=True 时始终带时区信息）。
        """
        now = now or timezone.now()
        meta = dict(invoice.metadata or {})
        collection = meta.get("collection", {})
        last_attempt_str = collection.get("last_attempt_at", "")
        attempt_count = int(collection.get("attempt_count") or 0)
        if not last_attempt_str or attempt_count <= 0:
            return False
        try:
            from datetime import datetime as _dt
            last_attempt = _dt.fromisoformat(last_attempt_str)
            if timezone.is_naive(last_attempt):
                last_attempt = timezone.make_aware(last_attempt)
            cooldown = cls._cooldown_seconds(attempt_count)
            return (now - last_attempt).total_seconds() < cooldown
        except (ValueError, TypeError):
            return False

    @classmethod
    def _ensure_collection_metadata(cls, invoice: BillingInvoice) -> Dict:
        metadata = dict(invoice.metadata or {})
        collection = dict(metadata.get("collection") or {})
        collection.setdefault("attempt_count", 0)
        collection.setdefault("last_attempt_at", None)
        collection.setdefault("last_error", "")
        collection.setdefault("last_error_code", "")
        collection.setdefault("last_success_at", None)
        collection.setdefault("last_wallet_tx_id", "")
        metadata["collection"] = collection
        return metadata

    @classmethod
    def _resolve_payer_user_id(cls, invoice: BillingInvoice) -> str:
        metadata = dict(invoice.metadata or {})
        explicit = str(metadata.get("payer_user_id") or "").strip()
        if explicit:
            return explicit

        policy = OrganizationBillingPolicyService.get_active_policy(invoice.organization_id)
        if policy and policy.metadata:
            policy_payer = str((policy.metadata or {}).get("payer_user_id") or "").strip()
            if policy_payer:
                return policy_payer

        try:
            from apps.tabtinspace.models import Organization

            owner_id = (
                Organization.objects.using(postgres_app_db_alias())
                .filter(id=invoice.organization_id)
                .values_list("owner_id", flat=True)
                .first()
            )
            return str(owner_id or "").strip()
        except (DatabaseError, ImportError) as exc:
            # 跨库依赖（MySQL billing → PostgreSQL tabtinspace）故障，升级为 error 级别
            # 可通过 BILLING_ALERT_WEBHOOK_URL 配置外部通知 (INV-A13-005)
            logger.error(
                "[CrossDB] organization payer 解析失败（跨库依赖故障）: "
                "organization=%s db=postgresql err_type=%s err=%s",
                invoice.organization_id, type(exc).__name__, exc,
                exc_info=True,
            )
            return ""

    @classmethod
    def _mark_collection_failed(
        cls,
        invoice: BillingInvoice,
        *,
        payer_user_id: str,
        error_message: str,
        error_code: str = "unexpected_error",
    ) -> BillingInvoice:
        metadata = cls._ensure_collection_metadata(invoice)
        collection = metadata["collection"]
        collection["attempt_count"] = int(collection.get("attempt_count") or 0) + 1
        collection["last_attempt_at"] = timezone.now().isoformat()
        collection["last_error"] = error_message
        collection["last_error_code"] = error_code
        if payer_user_id:
            metadata["payer_user_id"] = payer_user_id
        invoice.metadata = metadata

        update_fields = ["metadata", "updated_at"]
        invoice.collection_attempt_count = collection["attempt_count"]
        update_fields.append("collection_attempt_count")

        attempt_count = collection["attempt_count"]
        if attempt_count >= cls.MAX_COLLECTION_ATTEMPTS:
            invoice.status = "failed"
            update_fields.append("status")
            logger.warning(
                "账单扣款失败次数已达上限(%d)，标记为 failed: invoice=%s organization=%s",
                cls.MAX_COLLECTION_ATTEMPTS, invoice.id, invoice.organization_id,
            )

        invoice.save(update_fields=update_fields)

        if attempt_count >= cls.MAX_COLLECTION_ATTEMPTS:
            ws_payload = {
                "invoice_id": str(invoice.id),
                "invoice_no": invoice.invoice_no,
                "attempt_count": attempt_count,
                "last_error": collection.get("last_error", ""),
                "last_error_code": error_code,
                "total_amount": str(invoice.total_amount),
                "currency": invoice.currency,
            }
            organization_id = invoice.organization_id
            transaction.on_commit(lambda: publish_billing_event(
                organization_id, "invoice_collection_failed", ws_payload,
            ))

            from apps.services.billing.tasks import _dispatch_billing_alert
            _dispatch_billing_alert(
                "collection_exhausted", "error",
                f"Invoice {invoice.invoice_no} 催收 {cls.MAX_COLLECTION_ATTEMPTS} 次失败",
                organization_id=organization_id,
            )

            failed_count = BillingInvoice.objects.filter(
                organization_id=organization_id, status="failed",
            ).count()
            if failed_count >= 2:
                transaction.on_commit(lambda: publish_billing_event(
                    organization_id, "billing_blocked", {
                        "reason": "multiple_failed_invoices",
                        "failed_invoice_count": failed_count,
                    },
                ))

        return invoice

    @classmethod
    def _mark_collection_succeeded(
        cls,
        invoice: BillingInvoice,
        *,
        payer_user_id: str,
        wallet_tx_id: str,
    ) -> BillingInvoice:
        metadata = cls._ensure_collection_metadata(invoice)
        collection = metadata["collection"]
        collection["attempt_count"] = int(collection.get("attempt_count") or 0) + 1
        collection["last_attempt_at"] = timezone.now().isoformat()
        collection["last_error"] = ""
        collection["last_success_at"] = timezone.now().isoformat()
        collection["last_wallet_tx_id"] = wallet_tx_id
        metadata["payer_user_id"] = payer_user_id

        invoice.status = "paid"
        invoice.paid_at = timezone.now()
        invoice.metadata = metadata
        invoice.collection_attempt_count = collection["attempt_count"]
        invoice.save(update_fields=["status", "paid_at", "metadata", "collection_attempt_count", "updated_at"])

        ws_payload = {
            "invoice_id": str(invoice.id),
            "invoice_no": invoice.invoice_no,
            "total_amount": str(invoice.total_amount),
        }
        organization_id = invoice.organization_id
        transaction.on_commit(lambda: publish_billing_event(
            organization_id, "invoice_collection_succeeded", ws_payload,
        ))

        return invoice

    @classmethod
    def _find_existing_invoice_charge(cls, invoice: BillingInvoice):
        """Return an existing wallet charge for this invoice, if any.

        This is an application-level idempotency guard for the narrow crash window
        where wallet consumption succeeded but invoice status was not persisted.
        """
        amount = cls._to_decimal(invoice.total_amount)
        if not invoice.organization_id or amount <= 0:
            return None
        return (
            WalletTransaction.objects
            .filter(
                transaction_type="consume",
                related_order_id=str(invoice.id),
                organization_id=invoice.organization_id,
                amount_precise=-amount,
            )
            .order_by("-created_at")
            .first()
        )

    @classmethod
    def collect_invoice(
        cls,
        invoice_id: str,
        *,
        force: bool = False,
    ) -> Dict:
        if not getattr(settings, "BILLING_INVOICE_COLLECTION_ENABLED", False):
            try:
                invoice = BillingInvoice.objects.get(id=invoice_id)
                invoice_no = invoice.invoice_no
                status = invoice.status
            except BillingInvoice.DoesNotExist:
                raise
            logger.warning(
                "[Billing] invoice collection disabled in statement mode: "
                "invoice=%s force=%s",
                invoice_id, force,
            )
            billing_charges_total.labels(result="collection_disabled").inc()
            return {
                "invoice_id": str(invoice_id),
                "invoice_no": invoice_no,
                "status": status,
                "result": "disabled",
                "disabled": True,
                "reason": "statement_mode",
                "charged_amount": str(cls._to_decimal(0)),
            }

        # R9: 在 MySQL 事务外解析 payer_user_id（可能查询 PostgreSQL 的 Organization 表），
        # 避免跨库查询在 select_for_update 行锁持有期间执行：
        # PG 慢则 MySQL 行锁等待延长，PG 故障不应导致扣款事务回滚。
        try:
            _preview = BillingInvoice.objects.get(id=invoice_id)
            payer_user_id = cls._resolve_payer_user_id(_preview)
        except BillingInvoice.DoesNotExist:
            raise
        except Exception as exc:
            logger.warning(
                "[Billing] 事务前 payer 解析失败（使用空字符串 fallback）: "
                "invoice=%s err=%s",
                invoice_id, exc,
            )
            payer_user_id = ""

        return cls._collect_invoice_in_transaction(
            invoice_id, force=force, payer_user_id=payer_user_id,
        )

    @classmethod
    @transaction.atomic
    def _collect_invoice_in_transaction(
        cls,
        invoice_id: str,
        *,
        force: bool = False,
        payer_user_id: str = "",
    ) -> Dict:
        invoice = BillingInvoice.objects.select_for_update().get(id=invoice_id)
        amount = cls._to_decimal(invoice.total_amount)

        if invoice.status == "paid":
            return {
                "invoice_id": str(invoice.id),
                "invoice_no": invoice.invoice_no,
                "status": invoice.status,
                "result": "already_paid",
                "charged_amount": str(cls._to_decimal(0)),
            }
        if invoice.status == "failed" and not force:
            return {
                "invoice_id": str(invoice.id),
                "invoice_no": invoice.invoice_no,
                "status": invoice.status,
                "result": "skipped_max_attempts",
                "charged_amount": str(cls._to_decimal(0)),
            }
        if invoice.status != "open" and not force:
            return {
                "invoice_id": str(invoice.id),
                "invoice_no": invoice.invoice_no,
                "status": invoice.status,
                "result": "skipped_status",
                "charged_amount": str(cls._to_decimal(0)),
            }
        if amount <= 0:
            invoice.status = "paid"
            invoice.paid_at = timezone.now()
            invoice.save(update_fields=["status", "paid_at", "updated_at"])
            return {
                "invoice_id": str(invoice.id),
                "invoice_no": invoice.invoice_no,
                "status": invoice.status,
                "result": "zero_amount_paid",
                "charged_amount": str(cls._to_decimal(0)),
            }

        existing_tx = cls._find_existing_invoice_charge(invoice)
        if existing_tx is not None:
            logger.warning(
                "[Billing] 账单已存在扣款流水，跳过重复扣款并补齐 paid 状态: "
                "invoice=%s invoice_no=%s organization=%s tx=%s",
                invoice.id, invoice.invoice_no, invoice.organization_id, existing_tx.id,
            )
            invoice = cls._mark_collection_succeeded(
                invoice,
                payer_user_id=payer_user_id or "",
                wallet_tx_id=str(existing_tx.id),
            )
            billing_charges_total.labels(result="already_charged").inc()
            return {
                "invoice_id": str(invoice.id),
                "invoice_no": invoice.invoice_no,
                "status": invoice.status,
                "result": "already_charged",
                "charged_amount": str(cls._to_decimal(0)),
                "payer_source": "organization_wallet",
                "wallet_tx_id": str(existing_tx.id),
                "payer_user_id": payer_user_id or "",
            }

        organization_id = invoice.organization_id
        tx = None
        payer_source = ""

        # 仅从 OrganizationWallet 扣款；失败则标记催收失败。
        collection_failure: tuple[str, str, str, str] | None = None
        if organization_id:
            try:
                from apps.users.wallet.models import OrganizationWallet as OrganizationWalletModel

                ws_wallet = OrganizationWalletModel.objects.filter(organization_id=organization_id).first()
                if ws_wallet and ws_wallet.get_available_credits_precise() >= amount:
                    ws_wallet_service = OrganizationWalletService()
                    tx = ws_wallet_service.consume(
                        organization_id=organization_id,
                        credits_amount=amount,
                        description=f"账单自动扣款：{invoice.invoice_no}",
                        related_order_id=str(invoice.id),
                    )
                    payer_source = "organization_wallet"
                    logger.info(
                        "[Billing] 账单 OrganizationWallet 扣款成功: "
                        "invoice=%s invoice_no=%s organization=%s amount=%s tx=%s",
                        invoice.id, invoice.invoice_no, organization_id, amount, tx.id,
                    )
                elif ws_wallet is None:
                    logger.info(
                        "OrganizationWallet 不存在: invoice=%s organization=%s",
                        invoice.id, organization_id,
                    )
                    collection_failure = (
                        "failed_no_wallet",
                        "failed_no_wallet",
                        _("billing.insufficient_credits_deduct"),
                        "no_wallet",
                    )
                else:
                    logger.info(
                        "OrganizationWallet 余额不足: invoice=%s organization=%s",
                        invoice.id, organization_id,
                    )
                    collection_failure = (
                        "failed_insufficient_credits",
                        "failed_insufficient_credits",
                        _("billing.insufficient_credits_deduct"),
                        "insufficient_credits",
                    )
            except InsufficientCreditsError:
                logger.info(
                    "OrganizationWallet 扣款失败（余额不足）: invoice=%s organization=%s",
                    invoice.id, organization_id,
                )
                collection_failure = (
                    "failed_insufficient_credits",
                    "failed_insufficient_credits",
                    _("billing.insufficient_credits_deduct"),
                    "insufficient_credits",
                )
            except (WalletException, DatabaseError, ValueError) as exc:
                logger.warning(
                    "OrganizationWallet 扣款失败: invoice=%s err=%s",
                    invoice.id, exc,
                )
                collection_failure = (
                    "failed_exception",
                    "failed_exception",
                    _("billing.charge_error_contact"),
                    "wallet_exception",
                )
            except Exception as exc:
                logger.critical(
                    "OrganizationWallet 扣款失败（未预期异常）: invoice=%s err=%s",
                    invoice.id, exc, exc_info=True,
                )
                collection_failure = (
                    "failed_unexpected",
                    "failed_unexpected",
                    _("billing.charge_error_contact"),
                    "unexpected_error",
                )

        if collection_failure:
            result_key, metric_label, err_msg, err_code = collection_failure
            billing_charges_total.labels(result=metric_label).inc()
            cls._mark_collection_failed(
                invoice,
                payer_user_id=payer_user_id or "",
                error_message=err_msg,
                error_code=err_code,
            )
            body: Dict = {
                "invoice_id": str(invoice.id),
                "invoice_no": invoice.invoice_no,
                "status": invoice.status,
                "result": result_key,
                "charged_amount": str(cls._to_decimal(0)),
            }
            if payer_user_id:
                body["payer_user_id"] = payer_user_id
            return body

        if tx is None:
            if not organization_id:
                logger.error(
                    "[Billing] 扣款失败（账单缺少 organization_id）: invoice=%s invoice_no=%s amount=%s",
                    invoice.id, invoice.invoice_no, amount,
                )
                billing_charges_total.labels(result="failed_exception").inc()
                cls._mark_collection_failed(
                    invoice,
                    payer_user_id="",
                    error_message=_("billing.charge_error_contact"),
                    error_code="no_payer_configured",
                )
                return {
                    "invoice_id": str(invoice.id),
                    "invoice_no": invoice.invoice_no,
                    "status": invoice.status,
                    "result": "failed_exception",
                    "charged_amount": str(cls._to_decimal(0)),
                }
            logger.warning(
                "[Billing] OrganizationWallet 余额不足或无钱包，扣款失败: invoice=%s organization=%s amount=%s",
                invoice.id, organization_id, amount,
            )
            billing_charges_total.labels(result="failed_insufficient_credits").inc()
            cls._mark_collection_failed(
                invoice,
                payer_user_id=payer_user_id or "",
                error_message=_("billing.insufficient_credits_deduct"),
                error_code="insufficient_credits",
            )
            ret: Dict = {
                "invoice_id": str(invoice.id),
                "invoice_no": invoice.invoice_no,
                "status": invoice.status,
                "result": "failed_insufficient_credits",
                "charged_amount": str(cls._to_decimal(0)),
            }
            if payer_user_id:
                ret["payer_user_id"] = payer_user_id
            return ret

        # 扣款成功
        invoice = cls._mark_collection_succeeded(
            invoice,
            payer_user_id=payer_user_id,
            wallet_tx_id=str(tx.id),
        )
        logger.info(
            "[Billing] 账单扣款成功: invoice=%s invoice_no=%s organization=%s "
            "amount=%s payer=%s payer_source=%s tx=%s",
            invoice.id, invoice.invoice_no, invoice.organization_id,
            amount, payer_user_id, payer_source, tx.id,
        )
        billing_charges_total.labels(result="paid").inc()
        billing_charge_amount_credits.observe(float(amount))
        return {
            "invoice_id": str(invoice.id),
            "invoice_no": invoice.invoice_no,
            "status": invoice.status,
            "result": "paid",
            "charged_amount": str(amount),
            "wallet_tx_id": str(tx.id),
            "payer_user_id": payer_user_id,
            "payer_source": payer_source,
        }

    @classmethod
    def collect_open_invoices(
        cls,
        *,
        organization_id: str = "",
        limit: int = 100,
    ) -> Dict:
        queryset = BillingInvoice.objects.filter(status="open")
        if organization_id:
            queryset = queryset.filter(organization_id=organization_id)

        effective_limit = max(1, int(limit or 100))
        queryset = queryset.filter(collection_attempt_count__lt=cls.MAX_COLLECTION_ATTEMPTS)

        # 拉取候选后按指数退避冷却过滤，避免短时间内反复扣款 (INV-A13-003)
        candidates = list(
            queryset.order_by("period_start", "created_at")[:effective_limit * 3]
        )
        now = timezone.now()
        invoice_ids: List[str] = []
        for inv in candidates:
            if len(invoice_ids) >= effective_limit:
                break
            if cls._is_collection_cooling_down(inv, now):
                continue
            invoice_ids.append(str(inv.id))

        results: List[Dict] = []
        for invoice_id in invoice_ids:
            try:
                results.append(cls.collect_invoice(invoice_id))
            except (WalletException, DatabaseError, ValueError) as exc:
                logger.error("处理账单扣款失败: invoice=%s err=%s", invoice_id, exc, exc_info=True)
                try:
                    inv = BillingInvoice.objects.filter(id=invoice_id).first()
                    if inv:
                        cls._mark_collection_failed(inv, payer_user_id="", error_message=str(exc)[:200])
                except Exception:
                    pass
                results.append(
                    {
                        "invoice_id": invoice_id,
                        "status": "open",
                        "result": "failed_unhandled",
                    }
                )
            except Exception as exc:
                logger.critical(
                    "处理账单扣款出现未预期异常: invoice=%s err=%s", invoice_id, exc, exc_info=True,
                )
                try:
                    inv = BillingInvoice.objects.filter(id=invoice_id).first()
                    if inv:
                        cls._mark_collection_failed(inv, payer_user_id="", error_message=str(exc)[:200])
                except Exception:
                    pass
                results.append(
                    {
                        "invoice_id": invoice_id,
                        "status": "open",
                        "result": "failed_unhandled",
                    }
                )

        success_results = {"paid", "already_paid", "already_charged", "zero_amount_paid"}
        success_count = len([item for item in results if item.get("result") in success_results])
        failed_count = len(results) - success_count
        return {
            "organization_id": organization_id or "",
            "total": len(results),
            "success": success_count,
            "failed": failed_count,
            "results": results,
        }

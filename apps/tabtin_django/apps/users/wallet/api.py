"""
钱包系统API接口
"""

from ninja import Router, Schema
from ninja.errors import HttpError
from typing import List, Optional
from decimal import Decimal, InvalidOperation
import logging

from django.http import StreamingHttpResponse

from apps.users.auth.permissions import JWTAuth
from apps.i18n import get_text, _
from apps.i18n.response import success_response, error_response_with_status
from apps.services.llm.permissions import ensure_organization_permission

from .schemas import (
    OrganizationWalletInfoResponse,
    CreditPackageResponse,
    TransactionHistoryResponse,
    TransactionResponse,
)
from .models import CreditPackage, WalletTransaction
from .services.organization_wallet_service import OrganizationWalletService
from .services.base_wallet_service import validate_wallet_transaction_time_param
from .exceptions import WalletException

logger = logging.getLogger(__name__)

router = Router()
jwt_auth = JWTAuth()
DISPUTE_OPEN_STATUSES = ("open", "investigating")
DISPUTE_REASON_MAX_LEN = 1000
CASH_RECHARGE_MIN_CNY = Decimal("0.01")
CASH_RECHARGE_MAX_CNY = Decimal("100000.00")
CASH_RECHARGE_OPEN_STATUSES = ("pending", "paying")
CASH_RECHARGE_PAID_STATUSES = ("TRADE_SUCCESS", "TRADE_FINISHED", "SUCCESS")
CASH_RECHARGE_CLOSED_STATUSES = ("TRADE_CLOSED", "CLOSED", "CANCELLED", "CANCELED")


class DisputeCreateIn(Schema):
    transaction_id: str = ""
    reason: str


class CashWalletRechargeIn(Schema):
    amount_cny: str
    payment_method: str = "alipay"
    payment_type: Optional[str] = None
    extra_params: Optional[dict] = None


@router.get("/packages", auth=None, tags=["点券套餐"])
def get_credit_packages(request, active_only: bool = True):
    """
    获取点券套餐列表（公开接口）

    参数：
    - active_only: 仅返回启用的套餐（默认True）
    """
    try:
        queryset = CreditPackage.objects.all()
        if active_only:
            queryset = queryset.filter(is_active=True)

        packages = queryset.order_by('sort_order')

        return success_response(data=[
            CreditPackageResponse(
                id=pkg.id,
                name=pkg.name,
                description=pkg.description,
                price=pkg.price,
                credits_amount=pkg.credits_amount,
                bonus_credits=pkg.bonus_credits,
                total_credits=pkg.total_credits,
                discount_percentage=pkg.get_discount_percentage(),
                sort_order=pkg.sort_order,
                is_active=pkg.is_active
            ).model_dump()
            for pkg in packages
        ])

    except Exception as e:
        logger.error(f"获取点券套餐列表失败: {str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("wallet.packages_fetch_failed"), status_code=500)


@router.post("/recharge", tags=["点券充值"], auth=jwt_auth)
def recharge_credits(
    request,
    package_id: str = None,
    credits_amount: int = None,
    payment_method: str = "alipay",
    payment_type: str = None,
    extra_params: dict = None,
    organization_id: str = None,
):
    """
    购买点券（需要登录）- 创建支付订单

    参数：
    - package_id: 点券套餐ID
    - payment_method: 支付方式（alipay/wechat）
    - payment_type: 支付类型（alipay: page/wap/qr；wechat: native/jsapi/h5）
    - extra_params: 支付额外参数
    """
    try:
        from apps.services.payment.services.factory import PaymentServiceFactory
        from apps.services.payment.models import PaymentOrder
        from django.utils import timezone
        from django.conf import settings
        from datetime import timedelta

        if payment_method not in ('alipay', 'wechat'):
            return error_response_with_status("VALIDATION_ERROR", message=_("payment.unsupported_payment_method"), status_code=400)

        user_id = str(request.auth.id)
        if not organization_id:
            return error_response_with_status("VALIDATION_ERROR", message="点券充值必须绑定组织", status_code=400)
        ensure_organization_permission(request, organization_id, role='owner')

        if package_id:
            try:
                package = CreditPackage.objects.get(id=package_id, is_active=True)
                final_credits_amount = package.total_credits
                amount = package.price
                subject = f'购买点券套餐：{package.name}'
                description = package.description
            except CreditPackage.DoesNotExist:
                return error_response_with_status("NOT_FOUND", message=get_text("wallet.package_not_found"), status_code=404)
        else:
            return error_response_with_status("VALIDATION_ERROR", message="点券充值必须选择套餐", status_code=400)

        expired_at = timezone.now() + timedelta(minutes=settings.ORDER_EXPIRE_MINUTES)

        order = PaymentOrder.objects.create(
            user_id=user_id,
            organization_id=organization_id or '',
            order_type='credits',
            subject=subject,
            description=description,
            amount=amount,
            payment_method=payment_method,
            business_data={
                'package_id': str(package_id) if package_id else None,
                'credits_amount': final_credits_amount,
                'total_credits': final_credits_amount,
                'package_name': package.name,
                'credits_snapshot_source': 'credit_package',
                'organization_id': organization_id,
            },
            status='pending',
            expired_at=expired_at,
        )

        payment_service = PaymentServiceFactory.get_service(payment_method)
        payment_extra_params = dict(extra_params) if isinstance(extra_params, dict) else {}
        if payment_type:
            payment_extra_params["payment_type"] = payment_type

        # WAL-06: create_payment 失败时立即标记失败，避免 pending 订单堆积
        try:
            payment_result = payment_service.create_payment(
                order_no=order.order_no,
                amount=amount,
                subject=subject,
                description=description,
                extra_params=payment_extra_params,
            )
        except Exception as pay_err:
            order.business_data = {
                **(order.business_data or {}),
                "failure_reason": str(pay_err),
            }
            order.status = 'failed'
            order.save(update_fields=['business_data', 'status', 'updated_at'])
            logger.error(
                f"创建支付失败，订单已标记失败: order={order.order_no}, error={pay_err}"
            )
            return error_response_with_status(
                "PAYMENT_ERROR",
                message=get_text("wallet.recharge_failed", detail=str(pay_err)),
                status_code=500,
            )

        order.third_party_order_no = payment_result.get('third_party_order_no', '')
        order.status = 'paying'
        order.save(update_fields=['third_party_order_no', 'status', 'updated_at'])

        logger.info(f"点券充值订单创建成功: 用户={user_id}, 点券={final_credits_amount}, 订单={order.order_no}")

        return success_response(
            data={
                'order_no': order.order_no,
                'order_id': order.id,
                'credits_amount': final_credits_amount,
                'amount': str(amount),
                'pay_url': payment_result.get('pay_url'),
                'qr_code': payment_result.get('qr_code'),
                'form_html': payment_result.get('form_html'),
                'expired_at': order.expired_at.isoformat()
            },
            message=get_text("wallet.order_created"),
        )

    except HttpError:
        raise
    except Exception as e:
        logger.error(f"购买点券失败: {str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("wallet.recharge_failed", detail=str(e)), status_code=500)


# ============ Organization 级钱包接口 ============


@router.get(
    "/organizations/{organization_id}/wallet",
    tags=["组织钱包"],
    auth=jwt_auth,
)
def get_organization_wallet(request, organization_id: str):
    """
    查询组织钱包（需要登录）

    参数：
    - organization_id: 组织ID
    """
    try:
        ensure_organization_permission(request, organization_id, role='viewer')

        service = OrganizationWalletService()
        wallet_info = service.get_wallet_info(organization_id)

        return success_response(data=OrganizationWalletInfoResponse(**wallet_info).model_dump())

    except HttpError:
        raise
    except Exception as e:
        logger.error(f"查询组织钱包失败: organization={organization_id}, error={str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("wallet.info_fetch_failed"), status_code=500)


@router.get(
    "/organizations/{organization_id}/cash-wallet",
    tags=["组织钱包"],
    auth=jwt_auth,
)
def get_organization_cash_wallet(request, organization_id: str):
    """查询组织现金钱包（人民币）。成员可查看余额；在线充值见 POST .../cash-wallet/recharge。"""
    try:
        ensure_organization_permission(request, organization_id, role="viewer")

        from apps.users.wallet.services.organization_cash_wallet_service import (
            OrganizationCashWalletService,
        )

        wallet = OrganizationCashWalletService().get_or_create_wallet(organization_id)
        return success_response(
            data={
                "wallet_id": wallet.id,
                "organization_id": wallet.organization_id,
                "balance_cny": str(wallet.balance_cny),
                "frozen_cny": str(wallet.frozen_cny),
                "available_cny": str(wallet.get_available_cny()),
                "updated_at": wallet.updated_at.isoformat() if wallet.updated_at else None,
            }
        )
    except HttpError:
        raise
    except Exception as e:
        logger.error("查询组织现金钱包失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("wallet.info_fetch_failed"),
            status_code=500,
        )


@router.post(
    "/organizations/{organization_id}/cash-wallet/recharge",
    tags=["组织钱包"],
    auth=jwt_auth,
)
def recharge_organization_cash_wallet(
    request,
    organization_id: str,
    payload: CashWalletRechargeIn,
):
    """组织现金钱包在线充值：创建支付宝 / 微信支付订单，支付成功后入账人民币余额。仅 owner。"""
    try:
        import uuid
        from apps.services.payment.services.factory import PaymentServiceFactory
        from apps.services.payment.models import PaymentOrder
        from apps.services.payment.services.benefit_service import OrderBenefitService
        from apps.tabtinspace.models import Organization
        from django.utils import timezone
        from django.conf import settings
        from django.db import transaction
        from datetime import timedelta

        ensure_organization_permission(request, organization_id, role="owner")

        payment_method = (payload.payment_method or "").strip()
        if payment_method not in ("alipay", "wechat"):
            return error_response_with_status(
                "VALIDATION_ERROR",
                message=_("payment.unsupported_payment_method"),
                status_code=400,
            )

        try:
            amount_raw = Decimal(str(payload.amount_cny))
            if not amount_raw.is_finite():
                raise InvalidOperation("non-finite amount")
            amount = amount_raw.quantize(Decimal("0.01"))
            if amount_raw != amount:
                raise InvalidOperation("too many decimal places")
        except (InvalidOperation, TypeError, ValueError):
            return error_response_with_status(
                "VALIDATION_ERROR",
                message=get_text("wallet.cash_recharge_amount_range"),
                status_code=400,
            )
        if amount < CASH_RECHARGE_MIN_CNY or amount > CASH_RECHARGE_MAX_CNY:
            return error_response_with_status(
                "VALIDATION_ERROR",
                message=get_text("wallet.cash_recharge_amount_range"),
                status_code=400,
            )

        user_id = str(request.auth.id)
        subject = f"现金钱包充值：¥{amount}"
        description = f"组织现金钱包充值 {amount} 元"
        expired_at = timezone.now() + timedelta(minutes=settings.ORDER_EXPIRE_MINUTES)
        operation_token = uuid.uuid4().hex
        payment_extra_params = dict(payload.extra_params) if isinstance(payload.extra_params, dict) else {}
        if payload.payment_type:
            payment_extra_params["payment_type"] = payload.payment_type

        def busy_response():
            return error_response_with_status(
                "EXISTING_RECHARGE_UNCONFIRMED",
                message="存在未确认状态的充值订单，请稍后重试或联系支持处理。",
                status_code=409,
            )

        def enqueue_benefit_compensation(order, err):
            try:
                from apps.services.payment.tasks import grant_order_benefits
                grant_order_benefits.delay(order.id)
            except Exception as queue_exc:
                logger.critical(
                    "[CASH_RECHARGE_GRANT_QUEUE_FAILURE] 现金充值补偿任务投递失败: "
                    "order_id=%s order_no=%s error=%s original_error=%s",
                    order.id,
                    order.order_no,
                    queue_exc,
                    err,
                )
                try:
                    from apps.services.billing.tasks import _dispatch_billing_alert
                    _dispatch_billing_alert(
                        "cash_recharge_grant_queue_failure",
                        "critical",
                        f"现金钱包充值补偿任务投递失败: order_id={order.id} order_no={order.order_no} error={queue_exc}",
                        extra={"order_id": str(order.id), "order_no": order.order_no},
                    )
                except Exception:
                    pass

        def grant_paid_order(order_id: str):
            order = PaymentOrder.objects.get(id=order_id)
            try:
                OrderBenefitService.grant(order.id)
            except Exception as grant_err:
                logger.error(
                    "旧现金充值单已支付但发放失败，提交补偿: order=%s error=%s",
                    order.order_no,
                    grant_err,
                    exc_info=True,
                )
                enqueue_benefit_compensation(order, grant_err)

        order = None
        payment_result = None

        while order is None:
            stale_actions = []
            with transaction.atomic():
                Organization.objects.select_for_update().get(id=organization_id)
                stale_orders = list(
                    PaymentOrder.objects.select_for_update()
                    .filter(
                        organization_id=organization_id,
                        order_type="cash_wallet",
                        status__in=CASH_RECHARGE_OPEN_STATUSES,
                    )
                    .order_by("created_at", "id")
                )

                if stale_orders:
                    now = timezone.now()
                    for stale in stale_orders:
                        business_data = dict(stale.business_data or {})
                        if business_data.get("cash_wallet_payment_creating"):
                            logger.warning(
                                "现金充值订单正在创建第三方支付单，拒绝并发替换: org=%s order=%s",
                                organization_id,
                                stale.order_no,
                            )
                            return busy_response()
                        close_token = business_data.get("cash_wallet_close_token")
                        if close_token and close_token != operation_token:
                            logger.warning(
                                "现金充值旧单正在被其他请求关闭，拒绝并发替换: org=%s order=%s",
                                organization_id,
                                stale.order_no,
                            )
                            return busy_response()
                        business_data["cash_wallet_close_token"] = operation_token
                        stale.business_data = business_data
                        stale.save(update_fields=["business_data", "updated_at"])
                        stale_actions.append({
                            "id": stale.id,
                            "order_no": stale.order_no,
                            "payment_method": stale.payment_method,
                        })
                else:
                    order = PaymentOrder.objects.create(
                        user_id=user_id,
                        organization_id=organization_id,
                        order_type="cash_wallet",
                        subject=subject,
                        description=description,
                        amount=amount,
                        payment_method=payment_method,
                        business_data={
                            "organization_id": organization_id,
                            "amount_cny": str(amount),
                            "cash_wallet_payment_creating": True,
                            "cash_wallet_operation_token": operation_token,
                        },
                        status="pending",
                        expired_at=expired_at,
                    )

            if not stale_actions:
                break

            outcomes = []
            for stale in stale_actions:
                svc = PaymentServiceFactory.get_service(stale["payment_method"])
                close_ok = False
                try:
                    close_ok = bool(svc.cancel_order(stale["order_no"]))
                except Exception as close_err:
                    logger.warning(
                        "关闭旧现金充值第三方订单异常: order=%s error=%s",
                        stale["order_no"],
                        close_err,
                    )
                remote = {}
                if not close_ok:
                    try:
                        remote = svc.query_order(stale["order_no"]) or {}
                    except Exception as query_err:
                        logger.warning(
                            "查询旧现金充值第三方订单异常: order=%s error=%s",
                            stale["order_no"],
                            query_err,
                        )
                outcomes.append({"id": stale["id"], "order_no": stale["order_no"], "close_ok": close_ok, "remote": remote})

            paid_to_grant = []
            with transaction.atomic():
                Organization.objects.select_for_update().get(id=organization_id)
                for outcome in outcomes:
                    stale = PaymentOrder.objects.select_for_update().get(id=outcome["id"])
                    business_data = dict(stale.business_data or {})
                    if business_data.get("cash_wallet_close_token") != operation_token:
                        logger.warning(
                            "现金充值旧单关闭 token 已变化，拒绝继续: org=%s order=%s",
                            organization_id,
                            stale.order_no,
                        )
                        return busy_response()
                    business_data.pop("cash_wallet_close_token", None)

                    if stale.status not in CASH_RECHARGE_OPEN_STATUSES:
                        stale.business_data = business_data
                        stale.save(update_fields=["business_data", "updated_at"])
                        continue

                    remote = outcome["remote"] or {}
                    remote_status = str(remote.get("trade_status") or "").upper()
                    if outcome["close_ok"] or remote_status in CASH_RECHARGE_CLOSED_STATUSES:
                        stale.business_data = business_data
                        stale.status = "cancelled"
                        stale.save(update_fields=["business_data", "status", "updated_at"])
                        logger.info(
                            "新建现金充值前关闭旧未付单: org=%s order=%s close_ok=%s remote_status=%s",
                            organization_id,
                            stale.order_no,
                            outcome["close_ok"],
                            remote_status,
                        )
                        continue

                    if remote_status in CASH_RECHARGE_PAID_STATUSES:
                        stale.business_data = business_data
                        stale.third_party_trade_no = remote.get("third_party_trade_no", "") or stale.third_party_trade_no
                        stale.paid_amount = Decimal(str(remote.get("total_amount") or stale.amount)).quantize(Decimal("0.01"))
                        stale.paid_at = stale.paid_at or timezone.now()
                        stale.status = "paid"
                        stale.save(update_fields=[
                            "business_data",
                            "third_party_trade_no",
                            "paid_amount",
                            "paid_at",
                            "status",
                            "updated_at",
                        ])
                        paid_to_grant.append(stale.id)
                        logger.warning(
                            "旧现金充值单关单失败但第三方已支付，先同步入账: org=%s order=%s",
                            organization_id,
                            stale.order_no,
                        )
                        continue

                    stale.business_data = business_data
                    stale.save(update_fields=["business_data", "updated_at"])
                    logger.error(
                        "旧现金充值单状态未确认，拒绝新建订单: org=%s order=%s close_ok=%s remote_status=%s",
                        organization_id,
                        stale.order_no,
                        outcome["close_ok"],
                        remote_status or "unknown",
                    )
                    return busy_response()

            for order_id in paid_to_grant:
                grant_paid_order(order_id)

        payment_service = PaymentServiceFactory.get_service(payment_method)
        try:
            payment_result = payment_service.create_payment(
                order_no=order.order_no,
                amount=amount,
                subject=subject,
                description=description,
                extra_params=payment_extra_params,
            )
        except Exception as pay_err:
            with transaction.atomic():
                locked = PaymentOrder.objects.select_for_update().get(id=order.id)
                business_data = dict(locked.business_data or {})
                business_data.pop("cash_wallet_payment_creating", None)
                business_data.pop("cash_wallet_operation_token", None)
                business_data["failure_reason"] = str(pay_err)
                locked.business_data = business_data
                locked.status = "failed"
                locked.save(update_fields=["business_data", "status", "updated_at"])
            logger.error(
                "现金钱包充值支付创建失败: order=%s error=%s",
                order.order_no,
                pay_err,
            )
            return error_response_with_status(
                "PAYMENT_ERROR",
                message=get_text("wallet.cash_recharge_failed", detail=str(pay_err)),
                status_code=500,
            )

        with transaction.atomic():
            locked = PaymentOrder.objects.select_for_update().get(id=order.id)
            business_data = dict(locked.business_data or {})
            if (
                locked.status != "pending"
                or business_data.get("cash_wallet_operation_token") != operation_token
                or not business_data.get("cash_wallet_payment_creating")
            ):
                logger.error("现金钱包充值订单状态异常，未能写回支付中: order=%s", locked.order_no)
                return error_response_with_status(
                    "PAYMENT_ERROR",
                    message=get_text("wallet.cash_recharge_failed", detail="订单状态异常"),
                    status_code=500,
                )
            business_data.pop("cash_wallet_payment_creating", None)
            business_data.pop("cash_wallet_operation_token", None)
            locked.business_data = business_data
            locked.third_party_order_no = payment_result.get("third_party_order_no", "")
            locked.status = "paying"
            locked.save(update_fields=["business_data", "third_party_order_no", "status", "updated_at"])
            order = locked

        logger.info(
            "现金钱包充值订单创建成功: org=%s user=%s amount=%s order=%s",
            organization_id,
            user_id,
            amount,
            order.order_no,
        )

        return success_response(
            data={
                "order_no": order.order_no,
                "order_id": order.id,
                "amount": str(amount),
                "pay_url": payment_result.get("pay_url"),
                "qr_code": payment_result.get("qr_code"),
                "form_html": payment_result.get("form_html"),
                "expired_at": order.expired_at.isoformat(),
                "organization_id": organization_id,
            },
            message=get_text("wallet.order_created"),
        )
    except HttpError:
        raise
    except Exception as e:
        logger.error(
            "现金钱包充值失败: organization=%s error=%s",
            organization_id,
            e,
        )
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("wallet.cash_recharge_failed", detail=str(e)),
            status_code=500,
        )


@router.get(
    "/organizations/{organization_id}/cash-transactions",
    tags=["组织钱包"],
    auth=jwt_auth,
)
def get_organization_cash_transactions(
    request,
    organization_id: str,
    transaction_type: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
):
    """查询组织现金钱包流水（人民币，分页，只读）。

    账单中心「现金钱包」子视图数据源。成员（viewer 及以上）可查看。

    参数：
    - transaction_type: 类型过滤（recharge/purchase_credit_package/
      purchase_addon_package/llm_auto_topup/refund/manual_adjust/freeze/unfreeze）
    - limit / offset: 分页（limit 上限 100）
    """
    try:
        ensure_organization_permission(request, organization_id, role="viewer")
        limit = min(max(limit, 1), 100)
        offset = max(offset, 0)

        from apps.users.wallet.services.organization_cash_wallet_service import (
            OrganizationCashWalletService,
        )

        service = OrganizationCashWalletService()
        wallet = service.get_or_create_wallet(organization_id)
        history = service.get_transaction_history(
            organization_id,
            transaction_type=transaction_type,
            limit=limit,
            offset=offset,
        )

        return success_response(
            data={
                "organization_id": organization_id,
                "balance_cny": str(wallet.balance_cny),
                "frozen_cny": str(wallet.frozen_cny),
                "available_cny": str(wallet.get_available_cny()),
                "total": history["total"],
                "transactions": history["transactions"],
            }
        )
    except HttpError:
        raise
    except Exception as e:
        logger.error(
            "查询组织现金钱包流水失败: organization=%s error=%s", organization_id, e
        )
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("wallet.transactions_fetch_failed"),
            status_code=500,
        )


@router.get(
    "/organizations/{organization_id}/transactions",
    tags=["组织钱包"],
    auth=jwt_auth,
)
def get_organization_transactions(
    request,
    organization_id: str,
    transaction_type: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
    search: Optional[str] = None,
    order_by: Optional[str] = None,
):
    """
    查询组织交易记录（需要登录）

    参数：
    - organization_id: 组织ID
    - transaction_type: 交易类型过滤（recharge/consume/grant/expire/refund/freeze/unfreeze）
    - limit: 每页数量
    - offset: 偏移量
    - created_after / created_before: YYYY-MM-DD（按 Django TIME_ZONE 解释）或带时区的 ISO 日期时间（推荐客户端传本地日界 ISO）
    - search: 按说明或流水 id 模糊匹配
    - order_by: 排序字段，白名单：-created_at, created_at, ±amount_precise, ±balance_after_precise
    """
    try:
        ensure_organization_permission(request, organization_id, role='viewer')
        limit = min(limit, 100)
        offset = max(offset, 0)

        try:
            validate_wallet_transaction_time_param(created_after)
            validate_wallet_transaction_time_param(created_before)
        except ValueError:
            return error_response_with_status(
                "INVALID_PARAMS",
                message=get_text("wallet.transactions_time_filter_invalid"),
                status_code=400,
            )

        service = OrganizationWalletService()
        history = service.get_transaction_history(
            organization_id=organization_id,
            transaction_type=transaction_type,
            limit=limit,
            offset=offset,
            created_after=created_after,
            created_before=created_before,
            search=search,
            order_by=order_by,
        )

        return success_response(data=TransactionHistoryResponse(
            total=history['total'],
            transactions=[
                TransactionResponse(**t)
                for t in history['transactions']
            ]
        ).model_dump())

    except HttpError:
        raise
    except Exception as e:
        logger.error(f"查询组织交易记录失败: organization={organization_id}, error={str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("wallet.transactions_fetch_failed"), status_code=500)


@router.get(
    "/organizations/{organization_id}/transactions/export",
    tags=["组织钱包"],
    auth=jwt_auth,
)
def export_organization_transactions(
    request,
    organization_id: str,
    transaction_type: Optional[str] = None,
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
    search: Optional[str] = None,
    order_by: Optional[str] = None,
):
    """
    导出组织交易流水 CSV。

    与交易流水列表共用筛选条件，但**不接受分页参数**：导出当前筛选条件下的全部匹配记录。
    """
    try:
        ensure_organization_permission(request, organization_id, role='viewer')
        try:
            validate_wallet_transaction_time_param(created_after)
            validate_wallet_transaction_time_param(created_before)
        except ValueError:
            return error_response_with_status(
                "INVALID_PARAMS",
                message=get_text("wallet.transactions_time_filter_invalid"),
                status_code=400,
            )

        service = OrganizationWalletService()
        filename = f"wallet_transactions_{organization_id[:8]}.csv"
        response = StreamingHttpResponse(
            service.generate_transaction_csv_rows(
                organization_id,
                transaction_type=transaction_type,
                created_after=created_after,
                created_before=created_before,
                search=search,
                order_by=order_by,
            ),
            content_type="text/csv; charset=utf-8",
        )
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response

    except HttpError:
        raise
    except Exception as e:
        logger.error(f"导出组织交易流水失败: organization={organization_id}, error={str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("wallet.transactions_fetch_failed"), status_code=500)


# ============ W5-4: 用户申诉接口 ============


@router.post(
    "/organizations/{organization_id}/disputes",
    tags=["计费申诉"],
    auth=jwt_auth,
)
def create_dispute(request, organization_id: str, data: DisputeCreateIn):
    """用户发起计费申诉"""
    try:
        from apps.services.llm.permissions import ensure_organization_permission
        ensure_organization_permission(request, organization_id, role='viewer')

        transaction_id = (data.transaction_id or "").strip()
        if not transaction_id:
            return error_response_with_status(
                "VALIDATION_ERROR", message="交易流水不能为空", status_code=400
            )

        reason = (data.reason or "").strip()
        if not reason:
            return error_response_with_status(
                "VALIDATION_ERROR", message="申诉原因不能为空", status_code=400
            )
        if len(reason) > DISPUTE_REASON_MAX_LEN:
            return error_response_with_status(
                "VALIDATION_ERROR",
                message=f"申诉原因不能超过 {DISPUTE_REASON_MAX_LEN} 个字符",
                status_code=400,
            )

        from apps.services.billing.models import BillingDispute
        from django.utils import timezone
        from datetime import timedelta

        wallet_tx = (
            WalletTransaction.objects
            .select_related("organization_wallet")
            .filter(id=transaction_id)
            .first()
        )
        if not wallet_tx or wallet_tx.organization_wallet.organization_id != organization_id:
            return error_response_with_status(
                "NOT_FOUND", message="交易流水不存在", status_code=404
            )

        existing_dispute = (
            BillingDispute.objects
            .filter(
                transaction_id=wallet_tx.id,
                organization_id=organization_id,
                status__in=DISPUTE_OPEN_STATUSES,
            )
            .order_by("-created_at")
            .first()
        )
        if existing_dispute:
            return success_response(data={
                "id": str(existing_dispute.id),
                "status": existing_dispute.status,
                "sla_deadline": existing_dispute.sla_deadline.isoformat() if existing_dispute.sla_deadline else None,
                "existing": True,
            })

        sla_deadline = timezone.now() + timedelta(days=2)

        try:
            from django.db import IntegrityError
            dispute = BillingDispute.objects.create(
                transaction_id=wallet_tx.id,
                organization_id=organization_id,
                user_id=str(request.auth.id),
                reason=reason,
                sla_deadline=sla_deadline,
            )
        except IntegrityError:
            dispute = (
                BillingDispute.objects
                .filter(transaction_id=wallet_tx.id, organization_id=organization_id)
                .order_by("-created_at")
                .first()
            )
            return success_response(data={
                "id": str(dispute.id) if dispute else "",
                "status": dispute.status if dispute else "open",
                "sla_deadline": dispute.sla_deadline.isoformat() if dispute and dispute.sla_deadline else None,
                "existing": True,
            })

        return success_response(data={
            "id": str(dispute.id),
            "status": dispute.status,
            "sla_deadline": sla_deadline.isoformat(),
        })
    except HttpError:
        raise
    except Exception as e:
        logger.error(f"创建申诉失败: {e}")
        return error_response_with_status("INTERNAL_ERROR", message="创建申诉失败", status_code=500)


@router.get(
    "/organizations/{organization_id}/disputes",
    tags=["计费申诉"],
    auth=jwt_auth,
)
def list_disputes(request, organization_id: str, limit: int = 20, offset: int = 0):
    """查询组织的申诉记录"""
    try:
        from apps.services.llm.permissions import ensure_organization_permission
        ensure_organization_permission(request, organization_id, role='viewer')

        from apps.services.billing.models import BillingDispute

        qs = BillingDispute.objects.filter(organization_id=organization_id).order_by("-created_at")
        total = qs.count()
        items = []
        for d in qs[offset:offset + min(limit, 100)]:
            items.append({
                "id": str(d.id),
                "transaction_id": d.transaction_id,
                "reason": d.reason,
                "status": d.status,
                "admin_notes": d.admin_notes,
                "sla_deadline": d.sla_deadline.isoformat() if d.sla_deadline else None,
                "resolved_at": d.resolved_at.isoformat() if d.resolved_at else None,
                "created_at": d.created_at.isoformat() if d.created_at else None,
            })

        return success_response(data={"total": total, "disputes": items})
    except HttpError:
        raise
    except Exception as e:
        logger.error(f"查询申诉失败: {e}")
        return error_response_with_status("INTERNAL_ERROR", message="查询申诉失败", status_code=500)

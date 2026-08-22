"""
支付服务API接口
"""

from ninja import Router
from ninja.errors import HttpError
from django.db import transaction
from django.http import HttpResponse
from django.utils import timezone
from django.conf import settings
from datetime import timedelta
from decimal import Decimal
import logging
import json

from apps.users.auth.permissions import JWTAuth, StaffAuth
from apps.i18n import get_text, _
from apps.i18n.response import success_response, error_response_with_status

from .schemas import (
    CreateOrderRequest,
    CreateOrderResponse,
    OrderListItemSchema,
    OrderStatusResponse,
)
from .models import PaymentOrder, RefundRecord
from .services.factory import PaymentServiceFactory
from .callbacks.handler import PaymentCallbackHandler
from .callbacks.refund_handler import RefundCallbackHandler
from .exceptions import PaymentException
from apps.users.membership.exceptions import MembershipLifecycleError
from .ip_whitelist import require_payment_ip_whitelist

logger = logging.getLogger(__name__)

router = Router()

jwt_auth = JWTAuth()


def _mark_user_expired_orders(user_id: str, organization_id: str = "") -> int:
    qs = PaymentOrder.objects.filter(
        user=user_id,
        status__in=["pending", "paying"],
        expired_at__lt=timezone.now(),
    )
    if organization_id:
        qs = qs.filter(organization_id=organization_id)
    return qs.update(status="expired", updated_at=timezone.now())


def _hydrate_billing_addon_business_data(business_data: dict, amount):
    """用服务端 AddonPackage 快照覆盖客户端传入的权益字段。"""
    package_id = business_data.get('addon_package_id')
    if not package_id:
        raise ValueError("addon_package_id_required")

    from apps.services.billing.models import AddonPackage

    pkg = AddonPackage.objects.get(id=package_id, is_active=True)
    if amount != pkg.price:
        raise ValueError("amount_mismatch")
    business_data.update({
        'addon_code': pkg.addon_code,
        'addon_name': pkg.addon_name,
        'quota_key': pkg.quota_key,
        'quota_value': int(pkg.quota_value),
        'period_months': int(pkg.period_months),
    })
    return business_data


@router.post("/create-order", tags=["支付订单"], auth=jwt_auth)
def create_payment_order(request, payload: CreateOrderRequest):
    """
    创建支付订单（需要登录）

    支持：
    - 会员购买（order_type=membership）
    - 点券充值（order_type=credits）
    - 存储套餐（order_type=storage_package）
    - 权益增值包（order_type=billing_addon）
    """
    try:
        ALLOWED_ORDER_TYPES = (
            'membership',
            'credits',
            'storage_package',
            'billing_addon',
        )
        if payload.order_type not in ALLOWED_ORDER_TYPES:
            return error_response_with_status("VALIDATION_ERROR", message=_("payment.unsupported_order_type", type=payload.order_type), status_code=400)

        user_id = str(request.auth.id)
        business_data = dict(payload.business_data or {})
        organization_id = str(business_data.get('organization_id') or '').strip()
        if organization_id:
            from apps.services.common.permissions import ensure_organization_permission
            ensure_organization_permission(request, organization_id, role='owner')

        if payload.order_type == 'membership':
            tier_id = business_data.get('tier_id')
            if not tier_id:
                return error_response_with_status("VALIDATION_ERROR", message=_("payment.membership_tier_required"), status_code=400)
            from apps.users.membership.models import MembershipTier
            from apps.users.membership.services.membership_purchase_guard import (
                classify_and_guard_legacy_purchase,
            )
            try:
                tier = MembershipTier.objects.get(id=tier_id, is_active=True)
                if payload.amount != tier.price:
                    return error_response_with_status("VALIDATION_ERROR", message=_("payment.amount_mismatch"), status_code=400)
                lifecycle_action = classify_and_guard_legacy_purchase(
                    organization_id=organization_id,
                    target_tier=tier,
                    target_billing_cycle=business_data.get("billing_cycle") or "monthly",
                )
                if lifecycle_action:
                    business_data["lifecycle_action"] = lifecycle_action
                    business_data["billing_cycle"] = str(
                        business_data.get("billing_cycle") or "monthly"
                    ).strip().lower()
            except MembershipTier.DoesNotExist:
                return error_response_with_status("NOT_FOUND", message=_("payment.membership_plan_not_found"), status_code=404)
            except MembershipLifecycleError as exc:
                return error_response_with_status(
                    exc.error_code,
                    message=str(exc),
                    status_code=400,
                )
        elif payload.order_type == 'credits':
            if not organization_id:
                return error_response_with_status("VALIDATION_ERROR", message="点券充值订单必须绑定组织", status_code=400)
            package_id = business_data.get('package_id')
            if not package_id:
                return error_response_with_status("VALIDATION_ERROR", message="点券充值订单必须选择套餐", status_code=400)
            from apps.users.wallet.models import CreditPackage
            try:
                pkg = CreditPackage.objects.get(id=package_id, is_active=True)
                if payload.amount != pkg.price:
                    return error_response_with_status("VALIDATION_ERROR", message=_("payment.amount_mismatch"), status_code=400)
                business_data.update({
                    'package_id': str(pkg.id),
                    'organization_id': organization_id,
                    'credits_amount': pkg.total_credits,
                    'total_credits': pkg.total_credits,
                    'package_name': pkg.name,
                    'credits_snapshot_source': 'credit_package',
                })
            except CreditPackage.DoesNotExist:
                return error_response_with_status("NOT_FOUND", message=_("payment.credits_plan_not_found"), status_code=404)
        elif payload.order_type == 'storage_package':
            package_id = business_data.get('storage_package_id')
            if package_id:
                from apps.services.billing.models import StoragePackagePlan
                try:
                    pkg = StoragePackagePlan.objects.get(id=package_id, is_active=True)
                    if payload.amount != pkg.price:
                        return error_response_with_status("VALIDATION_ERROR", message=_("payment.amount_mismatch"), status_code=400)
                    business_data.setdefault('storage_bytes', int(pkg.total_storage_bytes))
                    business_data.setdefault('duration_months', int(pkg.duration_months))
                    business_data.setdefault('package_name', pkg.name)
                except StoragePackagePlan.DoesNotExist:
                    return error_response_with_status("NOT_FOUND", message=_("payment.storage_plan_not_found"), status_code=404)
        elif payload.order_type == 'billing_addon':
            if not organization_id:
                return error_response_with_status("VALIDATION_ERROR", message="增值包订单必须绑定组织", status_code=400)
            from apps.services.billing.models import AddonPackage
            try:
                _hydrate_billing_addon_business_data(business_data, payload.amount)
            except ValueError as exc:
                if str(exc) == "amount_mismatch":
                    return error_response_with_status("VALIDATION_ERROR", message=_("payment.amount_mismatch"), status_code=400)
                return error_response_with_status("VALIDATION_ERROR", message="增值包订单缺少 addon_package_id", status_code=400)
            except AddonPackage.DoesNotExist:
                return error_response_with_status("NOT_FOUND", message="增值包不存在或已下架", status_code=404)
        elif payload.order_type == 'cash_wallet':
            if not organization_id:
                return error_response_with_status(
                    "VALIDATION_ERROR",
                    message="现金钱包充值订单必须绑定组织",
                    status_code=400,
                )
            if payload.amount < Decimal('0.01') or payload.amount > Decimal('100000.00'):
                return error_response_with_status(
                    "VALIDATION_ERROR",
                    message=get_text("wallet.cash_recharge_amount_range"),
                    status_code=400,
                )
            business_data['amount_cny'] = str(payload.amount)

        expired_at = timezone.now() + timedelta(minutes=getattr(settings, "ORDER_EXPIRE_MINUTES", 30))

        order = PaymentOrder.objects.create(
            user_id=user_id,
            organization_id=organization_id,
            order_type=payload.order_type,
            subject=payload.subject,
            description=payload.description,
            amount=payload.amount,
            payment_method=payload.payment_method,
            business_data=business_data,
            status='pending',
            expired_at=expired_at,
        )

        payment_service = PaymentServiceFactory.get_service(payload.payment_method)

        try:
            payment_result = payment_service.create_payment(
                order_no=order.order_no,
                amount=payload.amount,
                subject=payload.subject,
                description=payload.description,
                extra_params=payload.extra_params
            )
        except Exception as pay_err:
            order.business_data = {
                **(order.business_data or {}),
                "failure_reason": str(pay_err),
            }
            order.status = 'failed'
            order.save(update_fields=['business_data', 'status', 'updated_at'])
            raise

        order.third_party_order_no = payment_result.get('third_party_order_no', '')
        order.status = 'paying'
        order.save(update_fields=['third_party_order_no', 'status', 'updated_at'])

        logger.info(f"支付订单创建成功: {order.order_no}, 用户: {user_id}, 支付方式: {payload.payment_method}")

        return success_response(
            data={
                'order_no': order.order_no,
                'order_id': str(order.id),
                'pay_url': payment_result.get('pay_url'),
                'qr_code': payment_result.get('qr_code'),
                'form_html': payment_result.get('form_html'),
                'expired_at': order.expired_at.isoformat() if order.expired_at else None,
                **(
                    {"action": business_data["lifecycle_action"]}
                    if business_data.get("lifecycle_action")
                    else {}
                ),
            },
            message=get_text("payment.order_created"),
        )

    except HttpError:
        raise
    except PaymentException as e:
        logger.error(f"创建支付订单失败: {str(e)}")
        return error_response_with_status("VALIDATION_ERROR", message=get_text("payment.order_create_failed", detail=str(e)), status_code=400)
    except Exception as e:
        logger.error(f"创建支付订单失败: {str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("payment.order_create_failed", detail=str(e)), status_code=500)


@router.get("/query-order", tags=["订单查询"], auth=jwt_auth)
def query_payment_order(request, order_no: str):
    """
    查询订单状态（需要登录，只能查询自己的订单）

    XM-12: 当订单处于 paying 状态且未过期时，主动查询第三方支付平台，
    防止回调延迟导致"用户已付款但无权益"的资损场景。

    参数：
    - order_no: 订单号
    """
    try:
        user_id = str(request.auth.id)
        order = PaymentOrder.objects.get(order_no=order_no, user=user_id)

        if order.status == 'paying' and not order.is_expired():
            order = _try_sync_provider_status(order)
        elif order.status in ('pending', 'paying') and order.is_expired():
            order.status = 'expired'
            order.save(update_fields=['status', 'updated_at'])

        return success_response(data=OrderStatusResponse(
            order_no=order.order_no,
            status=order.status,
            order_type=order.order_type,
            subject=order.subject,
            amount=order.amount,
            paid_amount=order.paid_amount,
            payment_method=order.payment_method,
            created_at=order.created_at,
            paid_at=order.paid_at,
            expired_at=order.expired_at,
            status_reason=(order.business_data or {}).get("failure_reason"),
        ).model_dump())

    except PaymentOrder.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("payment.order_not_found"), status_code=404)
    except Exception as e:
        logger.error(f"查询订单失败: {str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("payment.order_query_failed"), status_code=500)


def _try_sync_provider_status(order: PaymentOrder) -> PaymentOrder:
    """XM-12: 主动查询第三方支付平台状态，防止回调延迟导致资损。

    复用 tasks._sync_order_with_provider 的共享逻辑。
    """
    from .tasks import _sync_order_with_provider
    return _sync_order_with_provider(order)


@router.post("/cancel-order", tags=["取消订单"], auth=jwt_auth)
def cancel_payment_order(request, order_no: str):
    """
    取消订单（需要登录，只能取消自己的订单）

    参数：
    - order_no: 订单号
    """
    try:
        user_id = str(request.auth.id)

        with transaction.atomic():
            try:
                order = PaymentOrder.objects.select_for_update().get(
                    order_no=order_no, user=user_id
                )
            except PaymentOrder.DoesNotExist:
                return error_response_with_status(
                    "NOT_FOUND",
                    message=get_text("payment.order_not_found"),
                    status_code=404,
                )

            if not order.can_cancel():
                return error_response_with_status(
                    "VALIDATION_ERROR",
                    message=get_text("payment.order_cancel_not_allowed"),
                    status_code=400,
                )

            payment_service = PaymentServiceFactory.get_service(order.payment_method)
            close_ok = False
            try:
                close_ok = payment_service.cancel_order(order.order_no)
            except Exception as e:
                logger.warning(f"第三方关单异常: {order.order_no}, {e}")

            if not close_ok:
                try:
                    remote = payment_service.query_order(order.order_no)
                    remote_status = remote.get('trade_status', '')
                    if remote_status in ('TRADE_SUCCESS', 'TRADE_FINISHED', 'SUCCESS'):
                        logger.error(
                            f"关单失败且第三方已支付，拒绝本地取消: {order.order_no}"
                        )
                        return error_response_with_status(
                            "VALIDATION_ERROR",
                            message=get_text("payment.order_already_paid_cannot_cancel"),
                            status_code=400,
                        )
                except Exception as qe:
                    logger.warning(f"查询第三方订单状态失败: {order.order_no}, {qe}")

            order.status = 'cancelled'
            order.save(update_fields=['status', 'updated_at'])

        logger.info(f"订单取消成功: {order.order_no}, 用户: {user_id}")
        return success_response(
            data={'order_no': order.order_no},
            message=get_text("payment.order_cancel_success"),
        )

    except HttpError:
        raise
    except Exception as e:
        logger.error(f"取消订单失败: {str(e)}")
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("payment.order_cancel_failed"),
            status_code=500,
        )


@router.get("/my-orders", tags=["订单列表"], auth=jwt_auth)
def list_my_orders(
    request,
    organization_id: str = None,
    order_type: str = None,
    status: str = None,
    limit: int = 20,
    offset: int = 0,
):
    """
    查询当前用户的订单列表（需要登录）

    支持按 organization_id / order_type / status 筛选，分页通过 limit + offset 控制。
    返回格式与前端 PaymentOrderList 对齐：{ items: [...], total: N }。
    """
    try:
        user_id = str(request.auth.id)

        # 当指定了 organization_id 筛选时，校验当前用户是否是该组织的成员。
        # 虽然后续 filter(user=user_id) 保证了不会泄漏其他人的数据，
        # 但非成员传入他人 organization_id 属于越权探测，应直接拒绝。
        if organization_id:
            from apps.services.common.permissions import ensure_organization_permission
            ensure_organization_permission(request, organization_id, role='viewer')

        _mark_user_expired_orders(user_id, organization_id or "")

        qs = PaymentOrder.objects.filter(user=user_id).order_by('-created_at')

        if organization_id:
            qs = qs.filter(organization_id=organization_id)
        if order_type:
            qs = qs.filter(order_type=order_type)
        if status:
            qs = qs.filter(status=status)

        total = qs.count()

        # 防御性边界校正
        safe_limit = max(1, min(limit, 100))
        safe_offset = max(0, offset)
        orders = qs[safe_offset:safe_offset + safe_limit]

        items = [
            OrderListItemSchema(
                id=str(o.id),
                order_no=o.order_no,
                order_type=o.order_type,
                subject=o.subject,
                amount=o.amount,
                status=o.status,
                payment_method=o.payment_method,
                created_at=o.created_at,
                paid_at=o.paid_at,
                expired_at=o.expired_at,
                status_reason=(o.business_data or {}).get("failure_reason"),
            ).model_dump()
            for o in orders
        ]

        return success_response(data={"items": items, "total": total})

    except HttpError:
        raise
    except Exception as e:
        logger.error(f"查询订单列表失败: {e}")
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("payment.order_query_failed"),
            status_code=500,
        )


# ── 团队资金流水（付款 + 退款混排）─────────────────────────────
# 账单中心「资金流水列表」数据源：把 PaymentOrder（付款）与 RefundRecord（退款）
# 归一化成统一「流水项」，按发生时间倒序混排。团队维度取数（不按下单人），
# 规避 owner 转让后丢历史订单的问题。
# 详见 docs/agent/billing-center/funds-flow-list-plan.md。

# 单次全量返回的硬上限（安全阀）：正常团队订单量远小于此，一次拉完；
# 异常团队（高频 / 刷单）截断到最近 N 条，避免接口被拖挂。
ORGANIZATION_TRANSACTIONS_CAP = 500

# 付款原始状态 → 账单中心归一化状态
_PAYMENT_STATUS_NORMALIZE = {
    "pending": "pending",
    "paying": "pending",
    "paid": "paid",
    "completed": "paid",
    "failed": "payment_failed",
    "cancelled": "closed",
    "expired": "closed",
    "refunded": "refunded",
    "partially_refunded": "partially_refunded",
}

# 退款原始状态 → 账单中心归一化状态
_REFUND_STATUS_NORMALIZE = {
    "pending": "refunding",
    "refunding": "refunding",
    "refunded": "refunded",
    "refund_failed": "refund_failed",
}


def _serialize_payment_transaction(order: PaymentOrder) -> dict:
    """把一笔支付订单序列化成统一「流水项」（付款方向）。"""
    occurred_at = order.paid_at or order.created_at
    user = getattr(order, "user", None)
    user_id = str(getattr(user, "id", "") or getattr(order, "user_id", "") or "")
    user_display = ""
    if user is not None:
        user_display = (
            getattr(user, "nickname", None)
            or getattr(user, "username", None)
            or getattr(user, "phone", None)
            or ""
        )
    return {
        "kind": "payment",
        "id": str(order.id),
        "no": order.order_no,
        "order_type": order.order_type,
        "summary": order.subject,
        "amount": str(order.amount),
        "payment_method": order.payment_method,
        "status": _PAYMENT_STATUS_NORMALIZE.get(order.status, order.status),
        "raw_status": order.status,
        "occurred_at": occurred_at.isoformat() if occurred_at else None,
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "paid_at": order.paid_at.isoformat() if order.paid_at else None,
        "third_party_no": order.third_party_trade_no or order.third_party_order_no or "",
        "related_order_no": "",
        "reason": "",
        "failure_reason": (order.business_data or {}).get("failure_reason", ""),
        "business_data": order.business_data or {},
        "user_id": user_id,
        "user_display_name": str(user_display or ""),
    }


def _serialize_refund_transaction(refund: RefundRecord) -> dict:
    """把一条退款记录序列化成统一「流水项」（退款方向）。

    退款行的「原订单类型 / 标题 / 订单号」顺 payment_order 外键取得；
    前端按 kind=refund 给摘要加「退款 · 」前缀并展示负号金额。
    """
    order = refund.payment_order
    occurred_at = refund.refunded_at or refund.created_at
    user = getattr(order, "user", None) if order else None
    user_id = str(getattr(user, "id", "") or getattr(order, "user_id", "") or "") if order else ""
    user_display = ""
    if user is not None:
        user_display = (
            getattr(user, "nickname", None)
            or getattr(user, "username", None)
            or getattr(user, "phone", None)
            or ""
        )
    return {
        "kind": "refund",
        "id": str(refund.id),
        "no": refund.refund_no,
        "order_type": order.order_type if order else "",
        "summary": order.subject if order else "",
        "amount": str(refund.refund_amount),
        "payment_method": refund.payment_method,
        "status": _REFUND_STATUS_NORMALIZE.get(refund.refund_status, refund.refund_status),
        "raw_status": refund.refund_status,
        "occurred_at": occurred_at.isoformat() if occurred_at else None,
        "created_at": refund.created_at.isoformat() if refund.created_at else None,
        "refunded_at": refund.refunded_at.isoformat() if refund.refunded_at else None,
        "third_party_no": refund.third_party_refund_no or "",
        "related_order_no": order.order_no if order else "",
        "reason": refund.reason or "",
        "failure_reason": refund.failure_reason or "",
        "business_data": {},
        "user_id": user_id,
        "user_display_name": str(user_display or ""),
        "operator_user_id": getattr(refund, "operator_user_id", "") or "",
    }


def build_organization_payment_transactions(organization_id: str) -> dict:
    """构建账单中心资金流水（付款+退款混排），用户侧与 Admin staff 共用。"""
    PaymentOrder.objects.filter(
        organization_id=organization_id,
        status__in=["pending", "paying"],
        expired_at__lt=timezone.now(),
    ).update(status="expired", updated_at=timezone.now())

    payment_qs = PaymentOrder.objects.filter(organization_id=organization_id).select_related("user")
    refund_qs = (
        RefundRecord.objects
        .filter(payment_order__organization_id=organization_id)
        .select_related("payment_order", "payment_order__user")
    )

    cap = ORGANIZATION_TRANSACTIONS_CAP
    payment_total = payment_qs.count()
    refund_total = refund_qs.count()

    payments = list(payment_qs.order_by("-created_at")[:cap])
    refunds = list(refund_qs.order_by("-created_at")[:cap])

    combined = [
        ((o.paid_at or o.created_at), _serialize_payment_transaction(o))
        for o in payments
    ] + [
        ((r.refunded_at or r.created_at), _serialize_refund_transaction(r))
        for r in refunds
    ]
    combined.sort(key=lambda pair: pair[0], reverse=True)

    items = [item for _, item in combined[:cap]]
    truncated = payment_total > cap or refund_total > cap or len(combined) > cap

    return {
        "organization_id": organization_id,
        "items": items,
        "total": len(items),
        "truncated": truncated,
    }


@router.get("/organizations/{organization_id}/transactions", tags=["资金流水"], auth=jwt_auth)
def list_organization_transactions(request, organization_id: str):
    """
    团队资金流水（付款 + 退款混排，按发生时间倒序）。

    账单中心「资金流水列表」数据源。团队成员（viewer 及以上）可读；
    「仅 owner 可见」由前端菜单 gating 控制，接口不硬编码角色。
    全量返回、不分页，受 ORGANIZATION_TRANSACTIONS_CAP 安全阀保护。
    """
    try:
        from apps.services.common.permissions import ensure_organization_permission
        ensure_organization_permission(request, organization_id, role='viewer')
        return success_response(data=build_organization_payment_transactions(organization_id))
    except HttpError:
        raise
    except Exception as e:
        logger.error(f"查询团队资金流水失败: {e}")
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("payment.order_query_failed"),
            status_code=500,
        )


@router.get(
    "/admin/organizations/{organization_id}/transactions",
    tags=["Admin 资金流水"],
    auth=StaffAuth(),
)
def admin_list_organization_transactions(request, organization_id: str):
    """Staff 只读：对齐 Electron 账单中心「资金流水」。"""
    try:
        normalized = (organization_id or "").strip()
        if not normalized:
            raise HttpError(400, "organization_id required")
        return success_response(data=build_organization_payment_transactions(normalized))
    except HttpError:
        raise
    except Exception as e:
        logger.error(f"Admin 查询团队资金流水失败: {e}")
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("payment.order_query_failed"),
            status_code=500,
        )


@router.post("/callback/alipay", auth=None, tags=["支付回调"])
@require_payment_ip_whitelist("alipay")
def alipay_callback(request):
    """
    支付宝支付回调

    注意：此接口由支付宝服务器调用

    PAY-24: 已在应用层添加 IP 白名单校验（ip_whitelist.py），
    仍建议在 Nginx/网关层配置 IP 白名单 + 速率限制作为额外防护层。
    支付宝官方出口 IP 段https://opendocs.alipay.com/support/01rg6h
    """
    try:
        callback_data = dict(request.POST.items())

        logger.info(f"收到支付宝回调: {callback_data.get('out_trade_no')}")

        handler = PaymentCallbackHandler('alipay')
        result = handler.handle_callback(callback_data)

        return HttpResponse("success")

    except Exception as e:
        logger.error(f"支付宝回调处理失败: {str(e)}")
        return HttpResponse("fail")


@router.post("/callback/wechat", auth=None, tags=["支付回调"])
@require_payment_ip_whitelist("wechat")
def wechat_callback(request):
    """
    微信支付回调

    注意：此接口由微信服务器调用

    PAY-24: 已在应用层添加 IP 白名单校验（ip_whitelist.py），
    仍建议在 Nginx/网关层配置 IP 白名单 + 速率限制作为额外防护层。
    微信支付官方出口 IP https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay2_0.shtml
    """
    try:
        raw_body = request.body.decode('utf-8')
        callback_data = {
            "headers": {
                "Wechatpay-Timestamp": request.headers.get("Wechatpay-Timestamp"),
                "Wechatpay-Nonce": request.headers.get("Wechatpay-Nonce"),
                "Wechatpay-Signature": request.headers.get("Wechatpay-Signature"),
                "Wechatpay-Serial": request.headers.get("Wechatpay-Serial"),
            },
            "body": raw_body,
        }

        logger.info("收到微信回调: serial=%s", request.headers.get("Wechatpay-Serial", "N/A"))

        handler = PaymentCallbackHandler('wechat')
        result = handler.handle_callback(callback_data)

        # handler 返回 {status, order, parsed_data}，order_no 与 transaction_id 需从子结构提取
        _order = result.get("order") if isinstance(result, dict) else None
        _parsed = result.get("parsed_data") if isinstance(result, dict) else {}
        logger.info(
            "微信回调处理完成: order_no=%s transaction_id=%s",
            getattr(_order, "order_no", "N/A") if _order else "N/A",
            (_parsed or {}).get("third_party_trade_no", "N/A"),
        )

        return HttpResponse(
            json.dumps({'code': 'SUCCESS', 'message': '成功'}),
            content_type='application/json'
        )

    except Exception as e:
        logger.error(f"微信回调处理失败: {str(e)}")
        return HttpResponse(
            json.dumps({'code': 'FAIL', 'message': '失败'}),
            content_type='application/json'
        )


@router.post("/callback/wechat/refund", auth=None, tags=["退款回调"])
@require_payment_ip_whitelist("wechat_refund")
def wechat_refund_callback(request):
    """
    微信退款回调

    D10 决策：退款异步回调，验签→解密→更新退款状态。
    此接口由微信服务器调用，无需用户认证。
    PAY-24: 已在应用层添加 IP 白名单校验。
    """
    try:
        raw_body = request.body
        if not raw_body:
            logger.warning("微信退款回调 body 为空")
            return HttpResponse(
                json.dumps({'code': 'FAIL', 'message': 'empty body'}),
                content_type='application/json',
                status=400,
            )
        raw_body = raw_body.decode('utf-8')
        callback_data = {
            "headers": {
                "Wechatpay-Timestamp": request.headers.get("Wechatpay-Timestamp"),
                "Wechatpay-Nonce": request.headers.get("Wechatpay-Nonce"),
                "Wechatpay-Signature": request.headers.get("Wechatpay-Signature"),
                "Wechatpay-Serial": request.headers.get("Wechatpay-Serial"),
            },
            "body": raw_body,
        }

        logger.info(
            "收到微信退款回调: serial=%s",
            request.headers.get("Wechatpay-Serial", "N/A"),
        )

        handler = RefundCallbackHandler('wechat')
        result = handler.handle_callback(callback_data)

        _order = result.get("order") if isinstance(result, dict) else None
        _parsed = result.get("parsed_data") if isinstance(result, dict) else {}
        logger.info(
            "微信退款回调处理完成: order_no=%s refund_no=%s status=%s",
            getattr(_order, "order_no", "N/A") if _order else "N/A",
            (_parsed or {}).get("refund_no", "N/A"),
            (_parsed or {}).get("status", "N/A"),
        )

        return HttpResponse(
            json.dumps({'code': 'SUCCESS', 'message': '成功'}),
            content_type='application/json',
        )

    except Exception as e:
        logger.error("微信退款回调处理失败: %s", e, exc_info=True)
        return HttpResponse(
            json.dumps({'code': 'FAIL', 'message': '失败'}),
            content_type='application/json',
        )

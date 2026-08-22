"""
会员体系API接口
"""

import logging
import uuid
import hashlib
import json
from decimal import Decimal
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.users.auth.permissions import JWTAuth
from apps.services.llm.permissions import ensure_organization_permission
from apps.services.payment.models import PaymentOrder
from apps.i18n import get_text, _
from apps.i18n.response import success_response, error_response_with_status

from .schemas import (
    MembershipTierResponse,
    OrganizationMembershipStatusResponse,
    OrganizationPurchaseRequest,
    OrganizationPurchasePreviewRequest,
    OrganizationUpgradePreviewRequest,
    OrganizationUpgradeOrderRequest,
    OrganizationLifecycleTargetRequest,
    OrganizationLifecycleTargetApplyRequest,
    OrganizationRenewalPreviewRequest,
    OrganizationRenewalOrderRequest,
    MembershipPaymentMethodSwitchRequest,
    CancelScheduledChangeRequest,
    AutoRenewRequest,
)
from .models import MembershipTier, OrganizationMembership, OrganizationMembershipChangeLog
from .services.organization_membership_service import OrganizationMembershipService
from .services.membership_purchase_guard import (
    classify_and_guard_legacy_purchase,
    classify_organization_membership_change,
)
from .services.subscription_pricing_service import (
    SubscriptionPricingError,
    SubscriptionPricingService,
)
from .services.subscription_catalog_service import SubscriptionCatalogService
from .services.subscription_order_service import (
    MembershipUpgradeBalanceError,
    SubscriptionOrderService,
)
from .services.subscription_lifecycle_service import SubscriptionLifecycleService
from .services.membership_payment_service import MembershipPaymentError, MembershipPaymentService
from .exceptions import MembershipException, MembershipLifecycleError
from .constants import ALLOWED_PAYMENT_METHODS

logger = logging.getLogger(__name__)

router = Router()
jwt_auth = JWTAuth()

_TEST_PAYMENT_AMOUNT_PARAM = "test_amount"


@router.get("/orders/{order_id}/payment-options", tags=["组织会员"], auth=jwt_auth)
def membership_payment_options(request, order_id: str):
    organization_id = request.GET.get("organization_id") or request.headers.get("X-Organization-Id")
    if not organization_id:
        organization_id = PaymentOrder.objects.filter(id=order_id, order_type="membership").values_list("organization_id", flat=True).first()
    if not organization_id:
        return error_response_with_status("ORGANIZATION_REQUIRED", message="缺少组织标识", status_code=400)
    try:
        ensure_organization_permission(request, organization_id, role="owner")
        data = MembershipPaymentService().payment_options(organization_id=organization_id, order_id=order_id)
        return success_response(data=data)
    except MembershipPaymentError as exc:
        return error_response_with_status(exc.code, message=str(exc), status_code=404 if exc.code.endswith("NOT_FOUND") else 400, data=exc.data)


@router.post("/organizations/{organization_id}/payment-orders", tags=["组织会员"], auth=jwt_auth)
def create_membership_payment_order(request, organization_id: str, payload: OrganizationPurchasePreviewRequest):
    """只创建冻结报价的会员 PaymentOrder，不调用第三方支付。"""
    try:
        ensure_organization_permission(request, organization_id, role="owner")
        tier = MembershipTier.objects.get(id=payload.tier_id, is_active=True)
        billing_cycle = (payload.billing_cycle or "monthly").strip().lower()
        change_type, _state = classify_organization_membership_change(
            organization_id=organization_id, target_tier=tier, target_billing_cycle=billing_cycle,
        )
        snapshot = {
            "target_tier_id": str(tier.id), "target_tier_name": tier.name,
            "target_tier_level": tier.tier_level, "target_effective_period_price": str(tier.price),
            "billing_cycle": billing_cycle, "currency": "CNY",
        }
        quote_hash = hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        existing = PaymentOrder.objects.filter(
            organization_id=organization_id, order_type="membership", status__in=["pending", "paying"],
            business_data__quote_hash=quote_hash,
        ).order_by("-created_at").first()
        if existing and existing.status == "pending" and existing.is_expired():
            existing.status = "expired"
            existing.save(update_fields=["status", "updated_at"])
            existing = None
        if existing:
            return success_response(data={"order_id": str(existing.id), "amount": str(existing.amount), "currency": "CNY", "expires_at": existing.expired_at.isoformat()})
        order = PaymentOrder.objects.create(
            user_id=str(request.auth.id), organization_id=organization_id, order_type="membership",
            subject=f"购买会员：{tier.name}", description=f"{tier.name} - {billing_cycle}",
            amount=Decimal(str(tier.price)), payment_method="organization_wallet", status="pending",
            expired_at=timezone.now() + timedelta(minutes=settings.ORDER_EXPIRE_MINUTES),
            business_data={"tier_id": str(tier.id), "organization_id": organization_id, "change_type": change_type or "new", "billing_cycle": billing_cycle, "pricing_snapshot": snapshot, "quote_hash": quote_hash},
        )
        return success_response(data={"order_id": str(order.id), "amount": str(order.amount), "currency": "CNY", "expires_at": order.expired_at.isoformat()})
    except MembershipTier.DoesNotExist:
        return error_response_with_status("MEMBERSHIP_TIER_NOT_FOUND", message="套餐不存在", status_code=404)


@router.post("/orders/{order_id}/wallet-pay", tags=["组织会员"], auth=jwt_auth)
def membership_wallet_pay(request, order_id: str):
    organization_id = request.headers.get("X-Organization-Id")
    if not organization_id:
        organization_id = PaymentOrder.objects.filter(id=order_id, order_type="membership").values_list("organization_id", flat=True).first()
    if not organization_id:
        return error_response_with_status("ORGANIZATION_REQUIRED", message="缺少组织标识", status_code=400)
    try:
        ensure_organization_permission(request, organization_id, role="owner")
        data = MembershipPaymentService().pay_with_wallet(user=request.auth, organization_id=organization_id, order_id=order_id)
        return success_response(data=data, message="会员订单支付成功")
    except MembershipPaymentError as exc:
        if exc.code == "ORGANIZATION_BALANCE_INSUFFICIENT":
            status = 402
        elif exc.code.endswith("NOT_FOUND"):
            status = 404
        elif exc.code in {
            "PAYMENT_SWITCH_NOT_ALLOWED",
            "PAYMENT_SWITCH_UNCONFIRMED",
            "PAYMENT_STATUS_CHANGED",
        }:
            status = 409
        else:
            status = 400
        return error_response_with_status(exc.code, message=str(exc), status_code=status, data=exc.data)


def _pay_existing_membership_order(request, order_id: str, payment_method: str):
    """对已创建的 pending PaymentOrder 发起第三方支付，不重新创建订单。"""
    try:
        with transaction.atomic():
            order = PaymentOrder.objects.select_for_update().filter(
                id=str(order_id), order_type="membership"
            ).first()
            if not order:
                return error_response_with_status("MEMBERSHIP_ORDER_NOT_FOUND", message="会员订单不存在", status_code=404)
            ensure_organization_permission(request, str(order.organization_id), role="owner")
            if order.payment_method == "organization_wallet" and order.status == "paid":
                return error_response_with_status("PAYMENT_METHOD_CONFLICT", message="订单已使用组织余额支付", status_code=409)
            business_data = dict(order.business_data or {})
            existing = business_data.get("third_party_payment")
            if order.status == "pending" and order.is_expired():
                order.status = "expired"
                order.save(update_fields=["status", "updated_at"])
                change_log_id = business_data.get("change_log_id")
                if change_log_id:
                    OrganizationMembershipChangeLog.objects.filter(
                        id=change_log_id,
                        status=OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                    ).update(
                        status=OrganizationMembershipChangeLog.Status.CANCELLED,
                        reason="upgrade_order_expired",
                        updated_at=timezone.now(),
                    )
                return error_response_with_status(
                    "MEMBERSHIP_ORDER_EXPIRED",
                    message="订单已过期，请重新创建订单",
                    status_code=400,
                )
            if existing and order.payment_method == payment_method and order.status in {"pending", "paying"}:
                return success_response(data=existing)
            if order.status == "paying" and order.payment_method != payment_method:
                channel = "支付宝" if order.payment_method == "alipay" else "微信"
                return error_response_with_status(
                    "PAYMENT_METHOD_LOCKED",
                    message=f"订单已发起{channel}扫码支付，请继续使用原支付方式",
                    status_code=409,
                )
            if order.status != "pending":
                return error_response_with_status("MEMBERSHIP_ORDER_STATUS_INVALID", message="订单状态不允许支付", status_code=400)
            from apps.services.payment.services.factory import PaymentServiceFactory
            result = PaymentServiceFactory.get_service(payment_method).create_payment(
                order_no=order.order_no,
                amount=order.amount,
                subject=order.subject,
                description=order.description,
                # 会员购买统一使用桌面端扫码支付，不跳转网页支付页。
                extra_params={"payment_type": "qr" if payment_method == "alipay" else "native"},
            )
            data = {
                "order_id": str(order.id), "order_no": order.order_no,
                "payment_method": payment_method, "amount": str(order.amount),
                "pay_url": result.get("pay_url"), "qr_code": result.get("qr_code"),
                "form_html": result.get("form_html"), "expired_at": order.expired_at.isoformat() if order.expired_at else None,
            }
            order.payment_method = payment_method
            order.third_party_order_no = result.get("third_party_order_no", "")
            order.status = "paying"
            order.business_data = {
                **business_data,
                "payment_source": {"method": payment_method, "channel": "third_party"},
                "third_party_payment": data,
            }
            order.save(update_fields=["payment_method", "third_party_order_no", "status", "business_data", "updated_at"])
            change_log_id = business_data.get("change_log_id")
            if change_log_id:
                change_log = (
                    OrganizationMembershipChangeLog.objects
                    .select_for_update()
                    .filter(id=change_log_id)
                    .first()
                )
                if change_log:
                    metadata = dict(change_log.metadata or {})
                    metadata["payment_source"] = {
                        "method": payment_method,
                        "channel": "third_party",
                    }
                    change_log.metadata = metadata
                    change_log.save(update_fields=["metadata", "updated_at"])
            return success_response(data=data)
    except Exception as exc:
        logger.exception("基于已有会员订单发起第三方支付失败: order=%s method=%s", order_id, payment_method)
        return error_response_with_status("PAYMENT_CREATE_FAILED", message=str(exc), status_code=400)


@router.post("/orders/{order_id}/alipay-pay", tags=["组织会员"], auth=jwt_auth)
def membership_alipay_pay(request, order_id: str):
    return _pay_existing_membership_order(request, order_id, "alipay")


@router.post("/orders/{order_id}/wechat-pay", tags=["组织会员"], auth=jwt_auth)
def membership_wechat_pay(request, order_id: str):
    return _pay_existing_membership_order(request, order_id, "wechat")


@router.post("/orders/{order_id}/switch-payment-method", tags=["组织会员"], auth=jwt_auth)
def membership_switch_payment_method(
    request,
    order_id: str,
    payload: MembershipPaymentMethodSwitchRequest,
):
    """安全关闭原扫码订单，使用新订单号发起目标渠道支付。"""
    order = PaymentOrder.objects.filter(id=str(order_id), order_type="membership").first()
    if not order:
        return error_response_with_status(
            "MEMBERSHIP_ORDER_NOT_FOUND",
            message="会员订单不存在",
            status_code=404,
        )
    try:
        ensure_organization_permission(request, str(order.organization_id), role="owner")
        replacement = MembershipPaymentService().switch_third_party_method(
            organization_id=str(order.organization_id),
            order_id=str(order.id),
            target_method=payload.payment_method,
        )
        return _pay_existing_membership_order(
            request,
            str(replacement.id),
            payload.payment_method,
        )
    except MembershipPaymentError as exc:
        status_code = 404 if exc.code.endswith("NOT_FOUND") else (
            409 if exc.code in {
                "PAYMENT_SWITCH_NOT_ALLOWED",
                "PAYMENT_SWITCH_UNCONFIRMED",
                "PAYMENT_STATUS_CHANGED",
            } else 400
        )
        return error_response_with_status(
            exc.code,
            message=str(exc),
            status_code=status_code,
            data=exc.data,
        )


@router.get("/tiers", auth=None, tags=["会员等级"])
def get_membership_tiers(request, active_only: bool = True):
    """
    获取会员等级列表（公开接口）

    参数：
    - active_only: 仅返回启用的等级（默认True）
    """
    try:
        queryset = MembershipTier.objects.all()
        if active_only:
            queryset = queryset.filter(is_active=True)

        tiers = queryset.order_by('sort_order')

        return success_response(data=[
            MembershipTierResponse(
                id=tier.id,
                tier_type=tier.tier_type,
                name=tier.name,
                description=tier.description,
                price=tier.price,
                duration_months=tier.duration_months,
                max_tables=tier.max_tables,
                max_documents=getattr(tier, "max_documents", -1),
                max_groups=getattr(tier, "max_groups", -1),
                max_records_per_table=tier.max_records_per_table,
                max_api_calls_per_day=None,  # Legacy, not enforced (D5/QTA-14)
                max_crawl_tasks_per_day=None,  # Legacy, not enforced (D5/QTA-14)
                included_storage_bytes=tier.included_storage_bytes,
                included_llm_credits_monthly=tier.included_llm_credits_monthly,
                max_members=tier.max_members,
                base_seats=tier.base_seats,
                extra_seat_price=tier.extra_seat_price,
                trash_retention_days=tier.trash_retention_days,
                features=tier.features,
                sort_order=tier.sort_order,
                display_order=tier.sort_order,
                tier_level=tier.tier_level,
                is_active=tier.is_active,
            ).model_dump()
            for tier in tiers
        ])

    except Exception as e:
        logger.error(f"获取会员等级列表失败: {str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("membership.tiers_fetch_failed"), status_code=500)


def _create_membership_payment(
    user_id: str,
    tier_id: str,
    payment_method: str,
    organization_id: str,
    billing_cycle: str = "monthly",
    extra_params: dict = None,
) -> dict:
    """
    公共购买逻辑：查找等级 → 创建订单 → 调用支付 → 返回结果
    内部 helper，HttpError 由调用方的 except HttpError: raise 传播到全局 handler。
    organization_id 必填（组织会员购买）。
    """
    from apps.services.payment.services.factory import PaymentServiceFactory
    from apps.services.payment.models import PaymentOrder
    from django.core.cache import cache
    from django.conf import settings
    from datetime import timedelta

    try:
        tier = MembershipTier.objects.get(id=tier_id, is_active=True)
    except MembershipTier.DoesNotExist:
        raise HttpError(404, get_text("membership.tier_not_found"))

    lifecycle_action = classify_and_guard_legacy_purchase(
        organization_id=organization_id,
        target_tier=tier,
        target_billing_cycle=billing_cycle,
    )

    # 与 billing 任务一致：cache（通常为 Redis）分布式锁，防并发创建 + 包裹支付网关调用
    lock_key = f"membership_purchase_lock:{organization_id}"
    lock_ttl = 120
    lock_value = uuid.uuid4().hex
    if not cache.add(lock_key, lock_value, lock_ttl):
        raise HttpError(409, get_text("membership.purchase_lock_held"))

    try:
        expired_at = timezone.now() + timedelta(minutes=settings.ORDER_EXPIRE_MINUTES)

        amount = tier.price
        raw_test_amount = (extra_params or {}).get(_TEST_PAYMENT_AMOUNT_PARAM)
        test_amount_enabled = (
            getattr(settings, 'DEBUG', False) or
            getattr(settings, 'PAYMENT_ALLOW_CLIENT_TEST_AMOUNT', False)
        )
        if raw_test_amount and test_amount_enabled:
            try:
                amount = Decimal(str(raw_test_amount)).quantize(Decimal("0.01"))
            except Exception:
                raise HttpError(400, "测试支付金额格式错误")
            if amount <= 0:
                raise HttpError(400, "测试支付金额必须大于 0")

        business_data = {'tier_id': str(tier.id), 'organization_id': organization_id}
        if lifecycle_action:
            normalized_billing_cycle = str(billing_cycle or "monthly").strip().lower()
            business_data["lifecycle_action"] = lifecycle_action
            business_data["billing_cycle"] = normalized_billing_cycle
        if amount != tier.price:
            business_data['original_amount'] = str(tier.price)
            business_data['test_amount_override'] = str(amount)

        order = PaymentOrder.objects.create(
            user_id=user_id,
            organization_id=organization_id,
            order_type='membership',
            subject=f'购买会员：{tier.name}',
            description=f'{tier.name} - {tier.duration_months}个月',
            amount=amount,
            payment_method=payment_method,
            business_data=business_data,
            status='pending',
            expired_at=expired_at,
        )

        payment_service = PaymentServiceFactory.get_service(payment_method)
        try:
            payment_result = payment_service.create_payment(
                order_no=order.order_no,
                amount=amount,
                subject=f'购买会员：{tier.name}',
                description=f'{tier.name} - {tier.duration_months}个月',
                extra_params=extra_params or {},
            )
        except Exception as pay_err:
            # P1-1：网关下单失败时将本地订单标为 failed，避免长期停留在 pending
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

        return {
            'order_no': order.order_no,
            'order_id': order.id,
            'tier_name': tier.name,
            'amount': str(amount),
            'pay_url': payment_result.get('pay_url'),
            'qr_code': payment_result.get('qr_code'),
            'form_html': payment_result.get('form_html'),
            'expired_at': order.expired_at.isoformat(),
            'organization_id': organization_id,
            **({"action": lifecycle_action} if lifecycle_action else {}),
        }
    finally:
        # compare-and-delete：仅释放自己持有的锁，避免超时后误删其他请求的锁
        if cache.get(lock_key) == lock_value:
            cache.delete(lock_key)


# ============ Organization 级会员接口 ============


@router.get(
    "/organizations/{organization_id}/membership",
    tags=["组织会员"],
    auth=jwt_auth,
)
def get_organization_membership(request, organization_id: str):
    """
    查询组织会员状态（需要登录）

    参数：
    - organization_id: 组织ID
    """
    try:
        ensure_organization_permission(request, organization_id, role='viewer')

        service = OrganizationMembershipService()
        status = service.check_membership_status(organization_id)

        return success_response(data=OrganizationMembershipStatusResponse(**status).model_dump())

    except HttpError:
        raise
    except Exception as e:
        logger.error(f"查询组织会员状态失败: organization={organization_id}, error={str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("membership.status_fetch_failed"), status_code=500)


@router.get(
    "/organizations/{organization_id}/overview",
    tags=["组织会员"],
    auth=jwt_auth,
)
def get_subscription_overview(request, organization_id: str):
    """Electron 订阅中心聚合快照。

    PR3.1 只读接口：不创建订单、不执行套餐变更。
    """
    try:
        ensure_organization_permission(request, organization_id, role='viewer')
        data = SubscriptionCatalogService().get_overview(organization_id)
        return success_response(data=data)
    except HttpError:
        raise
    except Exception as e:
        logger.error("查询订阅中心概览失败: organization=%s, error=%s", organization_id, e)
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("membership.status_fetch_failed"),
            status_code=500,
        )


@router.get(
    "/organizations/{organization_id}/plans",
    tags=["组织会员"],
    auth=jwt_auth,
)
def get_subscription_plans(request, organization_id: str):
    """套餐目录和服务端 action 快照。

    PR3.1 禁止客户端通过 upgrade-preview 循环获取 action。
    """
    try:
        ensure_organization_permission(request, organization_id, role='viewer')
        data = SubscriptionCatalogService().get_plans(organization_id)
        return success_response(data=data)
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("查询订阅套餐目录失败: organization=%s, error=%s", organization_id, e)
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("membership.tiers_fetch_failed"),
            status_code=500,
        )


@router.post(
    "/organizations/{organization_id}/purchase/preview",
    tags=["组织会员"],
    auth=jwt_auth,
)
def preview_membership_purchase(request, organization_id: str, payload: OrganizationPurchasePreviewRequest):
    """
    预览购买影响（降级场景返回剩余天数和价值损失）。

    返回 action: new / renew / upgrade / downgrade / switch。
    降级场景额外返回 impact：剩余天数、损失价值（float）、新旧等级名。
    日均价 = 当前套餐价 / (duration_months * 30)（Decimal 计算后转为 float）。
    """
    try:
        ensure_organization_permission(request, organization_id, role='owner')

        try:
            new_tier = MembershipTier.objects.get(id=payload.tier_id, is_active=True)
        except MembershipTier.DoesNotExist:
            raise HttpError(404, get_text("membership.tier_not_found"))

        action, state = classify_organization_membership_change(
            organization_id=organization_id,
            target_tier=new_tier,
            target_billing_cycle=payload.billing_cycle,
        )
        existing = (
            OrganizationMembership.objects
            .filter(organization_id=organization_id)
            .select_related("tier")
            .first()
        )
        response_data = {
            "action": action,
            "impact": None,
            "current_tier_level": (
                state.effective_tier.tier_level
                if state.has_effective_membership
                else None
            ),
            "target_tier_level": new_tier.tier_level,
            "current_display_order": (
                state.effective_tier.sort_order
                if state.has_effective_membership
                else None
            ),
            "target_display_order": new_tier.sort_order,
        }
        if (
            action == "upgrade"
            and getattr(settings, "MEMBERSHIP_UPGRADE_QUOTE_ENABLED", False)
        ):
            quote_service = SubscriptionPricingService()
            quote = quote_service.calculate_upgrade_quote(
                organization_id=organization_id,
                membership=existing,
                target_tier=new_tier,
                target_billing_cycle=payload.billing_cycle or "monthly",
            )
            quote_token = quote_service.create_quote_token(quote)
            return success_response(
                data=quote.to_preview_data(
                    current_tier=existing.tier,
                    target_tier=new_tier,
                    quote_token=quote_token,
                )
            )
        if action != "downgrade":
            return success_response(data=response_data)

        now = timezone.now()
        remaining_days = max(0, (existing.end_date - now).days) if existing.end_date else 0
        cur = existing.tier
        denom_months = max(int(cur.duration_months or 0), 1)
        period_days = Decimal(str(denom_months * 30))
        daily_value = cur.price / period_days
        lost_dec = (daily_value * Decimal(remaining_days)).quantize(Decimal("0.01"))
        lost_value = float(lost_dec)

        response_data["impact"] = {
            "remaining_days": remaining_days,
            "lost_value": lost_value,
            "current_tier": existing.tier.name,
            "new_tier": new_tier.name,
        }
        return success_response(data=response_data)
    except MembershipLifecycleError as e:
        error_data = None
        if isinstance(e, SubscriptionPricingError) and e.correct_action:
            error_data = {"correct_action": e.correct_action}
        return error_response_with_status(
            e.error_code,
            message=str(e),
            status_code=400,
            data=error_data,
        )
    except HttpError:
        raise
    except Exception as e:
        logger.error("预览会员购买失败: organization=%s, error=%s", organization_id, e)
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("membership.preview_failed"),
            status_code=500,
        )


@router.post(
    "/organizations/{organization_id}/upgrade-preview",
    tags=["组织会员"],
    auth=jwt_auth,
)
def preview_membership_upgrade(
    request,
    organization_id: str,
    payload: OrganizationUpgradePreviewRequest,
):
    """升级报价兼容入口；关闭开关时保持 legacy Preview 返回结构。"""
    return preview_membership_purchase(
        request,
        organization_id,
        OrganizationPurchasePreviewRequest(
            tier_id=payload.target_tier_id,
            billing_cycle=payload.billing_cycle,
        ),
    )


def _normalize_quote_error_code(error_code: str) -> str:
    mapping = {
        "UPGRADE_QUOTE_EXPIRED": "QUOTE_EXPIRED",
        "UPGRADE_QUOTE_INVALID": "QUOTE_INVALID",
        "UPGRADE_QUOTE_STALE": "QUOTE_INVALID",
        "UPGRADE_QUOTE_ORGANIZATION_MISMATCH": "QUOTE_INVALID",
        "UPGRADE_QUOTE_MEMBERSHIP_MISMATCH": "QUOTE_INVALID",
        "UPGRADE_QUOTE_TARGET_TIER_MISMATCH": "QUOTE_INVALID",
        "UPGRADE_QUOTE_BILLING_CYCLE_MISMATCH": "QUOTE_INVALID",
    }
    return mapping.get(error_code, error_code)


@router.post(
    "/organizations/{organization_id}/upgrade",
    tags=["组织会员"],
    auth=jwt_auth,
)
def create_membership_upgrade_order(
    request,
    organization_id: str,
    payload: OrganizationUpgradeOrderRequest,
):
    """创建会员升级订单。

    PR4 仅创建 organization_wallet 支付订单，不调用第三方支付，不修改会员。
    """
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        data = SubscriptionOrderService().create_upgrade_order(
            user=request.auth,
            organization_id=organization_id,
            target_tier_id=payload.target_tier_id,
            billing_cycle=payload.billing_cycle or "monthly",
            quote_token=payload.quote_token,
        )
        return success_response(data=data, message="会员升级订单已创建")
    except SubscriptionPricingError as e:
        return error_response_with_status(
            _normalize_quote_error_code(e.error_code),
            message=str(e),
            status_code=400,
        )
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("创建会员升级订单失败: organization=%s, error=%s", organization_id, e)
        return error_response_with_status(
            "INTERNAL_ERROR",
            message="创建会员升级订单失败",
            status_code=500,
        )


@router.get(
    "/organizations/{organization_id}/upgrade-orders/active",
    tags=["组织会员"],
    auth=jwt_auth,
)
def get_active_membership_upgrade_order(request, organization_id: str):
    """查询当前组织可恢复的活跃会员升级订单。"""
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        data = SubscriptionOrderService().get_active_upgrade_order(
            organization_id=organization_id,
        )
        return success_response(data=data)
    except HttpError:
        raise
    except Exception as e:
        logger.error("查询活跃会员升级订单失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status(
            "INTERNAL_ERROR",
            message="查询活跃会员升级订单失败",
            status_code=500,
        )


@router.get(
    "/organizations/{organization_id}/upgrade-orders/{order_id}",
    tags=["组织会员"],
    auth=jwt_auth,
)
def get_membership_upgrade_order(request, organization_id: str, order_id: str):
    """查询会员升级订单状态。"""
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        data = SubscriptionOrderService().get_upgrade_order(
            organization_id=organization_id,
            order_id=order_id,
        )
        return success_response(data=data)
    except PaymentOrder.DoesNotExist:
        return error_response_with_status(
            "MEMBERSHIP_UPGRADE_ORDER_NOT_FOUND",
            message="会员升级订单不存在",
            status_code=404,
        )
    except HttpError:
        raise
    except Exception as e:
        logger.error("查询会员升级订单失败: organization=%s order=%s error=%s", organization_id, order_id, e)
        return error_response_with_status(
            "INTERNAL_ERROR",
            message="查询会员升级订单失败",
            status_code=500,
        )


@router.post(
    "/organizations/{organization_id}/upgrade-orders/{order_id}/wallet-pay",
    tags=["组织会员"],
    auth=jwt_auth,
)
def pay_membership_upgrade_order_with_wallet(request, organization_id: str, order_id: str):
    """使用组织现金钱包支付会员升级订单。"""
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        data = SubscriptionOrderService().wallet_pay_upgrade_order(
            user=request.auth,
            organization_id=organization_id,
            order_id=order_id,
        )
        return success_response(data=data, message="会员升级支付成功")
    except MembershipUpgradeBalanceError as e:
        return error_response_with_status(
            e.error_code,
            message=str(e),
            status_code=402,
            data=e.data,
        )
    except PaymentOrder.DoesNotExist:
        return error_response_with_status(
            "MEMBERSHIP_UPGRADE_ORDER_NOT_FOUND",
            message="会员升级订单不存在",
            status_code=404,
        )
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("会员升级钱包支付失败: organization=%s order=%s error=%s", organization_id, order_id, e)
        return error_response_with_status(
            "INTERNAL_ERROR",
            message="会员升级钱包支付失败",
            status_code=500,
        )


@router.post(
    "/organizations/{organization_id}/downgrade-preview",
    tags=["组织会员"],
    auth=jwt_auth,
)
def preview_membership_downgrade(request, organization_id: str, payload: OrganizationLifecycleTargetRequest):
    """预览下周期降级；PR5 不退款、不立即变更权益。"""
    try:
        ensure_organization_permission(request, organization_id, role='viewer')
        data = SubscriptionLifecycleService().preview_downgrade(
            organization_id=organization_id,
            target_tier_id=payload.target_tier_id,
            billing_cycle=payload.billing_cycle or "monthly",
        )
        return success_response(data=data)
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("会员降级预览失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="会员降级预览失败", status_code=500)


@router.post(
    "/organizations/{organization_id}/downgrade",
    tags=["组织会员"],
    auth=jwt_auth,
)
def schedule_membership_downgrade(request, organization_id: str, payload: OrganizationLifecycleTargetApplyRequest):
    """预约下周期降级。"""
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        data = SubscriptionLifecycleService().schedule_downgrade(
            user=request.auth,
            organization_id=organization_id,
            target_tier_id=payload.target_tier_id,
            billing_cycle=payload.billing_cycle or "monthly",
            quote_token=payload.quote_token,
        )
        return success_response(data=data, message="已预约下周期降级")
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("预约会员降级失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="预约会员降级失败", status_code=500)


@router.get(
    "/organizations/{organization_id}/scheduled-change",
    tags=["组织会员"],
    auth=jwt_auth,
)
def get_membership_scheduled_change(request, organization_id: str):
    """查询当前预约的降级/同级切换。"""
    try:
        ensure_organization_permission(request, organization_id, role='viewer')
        return success_response(data=SubscriptionLifecycleService().get_scheduled_change(organization_id=organization_id))
    except HttpError:
        raise
    except Exception as e:
        logger.error("查询预约套餐变更失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="查询预约套餐变更失败", status_code=500)


@router.post(
    "/organizations/{organization_id}/scheduled-change/cancel",
    tags=["组织会员"],
    auth=jwt_auth,
)
def cancel_membership_scheduled_change(request, organization_id: str, payload: CancelScheduledChangeRequest):
    """取消当前预约的降级/同级切换。"""
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        data = SubscriptionLifecycleService().cancel_scheduled_change(
            user=request.auth,
            organization_id=organization_id,
            reason=payload.reason or "user_cancelled",
        )
        return success_response(data=data, message="已取消预约套餐变更")
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("取消预约套餐变更失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="取消预约套餐变更失败", status_code=500)


@router.post(
    "/organizations/{organization_id}/switch-preview",
    tags=["组织会员"],
    auth=jwt_auth,
)
def preview_membership_switch(request, organization_id: str, payload: OrganizationLifecycleTargetRequest):
    """预览同级套餐或月/年付切换。"""
    try:
        ensure_organization_permission(request, organization_id, role='viewer')
        data = SubscriptionLifecycleService().preview_switch(
            organization_id=organization_id,
            target_tier_id=payload.target_tier_id,
            billing_cycle=payload.billing_cycle or "monthly",
        )
        return success_response(data=data)
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("会员同级切换预览失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="会员同级切换预览失败", status_code=500)


@router.post(
    "/organizations/{organization_id}/switch",
    tags=["组织会员"],
    auth=jwt_auth,
)
def apply_or_create_membership_switch(request, organization_id: str, payload: OrganizationLifecycleTargetApplyRequest):
    """执行同级切换：零差价立即生效；高价切换创建钱包订单；低价切换下周期生效。"""
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        service = SubscriptionLifecycleService()
        resolved = service.resolve_verified_switch_action(
            organization_id=organization_id,
            target_tier_id=payload.target_tier_id,
            billing_cycle=payload.billing_cycle or "monthly",
            quote_token=payload.quote_token,
        )
        if resolved["payload"].get("effective_mode") == "immediate_paid":
            data = service.create_switch_order(
                user=request.auth,
                organization_id=organization_id,
                target_tier_id=payload.target_tier_id,
                billing_cycle=payload.billing_cycle or "monthly",
                quote_token=payload.quote_token,
            )
            return success_response(data=data, message="会员同级切换订单已创建")
        data = service.apply_free_switch(
            user=request.auth,
            organization_id=organization_id,
            target_tier_id=payload.target_tier_id,
            billing_cycle=payload.billing_cycle or "monthly",
            quote_token=payload.quote_token,
        )
        return success_response(data=data, message="会员同级切换已处理")
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("会员同级切换失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="会员同级切换失败", status_code=500)


@router.post(
    "/organizations/{organization_id}/renewal-preview",
    tags=["组织会员"],
    auth=jwt_auth,
)
def preview_membership_renewal(request, organization_id: str, payload: OrganizationRenewalPreviewRequest):
    """预览手动续费。"""
    try:
        ensure_organization_permission(request, organization_id, role='viewer')
        data = SubscriptionLifecycleService().preview_renewal(
            organization_id=organization_id,
            billing_cycle=payload.billing_cycle or "monthly",
        )
        return success_response(data=data)
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("会员续费预览失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="会员续费预览失败", status_code=500)


@router.post(
    "/organizations/{organization_id}/renew",
    tags=["组织会员"],
    auth=jwt_auth,
)
def create_membership_renewal_order(request, organization_id: str, payload: OrganizationRenewalOrderRequest):
    """创建手动续费钱包订单。"""
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        data = SubscriptionLifecycleService().create_renewal_order(
            user=request.auth,
            organization_id=organization_id,
            billing_cycle=payload.billing_cycle or "monthly",
            quote_token=payload.quote_token,
        )
        return success_response(data=data, message="会员续费订单已创建")
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("创建会员续费订单失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="创建会员续费订单失败", status_code=500)


@router.post(
    "/organizations/{organization_id}/membership-orders/{order_id}/wallet-pay",
    tags=["组织会员"],
    auth=jwt_auth,
)
def pay_membership_lifecycle_order_with_wallet(request, organization_id: str, order_id: str):
    """使用组织现金钱包支付续费/同级切换订单。"""
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        order = PaymentOrder.objects.only("id", "business_data").get(id=order_id, organization_id=organization_id)
        change_type = (order.business_data or {}).get("change_type")
        if change_type not in {"renewal", "switch"}:
            raise MembershipLifecycleError("该订单不能使用生命周期钱包支付入口", "MEMBERSHIP_ACTION_MISMATCH")
        data = SubscriptionLifecycleService().wallet_pay_membership_order(
            user=request.auth,
            organization_id=organization_id,
            order_id=order_id,
            change_type=change_type,
        )
        return success_response(data=data, message="会员订单支付成功")
    except MembershipUpgradeBalanceError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=402, data=e.data)
    except PaymentOrder.DoesNotExist:
        return error_response_with_status("MEMBERSHIP_ORDER_NOT_FOUND", message="会员订单不存在", status_code=404)
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error("会员生命周期钱包支付失败: organization=%s order=%s error=%s", organization_id, order_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="会员订单支付失败", status_code=500)


@router.get(
    "/organizations/{organization_id}/lifecycle",
    tags=["组织会员"],
    auth=jwt_auth,
)
def get_membership_lifecycle_snapshot(request, organization_id: str):
    """生命周期状态聚合：当前状态 + 预约变更。"""
    try:
        ensure_organization_permission(request, organization_id, role='viewer')
        membership = OrganizationMembershipService().check_membership_status(organization_id)
        scheduled = SubscriptionLifecycleService().get_scheduled_change(organization_id=organization_id)
        return success_response(data={"membership": membership, "scheduled_change": scheduled})
    except HttpError:
        raise
    except Exception as e:
        logger.error("查询会员生命周期失败: organization=%s error=%s", organization_id, e)
        return error_response_with_status("INTERNAL_ERROR", message="查询会员生命周期失败", status_code=500)


@router.post(
    "/organizations/{organization_id}/purchase",
    tags=["组织会员"],
    auth=jwt_auth,
)
def purchase_organization_membership(request, organization_id: str, payload: OrganizationPurchaseRequest):
    """
    为组织购买会员（需要登录）- 创建支付订单

    参数：
    - organization_id: 组织ID
    - payload.tier_id: 会员等级ID
    - payload.payment_method: 支付方式（alipay/wechat）
    - payload.extra_params: 支付额外参数
    """
    try:
        ensure_organization_permission(request, organization_id, role='owner')
        if payload.payment_method not in ALLOWED_PAYMENT_METHODS:
            return error_response_with_status("VALIDATION_ERROR", message=_("payment.unsupported_payment_method"), status_code=400)
        user_id = str(request.auth.id)
        data = _create_membership_payment(
            user_id, payload.tier_id, payload.payment_method,
            organization_id=organization_id,
            billing_cycle=payload.billing_cycle or "monthly",
            extra_params=payload.extra_params,
        )
        logger.info(f"组织会员购买订单创建成功: user={user_id}, organization={organization_id}, order={data['order_no']}")
        return success_response(data=data, message=get_text("membership.purchase_order_created"))
    except MembershipLifecycleError as e:
        return error_response_with_status(e.error_code, message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error(f"组织会员购买失败: organization={organization_id}, error={str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("membership.purchase_failed", detail=str(e)), status_code=500)


@router.patch(
    "/organizations/{organization_id}/membership/auto-renew",
    tags=["组织会员"],
    auth=jwt_auth,
)
def toggle_organization_auto_renew(request, organization_id: str, payload: AutoRenewRequest):
    """
    切换组织自动续费开关（需要登录）

    参数：
    - organization_id: 组织ID
    - payload.auto_renew: 是否开启自动续费
    """
    try:
        ensure_organization_permission(request, organization_id, role='owner')

        service = OrganizationMembershipService()
        result = service.toggle_auto_renew(organization_id, payload.auto_renew)

        return success_response(
            data=result,
            message=get_text("membership.auto_renew_updated"),
        )

    except MembershipException as e:
        return error_response_with_status("VALIDATION_ERROR", message=str(e), status_code=400)
    except HttpError:
        raise
    except Exception as e:
        logger.error(f"切换组织自动续费失败: organization={organization_id}, error={str(e)}")
        return error_response_with_status("INTERNAL_ERROR", message=get_text("membership.auto_renew_failed"), status_code=500)

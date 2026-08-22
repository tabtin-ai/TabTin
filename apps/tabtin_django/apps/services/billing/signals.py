"""
Billing 模块信号处理。

主要作用：
- BillingBudgetPolicy 更新时主动清除预算策略缓存，
  确保管理员修改后立即生效（不必等待缓存自然过期）。
"""

import logging

from django.db import transaction
from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver

logger = logging.getLogger(__name__)


def _get_invalidate_fn():
    """延迟导入，避免 AppConfig.ready() 时的循环导入。"""
    try:
        from apps.services.llm.services.billing import invalidate_budget_policy_cache
        return invalidate_budget_policy_cache
    except ImportError:
        return None


def _invalidate_budget_cache_for_policy(instance, **kwargs):
    organization_id = getattr(instance, "organization_id", None)
    if not organization_id:
        return
    fn = _get_invalidate_fn()
    if fn:
        fn(str(organization_id))


def _remember_previous_payment_status(instance, **kwargs):
    if not instance.pk:
        instance._real_recharge_previous_status = None
        return
    from apps.services.payment.models import PaymentOrder

    instance._real_recharge_previous_status = (
        PaymentOrder.objects.filter(pk=instance.pk).values_list("status", flat=True).first()
    )


def _enqueue_real_recharge_notification(instance, created=False, **kwargs):
    from apps.services.billing.services.real_recharge_report_service import (
        SUCCESS_STATUSES,
        is_real_recharge_order,
    )

    previous_status = getattr(instance, "_real_recharge_previous_status", None)
    if not is_real_recharge_order(instance):
        return
    if not created and previous_status in SUCCESS_STATUSES:
        return

    order_id = str(instance.id)

    def enqueue_after_commit():
        try:
            from apps.services.billing.tasks import deliver_single_real_recharge_report

            deliver_single_real_recharge_report.delay(order_id)
        except Exception:
            logger.exception(
                "[Billing] 真实充值即时通知入队失败 order_id=%s",
                order_id,
            )

    transaction.on_commit(enqueue_after_commit)


def register_signals():
    """在 AppConfig.ready() 中调用，注册所有信号。"""
    from django.db.models.signals import pre_save

    from apps.services.payment.models import PaymentOrder

    from .models import BillingBudgetPolicy

    post_save.connect(
        _invalidate_budget_cache_for_policy,
        sender=BillingBudgetPolicy,
        dispatch_uid="billing_budget_policy_post_save_cache_invalidate",
    )
    post_delete.connect(
        _invalidate_budget_cache_for_policy,
        sender=BillingBudgetPolicy,
        dispatch_uid="billing_budget_policy_post_delete_cache_invalidate",
    )
    pre_save.connect(
        _remember_previous_payment_status,
        sender=PaymentOrder,
        dispatch_uid="billing_real_recharge_pre_save_status",
    )
    post_save.connect(
        _enqueue_real_recharge_notification,
        sender=PaymentOrder,
        dispatch_uid="billing_real_recharge_post_save_notify",
    )
    logger.debug("[Billing] BillingBudgetPolicy 缓存失效信号已注册")

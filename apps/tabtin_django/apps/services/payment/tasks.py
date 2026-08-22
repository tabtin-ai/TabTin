"""
支付相关 Celery 任务
"""

import logging


from celery import shared_task
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from celery.schedules import crontab

from .models import PaymentOrder
from .services.benefit_service import OrderBenefitService
from .services.factory import PaymentServiceFactory

logger = logging.getLogger(__name__)

_PAYMENT_LOCK_PREFIX = "payment_task_lock:"


def _try_acquire_lock(lock_name: str, timeout: int = 300) -> bool:
    """Best-effort Redis-backed lock for periodic payment scans."""
    return cache.add(f"{_PAYMENT_LOCK_PREFIX}{lock_name}", "1", timeout)


def _release_lock(lock_name: str) -> None:
    cache.delete(f"{_PAYMENT_LOCK_PREFIX}{lock_name}")


def _sync_order_with_provider(order: PaymentOrder) -> PaymentOrder:
    """向第三方支付平台查询订单真实状态，如已付款则更新本地订单并发放权益。

    与 api.py 中 _try_sync_provider_status 逻辑一致，提取为可复用函数
    供定时任务（对账、取消前预检）使用。

    此函数可安全地在已持有订单行锁的上下文中调用（MySQL InnoDB 支持同连接行锁重入）。

    三阶段设计：
    1. 无锁查询第三方支付平台
    2. 加锁更新本地订单状态（防止与实时回调竞态）
    3. 锁外发放权益

    Returns:
        更新后的 order 实例。
    """
    try:
        # ── 阶段 1（无锁）：查询第三方支付平台 ──
        payment_service = PaymentServiceFactory.get_service(order.payment_method)
        provider_result = payment_service.query_order(order.order_no)
        if not provider_result:
            return order

        trade_status = provider_result.get('trade_status', '')
        if trade_status not in ('TRADE_SUCCESS', 'TRADE_FINISHED', 'SUCCESS'):
            return order

        logger.info(
            "PAY-36: 对账发现订单已付款: order=%s, trade_status=%s",
            order.order_no, trade_status,
        )

        from .callbacks.handler import PaymentCallbackHandler
        handler = PaymentCallbackHandler(order.payment_method)
        callback_data = {
            'order_no': order.order_no,
            'third_party_trade_no': provider_result.get('third_party_trade_no', ''),
            'paid_amount': provider_result.get('total_amount', order.amount),
            'trade_status': trade_status,
            'paid_at': provider_result.get('paid_at') or timezone.now(),
        }

        # ── 阶段 2（加锁）：更新本地订单 ──
        with transaction.atomic():
            order = PaymentOrder.objects.select_for_update().get(id=order.id)
            if order.status in ('paid', 'completed'):
                logger.info(
                    "PAY-36: 订单已被回调处理，跳过对账更新: order=%s, status=%s",
                    order.order_no, order.status,
                )
                return order
            handler._update_order_status(order, callback_data)

        # ── 阶段 3（锁外）：权益发放 ──
        if order.status == 'paid':
            try:
                handler._trigger_business_callback(order)
            except Exception as e:
                logger.error(
                    "PAY-36: 对账后权益发放失败，提交异步补偿: order=%s, error=%s",
                    order.order_no, e,
                )
                grant_order_benefits.delay(order.id)

        order.refresh_from_db()
    except Exception as exc:
        logger.warning(
            "PAY-36: 对账查询第三方状态失败: order=%s, error=%s",
            order.order_no, exc,
        )
    return order

# PAY-35: Prometheus 指标 — 超 24h 未发放权益的 paid 订单数量
try:
    from prometheus_client import Gauge
    STALE_PAID_ORDERS_GAUGE = Gauge(
        "payment_stale_paid_orders_total",
        "超过 24h 仍处于 paid 状态（权益未发放）的订单数量",
    )
except Exception:
    STALE_PAID_ORDERS_GAUGE = None


@shared_task(bind=True, max_retries=3, acks_late=True, time_limit=120, soft_time_limit=100)
def grant_order_benefits(self, order_id: str):
    """
    发放订单权益（会员/点券）。
    PAY-13: DoesNotExist 也触发重试（可能是 DB 复制延迟）。
    PAY-30: 使用指数退避避免惊群效应。

    幂等保证（INFRA-2）：acks_late=True 下若 Worker 在权益写入后、ack 前崩溃，
    任务将被重入队。此处在调用 service 前先读 status，提供任务层快速幂等路径；
    service 层的 select_for_update + status 检查提供数据库级双重保障。
    """
    try:
        # 任务层幂等快速路径：不加锁，仅读 status 字段
        try:
            _order_check = PaymentOrder.objects.only('id', 'status', 'order_no').get(id=order_id)
            if _order_check.status == 'completed':
                logger.info(
                    "订单权益已发放，幂等跳过: order_no=%s order_id=%s",
                    _order_check.order_no, order_id,
                )
                return order_id
        except PaymentOrder.DoesNotExist:
            pass  # 下方 DoesNotExist 分支会处理重试逻辑

        return OrderBenefitService.grant(order_id)
    except PaymentOrder.DoesNotExist as exc:
        backoff = 60 * (2 ** self.request.retries)
        if self.request.retries < self.max_retries:
            logger.warning(
                "未找到订单(可能DB延迟)，%ds后重试: order_id=%s retry=%d/%d",
                backoff, order_id, self.request.retries + 1, self.max_retries,
            )
            raise self.retry(exc=exc, countdown=backoff)
        logger.critical(
            "重试耗尽仍未找到订单，权益永久丢失风险: order_id=%s",
            order_id,
        )
        try:
            from decimal import Decimal
            from apps.services.billing.models import BillingAnomalyAlert
            BillingAnomalyAlert.objects.create(
                alert_type="charge_failed",
                severity="critical",
                metric_name="order_benefit_grant",
                current_value=Decimal("0"),
                baseline_value=Decimal("0"),
                message=f"grant_order_benefits 重试耗尽仍找不到订单 {order_id}，权益无法发放，需人工介入",
            )
        except Exception as alert_exc:
            logger.error("创建告警记录失败: %s", alert_exc)
    except Exception as exc:
        backoff = 60 * (2 ** self.request.retries)
        logger.error(f"发放订单权益失败: {order_id}, 错误: {exc}", exc_info=True)
        if self.request.retries >= self.max_retries:
            logger.critical("grant_order_benefits 通用异常重试耗尽: order_id=%s", order_id)
            try:
                from decimal import Decimal
                from apps.services.billing.models import BillingAnomalyAlert
                BillingAnomalyAlert.objects.create(
                    alert_type="charge_failed",
                    severity="critical",
                    metric_name="order_benefit_grant_exhausted",
                    current_value=Decimal("0"),
                    baseline_value=Decimal("0"),
                    message=f"grant_order_benefits 通用异常重试耗尽: order_id={order_id}, error={exc}",
                )
            except Exception:
                pass
        raise self.retry(exc=exc, countdown=backoff)


@shared_task(bind=True, max_retries=5, acks_late=True, time_limit=60, soft_time_limit=50)
def close_superseded_payment_order(self, order_id: str):
    """持久重试关闭支付链败者，防止旧二维码继续产生第二笔付款。"""
    order = PaymentOrder.objects.filter(id=order_id).first()
    if not order:
        return {"closed": False, "reason": "not_found"}
    business_data = dict(order.business_data or {})
    if not business_data.get("payment_chain_close_pending"):
        return {"closed": True, "reason": "already_resolved"}
    if order.status in {"paid", "completed"}:
        business_data["payment_chain_close_pending"] = False
        PaymentOrder.objects.filter(id=order.id).update(business_data=business_data)
        return {"closed": False, "reason": "already_paid"}

    try:
        service = PaymentServiceFactory.get_service(order.payment_method)
        closed = service.close_unpaid_order(order.order_no)
        provider_result = {} if closed else (service.query_order(order.order_no) or {})
        provider_status = str(provider_result.get("trade_status") or "").upper()
        if not closed and provider_status in {"TRADE_SUCCESS", "TRADE_FINISHED", "SUCCESS"}:
            order = _sync_order_with_provider(order)
            if order.status not in {"paid", "completed"}:
                raise RuntimeError("支付平台已确认付款，但本地对账尚未完成")
            business_data = dict(order.business_data or {})
            business_data["payment_chain_close_pending"] = False
            PaymentOrder.objects.filter(id=order.id).update(business_data=business_data)
            return {"closed": False, "reason": "already_paid"}
        if not closed and provider_status not in {
            "TRADE_CLOSED",
            "CLOSED",
            "REVOKED",
            "TRADE_NOT_EXIST",
        }:
            raise RuntimeError("支付平台未确认订单已关闭")

        with transaction.atomic():
            locked = PaymentOrder.objects.select_for_update().get(id=order.id)
            locked_business_data = dict(locked.business_data or {})
            locked_business_data["payment_chain_close_pending"] = False
            locked.business_data = locked_business_data
            locked.save(update_fields=["business_data", "updated_at"])
        return {"closed": True}
    except Exception as exc:
        countdown = min(300, 10 * (2 ** self.request.retries))
        should_alert = False
        with transaction.atomic():
            locked = PaymentOrder.objects.select_for_update().filter(id=order.id).first()
            if locked:
                locked_business_data = dict(locked.business_data or {})
                locked_business_data["payment_chain_close_attempts"] = (
                    int(locked_business_data.get("payment_chain_close_attempts") or 0) + 1
                )
                locked_business_data["payment_chain_close_last_attempt_at"] = (
                    timezone.now().isoformat()
                )
                if (
                    self.request.retries >= self.max_retries
                    and not locked_business_data.get("payment_chain_close_alerted_at")
                ):
                    locked_business_data["payment_chain_close_alerted_at"] = (
                        timezone.now().isoformat()
                    )
                    should_alert = True
                locked.business_data = locked_business_data
                locked.save(update_fields=["business_data", "updated_at"])
        if should_alert:
            try:
                from decimal import Decimal
                from apps.services.billing.models import BillingAnomalyAlert

                BillingAnomalyAlert.objects.create(
                    alert_type="charge_failed",
                    severity="critical",
                    metric_name="payment_chain_close_exhausted",
                    current_value=Decimal("1"),
                    baseline_value=Decimal("0"),
                    message=(
                        f"支付链败者订单 {order.order_no} 安全关单重试耗尽，"
                        "二维码可能仍可付款，需立即人工核查"
                    ),
                )
            except Exception:
                logger.exception("创建支付链关单失败告警异常: order=%s", order.order_no)
        logger.warning(
            "支付链败者关单失败，将重试: order=%s retry=%d/%d error=%s",
            order.order_no,
            self.request.retries + 1,
            self.max_retries,
            exc,
        )
        raise self.retry(exc=exc, countdown=countdown)


@shared_task(bind=True, max_retries=2, default_retry_delay=60, acks_late=True, time_limit=120, soft_time_limit=100)
def check_pending_orders(self):
    """
    定时标记已超时未支付的订单为 expired。
    """
    _lock_key = "check_pending_orders"
    if not _try_acquire_lock(_lock_key, timeout=540):
        logger.warning("[check_pending_orders] 跳过: 另一实例正在执行")
        return {"skipped": True, "reason": "lock_held"}

    try:
        now = timezone.now()
        _PENDING_BATCH_LIMIT = 50
        total_expired = PaymentOrder.objects.filter(
            status__in=["pending", "paying"],
            expired_at__lt=now,
        ).count()
        expired_order_ids = list(
            PaymentOrder.objects.filter(
                status__in=["pending", "paying"],
                expired_at__lt=now,
            ).values_list("id", flat=True)[:_PENDING_BATCH_LIMIT]
        )
        superseded_order_ids = list(
            PaymentOrder.objects.filter(
                business_data__payment_chain_close_pending=True,
            )
            .order_by("updated_at", "id")
            .values_list("id", flat=True)[:_PENDING_BATCH_LIMIT]
        )
        for superseded_order_id in superseded_order_ids:
            close_superseded_payment_order.delay(str(superseded_order_id))
        if not expired_order_ids:
            return 0

        if total_expired > _PENDING_BATCH_LIMIT:
            logger.warning(
                "超时订单积压: total=%d, 本次处理=%d, 剩余=%d 将在下次调度处理",
                total_expired, len(expired_order_ids), total_expired - len(expired_order_ids),
            )

        count = 0
        for order_id in expired_order_ids:
            try:
                with transaction.atomic():
                    try:
                        order = PaymentOrder.objects.select_for_update().get(
                            id=order_id
                        )
                    except PaymentOrder.DoesNotExist:
                        logger.warning(f"订单已删除，跳过: {order_id}")
                        continue

                    if order.status not in ("pending", "paying"):
                        logger.info(
                            f"订单状态已变更，跳过过期处理: "
                            f"{order.order_no}, status={order.status}"
                        )
                        continue

                    # PAY-36: paying 订单过期前必须先向支付平台确认是否已付款，
                    # 防止回调被 IP 白名单拦截导致"用户已付款但订单被标记过期"的资损。
                    if order.status == "paying":
                        order = _sync_order_with_provider(order)
                        if order.status in ("paid", "completed"):
                            logger.info(
                                "PAY-36: 过期 paying 订单经对账确认已付款，跳过取消: %s",
                                order.order_no,
                            )
                            continue

                    if order.payment_method != "organization_wallet":
                        try:
                            svc = PaymentServiceFactory.get_service(order.payment_method)
                            closed = svc.close_unpaid_order(order.order_no)
                            if closed is False:
                                logger.warning(
                                    "第三方关单未成功，保留 paying 状态等待下次对账: %s",
                                    order.order_no,
                                )
                                continue
                        except Exception as e:
                            logger.warning(
                                f"第三方关单异常，保留原状态等待下次对账: {order.order_no}, {e}"
                            )
                            continue
                    order.status = "expired"
                    order.updated_at = now
                    order.save(update_fields=["status", "updated_at"])
                    if (
                        order.order_type == "membership"
                        and (order.business_data or {}).get("change_type") == "upgrade"
                    ):
                        change_log_id = (order.business_data or {}).get("change_log_id")
                        if change_log_id:
                            from apps.users.membership.models import OrganizationMembershipChangeLog

                            OrganizationMembershipChangeLog.objects.filter(
                                id=change_log_id,
                                status=OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                            ).update(
                                status=OrganizationMembershipChangeLog.Status.CANCELLED,
                                reason="upgrade_order_expired",
                                updated_at=now,
                            )
                    count += 1
            except Exception as e:
                logger.error(f"取消订单失败: {order_id}, 错误: {e}", exc_info=True)

        logger.info(f"已标记过期订单数量: {count}")
        return count
    except Exception as exc:
        logger.error("check_pending_orders 任务异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)
    finally:
        _release_lock(_lock_key)


@shared_task(bind=True, max_retries=2, default_retry_delay=60, acks_late=True, time_limit=180, soft_time_limit=160)
def process_membership_expirations(self):
    """PR5: 扫描到期组织会员，进入 grace 或执行到期预约 Free。

    默认由 MEMBERSHIP_LIFECYCLE_TASKS_ENABLED 关闭，避免在 PR5 灰度前自动改状态。
    """
    if not getattr(settings, "MEMBERSHIP_LIFECYCLE_TASKS_ENABLED", False):
        return {"skipped": True, "reason": "feature_disabled"}
    _lock_key = "process_membership_expirations"
    if not _try_acquire_lock(_lock_key, timeout=540):
        return {"skipped": True, "reason": "lock_held"}
    try:
        from apps.users.membership.models import OrganizationMembership
        from apps.users.membership.services.subscription_lifecycle_service import (
            SubscriptionLifecycleService,
        )

        now = timezone.now()
        limit = int(getattr(settings, "MEMBERSHIP_LIFECYCLE_TASK_BATCH_SIZE", 100))
        membership_ids = list(
            OrganizationMembership.objects.filter(
                status="active",
                end_date__lte=now,
            ).order_by("end_date").values_list("id", flat=True)[:limit]
        )
        service = SubscriptionLifecycleService()
        changed = 0
        for membership_id in membership_ids:
            try:
                result = service.process_membership_expiry(membership_id=str(membership_id), now=now)
                if result.get("changed"):
                    changed += 1
            except Exception as exc:
                logger.error("处理会员到期失败: membership=%s error=%s", membership_id, exc, exc_info=True)
        return {"scanned": len(membership_ids), "changed": changed}
    except Exception as exc:
        logger.error("process_membership_expirations 任务异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)
    finally:
        _release_lock(_lock_key)


@shared_task(bind=True, max_retries=2, default_retry_delay=60, acks_late=True, time_limit=180, soft_time_limit=160)
def process_membership_grace_expirations(self):
    """PR5: 扫描宽限期结束的组织会员，降为 Free 或 expired。"""
    if not getattr(settings, "MEMBERSHIP_LIFECYCLE_TASKS_ENABLED", False):
        return {"skipped": True, "reason": "feature_disabled"}
    _lock_key = "process_membership_grace_expirations"
    if not _try_acquire_lock(_lock_key, timeout=540):
        return {"skipped": True, "reason": "lock_held"}
    try:
        from apps.users.membership.models import OrganizationMembership
        from apps.users.membership.services.subscription_lifecycle_service import (
            SubscriptionLifecycleService,
        )

        now = timezone.now()
        limit = int(getattr(settings, "MEMBERSHIP_LIFECYCLE_TASK_BATCH_SIZE", 100))
        membership_ids = list(
            OrganizationMembership.objects.filter(
                status="grace",
                grace_period_end__lte=now,
            ).order_by("grace_period_end").values_list("id", flat=True)[:limit]
        )
        service = SubscriptionLifecycleService()
        changed = 0
        for membership_id in membership_ids:
            try:
                result = service.process_grace_expiration(membership_id=str(membership_id), now=now)
                if result.get("changed"):
                    changed += 1
            except Exception as exc:
                logger.error("处理会员宽限结束失败: membership=%s error=%s", membership_id, exc, exc_info=True)
        return {"scanned": len(membership_ids), "changed": changed}
    except Exception as exc:
        logger.error("process_membership_grace_expirations 任务异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)
    finally:
        _release_lock(_lock_key)


PAYMENT_BEAT_SCHEDULE = {
    "check-pending-payment-orders": {
        "task": "apps.services.payment.tasks.check_pending_orders",
        "schedule": crontab(minute="*/10"),
        "options": {"expires": 540},
    },
    "process-membership-expirations": {
        "task": "apps.services.payment.tasks.process_membership_expirations",
        "schedule": crontab(minute="*/10"),
        "options": {"expires": 540},
    },
    "process-membership-grace-expirations": {
        "task": "apps.services.payment.tasks.process_membership_grace_expirations",
        "schedule": crontab(minute="*/10"),
        "options": {"expires": 540},
    },
}

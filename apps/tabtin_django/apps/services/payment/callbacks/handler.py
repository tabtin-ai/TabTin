"""
支付回调处理器

统一处理支付宝、微信等支付回调
"""

import logging
from typing import Dict, Any
from decimal import Decimal
from django.db import transaction

from ..models import PaymentOrder, PaymentCallback
from ..services.benefit_service import OrderBenefitService
from ..services.factory import PaymentServiceFactory
from ..exceptions import (
    OrderNotFoundException,
    OrderStatusError,
    SignatureVerificationError,
    CallbackProcessError
)

logger = logging.getLogger(__name__)


class PaymentCallbackHandler:
    """
    支付回调统一处理器

    职责：
    1. 验证回调签名
    2. 记录回调日志
    3. 更新订单状态
    4. 触发业务回调（会员开通、点券充值等）
    """

    def __init__(self, payment_method: str):
        """
        初始化回调处理器

        Args:
            payment_method: 支付方式（alipay、wechat）
        """
        self.payment_method = payment_method
        self.payment_service = PaymentServiceFactory.get_service(payment_method)

    def handle_callback(self, callback_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        处理支付回调

        分两步执行：
        1. 事务内：验签 + 订单状态更新
        2. 事务外：异步触发权益发放（失败不影响订单状态）

        Args:
            callback_data: 回调数据

        Returns:
            处理结果

        Raises:
            CallbackProcessError: 回调处理失败
        """
        order = None
        parsed_data = None

        # 回调记录在事务外创建，确保即使事务回滚也能保留日志
        callback_record = self._create_callback_record(callback_data)

        try:
            # ── 步骤 1：事务内完成验签 + 订单状态更新 ──
            with transaction.atomic():
                if not self.payment_service.verify_callback(callback_data):
                    callback_record.is_verified = False
                    callback_record.error_message = "签名验证失败"
                    callback_record.save()
                    raise SignatureVerificationError("签名验证失败")

                callback_record.is_verified = True

                parsed_data = self.payment_service.parse_callback(callback_data)

                order = self._get_order(parsed_data['order_no'])
                callback_record.order = order

                if order.status in ['paid', 'completed']:
                    incoming_trade_no = parsed_data.get('third_party_trade_no', '')
                    if (incoming_trade_no and order.third_party_trade_no
                            and incoming_trade_no != order.third_party_trade_no):
                        logger.critical(
                            "同一订单收到不同交易号: order=%s existing=%s incoming=%s",
                            order.order_no, order.third_party_trade_no, incoming_trade_no,
                        )
                        try:
                            from apps.services.billing.models import BillingAnomalyAlert
                            BillingAnomalyAlert.objects.create(
                                alert_type="charge_failed",
                                severity="critical",
                                metric_name="duplicate_trade_no",
                                current_value=Decimal('0'),
                                baseline_value=Decimal('0'),
                                message=f"订单 {order.order_no} 可能重复扣款: "
                                        f"已记录交易号={order.third_party_trade_no}, "
                                        f"新交易号={incoming_trade_no}",
                            )
                        except Exception:
                            pass

                    logger.warning(f"订单已支付，跳过处理: {order.order_no}")
                    callback_record.is_processed = True
                    callback_record.save()
                    # 已 paid 但未 completed：上次 grant 可能失败，补一次权益发放（grant 自身幂等）
                    if order.status == 'paid':
                        try:
                            self._trigger_business_callback(order)
                        except Exception as e:
                            logger.error(
                                "already_paid 补发权益失败: order=%s error=%s",
                                order.order_no,
                                e,
                                exc_info=True,
                            )
                            self._enqueue_benefit_compensation(order, e)
                    return {'status': 'already_paid', 'order': order}

                if order.status == 'cancelled':
                    trade_status = parsed_data.get('trade_status', '')
                    payment_confirmed = trade_status in [
                        'TRADE_SUCCESS', 'TRADE_FINISHED', 'SUCCESS'
                    ]
                    if payment_confirmed:
                        # fall through 到 _update_order_status → 恢复为 paid → 发放权益
                        logger.warning(
                            f"竞态恢复：订单 {order.order_no} 已取消但支付平台确认已扣款"
                            f"(trade_status={trade_status})，恢复订单并继续发放权益"
                        )
                    else:
                        logger.warning(
                            f"订单已取消，回调未确认支付成功: "
                            f"{order.order_no}, trade_status={trade_status}"
                        )
                        callback_record.is_processed = True
                        callback_record.error_message = (
                            f"订单已取消且支付未成功(trade_status={trade_status})"
                        )
                        callback_record.save()
                        return {'status': 'order_cancelled', 'order': order}

                self._update_order_status(order, parsed_data)

                callback_record.is_processed = True
                callback_record.save()

        except SignatureVerificationError:
            try:
                callback_record.is_verified = False
                callback_record.error_message = "签名验证失败"
                callback_record.save()
            except Exception:
                pass
            raise
        except OrderNotFoundException:
            raise
        except Exception as e:
            error_msg = f"回调处理失败: {str(e)}"
            logger.error(error_msg)

            try:
                callback_record.error_message = error_msg
                callback_record.save()
            except Exception:
                pass

            if isinstance(e, OrderStatusError) and hasattr(e, 'paid_amount'):
                try:
                    from apps.services.billing.models import BillingAnomalyAlert
                    BillingAnomalyAlert.objects.create(
                        alert_type="charge_failed",
                        severity="critical",
                        metric_name="payment_amount_mismatch",
                        current_value=e.paid_amount,
                        baseline_value=e.order_amount,
                        message=f"订单 {e.order_no} 金额严重不匹配: "
                                f"应付={e.order_amount}, 实付={e.paid_amount}, "
                                f"差额={e.amount_diff}",
                    )
                except Exception:
                    pass

            raise CallbackProcessError(error_msg)

        # ── 步骤 2：事务外触发权益发放 ──
        if order and order.status == 'paid':
            try:
                self._trigger_business_callback(order)
            except Exception as e:
                logger.error(f"权益发放失败，提交异步补偿: order={order.order_no}, error={e}")
                self._enqueue_benefit_compensation(order, e)

        logger.info(f"支付回调处理成功: {order.order_no if order else 'unknown'}")

        return {
            'status': 'success',
            'order': order,
            'parsed_data': parsed_data
        }

    def _create_callback_record(self, callback_data: Dict[str, Any]) -> PaymentCallback:
        """创建回调记录"""
        return PaymentCallback.objects.create(
            payment_method=self.payment_method,
            callback_data=callback_data,
            is_verified=False,
            is_processed=False,
        )

    def _get_order(self, order_no: str) -> PaymentOrder:
        """获取订单"""
        try:
            order = PaymentOrder.objects.select_for_update().get(order_no=order_no)
            return order
        except PaymentOrder.DoesNotExist:
            raise OrderNotFoundException(f"订单不存在: {order_no}", order_no=order_no)

    # 支付平台最小精度 0.01 元
    AMOUNT_TOLERANCE = Decimal('0.01')
    # 点券层最大允许偏差（防止高 CREDITS_PER_YUAN 倍率放大误差）
    MAX_CREDITS_TOLERANCE = Decimal('1')

    def _update_order_status(self, order: PaymentOrder, parsed_data: Dict[str, Any]):
        """更新订单状态"""
        paid_amount = parsed_data['paid_amount']
        amount_diff = abs(paid_amount - order.amount)

        if amount_diff > self.AMOUNT_TOLERANCE:
            error_msg = f"订单金额不匹配: 应付={order.amount}, 实付={paid_amount}"
            logger.error(error_msg)
            exc = OrderStatusError(error_msg)
            exc.paid_amount = paid_amount
            exc.order_amount = order.amount
            exc.amount_diff = amount_diff
            exc.order_no = order.order_no
            raise exc

        if amount_diff > 0:
            from django.conf import settings
            credits_per_yuan = Decimal(str(getattr(settings, 'CREDITS_PER_YUAN', 100)))
            credits_diff = amount_diff * credits_per_yuan
            if credits_diff > self.MAX_CREDITS_TOLERANCE:
                logger.warning(
                    "金额误差 %s 元在 CREDITS_PER_YUAN=%s 下等价于 %s 点券偏差"
                    "（超过阈值 %s），订单 %s 需关注",
                    amount_diff, credits_per_yuan, credits_diff,
                    self.MAX_CREDITS_TOLERANCE, order.order_no,
                )
                try:
                    from apps.services.billing.models import BillingAnomalyAlert
                    BillingAnomalyAlert.objects.create(
                        alert_type="pattern",
                        severity="warning",
                        metric_name="payment_credits_tolerance",
                        current_value=credits_diff,
                        baseline_value=self.MAX_CREDITS_TOLERANCE,
                        message=(
                            f"订单 {order.order_no} 金额误差 {amount_diff} 元，"
                            f"折合 {credits_diff} 点券偏差（CREDITS_PER_YUAN={credits_per_yuan}）"
                        ),
                    )
                except Exception as alert_exc:
                    logger.error("创建金额误差告警失败: %s", alert_exc)

        # 更新订单信息
        order.third_party_trade_no = parsed_data['third_party_trade_no']
        order.paid_amount = paid_amount
        order.paid_at = parsed_data['paid_at']

        # 判断交易状态
        trade_status = parsed_data.get('trade_status', '')

        # 支付宝：TRADE_SUCCESS 或 TRADE_FINISHED
        # 微信：SUCCESS
        if trade_status in ['TRADE_SUCCESS', 'TRADE_FINISHED', 'SUCCESS']:
            order.status = 'paid'
            logger.info(f"订单支付成功: {order.order_no}, 金额: {order.paid_amount}")
        elif trade_status in ['TRADE_CLOSED', 'CLOSED']:
            order.status = 'failed'
            logger.info(f"订单交易关闭: {order.order_no}")
        else:
            order.status = 'paying'
            logger.info(f"订单支付中: {order.order_no}, 状态: {trade_status}")

        order.save(update_fields=['third_party_trade_no', 'paid_amount', 'paid_at', 'status', 'updated_at'])

    def _trigger_business_callback(self, order: PaymentOrder):
        """
        触发业务回调

        根据订单类型执行不同的业务逻辑：
        - membership: 开通会员
        - credits: 充值点券
        """
        if order.status != 'paid':
            return

        try:
            result = OrderBenefitService.grant(order.id)
            if not result:
                raise CallbackProcessError(f"订单状态不满足权益发放条件: {order.order_no}")

            logger.info(f"业务回调完成: {order.order_no}, 类型: {order.order_type}")
        except Exception as e:
            logger.error(f"业务回调失败: {order.order_no}, 错误: {str(e)}", exc_info=True)
            # 维持订单为已支付状态，便于后续补偿或重试
            raise CallbackProcessError(f"业务回调失败: {e}")

    def _enqueue_benefit_compensation(self, order: PaymentOrder, error: Exception):
        """投递权益补偿任务；投递失败时发告警，避免 paid 未入账静默悬挂。"""
        try:
            from apps.services.payment.tasks import grant_order_benefits
            grant_order_benefits.delay(order.id)
        except Exception as queue_exc:
            logger.critical(
                "[BENEFIT_QUEUE_FAILURE] 异步补偿任务投递失败（可能 Redis 宕机），"
                "用户已付款但权益未发放，需人工介入: order_id=%s order_no=%s error=%s original_error=%s",
                order.id, order.order_no, queue_exc, error,
            )
            try:
                from apps.services.billing.tasks import _dispatch_billing_alert
                _dispatch_billing_alert(
                    "benefit_queue_failure", "critical",
                    f"异步补偿任务投递失败: order_id={order.id} order_no={order.order_no} error={queue_exc}",
                    extra={"order_id": str(order.id), "order_no": order.order_no},
                )
            except Exception:
                pass

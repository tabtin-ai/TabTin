"""
微信退款回调处理器

D10 决策：退款异步（管理员发起→refunding→回调→refunded），幂等处理。
"""

import logging
from typing import Dict, Any

from django.db import transaction

from ..models import PaymentOrder, PaymentCallback
from ..services.factory import PaymentServiceFactory
from ..exceptions import (
    SignatureVerificationError,
    CallbackProcessError,
)

logger = logging.getLogger(__name__)


class RefundCallbackHandler:
    """
    退款回调处理器

    职责：
    1. 验证退款回调签名
    2. 记录回调日志
    3. 更新订单退款状态
    4. 幂等：重复回调不重复处理
    """

    def __init__(self, payment_method: str):
        self.payment_method = payment_method
        self.payment_service = PaymentServiceFactory.get_service(payment_method)

    def handle_callback(self, callback_data: Dict[str, Any]) -> Dict[str, Any]:
        callback_record = self._create_callback_record(callback_data)

        try:
            with transaction.atomic():
                if not self.payment_service.verify_refund_callback(callback_data):
                    callback_record.is_verified = False
                    callback_record.error_message = "退款回调签名验证失败"
                    callback_record.save()
                    raise SignatureVerificationError("退款回调签名验证失败")

                callback_record.is_verified = True
                callback_record.save()

                parsed = self.payment_service.parse_refund_callback(callback_data)

                order_no = parsed.get('order_no', '')
                refund_no = parsed.get('refund_no', '')

                order = self._get_order(order_no)
                callback_record.order = order
                callback_record.save()

                existing = (order.business_data or {}).get('refund_callbacks', [])
                if any(r.get('refund_no') == refund_no for r in existing):
                    logger.info(
                        "退款回调幂等命中: order_no=%s refund_no=%s",
                        order_no, refund_no,
                    )
                    callback_record.is_processed = True
                    callback_record.save()
                    return {'status': 'already_processed', 'order': order}

                self._update_refund_status(order, parsed)

                callback_record.is_processed = True
                callback_record.save()

            logger.info(
                "退款回调处理完成: order_no=%s refund_no=%s status=%s",
                order_no, refund_no, parsed.get('status'),
            )

            return {
                'status': 'success',
                'order': order,
                'parsed_data': parsed,
            }

        except SignatureVerificationError:
            try:
                callback_record.is_verified = False
                callback_record.error_message = "退款回调签名验证失败"
                callback_record.save()
            except Exception:
                pass
            raise
        except Exception as e:
            error_msg = f"退款回调处理失败: {e}"
            logger.error(error_msg, exc_info=True)
            try:
                callback_record.error_message = error_msg
                callback_record.save()
            except Exception:
                pass
            raise CallbackProcessError(error_msg)

    def _create_callback_record(self, callback_data: Dict[str, Any]) -> PaymentCallback:
        return PaymentCallback.objects.create(
            payment_method=f"{self.payment_method}_refund",
            callback_data=callback_data,
            is_verified=False,
            is_processed=False,
        )

    def _get_order(self, order_no: str) -> PaymentOrder:
        try:
            return PaymentOrder.objects.select_for_update().get(order_no=order_no)
        except PaymentOrder.DoesNotExist:
            from ..exceptions import OrderNotFoundException
            raise OrderNotFoundException(f"退款回调订单不存在: {order_no}", order_no=order_no)

    def _update_refund_status(
        self, order: PaymentOrder, parsed: Dict[str, Any]
    ) -> None:
        refund_status = parsed.get('status', '')
        refund_no = parsed.get('refund_no', '')
        refund_id = parsed.get('refund_id', '')
        refund_amount = parsed.get('refund_amount')

        biz = dict(order.business_data or {})
        callbacks = biz.get('refund_callbacks', [])
        if not isinstance(callbacks, list):
            callbacks = []

        callbacks.append({
            'refund_no': refund_no,
            'refund_id': refund_id,
            'status': refund_status,
            'wx_status': parsed.get('wx_refund_status', ''),
            'refund_amount': str(refund_amount) if refund_amount else '',
            'success_time': parsed.get('success_time', ''),
        })
        biz['refund_callbacks'] = callbacks
        biz['last_refund_status'] = refund_status

        if refund_status == 'refunded':
            order.status = 'refunded'
        elif refund_status == 'failed':
            logger.warning(
                "微信退款关闭/失败: order_no=%s refund_no=%s",
                order.order_no, refund_no,
            )
        elif refund_status == 'abnormal':
            logger.error(
                "微信退款异常（需人工介入）: order_no=%s refund_no=%s",
                order.order_no, refund_no,
            )
            try:
                from apps.services.billing.tasks import _dispatch_billing_alert
                _dispatch_billing_alert(
                    "wechat_refund_abnormal", "critical",
                    f"微信退款异常: order_no={order.order_no} refund_no={refund_no}",
                    extra={
                        'order_no': order.order_no,
                        'refund_no': refund_no,
                        'refund_id': refund_id,
                    },
                )
            except Exception:
                pass

        order.business_data = biz
        order.save(update_fields=['status', 'business_data', 'updated_at'])

        if refund_status == 'refunded':
            _rno = refund_no
            _rid = refund_id
            _order = order
            transaction.on_commit(
                lambda: self._trigger_billing_refund(_rno, _rid, _order)
            )
        elif refund_status in ('failed', 'abnormal'):
            _rno_fail = refund_no
            _status_fail = refund_status
            transaction.on_commit(
                lambda: self._notify_refund_failure(_rno_fail, _status_fail)
            )

    @staticmethod
    def _notify_refund_failure(refund_no: str, refund_status: str) -> None:
        """微信退款 failed/abnormal 后，同步 RefundRecord 状态。"""
        try:
            from ..models import RefundRecord
            record = RefundRecord.objects.filter(refund_no=refund_no).first()
            if not record:
                logger.warning(
                    "微信退款失败回调但未找到 RefundRecord: refund_no=%s",
                    refund_no,
                )
                return
            if record.refund_status != 'refunding':
                logger.info(
                    "RefundRecord 已非 refunding，跳过失败同步: refund_no=%s status=%s",
                    refund_no, record.refund_status,
                )
                return
            failure_reason = (
                f"微信退款异常（{refund_status}），需人工介入"
                if refund_status == 'abnormal'
                else f"微信退款失败（{refund_status}）"
            )
            from apps.services.billing.services.refund_service import (
                BillingRefundService,
            )
            BillingRefundService.complete_platform_refund(
                refund_record_id=str(record.id),
                success=False,
                failure_reason=failure_reason,
            )
            logger.info(
                "微信退款 %s 已同步到 RefundRecord: refund_no=%s record=%s",
                refund_status, refund_no, record.id,
            )
        except Exception as exc:
            logger.error(
                "微信退款 %s 同步 RefundRecord 失败: refund_no=%s err=%s",
                refund_status, refund_no, exc, exc_info=True,
            )

    @staticmethod
    def _trigger_billing_refund(
        refund_no: str, third_party_refund_id: str, order: PaymentOrder
    ) -> None:
        """微信退款成功后，查找关联的 RefundRecord 并完成内部退款流程。"""
        try:
            from ..models import RefundRecord
            record = RefundRecord.objects.filter(refund_no=refund_no).first()
            if not record:
                logger.warning(
                    "微信退款回调成功但未找到 RefundRecord: refund_no=%s order=%s",
                    refund_no, order.order_no,
                )
                return

            from apps.services.billing.services.refund_service import (
                BillingRefundService,
            )
            BillingRefundService.complete_platform_refund(
                refund_record_id=str(record.id),
                success=True,
                third_party_refund_no=third_party_refund_id,
            )
            logger.info(
                "微信退款回调已触发内部退款: refund_record=%s order=%s",
                record.id, order.order_no,
            )
        except Exception as exc:
            logger.error(
                "微信退款回调触发内部退款失败: refund_no=%s order=%s err=%s",
                refund_no, order.order_no, exc, exc_info=True,
            )
            try:
                from ..models import RefundRecord
                record = RefundRecord.objects.filter(refund_no=refund_no).first()
                if record:
                    from apps.services.billing.services.refund_service import (
                        _schedule_internal_refund_retry,
                    )
                    credits_amount_str = (record.metadata or {}).get(
                        'credits_refund_amount', '0',
                    )
                    _schedule_internal_refund_retry(
                        record.invoice_id, credits_amount_str, record.reason,
                        record.operator_user_id,
                        {
                            'refund_status': 'refunded',
                            'refund_record_id': str(record.id),
                            'refund_no': record.refund_no,
                            'refund_amount_cny': str(record.refund_amount),
                        },
                    )
            except Exception as retry_exc:
                logger.critical(
                    "PAY-SAFETY: 微信退款回调补偿任务调度也失败: refund_no=%s err=%s",
                    refund_no, retry_exc, exc_info=True,
                )

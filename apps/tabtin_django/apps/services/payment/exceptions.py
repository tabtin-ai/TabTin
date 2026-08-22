"""
支付服务自定义异常
"""

from apps.i18n import _


class PaymentException(Exception):
    """支付相关异常基类"""
    def __init__(self, message=None, error_code="PAYMENT_ERROR"):
        message = message or _("payment.service_error")
        self.message = message
        self.error_code = error_code
        super().__init__(self.message)


class OrderNotFoundException(PaymentException):
    """订单不存在异常"""
    def __init__(self, message=None, order_no=None):
        message = message or _("payment.order_not_found")
        self.order_no = order_no
        super().__init__(message, "ORDER_NOT_FOUND")


class OrderExpiredException(PaymentException):
    """订单已过期异常"""
    def __init__(self, message=None):
        message = message or _("payment.order_expired")
        super().__init__(message, "ORDER_EXPIRED")


class OrderStatusError(PaymentException):
    """订单状态错误异常"""
    def __init__(self, message=None, current_status=None):
        message = message or _("payment.order_status_error")
        self.current_status = current_status
        super().__init__(message, "ORDER_STATUS_ERROR")


class PaymentMethodNotSupportedError(PaymentException):
    """支付方式不支持异常"""
    def __init__(self, message=None, method=None):
        message = message or _("payment.unsupported_payment_method")
        self.method = method
        super().__init__(message, "PAYMENT_METHOD_NOT_SUPPORTED")


class SignatureVerificationError(PaymentException):
    """签名验证失败异常"""
    def __init__(self, message=None):
        message = message or _("payment.signature_verify_failed")
        super().__init__(message, "SIGNATURE_VERIFICATION_FAILED")


class CallbackProcessError(PaymentException):
    """回调处理异常"""
    def __init__(self, message=None):
        message = message or _("payment.callback_failed")
        super().__init__(message, "CALLBACK_PROCESS_ERROR")

"""
钱包系统自定义异常
"""

from apps.i18n import _


class WalletException(Exception):
    """钱包相关异常基类"""
    def __init__(self, message=None, error_code="WALLET_ERROR"):
        message = message or _("wallet.service_error")
        self.message = message
        self.error_code = error_code
        super().__init__(self.message)


class InsufficientCreditsError(WalletException):
    """点券不足异常"""
    def __init__(self, message=None, required=0, current=0):
        message = message or _("wallet.insufficient_credits")
        self.required = required
        self.current = current
        super().__init__(message, "INSUFFICIENT_CREDITS")


class WalletNotFoundError(WalletException):
    """钱包不存在异常"""
    def __init__(self, message=None):
        message = message or _("wallet.wallet_not_found")
        super().__init__(message, "WALLET_NOT_FOUND")


class TransactionFailedError(WalletException):
    """交易失败异常"""
    def __init__(self, message=None):
        message = message or _("wallet.transaction_failed")
        super().__init__(message, "TRANSACTION_FAILED")


class BillingEventUpdateError(WalletException):
    """WAL-28 占位记录更新失败 — raise 让外层事务回滚，避免脏数据。"""
    def __init__(self, message=None, idempotency_key="", organization_id=""):
        message = message or "占位记录更新失败，事务需回滚"
        self.idempotency_key = idempotency_key
        self.organization_id = organization_id
        super().__init__(message, "BILLING_EVENT_UPDATE_FAILED")

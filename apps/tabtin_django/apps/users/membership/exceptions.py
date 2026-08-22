"""
会员体系自定义异常
"""

from apps.i18n import _


class MembershipException(Exception):
    """会员相关异常基类"""
    def __init__(self, message=None, error_code="MEMBERSHIP_ERROR"):
        message = message or _("membership.service_error")
        self.message = message
        self.error_code = error_code
        super().__init__(self.message)


class QuotaExceededError(MembershipException):
    """配额超限异常"""
    def __init__(self, message=None, quota_type=None, limit=None, current=None):
        message = message or _("membership.quota_exceeded")
        self.quota_type = quota_type
        self.limit = limit
        self.current = current
        super().__init__(message, "QUOTA_EXCEEDED")


class FeatureNotAvailableError(MembershipException):
    """功能不可用异常"""
    def __init__(self, message=None, feature_name=None, required_tier=None):
        message = message or _("membership.upgrade_required")
        self.feature_name = feature_name
        self.required_tier = required_tier
        super().__init__(message, "FEATURE_NOT_AVAILABLE")


class MembershipExpiredError(MembershipException):
    """会员已过期异常"""
    def __init__(self, message=None):
        message = message or _("membership.membership_expired")
        super().__init__(message, "MEMBERSHIP_EXPIRED")


class MembershipTierException(MembershipException):
    """会员等级异常"""
    def __init__(self, message=None):
        message = message or _("membership.tier_error")
        super().__init__(message, "MEMBERSHIP_TIER_ERROR")


class MembershipLifecycleError(MembershipException):
    """套餐动作或状态解析失败；错误码由调用点明确指定。"""

    def __init__(self, message, error_code):
        super().__init__(message, error_code)

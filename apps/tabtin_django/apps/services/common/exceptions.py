"""
Services模块自定义异常类
"""

from apps.i18n import _


class ServicesBaseException(Exception):
    """Services模块基础异常"""
    def __init__(self, message=None, error_code=None):
        message = message or _("common_exceptions.service_error")
        self.message = message
        self.error_code = error_code
        super().__init__(self.message)


class SmsServiceException(ServicesBaseException):
    """短信服务异常"""
    def __init__(self, message=None, error_code="SMS_ERROR"):
        message = message or _("common_exceptions.sms_error")
        super().__init__(message, error_code)


class EmailServiceException(ServicesBaseException):
    """邮件服务异常"""
    def __init__(self, message=None, error_code="EMAIL_ERROR"):
        message = message or _("common_exceptions.email_error")
        super().__init__(message, error_code)


class ConfigurationException(ServicesBaseException):
    """配置异常"""
    def __init__(self, message=None, error_code="CONFIG_ERROR"):
        message = message or _("common_exceptions.config_error")
        super().__init__(message, error_code)


class ValidationException(ServicesBaseException):
    """验证异常"""
    def __init__(self, message=None, error_code="VALIDATION_ERROR"):
        message = message or _("common_exceptions.validation_error")
        super().__init__(message, error_code)


class NetworkException(ServicesBaseException):
    """网络异常"""
    def __init__(self, message=None, error_code="NETWORK_ERROR"):
        message = message or _("common_exceptions.network_error")
        super().__init__(message, error_code)


class RateLimitException(ServicesBaseException):
    """频率限制异常"""
    def __init__(self, message=None, error_code="RATE_LIMIT_ERROR"):
        message = message or _("common_exceptions.rate_limit_error")
        super().__init__(message, error_code)


class AuthenticationException(ServicesBaseException):
    """认证异常"""
    def __init__(self, message=None, error_code="AUTH_ERROR"):
        message = message or _("common_exceptions.auth_error")
        super().__init__(message, error_code)


class OSSServiceException(ServicesBaseException):
    """OSS对象存储服务异常"""
    def __init__(self, message=None, error_code="OSS_ERROR"):
        message = message or _("common_exceptions.oss_error")
        super().__init__(message, error_code)

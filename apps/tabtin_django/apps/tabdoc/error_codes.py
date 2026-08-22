"""
Tabdoc 错误码定义

通用错误码从 apps.services.common.error_codes 继承，
Tabdoc 特有的错误码在本文件中定义。

API 响应请统一使用 apps.i18n.response 中的
success_response / error_response / not_found_response 等辅助函数，
不要使用本文件构造响应字典。

使用方式:
    from apps.tabdoc.error_codes import ErrorCode, ErrorMessage

    ErrorCode.DOCUMENT_NOT_FOUND   # 'DOCUMENT_NOT_FOUND'
    ErrorMessage.get(ErrorCode.REVISION_CONFLICT)  # '版本冲突，请刷新后重试'
"""

from apps.services.common.error_codes import (
    CommonErrorCode,
    CommonErrorMessage,
)


class ErrorCode(CommonErrorCode):
    """
    Tabdoc 错误码常量

    继承自 CommonErrorCode，包含所有通用错误码 + Tabdoc 特有错误码。
    """

    # 资源不存在 — Tabdoc 特有
    DOCUMENT_NOT_FOUND = "DOCUMENT_NOT_FOUND"
    REVISION_NOT_FOUND = "REVISION_NOT_FOUND"

    # 业务逻辑错误
    REVISION_CONFLICT = "REVISION_CONFLICT"


class ErrorMessage:
    """Tabdoc 错误消息模板"""

    MESSAGES = {
        # 继承通用消息
        **CommonErrorMessage.MESSAGES,
        # Tabdoc 特有
        ErrorCode.DOCUMENT_NOT_FOUND: "文档不存在",
        ErrorCode.REVISION_NOT_FOUND: "版本不存在",
        ErrorCode.REVISION_CONFLICT: "版本冲突，请刷新后重试",
    }

    @classmethod
    def get(cls, code: str, **kwargs) -> str:
        """
        获取错误消息

        Args:
            code: 错误码
            **kwargs: 消息模板参数

        Returns:
            格式化后的错误消息
        """
        message = cls.MESSAGES.get(code, cls.MESSAGES[ErrorCode.UNKNOWN_ERROR])
        try:
            return message.format(**kwargs)
        except KeyError:
            return message

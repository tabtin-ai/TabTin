"""
TabMemo 错误码定义

继承通用错误码，仅添加 TabMemo 特有的错误码。

使用方式:
    from apps.tabmemo.error_codes import ErrorCode
"""

from apps.services.common.error_codes import CommonErrorCode


class ErrorCode(CommonErrorCode):
    """TabMemo 错误码常量"""

    MEMO_NOT_FOUND = "MEMO_NOT_FOUND"
    COLLECTION_NOT_FOUND = "COLLECTION_NOT_FOUND"
    INVALID_INPUT = "INVALID_INPUT"
    INVALID_CURSOR = "INVALID_CURSOR"
    ATTACHMENT_LIMIT_EXCEEDED = "ATTACHMENT_LIMIT_EXCEEDED"
    BOOKMARK_FETCH_FAILED = "BOOKMARK_FETCH_FAILED"
    SMART_COLLECTION_NO_MANUAL = "SMART_COLLECTION_NO_MANUAL"
    GRANT_NOT_FOUND = "GRANT_NOT_FOUND"

"""
LLM 服务统一错误体系

所有 Provider 的原始异常通过 _classify_error() 映射到 LLMServiceError，
业务侧只需按 LLMErrorCode 做分支处理，无需关心 Provider 差异。
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class LLMErrorCode:
    """LLM 服务统一错误码"""

    TOKEN_LIMIT = "TOKEN_LIMIT"
    RATE_LIMIT = "RATE_LIMIT"
    AUTH_FAILED = "AUTH_FAILED"
    MODEL_NOT_FOUND = "MODEL_NOT_FOUND"
    CONTENT_FILTERED = "CONTENT_FILTERED"
    PROVIDER_DOWN = "PROVIDER_DOWN"
    TIMEOUT = "TIMEOUT"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    INVALID_REQUEST = "INVALID_REQUEST"
    VISION_NOT_SUPPORTED = "VISION_NOT_SUPPORTED"
    API_ERROR = "API_ERROR"
    SERVICE_ERROR = "SERVICE_ERROR"

    _RETRYABLE = frozenset({
        RATE_LIMIT,
        PROVIDER_DOWN,
        TIMEOUT,
    })

    @classmethod
    def is_retryable(cls, code: str) -> bool:
        return code in cls._RETRYABLE


class LLMServiceError(Exception):
    """LLM 服务统一异常"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: Optional[int] = None,
        provider_error: Optional[Exception] = None,
        error_type: Optional[str] = None,
        error_details: Optional[Dict[str, Any]] = None,
        retryable: Optional[bool] = None,
    ):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.provider_error = provider_error
        self.error_type = error_type
        self.error_details = error_details
        self.retryable = LLMErrorCode.is_retryable(code) if retryable is None else retryable

    def to_error_result(self, response_time: float = 0) -> Dict[str, Any]:
        """转换为 LLM 服务标准错误响应字典"""
        return {
            "success": False,
            "error": str(self),
            "error_code": self.code,
            "error_type": self.error_type,
            "status_code": self.status_code,
            "error_details": self.error_details,
            "response_time": response_time,
            "retryable": self.retryable,
        }

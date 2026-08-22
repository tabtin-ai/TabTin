"""
LLM Provider 异常分类器。

将各 SDK 原始异常统一映射到 LLMServiceError，消除各 Service 中
_classify_error 的重复逻辑。每个 Classifier 是纯静态工具类，
不依赖 Service 实例状态。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from apps.services.llm.errors import LLMErrorCode, LLMServiceError


def _extract_common_attrs(exc: Exception) -> Dict[str, Any]:
    """从异常对象提取 status_code / raw_code / error_type / error_details / msg。"""
    return {
        "status_code": getattr(exc, "status_code", None),
        "raw_code": str(getattr(exc, "code", "") or ""),
        "error_type": getattr(exc, "type", None),
        "error_details": getattr(exc, "body", None),
        "msg": str(exc),
    }


def _build_service_error(
    code: str,
    msg: str,
    status_code: Optional[int],
    exc: Exception,
    error_type: Any,
    error_details: Any,
) -> LLMServiceError:
    return LLMServiceError(
        code=code,
        message=msg,
        status_code=status_code,
        provider_error=exc,
        error_type=str(error_type) if error_type else None,
        error_details=error_details if isinstance(error_details, dict) else None,
    )


class OpenAIErrorClassifier:
    """OpenAI SDK 异常分类器，供 OpenAIService 及其子类（含 QwenService）使用。"""

    @staticmethod
    def classify(exc: Exception) -> LLMServiceError:
        import openai

        attrs = _extract_common_attrs(exc)
        status_code = attrs["status_code"]
        raw_code = attrs["raw_code"]

        if isinstance(exc, openai.AuthenticationError):
            code = LLMErrorCode.AUTH_FAILED
        elif isinstance(exc, openai.RateLimitError):
            code = LLMErrorCode.RATE_LIMIT
        elif isinstance(exc, openai.NotFoundError):
            code = LLMErrorCode.MODEL_NOT_FOUND
        elif isinstance(exc, openai.APITimeoutError):
            code = LLMErrorCode.TIMEOUT
        elif isinstance(exc, openai.APIConnectionError):
            code = LLMErrorCode.PROVIDER_DOWN
        elif isinstance(exc, openai.InternalServerError):
            code = LLMErrorCode.PROVIDER_DOWN
        elif raw_code in ("context_length_exceeded", "max_tokens") or status_code == 413:
            code = LLMErrorCode.TOKEN_LIMIT
        elif isinstance(exc, openai.APIError):
            code = LLMErrorCode.API_ERROR
        elif isinstance(exc, TimeoutError):
            code = LLMErrorCode.TIMEOUT
        else:
            code = LLMErrorCode.SERVICE_ERROR

        return _build_service_error(
            code, attrs["msg"], status_code, exc,
            attrs["error_type"], attrs["error_details"],
        )


class AnthropicErrorClassifier:
    """Anthropic SDK 异常分类器，供 MiniMaxService 使用。"""

    @staticmethod
    def classify(exc: Exception, *, anthropic_module: Any = None) -> LLMServiceError:
        """
        将 anthropic SDK 异常分类为标准错误类型。

        Parameters
        ----------
        exc : Exception
            原始异常。
        anthropic_module : module, optional
            anthropic SDK 模块引用（MiniMaxService 通过 self._anthropic 传入）。
            若未提供则动态 import。
        """
        if anthropic_module is None:
            import anthropic as anthropic_module  # noqa: N811

        attrs = _extract_common_attrs(exc)
        status_code = attrs["status_code"]
        raw_code = attrs["raw_code"]

        if isinstance(exc, anthropic_module.AuthenticationError):
            code = LLMErrorCode.AUTH_FAILED
        elif isinstance(exc, anthropic_module.PermissionDeniedError):
            code = LLMErrorCode.AUTH_FAILED
        elif isinstance(exc, anthropic_module.RateLimitError):
            code = LLMErrorCode.RATE_LIMIT
        elif isinstance(exc, anthropic_module.NotFoundError):
            code = LLMErrorCode.MODEL_NOT_FOUND
        elif isinstance(exc, anthropic_module.APITimeoutError):
            code = LLMErrorCode.TIMEOUT
        elif isinstance(exc, anthropic_module.APIConnectionError):
            code = LLMErrorCode.PROVIDER_DOWN
        elif isinstance(exc, anthropic_module.InternalServerError):
            code = LLMErrorCode.PROVIDER_DOWN
        elif raw_code in ("context_length_exceeded", "max_tokens") or status_code == 413:
            code = LLMErrorCode.TOKEN_LIMIT
        elif isinstance(exc, anthropic_module.APIError):
            code = LLMErrorCode.API_ERROR
        else:
            code = LLMErrorCode.SERVICE_ERROR

        return _build_service_error(
            code, attrs["msg"], status_code, exc,
            attrs["error_type"], attrs["error_details"],
        )

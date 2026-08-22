"""
API 响应国际化助手

职责：
- 提供国际化的API响应封装
- 自动翻译错误消息
- 兼容现有API响应格式
"""

from typing import Any, Optional

from django.http import JsonResponse

from .manager import get_text
from .language import SupportedLanguage


def success_response(
    data: Any = None,
    message_key: str = "common.success",
    message: Optional[str] = None,
    language: Optional[SupportedLanguage] = None,
    **kwargs
) -> dict:
    """
    生成国际化的成功响应

    Args:
        data: 响应数据
        message_key: 消息翻译键
        message: 自定义消息（如果提供，则不使用翻译）
        language: 目标语言
        **kwargs: 翻译参数

    Returns:
        标准成功响应

    Example:
        # 使用翻译键
        success_response(data={"id": 123}, message_key="auth.login_success")

        # 自定义消息
        success_response(data={"id": 123}, message="Welcome back!")

        # 参数化翻译
        success_response(
            data=records,
            message_key="common.records_created",
            count=10
        )
    """
    return {
        "success": True,
        "code": "SUCCESS",
        "message": message or get_text(message_key, language, **kwargs),
        "data": data
    }


def error_response(
    code: str,
    message_key: Optional[str] = None,
    message: Optional[str] = None,
    status_code: int = 400,
    language: Optional[SupportedLanguage] = None,
    **kwargs
) -> dict:
    """
    生成国际化的错误响应

    Args:
        code: 错误代码（如 "VALIDATION_ERROR"）
        message_key: 消息翻译键（如 "validation.field_required"）
        message: 自定义消息（如果提供，则不使用翻译）
        status_code: HTTP状态码
        language: 目标语言
        **kwargs: 翻译参数

    Returns:
        标准错误响应

    Example:
        # 使用翻译键
        error_response(
            code="FIELD_REQUIRED",
            message_key="validation.field_required",
            field_name="email"
        )

        # 自定义消息
        error_response(
            code="CUSTOM_ERROR",
            message="Something went wrong"
        )
    """
    # 如果没有提供message_key，尝试从code推导
    if not message_key and not message:
        message_key = f"error.{code.lower()}"

    return {
        "success": False,
        "code": code,
        "message": message or get_text(message_key or "common.error", language, **kwargs),
        "data": None
    }


def error_response_with_status(
    code: str,
    message: str = "",
    status_code: int = 400,
    data: Any = None,
    message_key: Optional[str] = None,
    language: Optional[SupportedLanguage] = None,
    **kwargs
) -> JsonResponse:
    """
    生成带 HTTP 状态码的错误响应。

    参数顺序与 tabtinspace.api_helpers.error_response 兼容，可直接替换。

    Returns:
        JsonResponse
    """
    if not message_key and not message:
        message_key = f"error.{code.lower()}"

    return JsonResponse({
        "success": False,
        "code": code,
        "message": message or get_text(message_key or "common.error", language, **kwargs),
        "data": data,
    }, status=status_code)


def not_found_response(
    resource: str = "",
    language: Optional[SupportedLanguage] = None,
) -> JsonResponse:
    """404 快捷响应

    Args:
        resource: 直接消息文本或留空使用默认翻译
    """
    msg = resource if resource else get_text("common.not_found", language)
    return error_response_with_status(
        "NOT_FOUND", message=msg, status_code=404, language=language
    )


def permission_denied_response(
    message: str = "",
    language: Optional[SupportedLanguage] = None,
) -> JsonResponse:
    """403 快捷响应"""
    return error_response_with_status(
        "PERMISSION_DENIED",
        message=message or get_text("auth.permission_denied", language),
        status_code=403, language=language
    )


def validation_error_response(
    detail: str,
    language: Optional[SupportedLanguage] = None,
    data: Optional[dict] = None,
) -> JsonResponse:
    """400 验证错误快捷响应"""
    response_data = {"detail": detail, **(data or {})}
    return error_response_with_status(
        "VALIDATION_ERROR",
        message=get_text("common.validation_error", language, detail=detail),
        status_code=400, data=response_data, language=language,
    )


def paginated_response(
    items: list,
    total: int,
    page: int = 1,
    page_size: int = 20,
    message_key: str = "common.success",
    language: Optional[SupportedLanguage] = None
) -> dict:
    """
    生成国际化的分页响应

    Args:
        items: 当前页数据
        total: 总数
        page: 当前页码
        page_size: 每页大小
        message_key: 消息翻译键
        language: 目标语言

    Returns:
        标准分页响应
    """
    return {
        "success": True,
        "code": "SUCCESS",
        "message": get_text(message_key, language),
        "data": {
            "items": items,
            "pagination": {
                "total": total,
                "page": page,
                "page_size": page_size,
                "total_pages": (total + page_size - 1) // page_size
            }
        }
    }

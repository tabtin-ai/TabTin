"""
API 响应辅助工具

提供统一的响应格式化和错误处理
"""
import inspect
import logging
from functools import wraps
from typing import Any, Optional, Type, TypeVar

from django.core.exceptions import ObjectDoesNotExist
from django.db.utils import ProgrammingError, OperationalError
from django.http import JsonResponse
from pydantic import BaseModel

from apps.tabdata.error_codes import ErrorCode, ErrorMessage, get_error_response, get_success_response
from apps.users.membership.exceptions import MembershipException, QuotaExceededError


T = TypeVar('T', bound=BaseModel)
_api_logger = logging.getLogger('tabdata.api')


def success_response(data: Any = None, message: str = ""):
    """
    生成成功响应

    Args:
        data: 响应数据
        message: 成功消息

    Returns:
        标准成功响应
    """
    return get_success_response(data=data, message=message)


def error_response(code: str, message: str = None, status_code: int = 400, **kwargs):
    """
    生成错误响应

    Args:
        code: 错误码
        message: 自定义错误消息
        status_code: HTTP状态码
        **kwargs: 消息模板参数

    Returns:
        JSON 错误响应
    """
    response = get_error_response(code, message, **kwargs)
    return JsonResponse(response, status=status_code)


def not_found_response(resource: str = ""):
    """资源不存在响应"""
    code_map = {
        "组织": ErrorCode.ORGANIZATION_NOT_FOUND,
        "项目": ErrorCode.PROJECT_NOT_FOUND,
        "表格": ErrorCode.TABLE_NOT_FOUND,
        "字段": ErrorCode.FIELD_NOT_FOUND,
        "记录": ErrorCode.RECORD_NOT_FOUND,
        "刷新任务": ErrorCode.REFRESH_TASK_NOT_FOUND,
        "视图": ErrorCode.NOT_FOUND,
        "上传任务": ErrorCode.NOT_FOUND,
        "文件": ErrorCode.NOT_FOUND,
        "附件引用": ErrorCode.NOT_FOUND,
        "版本": ErrorCode.NOT_FOUND,
        "Space": ErrorCode.NOT_FOUND,
        "智能体空间": ErrorCode.NOT_FOUND,
        "表格或视图": ErrorCode.NOT_FOUND,
    }

    code = code_map.get(resource, ErrorCode.NOT_FOUND)
    return error_response(code, status_code=404)


def permission_denied_response(message: str = None):
    """权限不足响应"""
    return error_response(
        ErrorCode.PERMISSION_DENIED,
        message=message,
        status_code=403
    )


def validation_error_response(detail: str):
    """数据验证错误响应"""
    return error_response(
        ErrorCode.VALIDATION_ERROR,
        status_code=400,
        detail=detail
    )


def conflict_response(message: str = None):
    """资源冲突响应（409）。常见于乐观锁版本不匹配场景。"""
    return error_response(
        ErrorCode.SCHEMA_VERSION_CONFLICT,
        message=message,
        status_code=409,
    )


_RETRYABLE_WRITE_SQLSTATES = frozenset({"40001", "40P01", "55P03"})


def retryable_write_sqlstate(exc: BaseException) -> str:
    """Return a retryable PostgreSQL write-contention SQLSTATE, if present."""
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        sqlstate = getattr(current, "sqlstate", None) or getattr(current, "pgcode", None)
        if sqlstate in _RETRYABLE_WRITE_SQLSTATES:
            return str(sqlstate)
        current = getattr(current, "__cause__", None) or getattr(current, "__context__", None)
    return ""


def write_contention_response():
    """Return the shared retryable response for short-lived write contention."""
    payload = get_error_response(ErrorCode.SAVE_BUSY)
    payload["data"] = {"retryable": True, "retry_after_ms": 500}
    return JsonResponse(payload, status=503)


def record_version_conflict_response():
    """Return a refresh-required response without exposing database details."""
    payload = get_error_response(ErrorCode.VERSION_CONFLICT)
    payload["data"] = {"retryable": False, "refresh_required": True}
    return JsonResponse(payload, status=409)


def _maybe_inject_rate_limit_headers(request, response):
    """如果 request 上有 _rate_limit_info，注入 X-RateLimit-* 响应头。"""
    rate_info = getattr(request, '_rate_limit_info', None)
    if rate_info and hasattr(response, '__setitem__'):
        response['X-RateLimit-Limit'] = str(rate_info.get('limit', 0))
        response['X-RateLimit-Remaining'] = str(rate_info.get('remaining', 0))
        response['X-RateLimit-Reset'] = str(rate_info.get('reset', 0))
    return response


def _handle_api_error(func_name, exc):
    """api_error_handler 的异常处理逻辑，同步/异步共用。"""
    try:
        from apps.services.billing.services.guard_service import BillingBlockedError
    except Exception:
        BillingBlockedError = None
    try:
        from apps.tabtinspace.services.organization_control_guard import (
            OrganizationControlBlockedError,
            organization_control_blocked_response,
        )
    except Exception:
        OrganizationControlBlockedError = None
        organization_control_blocked_response = None

    if isinstance(exc, ValueError):
        return validation_error_response(str(exc))
    if isinstance(exc, PermissionError):
        return permission_denied_response(str(exc))
    if isinstance(exc, ObjectDoesNotExist):
        return not_found_response()
    if (
        OrganizationControlBlockedError is not None
        and organization_control_blocked_response is not None
        and isinstance(exc, OrganizationControlBlockedError)
    ):
        _api_logger.warning(
            "[tabdata api] Organization control blocked in %s: %s",
            func_name,
            exc.code,
        )
        return organization_control_blocked_response(exc)
    if BillingBlockedError is not None and isinstance(exc, BillingBlockedError):
        details = exc.to_dict()
        _api_logger.warning(
            "[tabdata api] Billing blocked in %s: %s",
            func_name,
            details,
        )
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message=details.get("reason") or str(exc),
            status_code=403,
            data=details,
        )
    if isinstance(exc, QuotaExceededError):
        return error_response(
            ErrorCode.QUOTA_EXCEEDED,
            message=str(exc),
            status_code=403,
            detail=str(exc),
        )
    if isinstance(exc, MembershipException):
        _api_logger.warning(
            "[tabdata api] Membership error in %s: %s", func_name, exc,
        )
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message=str(exc),
            status_code=403,
        )
    if isinstance(exc, (ProgrammingError, OperationalError)):
        _api_logger.error(
            "[tabdata api] DB error in %s: %s", func_name, exc,
            exc_info=True,
        )
        from apps.i18n import _
        return error_response(
            ErrorCode.INTERNAL_ERROR,
            message=_("common.operation_failed"),
            status_code=500,
        )
    _api_logger.exception(
        "[tabdata api] Unexpected error in %s", func_name,
    )
    from apps.i18n import _
    return error_response(
        ErrorCode.INTERNAL_ERROR,
        message=_("common.operation_failed"),
        status_code=500,
    )


def api_error_handler(func):
    """统一 API 异常处理装饰器，为缺少 try-except 的接口提供兜底保护。

    放在 @router.xxx 下方，作为最外层安全网捕获未处理异常。
    函数内部的 try-except 优先级更高，不受影响。
    同时在响应中注入 X-RateLimit-* 头信息（如果限流检查已填充到 request 上）。
    支持同步和异步视图函数。
    """
    if inspect.iscoroutinefunction(func):
        @wraps(func)
        async def async_wrapper(request, *args, **kwargs):
            try:
                response = await func(request, *args, **kwargs)
                return _maybe_inject_rate_limit_headers(request, response)
            except Exception as exc:
                return _handle_api_error(func.__name__, exc)
        return async_wrapper

    @wraps(func)
    def wrapper(request, *args, **kwargs):
        try:
            response = func(request, *args, **kwargs)
            return _maybe_inject_rate_limit_headers(request, response)
        except Exception as exc:
            return _handle_api_error(func.__name__, exc)
    return wrapper

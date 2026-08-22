"""
认证模块异常处理器
"""

from ninja import NinjaAPI
from ninja.errors import HttpError, ValidationError as NinjaValidationError
from django.http import JsonResponse
import logging

logger = logging.getLogger(__name__)


def validation_error_handler(request, exc: NinjaValidationError):
    """
    处理Django Ninja的验证错误，转换为统一的API响应格式
    """
    logger.warning(f"Validation error: {exc}")

    # 提取第一个错误消息
    if hasattr(exc, 'errors') and exc.errors:
        first_error = exc.errors[0]
        if isinstance(first_error, dict):
            # 根据错误类型生成友好消息
            error_type = first_error.get('type', '')
            field_name = first_error.get('loc', [])[-1] if first_error.get('loc') else 'field'

            # 字段名映射
            field_names = {
                'phone': '手机号',
                'email': '邮箱',
                'password': '密码',
                'new_password': '新密码',
                'old_password': '原密码',
                'username': '用户名',
                'nickname': '昵称',
                'verification_code': '验证码',
                'bio': '个人简介'
            }

            friendly_field = field_names.get(field_name, field_name)

            # 错误类型映射
            if error_type == 'string_too_short':
                min_length = first_error.get('ctx', {}).get('min_length', 0)
                message = f"{friendly_field}长度至少{min_length}位"
            elif error_type == 'string_too_long':
                max_length = first_error.get('ctx', {}).get('max_length', 0)
                message = f"{friendly_field}长度不能超过{max_length}位"
            elif error_type == 'missing':
                message = f"{friendly_field}不能为空"
            elif error_type == 'value_error':
                message = first_error.get('msg', '数据格式错误')
            else:
                message = first_error.get('msg', '数据验证失败')
        else:
            message = str(first_error)
    else:
        message = "数据验证失败"

    return JsonResponse({
        "success": False,
        "message": message,
        "data": None,
        "code": "VALIDATION_ERROR"
    }, status=400)


STATUS_CODE_MAP = {
    400: "VALIDATION_ERROR",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    408: "REQUEST_TIMEOUT",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    422: "UNPROCESSABLE_ENTITY",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
}


def http_error_handler(request, exc: HttpError):
    """
    处理 Ninja HttpError，统一为标准响应格式
    """
    status_code = getattr(exc, "status_code", 500)
    message = str(getattr(exc, "message", "")) or str(exc)
    code = STATUS_CODE_MAP.get(status_code, f"HTTP_{status_code}")
    return JsonResponse({
        "success": False,
        "message": message,
        "data": None,
        "code": code
    }, status=status_code)


def service_disabled_error_handler(request, exc: 'ServiceDisabledError'):
    """处理服务被禁用异常，返回结构化错误以便前端精确匹配"""
    return JsonResponse({
        "success": False,
        "message": "该服务已被组织管理员禁用",
        "data": {
            "service_key": getattr(exc, "service_key", ""),
            "organization_id": getattr(exc, "organization_id", ""),
        },
        "code": "SERVICE_DISABLED",
    }, status=403)


def _generic_exception_handler(request, exc: Exception):
    """兜底异常处理器：防止未捕获异常的 str(e) 泄露内部信息给客户端。"""
    logger.error("[UnhandledError] %s: %s", type(exc).__name__, exc, exc_info=True)
    # ninja 在这里把异常吞成 500 响应，got_request_exception 信号不会触发，
    # Sentry 的 Django 集成抓不到——必须显式上报（DSN 未配置时是 no-op）。
    from tabtin.sentry import capture_api_exception
    capture_api_exception(request, exc)
    return JsonResponse({
        "success": False,
        "message": "服务暂时不可用，请稍后重试",
        "data": None,
        "code": "INTERNAL_ERROR",
    }, status=500)


def _service_error_handler(request, exc):
    """ServiceError 处理器：将 Service 层结构化错误映射为 HTTP 响应。

    ServiceError 的 message 是由开发者显式编写的用户可见消息，
    与 _generic_exception_handler 不同，它会原样返回给客户端。
    """
    from apps.tabtinspace.services.base import ServiceError
    if not isinstance(exc, ServiceError):
        return _generic_exception_handler(request, exc)
    return JsonResponse({
        "success": False,
        "message": exc.message or "操作失败",
        "data": exc.data,
        "code": exc.code,
    }, status=exc.status)


def scene_call_error_handler(request, exc):
    """将 Scene 领域错误映射为稳定且脱敏的 HTTP 契约。"""
    from apps.services.llm.scenes.exceptions import SceneCallError, SceneDisabled

    if not isinstance(exc, SceneCallError):
        return _generic_exception_handler(request, exc)
    if isinstance(exc, SceneDisabled):
        message = str(exc)
    else:
        logger.error(
            "[SceneCallError] %s: %s",
            type(exc).__name__,
            exc,
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        message = "服务暂时不可用，请稍后重试"
    return JsonResponse({
        "success": False,
        "message": message,
        "data": {"scene_key": exc.scene_key} if exc.scene_key else None,
        "code": exc.error_code or "SCENE_CALL_ERROR",
    }, status=exc.http_status or 500)


def register_exception_handlers(api: NinjaAPI):
    """注册异常处理器"""
    from apps.services.billing.services.service_guard import ServiceDisabledError
    from apps.services.llm.scenes.exceptions import SceneCallError
    from apps.tabtinspace.services.base import ServiceError

    api.add_exception_handler(NinjaValidationError, validation_error_handler)
    api.add_exception_handler(ServiceDisabledError, service_disabled_error_handler)
    api.add_exception_handler(HttpError, http_error_handler)
    api.add_exception_handler(ServiceError, _service_error_handler)
    api.add_exception_handler(SceneCallError, scene_call_error_handler)
    api.add_exception_handler(Exception, _generic_exception_handler)

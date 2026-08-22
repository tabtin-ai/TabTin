"""
LLM API 模块共享常量与工具函数。

所有 api_*.py 文件共享的 HTTP 错误码映射、统一错误包装装饰器、Provider 判定工具
集中在此处，消除跨文件重复定义。
"""

import asyncio
import functools
import inspect
import logging
import re
from urllib.parse import urlparse

from django.http import JsonResponse
from ninja.errors import HttpError
from apps.i18n import _, get_text
from .services.billing import BudgetExceededException

logger = logging.getLogger(__name__)


_PROVIDER_KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
USER_MODEL_PREFERENCES_NAMESPACE = "llm_model_preferences"
USER_MODEL_DEFAULT_ID_KEY = "default_model_id"
USER_SUBAGENT_MODEL_POLICY_KEY = "subagent_model_policy"
USER_SUBAGENT_MODEL_ID_KEY = "subagent_model_id"


def _normalize_provider_key(value: str) -> str:
    normalized = (value or '').strip().lower()
    if not normalized:
        raise HttpError(400, get_text("llm.provider_key_required"))
    if not _PROVIDER_KEY_PATTERN.match(normalized):
        raise HttpError(400, get_text("llm.provider_key_invalid"))
    return normalized


def _normalize_base_url(value: str) -> str:
    normalized = (value or '').strip()
    if not normalized:
        raise HttpError(400, get_text("llm.base_url_required"))
    parsed = urlparse(normalized)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        raise HttpError(400, get_text("llm.base_url_invalid"))
    return normalized.rstrip('/')


def _get_organization_default_model_id(organization_id):
    """读取 organization.settings.llm_default_model_id；organization 不存在返回 None。

    放在 api_common 而非 api.py：让 api_config / api_admin_models 等子模块不必
    回头依赖 api.py，避免循环导入。
    """
    if not organization_id:
        return None
    from apps.tabtinspace.models import Organization
    try:
        organization = Organization.objects.get(id=organization_id)
    except Organization.DoesNotExist:
        return None
    ws_settings = organization.settings or {}
    return ws_settings.get('llm_default_model_id')


def _read_user_model_preference(user, organization_id: str, key: str) -> str:
    if not user or not organization_id:
        return ""
    from apps.users.auth.models import UserProfile
    profile = UserProfile.objects.filter(user=user).only("ui_settings").first()
    if profile is None:
        return ""
    ui_settings = profile.ui_settings or {}
    preferences = ui_settings.get(USER_MODEL_PREFERENCES_NAMESPACE)
    if not isinstance(preferences, dict):
        return ""
    organization_preferences = preferences.get(str(organization_id))
    if not isinstance(organization_preferences, dict):
        return ""
    model_id = organization_preferences.get(key)
    return str(model_id or "").strip()


def _write_user_model_preference(user, organization_id: str, key: str, model_id: str) -> None:
    from apps.users.auth.models import UserProfile
    profile, _ = UserProfile.objects.get_or_create(user=user)
    ui_settings = dict(profile.ui_settings or {})
    preferences = ui_settings.get(USER_MODEL_PREFERENCES_NAMESPACE)
    if not isinstance(preferences, dict):
        preferences = {}
    else:
        preferences = dict(preferences)
    organization_preferences = preferences.get(str(organization_id))
    if not isinstance(organization_preferences, dict):
        organization_preferences = {}
    else:
        organization_preferences = dict(organization_preferences)
    organization_preferences[key] = str(model_id)
    preferences[str(organization_id)] = organization_preferences
    ui_settings[USER_MODEL_PREFERENCES_NAMESPACE] = preferences
    profile.ui_settings = ui_settings
    profile.save(update_fields=["ui_settings", "updated_at"])


def _clear_user_model_preference(user, organization_id: str, key: str) -> None:
    if not user or not organization_id:
        return
    from apps.users.auth.models import UserProfile
    profile = UserProfile.objects.filter(user=user).only("ui_settings").first()
    if profile is None:
        return
    ui_settings = dict(profile.ui_settings or {})
    preferences = ui_settings.get(USER_MODEL_PREFERENCES_NAMESPACE)
    if not isinstance(preferences, dict):
        return
    preferences = dict(preferences)
    organization_preferences = preferences.get(str(organization_id))
    if not isinstance(organization_preferences, dict) or key not in organization_preferences:
        return
    organization_preferences = dict(organization_preferences)
    organization_preferences.pop(key, None)
    if organization_preferences:
        preferences[str(organization_id)] = organization_preferences
    else:
        preferences.pop(str(organization_id), None)
    if preferences:
        ui_settings[USER_MODEL_PREFERENCES_NAMESPACE] = preferences
    else:
        ui_settings.pop(USER_MODEL_PREFERENCES_NAMESPACE, None)
    profile.ui_settings = ui_settings
    profile.save(update_fields=["ui_settings", "updated_at"])


def _read_user_default_model_id(user, organization_id: str) -> str:
    return _read_user_model_preference(user, organization_id, USER_MODEL_DEFAULT_ID_KEY)


def _write_user_default_model_id(user, organization_id: str, model_id: str) -> None:
    _write_user_model_preference(user, organization_id, USER_MODEL_DEFAULT_ID_KEY, model_id)


def _clear_user_default_model_id(user, organization_id: str) -> None:
    _clear_user_model_preference(user, organization_id, USER_MODEL_DEFAULT_ID_KEY)


def _read_user_subagent_model_id(user, organization_id: str) -> str:
    return _read_user_model_preference(user, organization_id, USER_SUBAGENT_MODEL_ID_KEY)


def _read_user_subagent_model_policy(user, organization_id: str) -> str:
    policy = _read_user_model_preference(user, organization_id, USER_SUBAGENT_MODEL_POLICY_KEY)
    return policy if policy in {"inherit", "inherit_main", "fixed"} else "inherit"


def _write_user_subagent_model_policy(user, organization_id: str, policy: str) -> None:
    _write_user_model_preference(user, organization_id, USER_SUBAGENT_MODEL_POLICY_KEY, policy)


def _clear_user_subagent_model_policy(user, organization_id: str) -> None:
    _clear_user_model_preference(user, organization_id, USER_SUBAGENT_MODEL_POLICY_KEY)


def _write_user_subagent_model_id(user, organization_id: str, model_id: str) -> None:
    _write_user_model_preference(user, organization_id, USER_SUBAGENT_MODEL_ID_KEY, model_id)


def _clear_user_subagent_model_id(user, organization_id: str) -> None:
    _clear_user_model_preference(user, organization_id, USER_SUBAGENT_MODEL_ID_KEY)


def _serialize_organization_subagent_model_policy(organization) -> dict:
    """把 Organization.settings 投影成稳定的子 Agent 模型策略响应。"""
    ws_settings = getattr(organization, 'settings', None) or {}
    model_id = str(ws_settings.get('llm_subagent_model_id') or '').strip()
    return {
        'subagent_model_policy': 'fixed' if model_id else 'inherit',
        'subagent_model_id': model_id or None,
    }


def _get_organization_subagent_model_policy(organization_id) -> dict:
    """读取组织默认子 Agent 模型策略；缺省 / 组织不存在时安全回落 inherit。"""
    if not organization_id:
        return {'subagent_model_policy': 'inherit', 'subagent_model_id': None}
    from apps.tabtinspace.models import Organization
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return {'subagent_model_policy': 'inherit', 'subagent_model_id': None}
    return _serialize_organization_subagent_model_policy(organization)


def _clear_organization_default_model_id(organization_id, model_id: str) -> None:
    if not organization_id or not model_id:
        return
    from apps.tabtinspace.models import Organization
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return
    ws_settings = organization.settings or {}
    if ws_settings.get('llm_default_model_id') != model_id:
        return
    ws_settings.pop('llm_default_model_id', None)
    organization.settings = ws_settings
    organization.save(update_fields=['settings', 'updated_at'])


def _clear_organization_subagent_model_id(organization_id, model_id: str) -> None:
    """指定模型被删除时把子 Agent 策略安全降回 inherit。"""
    if not organization_id or not model_id:
        return
    from apps.tabtinspace.models import Organization
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return
    ws_settings = organization.settings or {}
    if ws_settings.get('llm_subagent_model_id') != model_id:
        return
    ws_settings.pop('llm_subagent_model_id', None)
    organization.settings = ws_settings
    organization.save(update_fields=['settings', 'updated_at'])


def _extract_token_limits(model_info: dict) -> dict:
    max_input = model_info.get('max_input_tokens')
    max_output = model_info.get('max_output_tokens')
    max_tokens = model_info.get('max_tokens')

    if max_input and max_output:
        context_window = max_input + max_output
    elif max_input:
        context_window = max_input
    elif max_tokens:
        context_window = max_tokens
    else:
        context_window = None

    return {
        'context_window_tokens': context_window,
        'max_input_tokens': max_input,
        'max_output_tokens': max_output or max_tokens,
    }

HTTP_CODE_MAP = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    503: "SERVICE_UNAVAILABLE",
}


def envelope_errors(func):
    """统一为端点函数添加 HttpError / Exception 捕获，保证错误始终走 ApiEnvelope 格式。

    用法::

        @router.post("/chat", auth=JWTAuth())
        @envelope_errors
        def chat(request, payload):
            ...
    """
    def _error_json(status_code: int, code: str, message: str) -> JsonResponse:
        return JsonResponse(
            {"success": False, "code": code, "message": message, "data": None},
            status=status_code,
        )

    if inspect.iscoroutinefunction(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            try:
                return await func(*args, **kwargs)
            except HttpError as he:
                return _error_json(
                    he.status_code,
                    HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"),
                    str(he),
                )
            except BudgetExceededException as be:
                logger.warning("预算阻断 organization=%s status=%s", be.organization_id, be.budget_status)
                return _error_json(403, "BUDGET_EXCEEDED", _("llm.budget_limit_reached"))
            except Exception as e:
                logger.error(f"{func.__name__} 异常: {e}", exc_info=True)
                return _error_json(500, "INTERNAL_ERROR", _("llm.internal_error"))
        return async_wrapper
    else:
        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except HttpError as he:
                return _error_json(
                    he.status_code,
                    HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"),
                    str(he),
                )
            except BudgetExceededException as be:
                logger.warning("预算阻断 organization=%s status=%s", be.organization_id, be.budget_status)
                return _error_json(403, "BUDGET_EXCEEDED", _("llm.budget_limit_reached"))
            except Exception as e:
                logger.error(f"{func.__name__} 异常: {e}", exc_info=True)
                return _error_json(500, "INTERNAL_ERROR", _("llm.internal_error"))
        return sync_wrapper


_LLM_ERROR_MESSAGES = {
    "RATE_LIMIT": "请求过于频繁，请稍后再试",
    "RATE_LIMITED": "请求过于频繁，请稍后再试",
    "AUTH_FAILED": "模型服务认证失败，请检查配置",
    "TOKEN_LIMIT": "输入内容超出模型上下文长度限制",
    "MODEL_NOT_FOUND": "请求的模型不可用",
    "TIMEOUT": "模型响应超时，请稍后重试",
    "PROVIDER_DOWN": "模型服务暂时不可用，请稍后重试",
    "VISION_ERROR": "图片处理失败",
    "SERVICE_ERROR": "服务内部异常，请稍后重试",
    "API_ERROR": "模型服务调用失败，请稍后重试",
    "CONTENT_FILTER": "内容触发安全过滤",
    "INVALID_REQUEST": "请求参数无效",
    "UNKNOWN_ERROR": "模型服务调用失败，请稍后重试",
    "LLM_ERROR": "模型服务调用失败，请稍后重试",
}

_KNOWN_ERROR_CODES = frozenset(_LLM_ERROR_MESSAGES.keys())

_DEFAULT_LLM_ERROR_MESSAGE = "模型服务调用失败，请稍后重试"


def sanitize_llm_error(result: dict) -> tuple:
    """从 service 层 result 中提取脱敏的错误信息和 HTTP 状态码。

    返回 (error_code, user_message, status_code) 三元组：
    - error_code: 白名单内的已知错误码，未知码一律映射为 ``LLM_ERROR``
    - user_message: 对终端用户安全的提示语，不包含内部异常详情
    - status_code: HTTP 状态码，429 直接透传；Provider 上游 4xx/5xx 一律
      映射为 502，避免 401/402/451 等被前端误判或泄露部署信息
    """
    raw_code = result.get("error_code") or "LLM_ERROR"
    upstream_status = result.get("status_code")

    if upstream_status == 429 or raw_code in ("RATE_LIMIT", "RATE_LIMITED"):
        return "RATE_LIMITED", _LLM_ERROR_MESSAGES["RATE_LIMITED"], 429

    safe_code = raw_code if raw_code in _KNOWN_ERROR_CODES else "LLM_ERROR"
    user_message = _LLM_ERROR_MESSAGES.get(safe_code, _DEFAULT_LLM_ERROR_MESSAGE)

    if safe_code == "AUTH_FAILED":
        return safe_code, user_message, 502

    if isinstance(upstream_status, int) and 400 <= upstream_status < 600:
        status_code = 502
    else:
        status_code = 500

    return safe_code, user_message, status_code


def provider_defaults_to_responses(provider) -> bool:
    """判断 Provider 是否默认启用 Responses API（OpenAI/Codex 系列）。"""
    provider_name = str(getattr(provider, "name", "") or "").strip().lower()
    provider_key = str(getattr(provider, "provider_key", "") or "").strip().lower()
    if provider_name in {"openai", "codex"}:
        return True
    if provider_key in {"codex", "openai-codex", "openai_codex"}:
        return True
    return False

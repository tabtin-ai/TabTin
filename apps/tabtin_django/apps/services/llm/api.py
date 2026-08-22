"""
LLM 服务 API 接口（主模块）

路由拆分：
- api.py          → 聊天、模型目录、健康检查、配置验证（本文件）
- api_async.py    → 异步接口 & 任务管理
- api_config.py   → 用户配置 & 组织配置 CRUD
"""

from ninja import Router
from ninja.errors import HttpError
from typing import List, Optional
from django.conf import settings
from datetime import datetime
from urllib.parse import urlparse
import logging
import time
import uuid

from apps.i18n import get_text
from apps.i18n.response import success_response, error_response_with_status
from apps.users.auth.permissions import JWTAuth

from .api_common import (
    envelope_errors,
    provider_defaults_to_responses,
    sanitize_llm_error,
    _normalize_provider_key,
    _normalize_base_url,
    _PROVIDER_KEY_PATTERN,
    _get_organization_default_model_id,
    _get_organization_subagent_model_policy,
    _read_user_subagent_model_id,
    _read_user_subagent_model_policy,
    _clear_organization_default_model_id,
    _extract_token_limits,
)
from .schemas import (
    ChatRequest, ChatVisionRequest,
    FundingPreviewRequest, ModelInfo, TokenEstimateRequest,
)
from .services import (
    get_llm_service,
    get_available_models,
    validate_provider_config,
)
from .services.litellm_model_info import LiteLLMModelInfoService
from .services.capability_guard import CHAT_MODEL_MODES
from .services.model_resolver import resolve_model
from .services.billing import charge_llm_usage
from .models import LLMModel
from .services.runtime import report_provider_call_result, resolve_provider_key_for_report
from .services.llm_metrics import llm_calls_total, llm_call_duration_seconds, _model_to_family
from .utils.capabilities import get_capability_flag, get_model_limit
from apps.services.billing.decorators import billing_required

logger = logging.getLogger(__name__)

router = Router()

jwt_auth = JWTAuth()


# ============ 共享辅助函数（供子模块 import） ============
# `_normalize_provider_key`/`_normalize_base_url`/`_PROVIDER_KEY_PATTERN`
# 以及 `_get_organization_default_model_id`/`_clear_organization_default_model_id`/
# `_extract_token_limits` 全部迁至 `api_common.py`，本文件仅
# `from .api_common import ...` 重新导出以保持向后兼容（避免循环导入：
#   api_admin_providers / api_admin_models -> api -> api_admin
#   -> api_admin_providers / api_admin_models）。


def _resolve_default_model(models: List[dict], organization_id: Optional[str]) -> Optional[dict]:
    """根据 organization 默认/系统默认/列表顺序解析默认模型"""
    default_model_id = _get_organization_default_model_id(organization_id)
    if default_model_id:
        return next((m for m in models if m['id'] == default_model_id), None)

    default_model_name = getattr(settings, 'DEFAULT_LLM_MODEL', 'gpt-4o')
    default_model = next((m for m in models if m.get('name') == default_model_name), None)
    if default_model:
        return default_model

    return models[0] if models else None


def _charge_llm_request_usage(
    *,
    llm_service,
    result: dict,
    user_id: str,
    organization_id: str = "",
    request_id: str,
) -> bool:
    """按实际 token 用量执行点券扣减；返回 False 时调用方不得交付内容。"""
    from .services.billed_call import safe_charge_usage
    return safe_charge_usage(
        llm_service=llm_service,
        result=result,
        user_id=user_id,
        organization_id=organization_id,
        source="llm_api",
        biz_id=f"llm_api:{request_id}",
    )


def _billing_charge_failed_result(request_id: str) -> dict:
    return {
        "success": False,
        "request_id": request_id,
        "error": "[billing_charge_failed] LLM 调用已完成但扣费失败，结果未交付。请稍后重试。",
        "error_code": "BILLING_CHARGE_FAILED",
        "error_category": "billing_charge_failed",
    }


# 权限工具统一由 permissions 模块提供，这里保留下划线别名以兼容子模块 import
from .permissions import (
    is_admin_user as _is_admin_user,
    require_auth_user_id as _require_auth_user_id,
    ensure_organization_permission as _ensure_organization_permission,
    resolve_effective_user_id as _resolve_effective_user_id,
    ensure_self_user_id as _ensure_self_user_id,
    ensure_admin_or_self as _ensure_admin_or_self,
)


def _get_providers_metadata() -> dict:
    """从 ProviderRegistry 获取 LLM Provider 元数据，失败时返回空字典。"""
    try:
        from apps.services.llm.registry import ProviderRegistry
        all_meta = ProviderRegistry.all_metadata()
        return {
            name: meta for name, meta in all_meta.items()
            if "llm" in meta.get("capability_domains", [])
        }
    except Exception:
        logger.debug("获取 Provider 元数据失败，Catalog API 将省略 providers 字段")
        return {}


def _get_platform_capabilities() -> dict:
    """聚合平台多模态 AI 能力信息，供 Catalog API 前端消费。

    各模态独立 try/except：某一模态查询失败不影响其他模态数据返回。
    """
    capabilities: dict = {}

    # TTS
    try:
        from apps.services.speech.tts.factory import TTSServiceFactory
        supported = TTSServiceFactory.get_supported_providers()
        if supported:
            voices: list[dict] = []
            try:
                from apps.services.llm.models import LLMModel
                # v0.1：mode 字段已删（0022），按 capability_domain='tts' 过滤；
                # is_active 字段已删，wave_status='ready' 表达"可用"。
                tts_models = LLMModel.objects.filter(
                    capability_domain="tts",
                    wave_status="ready",
                    provider__routing_enabled=True,
                )
                for m in tts_models:
                    caps = m.capabilities_config or {}
                    default_speaker = caps.get("default_speaker", "")
                    if default_speaker:
                        voices.append({
                            "id": default_speaker,
                            "provider": getattr(m.provider, "name", ""),
                        })
            except Exception:
                pass
            capabilities["tts"] = {
                "providers": list(supported.keys()),
                "modes": supported,
                "voices": voices,
            }
    except Exception:
        logger.debug("获取 TTS 能力信息失败")

    # 图片/视频生成
    try:
        from apps.services.media_generation.services.factory import get_available_models as get_media_models
        all_media = get_media_models()
        image_models = [m for m in all_media if m.get("task_type", "").startswith(("text2image", "image2image", "image_edit"))]
        video_models = [m for m in all_media if m.get("task_type", "").startswith(("text2video", "image2video", "video_edit"))]

        if image_models:
            capabilities["image_gen"] = {
                "providers": list({m.get("provider", "") for m in image_models}),
                "models": [
                    {
                        "id": m.get("id"),
                        "model_name": m.get("model_name"),
                        "display_name": m.get("display_name"),
                        "task_type": m.get("task_type"),
                        "supported_sizes": m.get("supported_sizes", []),
                    }
                    for m in image_models
                ],
            }
        if video_models:
            capabilities["video_gen"] = {
                "providers": list({m.get("provider", "") for m in video_models}),
                "models": [
                    {
                        "id": m.get("id"),
                        "model_name": m.get("model_name"),
                        "display_name": m.get("display_name"),
                        "task_type": m.get("task_type"),
                        "supported_sizes": m.get("supported_sizes", []),
                        "supported_durations": m.get("supported_durations", []),
                    }
                    for m in video_models
                ],
            }
    except Exception:
        logger.debug("获取媒体生成能力信息失败")

    # BGM
    try:
        from apps.services.music.factory import MusicServiceFactory as BGMServiceFactory
        bgm_providers = BGMServiceFactory.get_supported_providers()
        if bgm_providers:
            capabilities["bgm"] = {
                "providers": bgm_providers,
            }
    except Exception:
        logger.debug("获取 BGM 能力信息失败")

    # ASR
    try:
        from apps.services.speech.asr.factory import ASRServiceFactory
        asr_supported = ASRServiceFactory.get_supported_providers()
        if asr_supported:
            capabilities["asr"] = {
                "providers": list(asr_supported.keys()),
                "modes": asr_supported,
            }
    except Exception:
        logger.debug("获取 ASR 能力信息失败")

    return capabilities


def _extract_user_prompt(messages: List[dict]) -> str:
    """提取用户提示词"""
    user_messages = [msg.get('content') for msg in messages if msg.get('role') == 'user']
    if not user_messages:
        return ""
    last_message = user_messages[-1]
    if isinstance(last_message, str):
        return last_message
    return str(last_message)


_PROVIDER_OPTIONS_BLOCKLIST = frozenset({
    "api_key", "api_base", "base_url", "api_version",
    "api_secret", "secret_key", "access_token", "authorization",
    "organization", "project",
    "model", "stream", "messages",
    "timeout", "max_retries",
    "http_client", "default_headers",
})


def _build_chat_kwargs(payload) -> dict:
    default_prompt_cache_retention = getattr(settings, "LLM_PROMPT_CACHE_DEFAULT_RETENTION", None)
    kwargs = {
        'temperature': payload.temperature,
        'max_tokens': payload.max_tokens,
    }

    for attr in ('top_p', 'frequency_penalty', 'presence_penalty'):
        val = getattr(payload, attr, None)
        if val is not None:
            kwargs[attr] = val

    optional_fields = {
        'response_format': payload.response_format,
        'functions': payload.functions,
        'function_call': payload.function_call,
        'tools': payload.tools,
        'tool_choice': payload.tool_choice,
        'thinking': payload.thinking,
        'metadata': payload.metadata,
        'api_variant': payload.api_variant,
        'use_responses_api': payload.use_responses_api,
        'previous_response_id': payload.previous_response_id,
        'store': payload.store,
        'include': payload.include,
        'prompt_cache_key': payload.prompt_cache_key,
        'prompt_cache_retention': payload.prompt_cache_retention or default_prompt_cache_retention,
    }
    for key, value in optional_fields.items():
        if value is not None:
            kwargs[key] = value

    if isinstance(payload.provider_options, dict):
        filtered = {
            k: v for k, v in payload.provider_options.items()
            if k not in _PROVIDER_OPTIONS_BLOCKLIST
        }
        kwargs.update(filtered)

    return kwargs


def _extract_response_format_type(response_format) -> Optional[str]:
    """从 string 或 dict 形式的 response_format 中提取 type。"""
    if isinstance(response_format, str):
        return response_format
    if isinstance(response_format, dict):
        return response_format.get("type")
    return None


def _validate_chat_capabilities(model_instance: LLMModel, payload: ChatRequest) -> None:
    """请求前能力校验（同步 chat）。"""
    # v0.1：模型硬开关已统一进 capabilities_config
    capabilities = model_instance.capabilities_config or {}
    stream_supported = bool(
        capabilities.get("wire", {}).get("stream_supported", True)
    )
    if payload.stream and not stream_supported:
        raise HttpError(400, get_text("llm.capability_streaming_disabled", model=model_instance.model_name))

    has_tool_payload = bool(payload.tools or payload.functions or payload.function_call or payload.tool_choice)
    supports_tool_use = get_capability_flag(model_instance, "supports_function_calling", default=False)
    if has_tool_payload and not supports_tool_use:
        raise HttpError(400, get_text("llm.capability_function_calling_disabled", model=model_instance.model_name))

    rf_type = _extract_response_format_type(payload.response_format)
    if rf_type in ("json_object", "json_schema"):
        if not get_capability_flag(model_instance, "supports_json_mode", default=False):
            raise HttpError(400, get_text("llm.capability_json_mode_disabled", model=model_instance.model_name))

    if payload.thinking is not None:
        if not get_capability_flag(model_instance, "supports_reasoning", default=False):
            raise HttpError(400, get_text("llm.capability_reasoning_disabled", model=model_instance.model_name))

    requested_responses = (
        (payload.api_variant or "").strip().lower() in {"responses", "response"}
        or payload.use_responses_api is True
    )
    if requested_responses:
        supports_responses = get_capability_flag(
            model_instance,
            "supports_responses_api",
            default=provider_defaults_to_responses(model_instance.provider),
        )
        if not supports_responses:
            raise HttpError(400, get_text("llm.capability_responses_api_disabled", model=model_instance.model_name))

    if payload.documents:
        if not get_capability_flag(model_instance, "supports_document_input", default=False):
            raise HttpError(400, get_text("llm.capability_document_input_disabled", model=model_instance.model_name))
        max_docs = get_model_limit(model_instance, "max_documents_per_request")
        if max_docs is not None and max_docs > 0 and len(payload.documents) > max_docs:
            raise HttpError(400, get_text("llm.capability_document_limit_exceeded", model=model_instance.model_name, max=max_docs))


def _extract_image_format(image: str) -> Optional[str]:
    raw = (image or "").strip().lower()
    if not raw:
        return None
    if raw.startswith("data:image/"):
        # data:image/png;base64,xxxx
        try:
            return raw.split("data:image/", 1)[1].split(";", 1)[0].strip(".")
        except Exception:
            return None
    if raw.startswith("http://") or raw.startswith("https://"):
        path = urlparse(raw).path or ""
        if "." not in path:
            return None
        return path.rsplit(".", 1)[-1].lower().strip(".")
    return None


def _validate_vision_capabilities(model_instance: LLMModel, payload: ChatVisionRequest) -> None:
    """请求前能力校验（vision）。"""
    # v0.1：vision 能力进 capabilities_config.image.enabled / capability_domain='vision'。
    capabilities = model_instance.capabilities_config or {}
    supports_vision = bool(capabilities.get("image", {}).get("enabled", False))
    if not supports_vision and model_instance.capability_domain != "vision":
        raise HttpError(400, get_text("llm.capability_vision_disabled", model=model_instance.model_name))

    has_tool_payload = bool(payload.tools or payload.functions or payload.function_call or payload.tool_choice)
    if has_tool_payload and not get_capability_flag(model_instance, "supports_function_calling", default=False):
        raise HttpError(400, get_text("llm.capability_function_calling_disabled", model=model_instance.model_name))
    rf_type = _extract_response_format_type(payload.response_format)
    if rf_type in ("json_object", "json_schema"):
        if not get_capability_flag(model_instance, "supports_json_mode", default=False):
            raise HttpError(400, get_text("llm.capability_json_mode_disabled", model=model_instance.model_name))
    if payload.thinking is not None:
        if not get_capability_flag(model_instance, "supports_reasoning", default=False):
            raise HttpError(400, get_text("llm.capability_reasoning_disabled", model=model_instance.model_name))

    requested_responses = (
        (payload.api_variant or "").strip().lower() in {"responses", "response"}
        or payload.use_responses_api is True
    )
    if requested_responses:
        supports_responses = get_capability_flag(
            model_instance,
            "supports_responses_api",
            default=provider_defaults_to_responses(model_instance.provider),
        )
        if not supports_responses:
            raise HttpError(400, get_text("llm.capability_responses_api_disabled", model=model_instance.model_name))

    # v0.1：max_images_per_request / supported_image_formats 字段已删（0022），
    # 改进 capabilities_config.image.{max_images_per_request, supported_formats}。
    image_caps = capabilities.get("image", {}) or {}
    max_images = int(image_caps.get("max_images_per_request") or 0)
    if max_images > 0 and len(payload.image_urls) > max_images:
        raise HttpError(400, get_text("llm.capability_image_limit_exceeded", model=model_instance.model_name, max=max_images))

    allowed_formats = {
        fmt.strip(".").lower()
        for fmt in (image_caps.get("supported_formats") or [])
        if fmt
    }
    if not allowed_formats:
        return

    for image_url in payload.image_urls:
        detected_format = _extract_image_format(image_url)
        if detected_format and detected_format not in allowed_formats:
            allowed = ", ".join(sorted(allowed_formats))
            raise HttpError(400, get_text("llm.capability_image_format_unsupported", model=model_instance.model_name, format=detected_format, allowed=allowed))


# ============ 聊天接口 ============


def _chat_billing_skip_layers() -> frozenset[str]:
    """Return the financial checks that do not apply to Community BYOK chat."""
    from apps.services.billing.services.billing_precheck import (
        LAYER_BALANCE,
        LAYER_GUARD,
        LAYER_SERVICE_GUARD,
    )

    layers = {LAYER_GUARD, LAYER_SERVICE_GUARD}
    if settings.TABTIN_EDITION == "community":
        layers.add(LAYER_BALANCE)
    return frozenset(layers)


@router.post("/chat", auth=jwt_auth, tags=["Chat"])
@envelope_errors
@billing_required(service_key="llm.chat", skip_balance_check=True)
def chat(request, payload: ChatRequest):
    """
    聊天接口

    支持多种LLM模型的同步对话功能。
    同步视图由 ASGI 运行在线程中，确保计费、权限与模型解析的同步 ORM
    不会落入 async context；上游同步 SDK 调用也留在同一请求线程。
    """
    request_id = str(uuid.uuid4())
    model_instance = None
    llm_service = None

    try:
        effective_user_id = _resolve_effective_user_id(
            request,
            payload.user_id,
            organization_id=payload.organization_id,
        )

        model_instance = resolve_model(
            model_id=payload.model_id,
            model_name=payload.model,
            organization_id=payload.organization_id,
            user_id=effective_user_id,
            require_active=True,
            allowed_modes=CHAT_MODEL_MODES,
        )
        if not model_instance:
            raise HttpError(400, get_text("chat.model_not_found", model_id=payload.model_id or payload.model))
        _validate_chat_capabilities(model_instance, payload)

        _provider_key = getattr(getattr(model_instance, "provider", None), "provider_key", "") or ""
        _model_name = getattr(model_instance, "model_name", "") or ""

        from apps.services.billing.services.billing_precheck import billing_precheck
        from apps.services.billing.services.member_budget_service import MemberBudgetService
        from apps.services.llm.services.billed_call import build_precheck_error, build_budget_error, build_member_budget_error

        resolved_wt = getattr(request, "_billing_organization_id", "") or payload.organization_id or ""
        _user_role = MemberBudgetService.resolve_user_role(resolved_wt, effective_user_id) if resolved_wt else None

        precheck_result = billing_precheck(
            resolved_wt, effective_user_id,
            context="llm_chat",
            skip_layers=_chat_billing_skip_layers(),
            user_role=_user_role,
            model_cost_tier=MemberBudgetService.compute_model_cost_tier(model_instance),
        )
        if precheck_result.blocked:
            _blocked_status = {
                "budget": "budget_blocked", "member_budget": "member_budget_blocked",
            }.get(precheck_result.layer, "balance_blocked")
            llm_calls_total.labels(provider=_provider_key, model_family=_model_to_family(_model_name), source="llm_api", status=_blocked_status).inc()
            if precheck_result.layer == "budget":
                err = build_budget_error()
            elif precheck_result.layer == "member_budget":
                _detail = precheck_result.get_raw_detail_dict()
                _detail["error_category"] = precheck_result.error_category
                _detail["error_code"] = precheck_result.error_code
                err = build_member_budget_error(billing_result=_detail)
            else:
                err = build_precheck_error(billing_result=precheck_result.get_raw_detail_dict())
            return 403, {
                **err,
                "code": err["error_code"],
                "message": err["error"],
                "data": precheck_result.get_raw_detail_dict(),
            }

        logger.info("[%s] Starting chat request", request_id, extra={
            'request_id': request_id,
            'model': payload.model or model_instance.model_name,
            'model_id': str(model_instance.id),
            'user_id': effective_user_id,
            'message_count': len(payload.messages)
        })

        llm_service = get_llm_service(
            model_id=str(model_instance.id),
            user_id=effective_user_id,
            organization_id=resolved_wt,
        )

        messages = [msg.dict() for msg in payload.messages]
        chat_kwargs = _build_chat_kwargs(payload)

        def _run_chat_sync():
            _call_start = time.perf_counter()

            _chat_provider = getattr(llm_service, 'provider', None)
            _chat_provider_key = getattr(llm_service, 'provider_key', None)
            if _chat_provider and _chat_provider_key is not None:
                from .services.failover_executor import chat_with_failover
                # v0.1.x Phase 2.5：base_url 从 model 取（Provider.base_url 已删）
                result = chat_with_failover(
                    provider_id=str(_chat_provider.id),
                    provider_name=_chat_provider.name,
                    base_url=model_instance.base_url,
                    model_name=model_instance.model_name,
                    messages=messages,
                    **chat_kwargs,
                )
            else:
                result = llm_service.chat(messages=messages, **chat_kwargs)

            _call_elapsed = time.perf_counter() - _call_start

            llm_call_duration_seconds.labels(provider=_provider_key, model_family=_model_to_family(_model_name)).observe(_call_elapsed)
            llm_calls_total.labels(
                provider=_provider_key, model_family=_model_to_family(_model_name), source="llm_api",
                status="success" if result.get('success') else "failed",
            ).inc()

            if result.get('success'):
                charged = _charge_llm_request_usage(
                    llm_service=llm_service,
                    result=result,
                    user_id=effective_user_id,
                    organization_id=resolved_wt,
                    request_id=request_id,
                )
                if not charged:
                    result = _billing_charge_failed_result(request_id)
            else:
                # v0.1 Wave B2：HTTP /chat 视为主对话路径 → scene_key='_main_chat'
                from .services.usage_tracking import (
                    derive_scope_and_cost_status,
                    record_usage_fact_from_dict_safely,
                )
                _scope, _cost_status = derive_scope_and_cost_status(model_instance, "failed")
                record_usage_fact_from_dict_safely(
                    request_id=request_id,
                    scene_key="_main_chat",
                    capability_domain="chat",
                    effective_provider_scope=_scope,
                    cost_status=_cost_status,
                    user_id=effective_user_id,
                    organization_id=resolved_wt,
                    model_id=str(model_instance.id),
                    provider_key=_provider_key,
                    model_name=_model_name,
                    status="failed",
                    error_code=str(result.get('error_code') or '')[:100],
                )

            _pkey = resolve_provider_key_for_report(llm_service, result)
            _total_t = int((result.get('usage') or {}).get('total_tokens', 0) or 0)
            report_provider_call_result(
                model_instance.provider,
                success=bool(result.get('success')),
                latency_seconds=result.get('response_time'),
                error_message=result.get('error') or '',
                provider_key_obj=_pkey,
                tokens=_total_t,
            )
            return result

        result = _run_chat_sync()

        logger.info("[%s] Chat request completed", request_id, extra={
            'request_id': request_id,
            'success': result.get('success', False),
            'tokens': result.get('usage', {}).get('total_tokens', 0)
        })

        if result.get('success'):
            return success_response(data={
                "content": result.get('content'),
                "usage": result.get('usage'),
                "cost": result.get('cost'),
                "response_time": result.get('response_time'),
                "model": result.get('model'),
                "finish_reason": result.get('finish_reason'),
                "request_id": request_id,
            })
        else:
            err_code, err_msg, err_status = sanitize_llm_error(result)
            logger.warning(
                "[%s] LLM call failed: code=%s raw=%s",
                request_id, err_code, result.get('error', ''),
            )
            return error_response_with_status(
                err_code,
                message=err_msg,
                status_code=err_status,
                data={"request_id": request_id, "model": result.get('model')},
            )

    except Exception as exc:
        _is_client_error = isinstance(exc, HttpError) and 400 <= exc.status_code < 500
        if model_instance is not None and not _is_client_error:
            try:
                from .services.usage_tracking import (
                    derive_scope_and_cost_status,
                    record_usage_fact_from_dict_safely,
                )
                _scope, _cost_status = derive_scope_and_cost_status(model_instance, "failed")
                record_usage_fact_from_dict_safely(
                    request_id=request_id,
                    scene_key="_main_chat",
                    capability_domain="chat",
                    effective_provider_scope=_scope,
                    cost_status=_cost_status,
                    user_id=effective_user_id,
                    organization_id=resolved_wt,
                    model_id=str(model_instance.id),
                    status="failed",
                    error_code=type(exc).__name__,
                )
            except Exception:
                logger.warning("[%s] Failed to record usage fact after chat error", request_id, exc_info=True)
            _pkey = getattr(llm_service, 'provider_key', None) if llm_service else None
            report_provider_call_result(
                model_instance.provider,
                success=False,
                latency_seconds=None,
                error_message='Internal service error',
                error=exc,
                provider_key_obj=_pkey,
            )
        raise


@router.post("/chat-vision", auth=jwt_auth, tags=["图片聊天"])
@envelope_errors
@billing_required(service_key="llm.chat", skip_balance_check=True)
async def chat_vision(request, payload: ChatVisionRequest):
    """
    图片聊天接口

    支持图片输入的对话功能。
    async + run_in_executor 确保 LLM 调用不阻塞 ASGI 事件循环。
    """
    from apps.services.common.executor import run_in_agent_executor
    request_id = str(uuid.uuid4())
    model_instance = None
    llm_service = None

    try:
        effective_user_id = _resolve_effective_user_id(
            request,
            payload.user_id,
            organization_id=payload.organization_id,
        )

        model_instance = resolve_model(
            model_id=payload.model_id,
            model_name=payload.model,
            organization_id=payload.organization_id,
            user_id=effective_user_id,
            require_active=True,
            allowed_modes=CHAT_MODEL_MODES,
        )
        if not model_instance:
            raise HttpError(400, get_text("chat.model_not_found", model_id=payload.model_id or payload.model))
        _validate_vision_capabilities(model_instance, payload)

        _provider_key = getattr(getattr(model_instance, "provider", None), "provider_key", "") or ""
        _model_name = getattr(model_instance, "model_name", "") or ""

        from apps.services.billing.services.billing_precheck import billing_precheck, LAYER_GUARD, LAYER_SERVICE_GUARD
        from apps.services.billing.services.member_budget_service import MemberBudgetService
        from apps.services.llm.services.billed_call import build_precheck_error, build_budget_error, build_member_budget_error

        resolved_wt = getattr(request, "_billing_organization_id", "") or payload.organization_id or ""
        _user_role = MemberBudgetService.resolve_user_role(resolved_wt, effective_user_id) if resolved_wt else None

        precheck_result = billing_precheck(
            resolved_wt, effective_user_id,
            context="llm_chat_vision",
            skip_layers=frozenset({LAYER_GUARD, LAYER_SERVICE_GUARD}),
            user_role=_user_role,
            model_cost_tier=MemberBudgetService.compute_model_cost_tier(model_instance),
        )
        if precheck_result.blocked:
            _blocked_status = {
                "budget": "budget_blocked", "member_budget": "member_budget_blocked",
            }.get(precheck_result.layer, "balance_blocked")
            llm_calls_total.labels(provider=_provider_key, model_family=_model_to_family(_model_name), source="llm_api", status=_blocked_status).inc()
            if precheck_result.layer == "budget":
                err = build_budget_error()
            elif precheck_result.layer == "member_budget":
                _detail = precheck_result.get_raw_detail_dict()
                _detail["error_category"] = precheck_result.error_category
                _detail["error_code"] = precheck_result.error_code
                err = build_member_budget_error(billing_result=_detail)
            else:
                err = build_precheck_error(billing_result=precheck_result.get_raw_detail_dict())
            return 403, {
                **err,
                "code": err["error_code"],
                "message": err["error"],
                "data": precheck_result.get_raw_detail_dict(),
            }

        logger.info("[%s] Starting vision chat request", request_id, extra={
            'request_id': request_id,
            'model': payload.model or model_instance.model_name,
            'model_id': str(model_instance.id),
            'image_count': len(payload.image_urls)
        })

        llm_service = get_llm_service(
            model_id=str(model_instance.id),
            user_id=effective_user_id,
            organization_id=resolved_wt,
        )

        messages = [msg.dict() for msg in payload.messages]
        vision_chat_kwargs = _build_chat_kwargs(payload)

        def _run_vision_chat_sync():
            _call_start = time.perf_counter()
            _vision_provider = getattr(llm_service, 'provider', None)
            _vision_pkey = getattr(llm_service, 'provider_key', None)
            if _vision_provider and _vision_pkey is not None:
                from .services.failover_executor import vision_chat_with_failover
                # v0.1.x Phase 2.5：base_url 从 model 取（Provider.base_url 已删）
                result = vision_chat_with_failover(
                    provider_id=str(_vision_provider.id),
                    provider_name=_vision_provider.name,
                    base_url=model_instance.base_url,
                    model_name=model_instance.model_name,
                    messages=messages,
                    images=payload.image_urls,
                    **vision_chat_kwargs,
                )
            else:
                result = llm_service.chat_with_images(
                    messages=messages,
                    images=payload.image_urls,
                    **vision_chat_kwargs
                )
            _call_elapsed = time.perf_counter() - _call_start

            llm_call_duration_seconds.labels(provider=_provider_key, model_family=_model_to_family(_model_name)).observe(_call_elapsed)
            llm_calls_total.labels(
                provider=_provider_key, model_family=_model_to_family(_model_name), source="llm_api",
                status="success" if result.get('success') else "failed",
            ).inc()

            if result.get('success'):
                charged = _charge_llm_request_usage(
                    llm_service=llm_service,
                    result=result,
                    user_id=effective_user_id,
                    organization_id=resolved_wt,
                    request_id=request_id,
                )
                if not charged:
                    result = _billing_charge_failed_result(request_id)
            else:
                # v0.1 Wave B2：HTTP /chat-vision 直调主对话 → 视为 _main_chat（capability=chat）
                # 走 capability_domain='chat' 而非 'vision'：vision_service.parse 才是 vision 入口；
                # /chat-vision 是 chat 模型 + image content block，本质仍是 chat。
                from .services.usage_tracking import (
                    derive_scope_and_cost_status,
                    record_usage_fact_from_dict_safely,
                )
                _scope, _cost_status = derive_scope_and_cost_status(model_instance, "failed")
                record_usage_fact_from_dict_safely(
                    request_id=request_id,
                    scene_key="_main_chat",
                    capability_domain="chat",
                    effective_provider_scope=_scope,
                    cost_status=_cost_status,
                    user_id=effective_user_id,
                    organization_id=resolved_wt,
                    model_id=str(model_instance.id),
                    provider_key=_provider_key,
                    model_name=_model_name,
                    status="failed",
                    error_code=str(result.get('error_code') or '')[:100],
                )

            _pkey = resolve_provider_key_for_report(llm_service, result)
            _total_t = int((result.get('usage') or {}).get('total_tokens', 0) or 0)
            report_provider_call_result(
                model_instance.provider,
                success=bool(result.get('success')),
                latency_seconds=result.get('response_time'),
                error_message=result.get('error') or '',
                provider_key_obj=_pkey,
                tokens=_total_t,
            )
            return result

        result = await run_in_agent_executor(_run_vision_chat_sync)

        logger.info("[%s] Vision chat completed", request_id)

        if result.get('success'):
            return success_response(data={
                "content": result.get('content'),
                "usage": result.get('usage'),
                "cost": result.get('cost'),
                "response_time": result.get('response_time'),
                "model": result.get('model'),
                "finish_reason": result.get('finish_reason'),
                "request_id": request_id,
            })
        else:
            err_code, err_msg, err_status = sanitize_llm_error(result)
            logger.warning(
                "[%s] LLM vision call failed: code=%s raw=%s",
                request_id, err_code, result.get('error', ''),
            )
            return error_response_with_status(
                err_code,
                message=err_msg,
                status_code=err_status,
                data={"request_id": request_id, "model": result.get('model')},
            )

    except Exception as exc:
        _is_client_error = isinstance(exc, HttpError) and 400 <= exc.status_code < 500
        if model_instance is not None and not _is_client_error:
            try:
                from .services.usage_tracking import (
                    derive_scope_and_cost_status,
                    record_usage_fact_from_dict_safely,
                )
                _scope, _cost_status = derive_scope_and_cost_status(model_instance, "failed")
                record_usage_fact_from_dict_safely(
                    request_id=request_id,
                    scene_key="_main_chat",
                    capability_domain="chat",
                    effective_provider_scope=_scope,
                    cost_status=_cost_status,
                    user_id=effective_user_id,
                    organization_id=resolved_wt,
                    model_id=str(model_instance.id),
                    status="failed",
                    error_code=type(exc).__name__,
                )
            except Exception:
                logger.warning("[%s] Failed to record usage fact after vision chat error", request_id, exc_info=True)
            _pkey = getattr(llm_service, 'provider_key', None) if llm_service else None
            report_provider_call_result(
                model_instance.provider,
                success=False,
                latency_seconds=None,
                error_message='Internal service error',
                error=exc,
                provider_key_obj=_pkey,
            )
        raise


@router.post("/estimate-tokens", auth=jwt_auth, tags=["Model Management"])
@envelope_errors
def estimate_tokens(request, payload: TokenEstimateRequest):
    """Token 估算接口（支持渠道原生估算与本地回退）。"""
    _ensure_organization_permission(request, payload.organization_id, role='viewer')

    effective_user_id = _resolve_effective_user_id(
        request,
        payload.user_id,
        organization_id=payload.organization_id,
    )

    model_instance = resolve_model(
        model_id=payload.model_id,
        model_name=payload.model,
        organization_id=payload.organization_id,
        user_id=effective_user_id,
        require_active=True,
        allowed_modes=CHAT_MODEL_MODES,
    )
    if not model_instance:
        raise HttpError(400, get_text("chat.model_not_found", model_id=payload.model_id or payload.model))

    llm_service = get_llm_service(
        model_id=str(model_instance.id),
        user_id=effective_user_id,
        organization_id=payload.organization_id,
    )
    messages = [msg.dict() for msg in payload.messages]
    estimate = llm_service.estimate_tokens(
        messages=messages,
        prefer_provider_api=payload.prefer_provider_api,
    )

    billing_type = model_instance.billing_type or "token"
    estimated_cost = None
    cost_unavailable_reason = None
    if billing_type == "token":
        cost = llm_service._calculate_cost_from_usage(
            {
                "input_tokens": estimate.get("input_tokens", 0),
                "output_tokens": 0,
                "total_tokens": estimate.get("total_tokens", 0),
            }
        )
        estimated_cost = {
            "input_cost": float(cost.get("input_cost", 0)),
            "output_cost": float(cost.get("output_cost", 0)),
            "total_cost": float(cost.get("total_cost", 0)),
        }
    else:
        cost_unavailable_reason = f"billing_type '{billing_type}' does not support token-based cost estimation"

    return success_response(
        data={
            "model_id": str(model_instance.id),
            "model_name": model_instance.model_name,
            "provider": model_instance.provider.name,
            "billing_type": billing_type,
            "estimate": estimate,
            "estimated_cost": estimated_cost,
            "cost_unavailable_reason": cost_unavailable_reason,
        },
        message="Token estimation successful",
    )


# ============ 模型目录 ============


def _filter_models_by_member_policy(
    models: List[dict],
    organization_id: str,
    user_id: str,
) -> List[dict]:
    """委托给 factory.filter_models_by_member_tier（单一实现）。"""
    from .services.factory import filter_models_by_member_tier
    return filter_models_by_member_tier(models, organization_id, user_id)


# 子 Agent 模型自由度（Phase 4）：成本档 → 用户面语义标签。
# 成本档复用计费侧 MemberBudgetService.compute_model_cost_tier 的同一套阈值
# （standard/premium/enterprise），保证「菜单语义」与「tier 管控」口径一致。
_COST_TIER_LABEL = {
    'standard': '便宜/快',
    'premium': '均衡',
    'enterprise': '强/贵',
}


def _derive_usage_hint(model: dict) -> str:
    """为目录里的模型自动生成「语义用途标签」，供主 Agent 给子 Agent 选型。

    优先级：capabilities_config.usage_hint（运营手填的一个用途词）> 自动派生。
    自动派生只用结构化能力字段（成本档 / 上下文窗口 / 视觉），不产出自由文案，
    避免运营双轨维护（PRD §4 决策三、开放问题 3）。
    """
    caps_cfg = model.get('capabilities_config') or {}
    explicit = caps_cfg.get('usage_hint')
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()

    tags: List[str] = []
    try:
        from apps.services.billing.services.member_budget_service import MemberBudgetService
        cost_tier = MemberBudgetService.compute_model_cost_tier(
            model.get('cost_per_1k_tokens', 0) or 0
        )
    except Exception:
        cost_tier = 'standard'
    tags.append(_COST_TIER_LABEL.get(cost_tier, '均衡'))

    ctx = model.get('context_window_tokens') or 0
    if ctx and ctx >= 200_000:
        tags.append('长上下文')

    resolved_caps = model.get('resolved_capabilities') or {}
    if resolved_caps.get('supports_vision'):
        tags.append('视觉')

    return ' / '.join(tags)


@router.get("/catalog", auth=jwt_auth, tags=["Model Management"])
@envelope_errors
def get_model_catalog(
    request,
    organization_id: str,
    user_id: Optional[str] = None,
    use_case: Optional[str] = None,
    include_declared: bool = False,
):
    """
    统一模型目录入口

    use_case 支持: chat | ai | vision | embedding
    """
    user_id = _ensure_self_user_id(request, user_id, organization_id=organization_id)
    _ensure_organization_permission(request, organization_id, role='viewer')

    models = get_available_models(
        user_id=user_id,
        organization_id=organization_id,
        include_declared=include_declared,
    )

    # 成员级模型等级过滤
    if organization_id and user_id:
        models = _filter_models_by_member_policy(models, organization_id, user_id)

    # v0.1：catalog 过滤改用 capability_domain（mode/supports_vision 已删）。
    # 兼容期：use_case in {chat,ai,vision,embedding} 仍接受，映射到 capability_domain。
    normalized_use_case = (use_case or '').strip().lower()
    domain_filter = {
        'chat': 'chat',
        'ai': 'chat',
        'vision': 'vision',
        'embedding': 'embedding',
    }.get(normalized_use_case)
    if domain_filter:
        models = [m for m in models if m.get('capability_domain') == domain_filter]

    # 子 Agent 模型自由度（Phase 4）：给每个模型补「语义用途标签」，注入到主 Agent
    # 的可用模型清单里供选型。自动生成（不让运营手写自由文案）。
    for m in models:
        m['usage_hint'] = _derive_usage_hint(m)

    model_infos = [ModelInfo(**model) for model in models]
    default_model = _resolve_default_model(models, organization_id)
    organization_subagent_policy = _get_organization_subagent_model_policy(organization_id)
    user_subagent_model_id = _read_user_subagent_model_id(request.auth, organization_id)
    user_subagent_policy = _read_user_subagent_model_policy(request.auth, organization_id)
    user_subagent_model = None
    if user_subagent_model_id:
        user_subagent_model = next(
            (
                m for m in models
                if str(m.get("id") or "") == user_subagent_model_id
                and m.get("capability_domain") == "chat"
            ),
            None,
        )
    user_subagent_policy = "fixed" if user_subagent_model else ("inherit" if user_subagent_model_id else user_subagent_policy)
    effective_subagent_model_id = None
    if user_subagent_model:
        effective_subagent_model_id = str(user_subagent_model.get("id"))
    elif user_subagent_policy != "inherit_main":
        effective_subagent_model_id = organization_subagent_policy["subagent_model_id"]
    effective_subagent_policy = "fixed" if effective_subagent_model_id else "inherit"

    providers_metadata = _get_providers_metadata()
    capabilities = _get_platform_capabilities()

    serialized_models = [m.model_dump() for m in model_infos]
    if getattr(settings, "PROVIDER_CREDIT_UI_ENABLED", False):
        from apps.services.billing.services.provider_credit_capability import (
            ProviderCreditCapabilityService,
        )

        promotion_projection_available = True
        try:
            promotions_by_model_id = (
                ProviderCreditCapabilityService.get_model_promotion_credits(
                    organization=organization_id,
                    models=models,
                )
            )
        except Exception as exc:
            logger.warning(
                "[ModelCatalog] provider credit capability unavailable: "
                "organization=%s err=%s",
                organization_id,
                exc,
            )
            promotion_projection_available = False
            promotions_by_model_id = {}

        if promotion_projection_available:
            for raw_model, serialized_model in zip(models, serialized_models):
                model_id = str(raw_model.get("id") or "").strip()
                serialized_model["promotion_credit"] = (
                    promotions_by_model_id.get(model_id)
                )

    return success_response(data={
        "models": serialized_models,
        "total": len(model_infos),
        "default_model_id": default_model['id'] if default_model else None,
        "default_model_name": default_model['name'] if default_model else None,
        "subagent_model_policy": effective_subagent_policy,
        "subagent_model_id": effective_subagent_model_id,
        "organization_subagent_model_policy": organization_subagent_policy["subagent_model_policy"],
        "organization_subagent_model_id": organization_subagent_policy["subagent_model_id"],
        "user_subagent_model_policy": user_subagent_policy,
        "user_subagent_model_id": str(user_subagent_model.get("id")) if user_subagent_model else None,
        "providers": providers_metadata,
        "capabilities": capabilities,
    })


@router.post("/billing-precheck", auth=jwt_auth, tags=["Model Management"])
@envelope_errors
def preview_model_funding(request, payload: FundingPreviewRequest):
    """发送前只读资金预览；真正放行与扣费仍由 LLM 服务端链路决定。"""
    user_id = _ensure_self_user_id(
        request,
        organization_id=payload.organization_id,
    )
    _ensure_organization_permission(
        request,
        payload.organization_id,
        role="viewer",
    )

    visible_models = get_available_models(
        user_id=user_id,
        organization_id=payload.organization_id,
    )
    visible_models = _filter_models_by_member_policy(
        visible_models,
        payload.organization_id,
        user_id,
    )
    if not any(str(model.get("id") or "") == payload.model_id for model in visible_models):
        raise HttpError(404, get_text("llm.model_not_found"))

    from apps.services.billing.services.gateway import BillingGateway

    decision = BillingGateway.precheck_llm_usage(
        organization_id=payload.organization_id,
        user_id=user_id,
        estimated_tokens=payload.estimated_tokens,
        model_id=payload.model_id,
        context={"source": "electron_funding_preview"},
        perform_side_effects=False,
    )
    return success_response(
        data=decision,
        message="LLM funding preview calculated",
    )


@router.get("/search-models", auth=jwt_auth, tags=["Model Management"])
@envelope_errors
def search_models(
    request,
    keyword: str,
    organization_id: str,
    limit: int = 30
):
    """
    搜索可用模型名称（LiteLLM 数据库）
    """
    normalized = (keyword or '').strip()
    if not normalized:
        return error_response_with_status(
            "BAD_REQUEST", message="keyword cannot be empty", status_code=400,
        )

    _ensure_organization_permission(request, organization_id, role='viewer')

    results = LiteLLMModelInfoService.search_models(normalized)
    model_items = []
    for model_name, model_info in list(results.items())[: max(1, min(limit, 100))]:
        token_limits = _extract_token_limits(model_info or {})
        # LiteLLM 元数据用第三方 schema（仍含 mode/supports_vision），仅作搜索回填来源；
        # 业务侧落库时由 admin_create_model 转换到 capability_domain + capabilities_config。
        model_items.append({
            "name": model_name,
            "provider": model_info.get("litellm_provider"),
            "litellm_mode": model_info.get("mode"),
            "litellm_supports_vision": model_info.get("supports_vision", False),
            "context_window_tokens": token_limits.get("context_window_tokens"),
            "max_input_tokens": token_limits.get("max_input_tokens"),
            "max_output_tokens": token_limits.get("max_output_tokens"),
        })

    return success_response(
        data={"models": model_items, "total": len(model_items)},
        message=get_text("llm.models_fetch_success"),
    )


# ============ Provider 品牌图标（公开，供 <img> 加载） ============

@router.get(
    "/provider-icons/{icon_key}",
    auth=None,
    tags=["Model Management"],
    # 直接返回 PNG，勿包 success envelope
)
def get_provider_icon(request, icon_key: str):
    """返回 Catalog 下发的品牌 PNG；无鉴权（img 标签无法带 JWT）。"""
    from apps.services.llm.provider_icons import serve_provider_icon

    return serve_provider_icon(request, icon_key)


# ============ 健康检查 & 配置验证 ============

@router.get("/health", auth=None, tags=["Health Check"])
@envelope_errors
def health_check(request):
    """健康检查接口"""
    db_status = 'ok'
    try:
        from .models import LLMUsageFact
        LLMUsageFact.objects.count()
    except Exception:
        db_status = 'error'

    llm_status = 'ok'
    try:
        get_available_models()
    except Exception:
        llm_status = 'error'

    overall_status = 'healthy' if db_status == 'ok' and llm_status == 'ok' else 'unhealthy'

    return success_response(data={
        "service": "llm",
        "status": overall_status,
        "version": "1.0.0",
        "timestamp": datetime.now().isoformat(),
        "dependencies": {
            "database": db_status,
            "llm_services": llm_status,
        },
    })


@router.post("/validate", auth=jwt_auth, tags=["Config Validation"])
@envelope_errors
def validate_config(
    request,
    provider_name: str,
    organization_id: str,
    user_id: Optional[str] = None,
    provider_key: Optional[str] = None
):
    """验证提供商配置"""
    user_id = _ensure_self_user_id(request, user_id, organization_id=organization_id)
    _ensure_organization_permission(request, organization_id, role='viewer')

    result = validate_provider_config(
        provider_name,
        user_id=user_id,
        organization_id=organization_id,
        provider_key=provider_key
    )

    return success_response(data={
        "valid": result.get('valid', False),
        "details": result.get('details'),
        "message": result.get('error') if not result.get('valid') else get_text("llm.config_validation_success"),
    })


# ============ 注册子路由 ============
# Django Ninja 的 add_router("", sub_router) 将子路由的路径平铺到当前路由下，
# 保持所有 API 路径不变（如 /services/llm/chat-async、/services/llm/user/providers 等）。

from .api_async import router as _async_router       # noqa: E402
from .api_admin import router as _admin_router       # noqa: E402
from .api_config import router as _config_router     # noqa: E402

router.add_router("", _async_router)
router.add_router("", _admin_router)
router.add_router("", _config_router)

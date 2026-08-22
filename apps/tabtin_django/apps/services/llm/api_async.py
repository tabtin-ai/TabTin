"""
LLM 异步接口 & 任务管理
"""

from ninja import Router
from ninja.errors import HttpError
from typing import List, Optional
from urllib.parse import urlparse
import logging
import uuid

from apps.i18n import get_text, _
from apps.i18n.response import success_response, error_response_with_status
from apps.users.auth.permissions import JWTAuth

from .api_common import envelope_errors
from .api import _validate_chat_capabilities, _validate_vision_capabilities
from .schemas import ChatRequest, ChatVisionRequest
from .tasks import (
    process_llm_request_async, process_vision_request_async,
    batch_process_llm_requests, get_task_status, cancel_task
)
from .services.capability_guard import CHAT_MODEL_MODES
from .services.model_resolver import resolve_model
from apps.services.billing.services.billing_precheck import billing_precheck, LAYER_GUARD, LAYER_SERVICE_GUARD
from apps.services.billing.services.member_budget_service import MemberBudgetService
from apps.services.billing.decorators import billing_required

# 权限工具
from .permissions import resolve_effective_user_id

logger = logging.getLogger(__name__)

router = Router()

jwt_auth = JWTAuth()


def _validate_callback_url(callback_url: str) -> None:
    """校验 callback URL 格式，仅允许 HTTPS，防止 SSRF。"""
    parsed = urlparse(callback_url)
    if parsed.scheme != 'https':
        raise HttpError(400, "callback_url must use HTTPS")
    if not parsed.hostname:
        raise HttpError(400, "callback_url is invalid")


@router.post("/chat-async", auth=jwt_auth, tags=["异步接口"])
@envelope_errors
@billing_required(service_key="llm.chat", skip_balance_check=True)
def chat_async(request, payload: ChatRequest, callback_url: Optional[str] = None):
    """
    异步聊天接口

    提交异步聊天任务，返回任务ID
    """
    effective_user_id = resolve_effective_user_id(
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
        return error_response_with_status("BAD_REQUEST", message=get_text("chat.model_not_found", model_id=payload.model_id or payload.model), status_code=400)
    _validate_chat_capabilities(model_instance, payload)

    resolved_wt = getattr(request, "_billing_organization_id", "") or payload.organization_id or ""
    _user_role = MemberBudgetService.resolve_user_role(resolved_wt, effective_user_id) if resolved_wt else None

    precheck_result = billing_precheck(
        resolved_wt, effective_user_id,
        context="llm_chat_async",
        skip_layers=frozenset({LAYER_GUARD, LAYER_SERVICE_GUARD}),
        user_role=_user_role,
        model_cost_tier=MemberBudgetService.compute_model_cost_tier(model_instance),
    )
    if precheck_result.blocked:
        return error_response_with_status(
            precheck_result.error_code,
            message=f"[{precheck_result.error_category}] {get_text('billing.' + precheck_result.error_category)}",
            status_code=403,
            data=precheck_result.get_raw_detail_dict(),
        )

    if callback_url:
        _validate_callback_url(callback_url)

    request_id = str(uuid.uuid4())

    task_data = {
        'request_id': request_id,
        'model': payload.model,
        'model_id': payload.model_id,
        'messages': [msg.dict() for msg in payload.messages],
        'user_id': effective_user_id,
        'organization_id': resolved_wt,
        'documents': payload.documents or [],
        'parameters': {
            'temperature': payload.temperature,
            'max_tokens': payload.max_tokens,
            'top_p': payload.top_p,
            'frequency_penalty': payload.frequency_penalty,
            'presence_penalty': payload.presence_penalty,
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
            'prompt_cache_retention': payload.prompt_cache_retention,
        }
    }
    if isinstance(payload.provider_options, dict):
        task_data['parameters'].update(payload.provider_options)

    task = process_llm_request_async.delay(task_data, callback_url)

    logger.info("异步聊天任务已提交: %s", task.id)

    return success_response(
        data={
            'task_id': task.id,
            'request_id': request_id,
            'status': 'PENDING'
        },
        message=get_text("llm.async_task_submitted"),
    )


@router.post("/chat-vision-async", auth=jwt_auth, tags=["异步接口"])
@envelope_errors
@billing_required(service_key="llm.chat", skip_balance_check=True)
def chat_vision_async(request, payload: ChatVisionRequest, callback_url: Optional[str] = None):
    """
    异步图片聊天接口

    提交异步图片聊天任务，返回任务ID
    """
    effective_user_id = resolve_effective_user_id(
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
        return error_response_with_status("BAD_REQUEST", message=get_text("chat.model_not_found", model_id=payload.model_id or payload.model), status_code=400)
    _validate_vision_capabilities(model_instance, payload)

    resolved_wt = getattr(request, "_billing_organization_id", "") or payload.organization_id or ""
    _user_role = MemberBudgetService.resolve_user_role(resolved_wt, effective_user_id) if resolved_wt else None

    precheck_result = billing_precheck(
        resolved_wt, effective_user_id,
        context="llm_chat_vision_async",
        skip_layers=frozenset({LAYER_GUARD, LAYER_SERVICE_GUARD}),
        user_role=_user_role,
        model_cost_tier=MemberBudgetService.compute_model_cost_tier(model_instance),
    )
    if precheck_result.blocked:
        return error_response_with_status(
            precheck_result.error_code,
            message=f"[{precheck_result.error_category}] {get_text('billing.' + precheck_result.error_category)}",
            status_code=403,
            data=precheck_result.get_raw_detail_dict(),
        )

    if callback_url:
        _validate_callback_url(callback_url)

    request_id = str(uuid.uuid4())

    task_data = {
        'request_id': request_id,
        'model': payload.model,
        'model_id': payload.model_id,
        'messages': [msg.dict() for msg in payload.messages],
        'images': payload.image_urls,
        'user_id': effective_user_id,
        'organization_id': resolved_wt,
        'parameters': {
            'temperature': payload.temperature,
            'max_tokens': payload.max_tokens,
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
            'prompt_cache_retention': payload.prompt_cache_retention,
        }
    }
    if isinstance(payload.provider_options, dict):
        task_data['parameters'].update(payload.provider_options)

    task = process_vision_request_async.delay(task_data, callback_url)

    logger.info("异步图片聊天任务已提交: %s", task.id)

    return success_response(
        data={
            'task_id': task.id,
            'request_id': request_id,
            'status': 'PENDING'
        },
        message=get_text("llm.vision_async_task_submitted"),
    )


MAX_BATCH_SIZE = 50


@router.post("/batch-async", auth=jwt_auth, tags=["异步接口"])
@envelope_errors
def batch_chat_async(request, requests: List[ChatRequest], callback_url: Optional[str] = None):
    """
    批量异步聊天接口

    提交批量聊天任务，返回批次ID
    """
    if not requests:
        raise HttpError(400, _("llm.batch_requests_empty"))
    if len(requests) > MAX_BATCH_SIZE:
        raise HttpError(400, _("llm.batch_requests_max", max=MAX_BATCH_SIZE, current=len(requests)))

    if callback_url:
        _validate_callback_url(callback_url)

    # TRANS-22: 按 (organization_id, user_id) 分组预检，防止跨空间绕过
    checked_pairs: set = set()
    for idx, req in enumerate(requests):
        eff_uid = resolve_effective_user_id(request, req.user_id, organization_id=req.organization_id)

        # SF-1: 解析模型用于 BYOK 豁免判断
        _req_model = None
        try:
            _req_model = resolve_model(
                model_id=req.model_id,
                model_name=req.model,
                organization_id=req.organization_id,
                user_id=eff_uid,
                require_active=True,
                allowed_modes=CHAT_MODEL_MODES,
            )
        except Exception:
            pass

        from apps.services.llm.services.billing import _is_byok_provider
        if _is_byok_provider(_req_model):
            continue

        pair_key = (req.organization_id or '', eff_uid)
        if pair_key in checked_pairs:
            continue
        checked_pairs.add(pair_key)

        _batch_model_tier = (
            MemberBudgetService.compute_model_cost_tier(_req_model) if _req_model else None
        )
        _batch_user_role = (
            MemberBudgetService.resolve_user_role(req.organization_id or "", eff_uid)
            if req.organization_id else None
        )
        precheck_result = billing_precheck(
            req.organization_id or "", eff_uid,
            context="llm_batch_async",
            skip_layers=frozenset({LAYER_GUARD, LAYER_SERVICE_GUARD}),
            user_role=_batch_user_role,
            model_cost_tier=_batch_model_tier,
        )
        if precheck_result.blocked:
            return error_response_with_status(
                precheck_result.error_code,
                message=f"[{precheck_result.error_category}] {get_text('billing.' + precheck_result.error_category)}",
                status_code=403,
                data={**precheck_result.get_raw_detail_dict(), "request_index": idx},
            )

    batch_id = str(uuid.uuid4())

    requests_data = []
    for i, req in enumerate(requests):
        effective_user_id = resolve_effective_user_id(
            request,
            req.user_id,
            organization_id=req.organization_id,
        )

        model_instance = resolve_model(
            model_id=req.model_id,
            model_name=req.model,
            organization_id=req.organization_id,
            user_id=effective_user_id,
            require_active=True,
            allowed_modes=CHAT_MODEL_MODES,
        )
        if not model_instance:
            return error_response_with_status(
                "BAD_REQUEST",
                message=get_text("chat.model_not_found", model_id=req.model_id or req.model),
                status_code=400,
                data={"request_index": i},
            )
        _validate_chat_capabilities(model_instance, req)

        _batch_resolved_wt = getattr(request, "_billing_organization_id", "") or req.organization_id or ""
        task_data = {
            'request_id': f"{batch_id}_{i}",
            'model': req.model,
            'model_id': req.model_id,
            'messages': [msg.dict() for msg in req.messages],
            'user_id': effective_user_id,
            'organization_id': _batch_resolved_wt,
            'documents': req.documents or [],
            'parameters': {
                'temperature': req.temperature,
                'max_tokens': req.max_tokens,
                'top_p': req.top_p,
                'frequency_penalty': req.frequency_penalty,
                'presence_penalty': req.presence_penalty,
                'response_format': req.response_format,
                'functions': req.functions,
                'function_call': req.function_call,
                'tools': req.tools,
                'tool_choice': req.tool_choice,
                'thinking': req.thinking,
                'metadata': req.metadata,
                'api_variant': req.api_variant,
                'use_responses_api': req.use_responses_api,
                'previous_response_id': req.previous_response_id,
                'store': req.store,
                'include': req.include,
                'prompt_cache_key': req.prompt_cache_key,
                'prompt_cache_retention': req.prompt_cache_retention,
            }
        }
        if isinstance(req.provider_options, dict):
            task_data['parameters'].update(req.provider_options)
        requests_data.append(task_data)

    task = batch_process_llm_requests.delay(requests_data, callback_url, batch_id=batch_id)

    logger.info("批量异步任务已提交: %s, 包含 %d 个请求", task.id, len(requests))

    return success_response(
        data={
            'task_id': task.id,
            'batch_id': batch_id,
            'request_count': len(requests),
            'status': 'PENDING'
        },
        message=get_text("llm.batch_async_task_submitted"),
    )


@router.get("/tasks/{task_id}/status", auth=jwt_auth, tags=["任务管理"])
@envelope_errors
def get_task_status_api(request, task_id: str):
    """
    获取任务状态
    """
    status_info = get_task_status(task_id)

    return success_response(
        data=status_info,
        message=get_text("llm.task_status_fetch_success"),
    )


@router.post("/tasks/{task_id}/cancel", auth=jwt_auth, tags=["任务管理"])
@envelope_errors
def cancel_task_api(request, task_id: str):
    """
    取消任务
    """
    result = cancel_task(task_id)

    if result.get('success'):
        return success_response(
            data={'task_id': task_id},
            message=result.get('message', result.get('error')),
        )
    return error_response_with_status(
        "BAD_REQUEST",
        message=result.get('message') or result.get('error') or get_text("llm.task_cancel_failed", detail="取消失败"),
        status_code=400,
    )

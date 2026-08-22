"""
LLM异步任务
"""

from celery import shared_task
from celery.exceptions import Retry, SoftTimeLimitExceeded
from django.utils import timezone
from typing import Dict, Any, List, Optional
import ipaddress
import logging
import socket
import time
import uuid
import requests
import json
from urllib.parse import urlparse

from ..models import LLMModel
from ..services import get_llm_service
from ..services.billing import charge_llm_usage
from ..services.model_resolver import resolve_model
from ..services.runtime import report_provider_call_result, resolve_provider_key_for_report
from ..utils.image_processor import get_image_processor

logger = logging.getLogger(__name__)


def _process_single_llm_request(request_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    处理单个 LLM 请求的核心逻辑（无 Celery 依赖）。

    供 process_llm_request_async 和 batch_process_llm_requests 共用，
    避免批量任务通过 .apply() 阻塞 worker 或绕过重试。

    Args:
        request_data: 请求数据

    Returns:
        Dict: 处理结果

    Raises:
        Exception: 处理失败时向上抛出
    """
    request_id = request_data.get('request_id', str(uuid.uuid4()))
    model = None
    llm_service = None

    _user_id_early = (request_data.get('user_id') or '').strip()
    if not _user_id_early:
        logger.warning("[%s] user_id 为空，拒绝执行 LLM 异步任务", request_id)
        return {
            'request_id': request_id,
            'success': False,
            'error': 'user_id is required',
            'error_code': 'MISSING_USER_ID',
        }

    _ws_id_early = (request_data.get('organization_id') or '').strip()
    if not _ws_id_early:
        logger.warning("[%s] organization_id 为空，拒绝执行 LLM 异步任务", request_id)
        return {
            'request_id': request_id,
            'success': False,
            'error': 'organization_id is required',
            'error_code': 'MISSING_WORKSPACE_ID',
        }

    try:
        logger.info("[%s] 开始处理LLM请求", request_id)

        # 执行时统一计费预检（入队到执行间可能有时间差）
        try:
            from apps.services.llm.services.billed_call import build_precheck_error, build_budget_error
            from apps.services.billing.services.billing_precheck import billing_precheck
            _uid = request_data.get('user_id', '')
            _ws_id = request_data.get('organization_id', '')

            precheck_result = billing_precheck(_ws_id, _uid, context="llm_task", source="auto_task")
            if precheck_result.blocked:
                _raw = precheck_result.get_raw_detail_dict()
                logger.info("[%s] 统一预检拦截 (layer=%s): user=%s ws=%s",
                            request_id, precheck_result.layer, _uid, _ws_id)
                try:
                    _precheck_model = _resolve_model_or_raise(request_data)
                    from ..services.usage_tracking import (
                        derive_scope_and_cost_status,
                        record_usage_fact_from_dict_safely,
                    )
                    _scope, _cost_status = derive_scope_and_cost_status(_precheck_model, "failed")
                    record_usage_fact_from_dict_safely(
                        request_id=request_id,
                        scene_key="_main_chat",
                        capability_domain="chat",
                        effective_provider_scope=_scope,
                        cost_status=_cost_status,
                        user_id=_uid,
                        organization_id=_ws_id,
                        model_id=str(_precheck_model.id),
                        status="failed",
                        error_code="BUDGET_BLOCKED" if precheck_result.layer == "budget" else "PRECHECK_BLOCKED",
                    )
                except Exception:
                    pass
                if precheck_result.layer == "budget":
                    return build_budget_error(request_id=request_id, billing_result=_raw)
                return build_precheck_error(request_id=request_id, billing_result=_raw)
        except Exception as _pre_exc:
            logger.error("[%s] 执行时预检异常（拦截）: %s", request_id, _pre_exc, exc_info=True)
            try:
                _m = _resolve_model_or_raise(request_data)
                from ..services.usage_tracking import (
                    derive_scope_and_cost_status,
                    record_usage_fact_from_dict_safely,
                )
                _scope, _cost_status = derive_scope_and_cost_status(_m, "failed")
                record_usage_fact_from_dict_safely(
                    request_id=request_id,
                    scene_key="_main_chat",
                    capability_domain="chat",
                    effective_provider_scope=_scope,
                    cost_status=_cost_status,
                    user_id=request_data.get('user_id', ''),
                    organization_id=request_data.get('organization_id', ''),
                    model_id=str(_m.id),
                    status="failed",
                    error_code="PRECHECK_INFRA_ERROR",
                )
            except Exception:
                logger.warning("[%s] 预检失败后记录 usage fact 出错", request_id, exc_info=True)
            return {
                'request_id': request_id,
                'success': False,
                'error': 'billing precheck infrastructure error',
                'error_code': 'PRECHECK_ERROR',
            }

        # 解析模型（优先 model_id）
        model = _resolve_model_or_raise(request_data)
        _validate_vision_request_against_model(model, request_data.get('images', []))

        # 获取LLM服务
        llm_service = get_llm_service(
            model_id=str(model.id),
            user_id=request_data.get('user_id'),
            organization_id=request_data.get('organization_id'),
        )

        _msgs = request_data.get('messages', [])
        _params = request_data.get('parameters', {})
        _task_vp = getattr(llm_service, 'provider', None)
        _task_vk = getattr(llm_service, 'provider_key', None)
        if _task_vp and _task_vk is not None:
            from ..services.failover_executor import chat_with_failover
            # v0.1.x Phase 2.5：base_url 从 model 取（Provider.base_url 已删）
            result = chat_with_failover(
                provider_id=str(_task_vp.id),
                provider_name=_task_vp.name,
                base_url=model.base_url,
                model_name=model.model_name,
                messages=_msgs,
                **_params,
            )
        else:
            result = llm_service.chat(messages=_msgs, **_params)

        from ..services.usage_tracking import (
            derive_scope_and_cost_status,
            record_usage_fact_from_dict_safely,
        )
        _usage = result.get('usage') or {}
        _is_success = bool(result.get('success'))
        _input_t = int(_usage.get('input_tokens', 0) or _usage.get('prompt_tokens', 0) or 0)
        _output_t = int(_usage.get('output_tokens', 0) or _usage.get('completion_tokens', 0) or 0)
        _cost = result.get('cost') or {}
        _input_cost = _cost.get('input', 0) if isinstance(_cost, dict) else 0
        _output_cost = _cost.get('output', 0) if isinstance(_cost, dict) else 0
        _total_cost = _cost.get('total', 0) if isinstance(_cost, dict) else 0

        _status = "completed" if _is_success else "failed"
        _scope, _cost_status = derive_scope_and_cost_status(model, _status)
        record_usage_fact_from_dict_safely(
            request_id=request_id,
            scene_key="_main_chat",
            capability_domain="chat",
            effective_provider_scope=_scope,
            cost_status=_cost_status,
            user_id=request_data.get('user_id', ''),
            organization_id=request_data.get('organization_id', ''),
            model_id=str(model.id),
            provider_key=getattr(getattr(model, 'provider', None), 'provider_key', '') or '',
            model_name=model.model_name,
            input_tokens=_input_t,
            output_tokens=_output_t,
            total_tokens=int(_usage.get('total_tokens', 0) or 0),
            input_cost=_input_cost,
            output_cost=_output_cost,
            total_cost=_total_cost,
            status=_status,
            error_code=str(result.get('error_code') or '')[:100] if not _is_success else "",
        )

        _pk = resolve_provider_key_for_report(llm_service, result)
        _total_t = int(_usage.get('total_tokens', 0) or 0)
        report_provider_call_result(
            model.provider,
            success=_is_success,
            latency_seconds=result.get('response_time'),
            error_message=(result.get('error') or '') if not _is_success else '',
            provider_key_obj=_pk,
            tokens=_total_t,
        )

        if _is_success:
            try:
                charge_result = charge_llm_usage(
                    user_id=request_data.get('user_id'),
                    organization_id=request_data.get('organization_id'),
                    model_instance=model,
                    usage=result.get('usage'),
                    request_id=request_id,
                    source='llm_async',
                    idempotency_key=f"llm_async:{request_id}",
                    # 计费收尾：与本任务 LLMUsageFact 侧的 scene_key 对齐（同源同值），
                    # 避免异步真扣费落进「未分类」桶。
                    scene_key="_main_chat",
                )
                if not charge_result:
                    raise RuntimeError("charge_llm_usage returned empty result")
            except SoftTimeLimitExceeded:
                raise
            except Exception as charge_exc:
                logger.warning("[%s] 异步任务点券扣减失败: %s", request_id, charge_exc)
                try:
                    from apps.services.billing.services.usage_service import BillingUsageService
                    from decimal import Decimal
                    BillingUsageService.record_event(
                        organization_id=request_data.get('organization_id') or "",
                        meter_key="llm.tokens",
                        quantity=Decimal(str(_input_t + _output_t)),
                        unit="token",
                        unit_price=Decimal("0"),
                        amount=Decimal("0"),
                        user_id=request_data.get('user_id') or "",
                        biz_type="charge_failed",
                        biz_id=f"llm_async:{request_id}",
                        scene_key="_main_chat",
                        idempotency_key=f"failed:llm_async:{request_id}",
                        metadata={"error": str(charge_exc)[:500], "source": "llm_async", "input_tokens": _input_t, "output_tokens": _output_t},
                    )
                except Exception:
                    pass
                try:
                    from apps.services.billing.services.degradation_tracker import track_billing_degradation
                    track_billing_degradation(meter_key="llm.billing", organization_id=request_data.get('organization_id', ''), biz_type="llm_async", error=str(charge_exc))
                except Exception:
                    pass
                return {
                    'success': False,
                    'request_id': request_id,
                    'error': 'LLM 调用已完成但扣费失败，结果未交付。请稍后重试。',
                    'error_code': 'BILLING_CHARGE_FAILED',
                    'error_category': 'billing_charge_failed',
                }

            return {
                'success': True,
                'request_id': request_id,
                'content': result.get('content'),
                'usage': result.get('usage'),
                'cost': result.get('cost'),
                'response_time': result.get('response_time')
            }
        else:
            return {
                'success': False,
                'request_id': request_id,
                'error': result.get('error'),
                'error_code': result.get('error_code')
            }

    except Exception as exc:
        if model is not None:
            try:
                from ..services.usage_tracking import (
                    derive_scope_and_cost_status,
                    record_usage_fact_from_dict_safely,
                )
                _scope, _cost_status = derive_scope_and_cost_status(model, "failed")
                record_usage_fact_from_dict_safely(
                    request_id=request_id,
                    scene_key="_main_chat",
                    capability_domain="chat",
                    effective_provider_scope=_scope,
                    cost_status=_cost_status,
                    user_id=request_data.get('user_id', ''),
                    organization_id=request_data.get('organization_id', ''),
                    model_id=str(model.id),
                    status="failed",
                    error_code=type(exc).__name__,
                )
            except Exception:
                logger.warning("[%s] 记录 usage fact 失败", request_id, exc_info=True)
            _pk_exc = getattr(llm_service, 'provider_key', None) if llm_service else None
            report_provider_call_result(
                model.provider,
                success=False,
                latency_seconds=None,
                error_message=str(exc)[:500],
                error=exc,
                provider_key_obj=_pk_exc,
            )
        raise


@shared_task(bind=True, max_retries=3, default_retry_delay=60, time_limit=600, soft_time_limit=540)
def process_llm_request_async(self, request_data: Dict[str, Any], callback_url: Optional[str] = None):
    """
    异步处理LLM请求

    Args:
        request_data: 请求数据
        callback_url: 回调URL

    Returns:
        Dict: 处理结果
    """
    request_id = request_data.get('request_id', str(uuid.uuid4()))

    try:
        response_data = _process_single_llm_request(request_data)

        # 发送回调
        if callback_url:
            _send_callback_best_effort(callback_url, response_data, request_id)

        logger.info("[%s] 异步LLM请求处理完成", request_id)
        return response_data

    except SoftTimeLimitExceeded:
        logger.error("[%s] 异步LLM请求软超时(soft_time_limit), 不重试直接标记失败", request_id)
        if callback_url:
            _send_callback(callback_url, {
                'success': False,
                'request_id': request_id,
                'error': 'soft_time_limit exceeded',
                'error_code': 'TIMEOUT_NO_RETRY',
            })
        return {
            'success': False,
            'request_id': request_id,
            'error': 'soft_time_limit exceeded',
            'error_code': 'TIMEOUT_NO_RETRY',
        }

    except Exception as exc:
        logger.error("[%s] 异步LLM请求处理异常: %s", request_id, exc, exc_info=True)

        if self.request.retries < self.max_retries:
            logger.info("[%s] 第 %d 次重试", request_id, self.request.retries + 1)
            raise self.retry(exc=exc, countdown=60 * (2 ** self.request.retries))

        if callback_url:
            error_data = {
                'success': False,
                'request_id': request_id,
                'error': str(exc),
                'error_code': 'TASK_FAILED'
            }
            _send_callback(callback_url, error_data)

        raise exc


@shared_task(bind=True, max_retries=3, default_retry_delay=30, time_limit=600, soft_time_limit=540)
def process_vision_request_async(self, request_data: Dict[str, Any], callback_url: Optional[str] = None):
    """
    异步处理图片LLM请求

    Args:
        request_data: 请求数据（包含图片）
        callback_url: 回调URL

    Returns:
        Dict: 处理结果
    """
    request_id = request_data.get('request_id', str(uuid.uuid4()))

    _user_id_v = (request_data.get('user_id') or '').strip()
    if not _user_id_v:
        logger.warning("[%s] user_id 为空，拒绝执行 vision 异步任务", request_id)
        return {
            'request_id': request_id,
            'success': False,
            'error': 'user_id is required',
            'error_code': 'MISSING_USER_ID',
        }
    _ws_id_v = (request_data.get('organization_id') or '').strip()
    if not _ws_id_v:
        logger.warning("[%s] organization_id 为空，拒绝执行 vision 异步任务", request_id)
        return {
            'request_id': request_id,
            'success': False,
            'error': 'organization_id is required',
            'error_code': 'MISSING_WORKSPACE_ID',
        }

    model = None
    llm_service = None

    try:
        logger.info("[%s] 开始异步处理图片LLM请求", request_id)

        # 执行时统一计费预检
        try:
            from apps.services.llm.services.billed_call import build_precheck_error, build_budget_error
            from apps.services.billing.services.billing_precheck import billing_precheck
            _uid = request_data.get('user_id', '')
            _ws_id = request_data.get('organization_id', '')

            precheck_result_v = billing_precheck(_ws_id, _uid, context="llm_task", source="auto_task")
            if precheck_result_v.blocked:
                _raw_v = precheck_result_v.get_raw_detail_dict()
                logger.info("[%s] vision 统一预检拦截 (layer=%s): user=%s ws=%s",
                            request_id, precheck_result_v.layer, _uid, _ws_id)
                try:
                    _m = _resolve_model_or_raise(request_data)
                    from ..services.usage_tracking import (
                        derive_scope_and_cost_status,
                        record_usage_fact_from_dict_safely,
                    )
                    _scope, _cost_status = derive_scope_and_cost_status(_m, "failed")
                    record_usage_fact_from_dict_safely(
                        request_id=request_id,
                        scene_key="_main_chat",
                        capability_domain="chat",
                        effective_provider_scope=_scope,
                        cost_status=_cost_status,
                        user_id=_uid,
                        organization_id=_ws_id,
                        model_id=str(_m.id),
                        status="failed",
                        error_code="BUDGET_BLOCKED" if precheck_result_v.layer == "budget" else "PRECHECK_BLOCKED",
                    )
                except Exception:
                    pass
                if precheck_result_v.layer == "budget":
                    _err = build_budget_error(request_id=request_id, billing_result=_raw_v)
                else:
                    _err = build_precheck_error(request_id=request_id, billing_result=_raw_v)
                if callback_url:
                    _send_callback(callback_url, _err)
                return _err
        except Exception as _pre_exc:
            logger.error("[%s] vision 执行时预检异常（拦截）: %s", request_id, _pre_exc, exc_info=True)
            try:
                _m = _resolve_model_or_raise(request_data)
                from ..services.usage_tracking import (
                    derive_scope_and_cost_status,
                    record_usage_fact_from_dict_safely,
                )
                _scope, _cost_status = derive_scope_and_cost_status(_m, "failed")
                record_usage_fact_from_dict_safely(
                    request_id=request_id,
                    scene_key="_main_chat",
                    capability_domain="chat",
                    effective_provider_scope=_scope,
                    cost_status=_cost_status,
                    user_id=request_data.get('user_id', ''),
                    organization_id=request_data.get('organization_id', ''),
                    model_id=str(_m.id),
                    status="failed",
                    error_code="PRECHECK_INFRA_ERROR",
                )
            except Exception:
                logger.warning("[%s] vision 预检失败后记录 usage fact 出错", request_id, exc_info=True)
            _err = {
                'request_id': request_id,
                'success': False,
                'error': 'billing precheck infrastructure error',
                'error_code': 'PRECHECK_ERROR',
            }
            if callback_url:
                _send_callback(callback_url, _err)
            return _err

        # 解析模型（优先 model_id）
        model = _resolve_model_or_raise(request_data)
        _validate_vision_request_against_model(model, request_data.get('images', []))

        processed_images = request_data.get('images', [])

        # 获取LLM服务
        llm_service = get_llm_service(
            model_id=str(model.id),
            user_id=request_data.get('user_id'),
            organization_id=request_data.get('organization_id'),
        )

        _vparams = request_data.get('parameters', {})
        _vmsgs = request_data.get('messages', [])
        _vprov = getattr(llm_service, 'provider', None)
        _vpkey_obj = getattr(llm_service, 'provider_key', None)
        if _vprov and _vpkey_obj is not None:
            from ..services.failover_executor import vision_chat_with_failover
            # v0.1.x Phase 2.5：base_url 从 model 取（Provider.base_url 已删）
            result = vision_chat_with_failover(
                provider_id=str(_vprov.id),
                provider_name=_vprov.name,
                base_url=model.base_url,
                model_name=model.model_name,
                messages=_vmsgs,
                images=processed_images,
                **_vparams,
            )
        else:
            result = llm_service.chat_with_images(
                messages=_vmsgs,
                images=processed_images,
                **_vparams,
            )

        from ..services.usage_tracking import (
            derive_scope_and_cost_status,
            record_usage_fact_from_dict_safely,
        )
        _v_usage = result.get('usage') or {}
        _v_success = bool(result.get('success'))
        _v_input_t = int(_v_usage.get('input_tokens', 0) or _v_usage.get('prompt_tokens', 0) or 0)
        _v_output_t = int(_v_usage.get('output_tokens', 0) or _v_usage.get('completion_tokens', 0) or 0)
        _v_cost = result.get('cost') or {}
        _v_input_cost = _v_cost.get('input', 0) if isinstance(_v_cost, dict) else 0
        _v_output_cost = _v_cost.get('output', 0) if isinstance(_v_cost, dict) else 0
        _v_total_cost = _v_cost.get('total', 0) if isinstance(_v_cost, dict) else 0

        _v_status = "completed" if _v_success else "failed"
        _v_scope, _v_cost_status = derive_scope_and_cost_status(model, _v_status)
        record_usage_fact_from_dict_safely(
            request_id=request_id,
            scene_key="_main_chat",
            capability_domain="chat",
            effective_provider_scope=_v_scope,
            cost_status=_v_cost_status,
            user_id=request_data.get('user_id', ''),
            organization_id=request_data.get('organization_id', ''),
            model_id=str(model.id),
            provider_key=getattr(getattr(model, 'provider', None), 'provider_key', '') or '',
            model_name=model.model_name,
            input_tokens=_v_input_t,
            output_tokens=_v_output_t,
            total_tokens=int(_v_usage.get('total_tokens', 0) or 0),
            input_cost=_v_input_cost,
            output_cost=_v_output_cost,
            total_cost=_v_total_cost,
            status=_v_status,
            error_code=str(result.get('error_code') or '')[:100] if not _v_success else "",
        )

        _vpk = resolve_provider_key_for_report(llm_service, result)
        _vtok = int(_v_usage.get('total_tokens', 0) or 0)
        report_provider_call_result(
            model.provider,
            success=_v_success,
            latency_seconds=result.get('response_time'),
            error_message=(result.get('error') or '') if not _v_success else '',
            provider_key_obj=_vpk,
            tokens=_vtok,
        )

        if _v_success:
            try:
                charge_result = charge_llm_usage(
                    user_id=request_data.get('user_id'),
                    organization_id=request_data.get('organization_id'),
                    model_instance=model,
                    usage=result.get('usage'),
                    request_id=request_id,
                    source='llm_async_vision',
                    idempotency_key=f"llm_async_vision:{request_id}",
                    # 计费收尾：与本任务 LLMUsageFact 侧 scene_key 对齐（同源同值）。
                    scene_key="_main_chat",
                )
                if not charge_result:
                    raise RuntimeError("charge_llm_usage returned empty result")
            except SoftTimeLimitExceeded:
                raise
            except Exception as charge_exc:
                logger.warning("[%s] 异步 vision 任务点券扣减失败: %s", request_id, charge_exc)
                try:
                    from apps.services.billing.services.usage_service import BillingUsageService
                    from decimal import Decimal
                    BillingUsageService.record_event(
                        organization_id=request_data.get('organization_id') or "",
                        meter_key="llm.tokens",
                        quantity=Decimal(str(_v_input_t + _v_output_t)),
                        unit="token",
                        unit_price=Decimal("0"),
                        amount=Decimal("0"),
                        user_id=request_data.get('user_id') or "",
                        biz_type="charge_failed",
                        biz_id=f"llm_async_vision:{request_id}",
                        scene_key="_main_chat",
                        idempotency_key=f"failed:llm_async_vision:{request_id}",
                        metadata={"error": str(charge_exc)[:500], "source": "llm_async_vision", "input_tokens": _v_input_t, "output_tokens": _v_output_t},
                    )
                except Exception:
                    pass
                try:
                    from apps.services.billing.services.degradation_tracker import track_billing_degradation
                    track_billing_degradation(meter_key="llm.billing", organization_id=request_data.get('organization_id', ''), biz_type="llm_async_vision", error=str(charge_exc))
                except Exception:
                    pass
                response_data = {
                    'success': False,
                    'request_id': request_id,
                    'error': 'LLM 调用已完成但扣费失败，结果未交付。请稍后重试。',
                    'error_code': 'BILLING_CHARGE_FAILED',
                    'error_category': 'billing_charge_failed',
                }
            else:
                response_data = {
                    'success': True,
                    'request_id': request_id,
                    'content': result.get('content'),
                    'usage': result.get('usage'),
                    'cost': result.get('cost'),
                    'response_time': result.get('response_time')
                }

        else:
            response_data = {
                'success': False,
                'request_id': request_id,
                'error': result.get('error'),
                'error_code': result.get('error_code')
            }

        # 发送回调
        if callback_url:
            _send_callback_best_effort(callback_url, response_data, request_id)

        logger.info("[%s] 异步图片LLM请求处理完成", request_id)
        return response_data

    except SoftTimeLimitExceeded:
        logger.error("[%s] 异步图片LLM请求软超时(soft_time_limit), 不重试直接标记失败", request_id)
        if callback_url:
            _send_callback(callback_url, {
                'success': False,
                'request_id': request_id,
                'error': 'soft_time_limit exceeded',
                'error_code': 'TIMEOUT_NO_RETRY',
            })
        return {
            'success': False,
            'request_id': request_id,
            'error': 'soft_time_limit exceeded',
            'error_code': 'TIMEOUT_NO_RETRY',
        }

    except Exception as exc:
        logger.error("[%s] 异步图片LLM请求处理异常: %s", request_id, exc, exc_info=True)

        if model is not None:
            try:
                from ..services.usage_tracking import (
                    derive_scope_and_cost_status,
                    record_usage_fact_from_dict_safely,
                )
                _scope, _cost_status = derive_scope_and_cost_status(model, "failed")
                record_usage_fact_from_dict_safely(
                    request_id=request_id,
                    scene_key="_main_chat",
                    capability_domain="chat",
                    effective_provider_scope=_scope,
                    cost_status=_cost_status,
                    user_id=request_data.get('user_id', ''),
                    organization_id=request_data.get('organization_id', ''),
                    model_id=str(model.id),
                    status="failed",
                    error_code=type(exc).__name__,
                )
            except Exception:
                logger.warning("[%s] 记录 vision usage fact 失败", request_id, exc_info=True)
            _vpk_e = getattr(llm_service, 'provider_key', None) if llm_service else None
            report_provider_call_result(
                model.provider,
                success=False,
                latency_seconds=None,
                error_message=str(exc)[:500],
                error=exc,
                provider_key_obj=_vpk_e,
            )

        if self.request.retries < self.max_retries:
            logger.info("[%s] 第 %d 次重试", request_id, self.request.retries + 1)
            raise self.retry(exc=exc, countdown=30 * (2 ** self.request.retries))

        if callback_url:
            error_data = {
                'success': False,
                'request_id': request_id,
                'error': str(exc),
                'error_code': 'TASK_FAILED'
            }
            _send_callback(callback_url, error_data)

        raise exc


@shared_task(bind=True, max_retries=2, time_limit=1800, soft_time_limit=1740)
def batch_process_llm_requests(self, requests_data: List[Dict[str, Any]], callback_url: Optional[str] = None, batch_id: Optional[str] = None):
    """
    批量处理LLM请求

    Args:
        requests_data: 请求数据列表
        callback_url: 回调URL
        batch_id: API 层分配的批次 ID，保证客户端可追踪

    Returns:
        Dict: 批量处理结果
    """
    if not batch_id:
        batch_id = str(uuid.uuid4())

    try:
        logger.info("[%s] 开始批量处理 %d 个LLM请求", batch_id, len(requests_data))

        results = []
        successful_count = 0
        failed_count = 0

        for i, request_data in enumerate(requests_data):
            try:
                request_data['request_id'] = f"{batch_id}_{i}"
                response = _process_single_llm_request(request_data)

                if response.get('success'):
                    successful_count += 1
                else:
                    failed_count += 1
                results.append(response)

            except SoftTimeLimitExceeded:
                logger.error("[%s] 批量请求 %d/%d 处遇到软超时，中断循环，保留已完成的 %d 条结果", batch_id, i, len(requests_data), len(results))
                failed_count += len(requests_data) - i
                break
            except Exception as e:
                logger.error("[%s] 批量请求 %d 处理异常: %s", batch_id, i, e)
                failed_count += 1
                results.append({
                    'success': False,
                    'request_id': request_data.get('request_id', f"{batch_id}_{i}"),
                    'error': str(e),
                    'error_code': 'BATCH_ITEM_ERROR'
                })

        batch_result = {
            'success': True,
            'batch_id': batch_id,
            'total_requests': len(requests_data),
            'successful_count': successful_count,
            'failed_count': failed_count,
            'results': results
        }

        # 发送批量回调
        if callback_url:
            _send_callback(callback_url, batch_result)

        logger.info("[%s] 批量处理完成: 成功 %d, 失败 %d", batch_id, successful_count, failed_count)
        return batch_result

    except SoftTimeLimitExceeded:
        logger.error("[%s] 批量处理软超时(soft_time_limit), 不重试直接终止", batch_id)
        _timeout_result = {
            'success': False,
            'batch_id': batch_id,
            'error': 'soft_time_limit exceeded',
            'error_code': 'TIMEOUT_NO_RETRY',
        }
        if callback_url:
            _send_callback(callback_url, _timeout_result)
        return _timeout_result

    except Exception as exc:
        logger.error("[%s] 批量处理异常: %s", batch_id, exc, exc_info=True)

        if self.request.retries < self.max_retries:
            logger.info("[%s] 批量处理重试", batch_id)
            raise self.retry(exc=exc, countdown=120)

        if callback_url:
            error_data = {
                'success': False,
                'batch_id': batch_id,
                'error': str(exc),
                'error_code': 'BATCH_FAILED'
            }
            _send_callback(callback_url, error_data)

        raise exc


@shared_task(time_limit=60, soft_time_limit=50)
def get_task_status(task_id: str):
    """
    获取任务状态

    Args:
        task_id: 任务ID

    Returns:
        Dict: 任务状态信息
    """
    from celery.result import AsyncResult

    try:
        result = AsyncResult(task_id)

        return {
            'task_id': task_id,
            'status': result.status,
            'result': result.result if result.ready() else None,
            'has_error': result.failed(),
            'info': result.info
        }

    except Exception as e:
        logger.error("获取任务状态异常: %s", e)
        return {
            'task_id': task_id,
            'status': 'UNKNOWN',
            'error': str(e)
        }


@shared_task(time_limit=60, soft_time_limit=50)
def cancel_task(task_id: str):
    """
    取消任务

    Args:
        task_id: 任务ID

    Returns:
        Dict: 取消结果
    """
    from celery.result import AsyncResult

    try:
        result = AsyncResult(task_id)
        result.revoke(terminate=True)

        return {
            'success': True,
            'task_id': task_id,
            'message': '任务已取消'
        }

    except Exception as e:
        logger.error("取消任务异常: %s", e)
        return {
            'success': False,
            'task_id': task_id,
            'error': str(e)
        }


# 辅助函数
def _resolve_model_or_raise(request_data: Dict[str, Any]) -> LLMModel:
    from apps.services.llm.services.capability_guard import CHAT_MODEL_MODES

    model = resolve_model(
        model_id=request_data.get('model_id'),
        model_name=request_data.get('model'),
        organization_id=request_data.get('organization_id'),
        user_id=request_data.get('user_id'),
        require_active=True,
        allowed_modes=CHAT_MODEL_MODES,
    )
    if not model:
        raise ValueError("model not found")
    return model


def _validate_vision_request_against_model(model: LLMModel, images: List[str]) -> None:
    """异步视觉任务能力校验。仅在请求包含图片时校验模型视觉能力。"""
    if not images:
        return
    # v0.1：supports_vision / max_images_per_request 字段已删（0022）；
    # 进 capabilities_config.image。capability_domain='vision' 也视为支持。
    capabilities = model.capabilities_config or {}
    image_caps = capabilities.get("image") or {}
    supports_vision = bool(image_caps.get("enabled", False)) or model.capability_domain == "vision"
    if not supports_vision:
        raise ValueError(f"model {model.model_name} does not support vision input")

    max_images = int(image_caps.get("max_images_per_request") or 0)
    if max_images > 0 and len(images or []) > max_images:
        raise ValueError(f"model {model.model_name} max_images_per_request={max_images}, got={len(images or [])}")


def _extract_user_prompt(messages: List[Dict]) -> str:
    """提取用户提示词"""
    user_messages = [msg['content'] for msg in messages if msg.get('role') == 'user']
    return user_messages[-1] if user_messages else ""


_BLOCKED_IP_NETWORKS = [
    ipaddress.ip_network('10.0.0.0/8'),
    ipaddress.ip_network('172.16.0.0/12'),
    ipaddress.ip_network('192.168.0.0/16'),
    ipaddress.ip_network('127.0.0.0/8'),
    ipaddress.ip_network('169.254.0.0/16'),
    ipaddress.ip_network('0.0.0.0/8'),
    ipaddress.ip_network('::1/128'),
    ipaddress.ip_network('fc00::/7'),
    ipaddress.ip_network('fe80::/10'),
]


def _is_callback_url_safe(url: str) -> bool:
    """
    校验 callback URL 安全性，防止 SSRF。
    仅允许 HTTPS 且目标地址不在私有/保留 IP 段。
    """
    try:
        parsed = urlparse(url)
        if parsed.scheme != 'https':
            return False
        hostname = parsed.hostname
        if not hostname:
            return False
        addr_infos = socket.getaddrinfo(
            hostname, parsed.port or 443, proto=socket.IPPROTO_TCP
        )
        for _, _, _, _, sockaddr in addr_infos:
            ip = ipaddress.ip_address(sockaddr[0])
            for network in _BLOCKED_IP_NETWORKS:
                if ip in network:
                    return False
        return True
    except Exception:
        return False


def _send_callback(callback_url: str, data: Dict[str, Any]) -> bool:
    """发送回调通知（含 SSRF 防护）"""
    if not _is_callback_url_safe(callback_url):
        logger.warning("回调 URL 未通过安全校验，已拦截: %s", callback_url)
        return False

    max_retries = 3
    for attempt in range(max_retries + 1):
        try:
            response = requests.post(
                callback_url,
                json=data,
                headers={'Content-Type': 'application/json'},
                timeout=30,
                allow_redirects=False,
            )
            response.raise_for_status()
            logger.info("回调发送成功: %s", callback_url)
            return True
        except Exception as e:
            if attempt < max_retries:
                delay = 2 ** attempt  # 1s, 2s, 4s
                logger.warning(
                    "回调发送失败 (attempt %d/%d) %s: %s, retry in %ds",
                    attempt + 1,
                    max_retries,
                    callback_url,
                    e,
                    delay,
                )
                time.sleep(delay)
            else:
                logger.error("回调发送最终失败 %s: %s", callback_url, e)
                return False


def _send_callback_best_effort(callback_url: str, data: Dict[str, Any], request_id: str) -> None:
    """Send post-provider callbacks without causing Celery to replay provider work."""
    try:
        callback_sent = _send_callback(callback_url, data)
    except Exception as exc:
        logger.warning(
            "[%s] callback failed after provider result; not retrying LLM task: %s",
            request_id,
            exc,
            exc_info=True,
        )
        data["callback_status"] = "failed"
        data["callback_error"] = str(exc)[:500]
        return

    if not callback_sent:
        data["callback_status"] = "failed"

"""
两阶段故障转移执行器。

调用链：
1. 选择 Provider Key → 创建 Service → 执行请求
2. 失败时分类错误 → 标记 Key cooldown/disabled
3. 若为可重试错误 → 选下一个 Key 重试（阶段一：Key 内轮换）
4. 若所有 Key 耗尽 → 返回失败，由上层决定 Provider/Model 降级（阶段二）

两阶段故障转移：先换 Key，再换 Model。
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, Generator, List, MutableMapping, Optional

logger = logging.getLogger(__name__)

MAX_KEY_RETRIES = 3


def _resolve_failover_adapter_name(*, provider=None, provider_id: str = "", fallback_name: str = "") -> str:
    """有 Provider 对象或能按 id 取到时走统一 Resolver。"""
    from apps.services.llm.adapter_resolver import resolve_adapter_name

    if provider is not None:
        return resolve_adapter_name(provider)
    if provider_id:
        from django.core.exceptions import ValidationError

        from apps.services.llm.models import LLMProvider

        try:
            loaded = LLMProvider.objects.filter(id=provider_id).only("name", "provider_key").first()
        except (ValidationError, ValueError, TypeError):
            loaded = None
        if loaded is not None:
            return resolve_adapter_name(loaded)
    return str(fallback_name or "").strip().lower()


def get_service_with_failover(
    *,
    provider,
    model_name: str,
    session_id: Optional[str] = None,
    extra_config: Optional[Dict[str, Any]] = None,
):
    """选择最优 Key 并创建 LLM Service 实例。

    与 get_llm_service 的区别：此函数仅在 Provider 有 ProviderKey 记录时启用
    Key 级选择。返回 (service, selected_key) 元组，调用方可在失败后标记 Key 并重试。

    Returns:
        (BaseLLMService, LLMProviderKey | None)
    """
    from .key_manager import select_provider_key
    from .factory import LLMServiceFactory

    selected_key = select_provider_key(str(provider.id), session_id=session_id)

    api_key = selected_key.api_key if selected_key else provider.api_key
    # v0.1.x Phase 2.5：base_url 从 model 取（Provider.base_url 已删）
    base_url = _resolve_model_base_url(provider, model_name)
    config = {
        'name': provider.name,
        'api_key': api_key,
        'base_url': base_url,
        'model_name': model_name,
        'max_retries': 1,
        'retry_delay': 0,
        'provider_obj': provider,
        'provider_key_obj': selected_key,
        **(extra_config or {}),
    }

    service = LLMServiceFactory.create_service(
        _resolve_failover_adapter_name(provider=provider, fallback_name=provider.name),
        config,
    )
    return service, selected_key


def _resolve_model_base_url(provider, model_name: str) -> str:
    """v0.1.x Phase 2.5：base_url 从 Model 取（Provider.base_url 已删）。
    委托给 ``_runtime/endpoint_resolver``，避免跟 runtime.py 重复实现。
    """
    from ._runtime.endpoint_resolver import resolve_model_base_url
    return resolve_model_base_url(provider, model_name)


def chat_with_failover(
    *,
    provider_id: str,
    provider_name: str,
    base_url: str,
    model_name: str,
    messages: List[Dict[str, Any]],
    session_id: Optional[str] = None,
    **chat_kwargs,
) -> Dict[str, Any]:
    """带 Key 级故障转移的 chat 执行器。

    Returns:
        标准 chat 响应 dict（含 success / content / usage / error 等）
    """
    from .key_manager import select_provider_key, mark_key_cooldown
    from .failover_classifier import classify_failover_reason
    from .factory import LLMServiceFactory

    adapter_name = _resolve_failover_adapter_name(
        provider_id=provider_id,
        fallback_name=provider_name,
    )
    tried_key_ids: set = set()
    last_error = None

    for attempt in range(MAX_KEY_RETRIES):
        selected_key = select_provider_key(provider_id, session_id=session_id)

        if selected_key and str(selected_key.id) in tried_key_ids:
            selected_key = None

        if not selected_key:
            break

        tried_key_ids.add(str(selected_key.id))

        config = {
            'name': provider_name,
            'api_key': selected_key.api_key,
            'base_url': base_url,
            'model_name': model_name,
            'max_retries': 1,
            'retry_delay': 0,
            'provider_key_obj': selected_key,
        }

        start = time.perf_counter()
        try:
            service = LLMServiceFactory.create_service(adapter_name, config)
            result = service.chat(messages=messages, **chat_kwargs)

            latency_s = time.perf_counter() - start

            if result.get("success"):
                # Key 级成功统计由 report_provider_call_result 统一写入，避免重复计数
                result["_provider_key_id"] = str(selected_key.id)
                result["_attempt"] = attempt + 1
                return result

            error_code = result.get("error_code", "")
            error_msg = result.get("error", "")
            reason = classify_failover_reason(error_code=error_code, raw_message=error_msg)

            if reason and reason.should_rotate_key:
                mark_key_cooldown(selected_key, reason=reason.value)
                last_error = result
                logger.info(
                    "[Failover] Key %s cooldown (reason=%s), trying next key (attempt %d/%d)",
                    selected_key.id, reason.value, attempt + 1, MAX_KEY_RETRIES,
                )
                continue

            if reason and reason.should_disable_key:
                from .key_manager import mark_key_disabled
                mark_key_disabled(selected_key, reason=reason.value)

            return result

        except Exception as exc:
            latency_s = time.perf_counter() - start
            reason = classify_failover_reason(error=exc)

            if reason and reason.should_rotate_key:
                mark_key_cooldown(selected_key, reason=reason.value)
                last_error = {"success": False, "error": str(exc), "error_code": reason.value}
                logger.info(
                    "[Failover] Key %s cooldown on exception (reason=%s), trying next (attempt %d/%d)",
                    selected_key.id, reason.value, attempt + 1, MAX_KEY_RETRIES,
                )
                continue

            if reason and reason.should_disable_key:
                from .key_manager import mark_key_disabled
                mark_key_disabled(selected_key, reason=reason.value)

            raise

    if last_error:
        last_error["_failover_exhausted"] = True
        last_error["_keys_tried"] = len(tried_key_ids)
        return last_error

    return {
        "success": False,
        "error": "No available keys for this provider",
        "error_code": "NO_AVAILABLE_KEYS",
        "_failover_exhausted": True,
    }


def vision_chat_with_failover(
    *,
    provider_id: str,
    provider_name: str,
    base_url: str,
    model_name: str,
    messages: List[Dict[str, Any]],
    images: List[str],
    session_id: Optional[str] = None,
    **chat_kwargs,
) -> Dict[str, Any]:
    """带 Key 级故障转移的 vision chat（chat_with_images）。"""
    from .key_manager import select_provider_key, mark_key_cooldown
    from .failover_classifier import classify_failover_reason
    from .factory import LLMServiceFactory

    adapter_name = _resolve_failover_adapter_name(
        provider_id=provider_id,
        fallback_name=provider_name,
    )
    tried_key_ids: set = set()
    last_error = None

    for attempt in range(MAX_KEY_RETRIES):
        selected_key = select_provider_key(provider_id, session_id=session_id)

        if selected_key and str(selected_key.id) in tried_key_ids:
            selected_key = None

        if not selected_key:
            break

        tried_key_ids.add(str(selected_key.id))

        config = {
            'name': provider_name,
            'api_key': selected_key.api_key,
            'base_url': base_url,
            'model_name': model_name,
            'max_retries': 1,
            'retry_delay': 0,
            'provider_key_obj': selected_key,
        }

        try:
            service = LLMServiceFactory.create_service(adapter_name, config)
            result = service.chat_with_images(
                messages=messages,
                images=images,
                **chat_kwargs,
            )

            if result.get("success"):
                result["_provider_key_id"] = str(selected_key.id)
                result["_attempt"] = attempt + 1
                return result

            error_code = result.get("error_code", "")
            error_msg = result.get("error", "")
            reason = classify_failover_reason(error_code=error_code, raw_message=error_msg)

            if reason and reason.should_rotate_key:
                mark_key_cooldown(selected_key, reason=reason.value)
                last_error = result
                logger.info(
                    "[Failover][Vision] Key %s cooldown (reason=%s), trying next key (attempt %d/%d)",
                    selected_key.id, reason.value, attempt + 1, MAX_KEY_RETRIES,
                )
                continue

            if reason and reason.should_disable_key:
                from .key_manager import mark_key_disabled
                mark_key_disabled(selected_key, reason=reason.value)

            return result

        except Exception as exc:
            reason = classify_failover_reason(error=exc)

            if reason and reason.should_rotate_key:
                mark_key_cooldown(selected_key, reason=reason.value)
                last_error = {"success": False, "error": str(exc), "error_code": reason.value}
                logger.info(
                    "[Failover][Vision] Key %s cooldown on exception (reason=%s), trying next (attempt %d/%d)",
                    selected_key.id, reason.value, attempt + 1, MAX_KEY_RETRIES,
                )
                continue

            if reason and reason.should_disable_key:
                from .key_manager import mark_key_disabled
                mark_key_disabled(selected_key, reason=reason.value)

            raise

    if last_error:
        last_error["_failover_exhausted"] = True
        last_error["_keys_tried"] = len(tried_key_ids)
        return last_error

    return {
        "success": False,
        "error": "No available keys for this provider",
        "error_code": "NO_AVAILABLE_KEYS",
        "_failover_exhausted": True,
    }


def chat_stream_with_failover(
    *,
    provider,
    model_name: str,
    messages: List[Dict[str, Any]],
    session_id: Optional[str] = None,
    extra_config: Optional[Dict[str, Any]] = None,
    key_meta_out: Optional[MutableMapping[str, str]] = None,
    **stream_kwargs,
) -> Generator[Dict[str, Any], None, None]:
    """带 Key 级故障转移的流式 chat 执行器。

    Failover 规则：
    - 流开始前或第一个 chunk 即为错误 → 切换 Key 重试
    - 一旦有成功 chunk 发出 → 不再 failover（部分内容不可回溯）

    Yields:
        标准 stream chunk dict（含 success / content / finished / error 等）
    """
    from .key_manager import select_provider_key, mark_key_cooldown, mark_key_disabled
    from .failover_classifier import classify_failover_reason
    from .factory import LLMServiceFactory

    adapter_name = _resolve_failover_adapter_name(provider=provider, fallback_name=provider.name)
    tried_key_ids: set = set()

    for attempt in range(MAX_KEY_RETRIES):
        selected_key = select_provider_key(str(provider.id), session_id=session_id)

        if selected_key and str(selected_key.id) in tried_key_ids:
            selected_key = None

        if not selected_key:
            break

        tried_key_ids.add(str(selected_key.id))

        api_key = selected_key.api_key
        config = {
            'name': provider.name,
            'api_key': api_key,
            'base_url': _resolve_model_base_url(provider, model_name),
            'model_name': model_name,
            'max_retries': 1,
            'retry_delay': 0,
            'provider_obj': provider,
            'provider_key_obj': selected_key,
            **(extra_config or {}),
        }

        has_yielded_content = False
        try:
            service = LLMServiceFactory.create_service(adapter_name, config)
            stream_gen = service.chat_stream(messages=messages, **stream_kwargs)

            for chunk in stream_gen:
                if chunk.get("success"):
                    has_yielded_content = True
                    yield chunk
                    if chunk.get("finished"):
                        if key_meta_out is not None:
                            key_meta_out["provider_key_id"] = str(selected_key.id)
                        return
                else:
                    if not has_yielded_content:
                        error_msg = chunk.get("error", "")
                        error_code = chunk.get("error_code", "")
                        reason = classify_failover_reason(error_code=error_code, raw_message=error_msg)

                        if reason and reason.should_rotate_key:
                            mark_key_cooldown(selected_key, reason=reason.value)
                            logger.info(
                                "[StreamFailover] Key %s cooldown (reason=%s), trying next (attempt %d/%d)",
                                selected_key.id, reason.value, attempt + 1, MAX_KEY_RETRIES,
                            )
                            break

                        if reason and reason.should_disable_key:
                            mark_key_disabled(selected_key, reason=reason.value)

                    yield chunk
                    return

            if has_yielded_content:
                if key_meta_out is not None:
                    key_meta_out["provider_key_id"] = str(selected_key.id)
                return

        except Exception as exc:
            if has_yielded_content:
                raise

            reason = classify_failover_reason(error=exc)
            if reason and reason.should_rotate_key:
                mark_key_cooldown(selected_key, reason=reason.value)
                logger.info(
                    "[StreamFailover] Key %s cooldown on exception (reason=%s), trying next (attempt %d/%d)",
                    selected_key.id, reason.value, attempt + 1, MAX_KEY_RETRIES,
                )
                continue

            if reason and reason.should_disable_key:
                mark_key_disabled(selected_key, reason=reason.value)

            raise
    else:
        return

    yield {
        "success": False,
        "error": "All keys exhausted for this provider",
        "error_code": "NO_AVAILABLE_KEYS",
        "finished": True,
    }

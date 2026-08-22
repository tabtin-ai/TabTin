"""
LLM服务基础抽象类
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional, Generator, Union, Type
from decimal import Decimal
import logging
import os
import time
import json
import re
from django.core.cache import cache

from apps.services.llm.utils.capabilities import get_capability_flag, resolve_model_capabilities

logger = logging.getLogger(__name__)

_DEFAULT_TASK_HARD_LIMIT_SECONDS = 180.0
_TASK_TIMEOUT_SAFETY_MARGIN_SECONDS = 30.0
_MIN_UPSTREAM_REQUEST_TIMEOUT_SECONDS = 15.0

# Provider 无关的 Token/Context Overflow 错误模式（Token/Context Overflow 模式）。
# 合并所有供应商的已知错误文案，一次匹配即可覆盖 OpenAI / Anthropic / Gemini /
# Qwen / Moonshot / MiniMax / DeepSeek / Groq / xAI 等。
_SENSITIVE_KEYS = frozenset({
    'api_key', 'api-key', 'apikey',
    'access_token', 'token', 'auth_token',
    'codex_access_token',
    'authorization',
    'x-api-key',
    'secret', 'password',
    'api_base',
})

_SENSITIVE_HEADER_KEYS = frozenset({
    'authorization', 'x-api-key', 'proxy-authorization',
})


def _mask_value(value: str) -> str:
    """脱敏展示：保留前后各 4 字符，中间用 **** 替代。

    短 secret（len <= 12）全部 mask 为 ``"****"``，不露出任何真实字符；
    长 secret（len >= 13）保留前 4 + 后 4 字符。
    """
    if not value or not isinstance(value, str):
        return "****"
    if len(value) <= 12:
        return "****"
    return value[:4] + "****" + value[-4:]


def _sanitize_dict(data: dict) -> dict:
    """深度清洗字典中的敏感字段，返回副本。"""
    cleaned = {}
    for key, value in data.items():
        lower_key = key.lower() if isinstance(key, str) else str(key).lower()

        if lower_key in _SENSITIVE_KEYS:
            cleaned[key] = _mask_value(str(value)) if value else "****"
            continue

        if lower_key in ('headers', 'extra_headers') and isinstance(value, dict):
            cleaned[key] = _sanitize_headers(value)
            continue

        if isinstance(value, dict):
            cleaned[key] = _sanitize_dict(value)
        else:
            cleaned[key] = value

    return cleaned


def _sanitize_headers(headers: dict) -> dict:
    """清洗 HTTP headers 中的认证信息。"""
    cleaned = {}
    for key, value in headers.items():
        if key.lower() in _SENSITIVE_HEADER_KEYS:
            cleaned[key] = _mask_value(str(value)) if value else "****"
        else:
            cleaned[key] = value
    return cleaned


_OVERFLOW_PATTERNS = [
    re.compile(r"prompt is too long", re.I),
    re.compile(r"input is too long for requested model", re.I),
    re.compile(r"exceeds the context window", re.I),
    re.compile(r"input token count.*exceeds the maximum", re.I),
    re.compile(r"maximum prompt length is \d+", re.I),
    re.compile(r"reduce the length of the messages", re.I),
    re.compile(r"maximum context length is \d+ tokens", re.I),
    re.compile(r"exceeds the limit of \d+", re.I),
    re.compile(r"exceeds the available context size", re.I),
    re.compile(r"context window exceeds limit", re.I),
    re.compile(r"exceeded model token limit", re.I),
    re.compile(r"context[_ ]length[_ ]exceeded", re.I),
    re.compile(r"input token length too long", re.I),
    re.compile(r"request too long", re.I),
    re.compile(r"too many tokens", re.I),
    re.compile(r"input too long", re.I),
    re.compile(r"max[_ ]tokens\b(?!\s+per\b)", re.I),
    re.compile(r"maximum context", re.I),
]


class BaseLLMService(ABC):
    """LLM服务抽象基类"""

    def __init__(self, provider_config: Dict[str, Any]):
        """
        初始化LLM服务

        Args:
            provider_config: 提供商配置信息
        """
        self.provider_name = provider_config.get('name')
        self.api_key = provider_config.get('api_key')
        self.base_url = provider_config.get('base_url')
        self.model_name = provider_config.get('model_name', 'default')
        self.config = provider_config

        api_key = self.api_key
        self._api_key_masked = _mask_value(api_key) if api_key else "****"

        # 存储provider和model对象引用
        self.provider = provider_config.get('provider_obj')
        self.model = provider_config.get('model_obj')
        self.provider_key = provider_config.get('provider_key_obj')

        # Token Limit 配置
        self.context_window_tokens = provider_config.get('context_window_tokens')
        self.max_input_tokens = provider_config.get('max_input_tokens')
        self.max_output_tokens = provider_config.get('max_output_tokens')

        # 重试配置
        self.max_retries = provider_config.get('max_retries', 3)
        self.retry_delay = provider_config.get('retry_delay', 1)
        self.structured_output_retries = provider_config.get('structured_output_retries', 3)
        self.supports_function_calling = provider_config.get('supports_function_calling')

        self._request_timeout: int = 120

        logger.info("初始化 %s 服务: model=%s", self.provider_name, self.model_name)

    CAPABILITIES: Dict[str, Any] = {}

    def _resolve_request_timeout(self) -> int:
        """从 ProviderRegistry 读取 request_timeout，回退到默认 120s。"""
        try:
            from apps.services.llm.registry import ProviderRegistry
            meta = ProviderRegistry.get(self.provider_name)
            if meta and meta.request_timeout:
                self._request_timeout = meta.request_timeout
                return int(self._bounded_request_timeout(meta.request_timeout))
        except Exception:
            pass
        return int(self._bounded_request_timeout(self._request_timeout))

    def _bounded_request_timeout(self, requested_timeout: float) -> float:
        """让 Celery 任务内的 SDK 请求预算小于任务硬超时。

        普通 API 调用不压缩 provider 自身的 request_timeout；只有在 Celery
        task 上下文或显式设置 TABTIN_LLM_TASK_HARD_LIMIT_SECONDS 时，才按
        任务硬上限拆分预算，避免 worker 被 hard timeout 杀掉。
        """
        hard_limit = self._current_task_hard_limit_seconds()
        if hard_limit is None:
            return float(requested_timeout)

        attempts = max(int(getattr(self, "max_retries", 0) or 0) + 1, 1)
        backoff_seconds = sum(
            max(float(getattr(self, "retry_delay", 1) or 1) * (2 ** attempt), 0.0)
            for attempt in range(max(attempts - 1, 0))
        )
        budget = hard_limit - _TASK_TIMEOUT_SAFETY_MARGIN_SECONDS - backoff_seconds
        if budget <= 0:
            return min(float(requested_timeout), _MIN_UPSTREAM_REQUEST_TIMEOUT_SECONDS)

        per_attempt_budget = max(
            budget / attempts,
            _MIN_UPSTREAM_REQUEST_TIMEOUT_SECONDS,
        )
        return min(float(requested_timeout), per_attempt_budget)

    @staticmethod
    def _current_task_hard_limit_seconds() -> Optional[float]:
        override = os.environ.get("TABTIN_LLM_TASK_HARD_LIMIT_SECONDS")
        if override:
            try:
                return float(override)
            except (TypeError, ValueError):
                logger.warning(
                    "忽略非法 TABTIN_LLM_TASK_HARD_LIMIT_SECONDS=%r",
                    override,
                )

        try:
            from celery import current_task
        except Exception:
            return None

        request = getattr(current_task, "request", None)
        task_id = getattr(request, "id", None)
        timelimit = getattr(request, "timelimit", None)
        if not task_id and not timelimit:
            return None
        if isinstance(timelimit, (tuple, list)) and len(timelimit) >= 2 and timelimit[1]:
            return float(timelimit[1])
        return _DEFAULT_TASK_HARD_LIMIT_SECONDS

    @classmethod
    def validate_provider_config(cls, provider_name: str, config: dict) -> None:
        """验证 Provider 配置（子类可覆写添加特定验证逻辑）。

        基类为空实现——通用 api_key/base_url 检查由 Factory 统一处理。
        子类仅需关注 provider 特有的验证规则。

        Raises:
            ValueError: 配置无效时
        """

    # 每张图片的 token 估算值（用于预检和截断）。
    # ⚠ content_pruner / token_counter 也应引用同一常量，避免不一致。
    IMAGE_TOKEN_ESTIMATE: int = 765

    def get_capability(self, key: str, default: bool = False) -> bool:
        """读取能力标记，优先级：DB > capabilities_config > Service.CAPABILITIES > default。"""
        return get_capability_flag(
            self.model, key, default=default,
            service_capabilities=self.__class__.CAPABILITIES,
        )

    def get_resolved_capabilities(self) -> Dict[str, bool]:
        """返回统一能力快照（合并 DB + Service.CAPABILITIES）。"""
        return resolve_model_capabilities(
            self.model,
            service_capabilities=self.__class__.CAPABILITIES,
        )

    # ── 工具方法 ──

    def _estimate_stream_usage(
        self,
        messages: List[Dict[str, Any]],
        full_content: str,
    ) -> Optional[Dict[str, int]]:
        """流式结束但 Provider 未返回 usage 时，基于本地 token 计数估算。"""
        try:
            input_tokens = self._count_tokens(messages)
            output_tokens = self._count_tokens(
                [{"role": "assistant", "content": full_content}]
            ) if full_content else 0
            total_tokens = input_tokens + output_tokens
            if total_tokens <= 0:
                return None
            return {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "input_tokens_include_cache": True,
                "estimated": True,
            }
        except Exception as exc:
            logger.warning("流式 usage 本地估算失败: %s", exc)
            return None

    # ── Reasoning 提取统一方法 ──

    @staticmethod
    def _extract_reasoning_from_message(
        message: Any,
        *,
        is_stream: bool = False,
    ) -> list:
        """从 SDK 对象或 dict 中提取 reasoning 内容。

        统一处理两种来源：
        - SDK 对象属性：``getattr(message, "reasoning_content", None)``
        - 字典键：``message.get("reasoning_content")`` / ``message.get("thinking_content")``

        Args:
            message:   SDK message/delta 对象或字典
            is_stream: True 时输出 ``reasoning.delta``，否则 ``reasoning.text``

        Returns:
            空列表或 ``[{"type": "reasoning.text|reasoning.delta", "text": "..."}]``
        """
        reasoning = None
        if isinstance(message, dict):
            reasoning = message.get("reasoning_content") or message.get("thinking_content")
        else:
            reasoning = getattr(message, "reasoning_content", None) or getattr(message, "thinking_content", None)

        if not reasoning:
            return []

        entry_type = "reasoning.delta" if is_stream else "reasoning.text"
        return [{"type": entry_type, "text": reasoning}]

    @staticmethod
    def _extract_reasoning_from_content_blocks(content_blocks: Any) -> list:
        """从 Anthropic 风格的 content blocks 中提取 thinking 内容。

        遍历 ``response.content`` 中 ``type == "thinking"`` 的 block，
        取 ``block.thinking`` 属性。

        Returns:
            ``[{"type": "reasoning.text", "text": "..."}]`` 或空列表
        """
        details: list = []
        for block in content_blocks or []:
            if getattr(block, "type", None) != "thinking":
                continue
            text = getattr(block, "thinking", "") or ""
            if text:
                details.append({"type": "reasoning.text", "text": text})
        return details

    # ── 统一能力检测（子类可覆盖以添加硬编码 fallback） ──

    def _model_supports_vision(self, model: str) -> bool:
        """DB 字段优先，子类 CAPABILITIES fallback 次之。"""
        return self.get_capability("supports_vision")

    def _model_supports_json_mode(self, model: str) -> bool:
        """DB 字段优先，子类 fallback 次之。"""
        if self.model is not None:
            return get_capability_flag(self.model, "supports_json_mode", default=True)
        return True

    def _model_supports_reasoning(self, model: str) -> bool:
        """DB 字段优先。"""
        if self.model is not None:
            return get_capability_flag(self.model, "supports_reasoning")
        return False

    def supports_structured_output(self) -> bool:
        """
        判断是否支持 Structured Output。
        优先级：DB supports_function_calling > Registry 已注册 > False
        """
        if self.supports_function_calling is not None:
            return bool(self.supports_function_calling)

        try:
            from apps.services.llm.registry import ProviderRegistry
            if ProviderRegistry.is_registered(self.provider_name):
                return True
        except Exception:
            pass

        return False

    def with_structured_output(
        self,
        schema_cls: Type,
        *,
        max_retries: Optional[int] = None,
        user_id: str = "",
        organization_id: str = "",
    ):
        """
        返回支持 Structured Output 的包装器。

        传入 ``user_id`` / ``organization_id`` 可使 fallback 路径自动计费。
        """
        from apps.services.llm.services.structured_output import StructuredOutputWrapper

        return StructuredOutputWrapper(
            service=self,
            schema_cls=schema_cls,
            max_retries=max_retries or self.structured_output_retries,
            user_id=user_id,
            organization_id=organization_id,
        )

    def chat(self, messages: List[Dict[str, str]], **kwargs) -> Dict[str, Any]:
        """
        同步聊天接口（带 Token Limit 检查和截断）

        Args:
            messages: 消息列表 [{"role": "user", "content": "hello"}]
            **kwargs: 其他参数 (temperature, max_tokens等)

        Returns:
            Dict: 响应结果
            {
                "success": True,
                "content": "响应内容",
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 20,
                    "total_tokens": 30
                },
                "cost": {
                    "input_cost": 0.001,
                    "output_cost": 0.002,
                    "total_cost": 0.003
                },
                "response_time": 1.5,
                "model": "gpt-4"
            }
        """
        # 0. 消息格式校验（与 estimate_tokens 行为一致）
        try:
            self._validate_messages(messages)
        except ValueError as exc:
            return {
                "success": False,
                "error": str(exc),
                "error_code": "INVALID_REQUEST",
            }

        # 1. 渠道级限流（按 provider.rate_limit 每分钟）
        rate_limit_service_tag = kwargs.pop("rate_limit_service_tag", "llm")
        rate_limit_error = self._check_provider_rate_limit(
            service_tag=rate_limit_service_tag,
        )
        if rate_limit_error:
            return rate_limit_error

        # 2. 获取 max_output_tokens（用于预留输出空间）
        max_output_tokens = self._resolve_max_output_tokens(kwargs)

        # 3. Token Limit 检查和截断
        try:
            truncated_messages = self._check_and_truncate_messages(messages, max_output_tokens)
        except ValueError as exc:
            return {
                "success": False,
                "error": str(exc),
                "error_code": "TOKEN_LIMIT",
            }

        # 4. 调用子类实现（统一重试策略）
        return self._execute_chat_with_retry(truncated_messages, max_output_tokens, kwargs)

    @abstractmethod
    def _do_chat(self, messages: List[Dict[str, str]], **kwargs) -> Dict[str, Any]:
        """
        子类需要实现的实际聊天接口（由 chat 调用）

        Args:
            messages: 消息列表（已经过 Token 检查和截断）
            **kwargs: 其他参数

        Returns:
            Dict: 响应结果
        """
        pass

    def chat_stream(self, messages: List[Dict[str, str]], **kwargs) -> Generator[Dict[str, Any], None, None]:
        """
        流式聊天接口（带消息校验、限流、Token Limit 检查和截断）。

        保护链路与 ``chat()`` 对齐：
        validate → rate_limit → resolve_output_tokens → truncate → _do_chat_stream()

        子类应覆写 ``_do_chat_stream()`` 而非本方法。

        中断兜底：通过 try/finally 追踪已接收的 chunk 数和 usage 信息，
        当流被 GeneratorExit（客户端断开）中断时，记录中断事件供运维对账。
        """
        start_time = time.time()

        # 0. 消息格式校验（与 chat() 对齐）
        try:
            self._validate_messages(messages)
        except ValueError as exc:
            yield {
                "success": False,
                "error": str(exc),
                "error_code": "INVALID_REQUEST",
                "finished": True,
            }
            return

        # 1. 渠道级限流
        rate_limit_error = self._check_provider_rate_limit()
        if rate_limit_error:
            rate_limit_error["finished"] = True
            yield rate_limit_error
            return

        # 2. 获取 max_output_tokens
        max_output_tokens = self._resolve_max_output_tokens(kwargs)

        # 3. Token Limit 检查和截断
        try:
            truncated_messages = self._check_and_truncate_messages(messages, max_output_tokens)
        except ValueError as exc:
            yield {
                "success": False,
                "error": str(exc),
                "error_code": "TOKEN_LIMIT",
                "finished": True,
            }
            return

        # 4. 调用子类实现（带中断追踪）
        _stream_usage: Dict[str, Any] = {"input_tokens": 0, "output_tokens": 0, "chunks": 0}
        _stream_completed = False

        try:
            for chunk in self._do_chat_stream(truncated_messages, **kwargs):
                if isinstance(chunk, dict):
                    if chunk.get("usage"):
                        _stream_usage.update(chunk["usage"])
                    if chunk.get("finished"):
                        _stream_completed = True
                    _stream_usage["chunks"] += 1
                yield chunk
        except GeneratorExit:
            logger.warning(
                "[%s] Stream interrupted after %d chunks, input_tokens=%d",
                self.provider_name, _stream_usage["chunks"],
                _stream_usage.get("input_tokens", 0),
            )
        except Exception as exc:
            logger.error("%s chat_stream() 异常: %s", self.provider_name, exc, exc_info=True)
            yield self._build_stream_error_result(exc, start_time)
        finally:
            if not _stream_completed and _stream_usage["chunks"] > 0:
                self._record_interrupted_stream_usage(
                    messages, _stream_usage, kwargs, start_time,
                )

    def _record_interrupted_stream_usage(
        self,
        messages: List[Dict[str, str]],
        stream_usage: Dict[str, Any],
        kwargs: Dict[str, Any],
        start_time: float,
    ) -> None:
        """流式调用中断时，记录中断事件供运维事后对账。

        不执行实际扣款（无法确定精确消耗），仅记录 Trace 事件。
        """
        try:
            has_provider_usage = stream_usage.get("input_tokens", 0) > 0
            if has_provider_usage:
                self._record_llm_event(
                    messages, kwargs,
                    {"success": False, "interrupted": True, "usage": stream_usage},
                    start_time, is_stream=True,
                )
                logger.info(
                    "[%s] Interrupted stream recorded: input_tokens=%d, output_tokens=%d, chunks=%d",
                    self.provider_name,
                    stream_usage.get("input_tokens", 0),
                    stream_usage.get("output_tokens", 0),
                    stream_usage.get("chunks", 0),
                )
            else:
                estimated_input = self._count_tokens(messages) if hasattr(self, '_count_tokens') else 0
                if estimated_input > 0:
                    self._record_llm_event(
                        messages, kwargs,
                        {
                            "success": False,
                            "interrupted": True,
                            "usage": {
                                "input_tokens": estimated_input,
                                "output_tokens": 0,
                                "total_tokens": estimated_input,
                                "estimated": True,
                            },
                        },
                        start_time, is_stream=True,
                    )
                    logger.info(
                        "[%s] Estimated interrupted stream: ~%d input tokens, %d chunks",
                        self.provider_name, estimated_input,
                        stream_usage.get("chunks", 0),
                    )
        except Exception as exc:
            logger.debug("[chat_stream] _record_interrupted_stream_usage failed: %s", exc)

    def _do_chat_stream(self, messages: List[Dict[str, str]], **kwargs) -> Generator[Dict[str, Any], None, None]:
        """
        子类需要实现的实际流式聊天接口（由 chat_stream 调用）。

        迁移指南：将现有 chat_stream() 实现重命名为 _do_chat_stream()。
        """
        raise NotImplementedError(
            f"{type(self).__name__} 应实现 _do_chat_stream()，"
            f"请将现有 chat_stream() 重命名为 _do_chat_stream()"
        )

    def chat_with_images(self, messages: List[Dict[str, str]],
                        images: List[str], **kwargs) -> Dict[str, Any]:
        """
        带图片的聊天接口（默认走消息管道自动降级）。

        如果模型支持 vision，图片会被注入消息；
        否则图片自动降级为文本提示，不再报错。
        子类可覆盖以添加额外逻辑。
        """
        try:
            pipeline = self._get_message_pipeline(**kwargs)
            enhanced_messages = pipeline.transform(messages, images=images)
            return self.chat(enhanced_messages, **kwargs)
        except Exception as e:
            logger.error("%s 图片聊天异常: %s", self.provider_name, e, exc_info=True)
            return self._build_error_result(e)

    def _get_message_pipeline(self, **kwargs):
        """创建消息预处理管道实例。"""
        from apps.services.llm.utils.message_transform import MessageTransformPipeline

        model_name = kwargs.get("model", self.model_name)
        return MessageTransformPipeline(
            model_obj=self.model,
            provider_name=self.provider_name,
            model_name=model_name,
            supports_vision=self._model_supports_vision(model_name),
        )

    def estimate_tokens(
        self,
        messages: List[Dict[str, Any]],
        *,
        prefer_provider_api: bool = True,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        估算输入 Token 数量。

        策略：
        - 优先尝试渠道原生估算接口（如 Moonshot tokenizer）
        - 失败时回退本地 TokenCounter 估算
        """
        self._validate_messages(messages)

        provider_error: Optional[str] = None
        if prefer_provider_api:
            try:
                via_provider = self._estimate_tokens_via_provider(messages, **kwargs)
                if isinstance(via_provider, dict) and via_provider:
                    input_tokens = int(via_provider.get("input_tokens", 0) or 0)
                    total_tokens = int(via_provider.get("total_tokens", 0) or 0)
                    if total_tokens <= 0:
                        total_tokens = input_tokens
                    return {
                        "input_tokens": input_tokens,
                        "output_tokens": int(via_provider.get("output_tokens", 0) or 0),
                        "total_tokens": total_tokens,
                        "source": "provider_api",
                    }
            except Exception as exc:
                provider_error = str(exc)
                logger.warning(
                    "渠道原生 Token 估算失败，回退本地估算 provider=%s model=%s err=%s",
                    self.provider_name,
                    self.model_name,
                    provider_error,
                )

        local_tokens = self._count_tokens(messages)
        result = {
            "input_tokens": int(local_tokens or 0),
            "output_tokens": 0,
            "total_tokens": int(local_tokens or 0),
            "source": "local_counter",
        }
        if provider_error:
            result["provider_error"] = "渠道原生估算不可用，已使用本地估算"
        return result

    def _estimate_tokens_via_provider(
        self,
        messages: List[Dict[str, Any]],
        **kwargs,
    ) -> Optional[Dict[str, Any]]:
        """
        渠道原生 Token 估算（可选覆写）。
        返回 None 表示当前渠道不支持。
        """
        return None

    def validate_config(self) -> Dict[str, Any]:
        """
        验证配置是否有效

        Returns:
            Dict: 验证结果
            {
                "valid": True,
                "error": None,
                "details": {...}
            }
        """
        result = {
            "valid": False,
            "error": None,
            "details": {}
        }

        try:
            # 基础配置检查
            if not self.api_key:
                result["error"] = "API密钥未配置"
                return result

            if not self.base_url:
                result["error"] = "API基础URL未配置"
                return result

            # 调用子类的具体验证
            validation_result = self._validate_connection()
            result.update(validation_result)

        except Exception as e:
            logger.error("配置验证异常: %s", e)
            result["error"] = "配置验证失败，请检查配置后重试"

        return result

    @abstractmethod
    def _validate_connection(self) -> Dict[str, Any]:
        """
        验证连接是否正常
        子类需要实现具体的连接验证逻辑
        """
        pass

    PROBE_PROMPT = "Reply with OK. Do not use tools."
    PROBE_MAX_TOKENS = 5

    def probe(self, level: int = 0, model_name: str = "") -> Dict[str, Any]:
        """分层探针验证。

        Level 0: 连通性检查 — client.models.list()（现有 validate_config 逻辑）
        Level 1: Chat 探针 — 发最小 prompt 验证模型可用
        Level 2: 能力探测 — 测试 function calling / vision（可选，子类覆写）

        Returns:
            {
                "valid": bool,
                "level": int,
                "latency_ms": int,
                "details": {...},
                "error": str|None,
                "error_code": str|None,
                "status_code": int|None,
            }
        """
        import time
        start = time.perf_counter()

        result = {
            "valid": False,
            "level": level,
            "latency_ms": 0,
            "details": {},
            "error": None,
            "error_code": None,
            "status_code": None,
        }

        try:
            if level >= 0:
                conn = self.validate_config()
                result["details"]["level_0"] = conn
                if not conn.get("valid"):
                    self._apply_probe_failure(
                        result,
                        error=conn.get("error") or "连通性检查失败",
                        error_code=conn.get("error_code"),
                        status_code=conn.get("status_code"),
                    )
                    result["latency_ms"] = int((time.perf_counter() - start) * 1000)
                    return result

            if level >= 1:
                target_model = model_name or self.config.get("model_name", "")
                chat_result = self._probe_chat(target_model)
                result["details"]["level_1"] = chat_result
                if not chat_result.get("valid"):
                    self._apply_probe_failure(
                        result,
                        error=chat_result.get("error") or "Chat 探针失败",
                        error_code=chat_result.get("error_code"),
                        status_code=chat_result.get("status_code"),
                    )
                    result["latency_ms"] = int((time.perf_counter() - start) * 1000)
                    return result

            if level >= 2:
                caps = self._probe_capabilities(model_name or self.config.get("model_name", ""))
                result["details"]["level_2"] = caps

            result["valid"] = True
            result["latency_ms"] = int((time.perf_counter() - start) * 1000)
        except Exception as e:
            classified = self._classify_error(e)
            self._apply_probe_failure(
                result,
                error=str(classified)[:500],
                error_code=classified.code,
                status_code=classified.status_code,
            )
            result["latency_ms"] = int((time.perf_counter() - start) * 1000)
            logger.warning("[Probe] level=%d error: %s", level, e)

        return result

    @staticmethod
    def _apply_probe_failure(
        target: Dict[str, Any],
        *,
        error: str,
        error_code: Any = None,
        status_code: Any = None,
    ) -> None:
        """把探针失败的主文案与结构化码写入结果（供前端 i18n 映射）。"""
        target["error"] = str(error)[:500] if error else "连通性检查失败"
        if error_code:
            target["error_code"] = str(error_code)
        if status_code is not None:
            try:
                target["status_code"] = int(status_code)
            except (TypeError, ValueError):
                pass

    def _probe_chat(self, model_name: str) -> Dict[str, Any]:
        """Level 1: 发送最小 prompt，验证模型名是否可用。子类可覆写。"""
        try:
            # Kimi K2.x / Coding 上游只接受 temperature=1；探针默认 0 会 400。
            from apps.services.llm.utils.param_adaptor import requires_kimi_temperature_one

            probe_temperature = 1 if requires_kimi_temperature_one(model_name) else 0
            resp = self.chat(
                messages=[{"role": "user", "content": self.PROBE_PROMPT}],
                max_tokens=self.PROBE_MAX_TOKENS,
                model=model_name,
                temperature=probe_temperature,
            )
            if resp.get("success"):
                return {
                    "valid": True,
                    "model": resp.get("model", model_name),
                    "content_preview": (resp.get("content") or "")[:50],
                }
            failure = {
                "valid": False,
                "error": resp.get("error", "unknown"),
            }
            self._apply_probe_failure(
                failure,
                error=failure["error"],
                error_code=resp.get("error_code"),
                status_code=resp.get("status_code"),
            )
            return failure
        except Exception as e:
            classified = self._classify_error(e)
            failure = {"valid": False}
            self._apply_probe_failure(
                failure,
                error=str(classified)[:300],
                error_code=classified.code,
                status_code=classified.status_code,
            )
            return failure

    def _probe_capabilities(self, model_name: str) -> Dict[str, Any]:
        """Level 2: 探测模型能力。默认空实现，子类可覆写。"""
        return {"detected_capabilities": {}}

    def calculate_cost(self, usage: Dict[str, int], model_config: Dict[str, Any]) -> Dict[str, Decimal]:
        """
        计算请求成本

        Args:
            usage: Token使用量 {"input_tokens": 10, "output_tokens": 20}
            model_config: 模型配置信息

        Returns:
            Dict: 成本信息
        """
        input_tokens = usage.get('input_tokens', 0)
        output_tokens = usage.get('output_tokens', 0)

        # 获取价格配置
        input_price_per_1k = Decimal(str(model_config.get('input_price_per_1k', 0)))
        output_price_per_1k = Decimal(str(model_config.get('output_price_per_1k', 0)))

        # 计算成本
        input_cost = (Decimal(str(input_tokens)) / 1000) * input_price_per_1k
        output_cost = (Decimal(str(output_tokens)) / 1000) * output_price_per_1k
        total_cost = input_cost + output_cost

        return {
            'input_cost': input_cost,
            'output_cost': output_cost,
            'total_cost': total_cost,
            # 兼容历史存储字段：input/output/total 别名
            'input': input_cost,
            'output': output_cost,
            'total': total_cost,
        }

    def _get_custom_billing_config(self) -> Dict[str, Any]:
        """获取 custom_billing_config（优先 DB 模型，其次 provider_config）。"""
        model_obj = self.model
        if model_obj is not None:
            return getattr(model_obj, "custom_billing_config", {}) or {}
        return self.config.get("custom_billing_config", {}) or {}

    def _resolve_pricing_config(self) -> Dict[str, Decimal]:
        """解析当前模型价格配置（优先 DB 模型，其次 provider_config）。"""
        model_obj = self.model
        custom_billing = self._get_custom_billing_config()

        if model_obj is not None:
            input_price = Decimal(str(getattr(model_obj, "input_price_per_1k", 0) or 0))
            output_price = Decimal(str(getattr(model_obj, "output_price_per_1k", 0) or 0))
        else:
            input_price = Decimal(str(self.config.get("input_price_per_1k", 0) or 0))
            output_price = Decimal(str(self.config.get("output_price_per_1k", 0) or 0))

        cache_read_raw = custom_billing.get("cache_read_input_price_per_1k") if isinstance(custom_billing, dict) else None
        cache_write_raw = custom_billing.get("cache_write_input_price_per_1k") if isinstance(custom_billing, dict) else None
        cache_read_price = input_price if cache_read_raw is None else Decimal(str(cache_read_raw or 0))
        cache_write_price = input_price if cache_write_raw is None else Decimal(str(cache_write_raw or 0))

        return {
            "input_price_per_1k": input_price,
            "output_price_per_1k": output_price,
            "cache_read_input_price_per_1k": cache_read_price,
            "cache_write_input_price_per_1k": cache_write_price,
        }

    def _calculate_cost_from_usage(self, usage: Dict[str, int]) -> Dict[str, Decimal]:
        """
        从 usage 计算成本：
        - 标准 input/output token 成本
        - prompt cache 读写成本（若 usage + model 配置中存在）
        - 阶梯计费（若 custom_billing_config.tiered_pricing 存在）
        """
        pricing = self._resolve_pricing_config()

        input_tokens = int(usage.get("input_tokens", 0) or 0)
        output_tokens = int(usage.get("output_tokens", 0) or 0)
        cache_read_tokens = int(usage.get("cache_read_input_tokens", 0) or 0)
        cache_write_tokens = int(usage.get("cache_creation_input_tokens", 0) or 0)
        input_tokens_include_cache = self._usage_input_includes_cache(usage)
        if input_tokens_include_cache:
            base_input_tokens = max(input_tokens - cache_read_tokens - cache_write_tokens, 0)
            billable_input_tokens = max(input_tokens, base_input_tokens + cache_read_tokens + cache_write_tokens)
        else:
            base_input_tokens = input_tokens
            billable_input_tokens = input_tokens + cache_read_tokens + cache_write_tokens

        from .billing import resolve_tiered_pricing
        custom_billing = self._get_custom_billing_config()
        tier = resolve_tiered_pricing(custom_billing, billable_input_tokens)
        if tier:
            pricing["input_price_per_1k"] = Decimal(str(tier.get("input_price_per_1k", pricing["input_price_per_1k"])))
            pricing["output_price_per_1k"] = Decimal(str(tier.get("output_price_per_1k", pricing["output_price_per_1k"])))
            cache_hit_raw = tier.get("cache_hit_price_per_1k")
            cache_creation_raw = tier.get("cache_creation_price_per_1k")
            if cache_hit_raw is not None:
                pricing["cache_read_input_price_per_1k"] = Decimal(str(cache_hit_raw))
            if cache_creation_raw is not None:
                pricing["cache_write_input_price_per_1k"] = Decimal(str(cache_creation_raw))

        input_cost = (Decimal(base_input_tokens) / Decimal(1000)) * pricing["input_price_per_1k"]
        output_cost = (Decimal(output_tokens) / Decimal(1000)) * pricing["output_price_per_1k"]
        cache_read_cost = (Decimal(cache_read_tokens) / Decimal(1000)) * pricing["cache_read_input_price_per_1k"]
        cache_write_cost = (Decimal(cache_write_tokens) / Decimal(1000)) * pricing["cache_write_input_price_per_1k"]
        total_cost = input_cost + output_cost + cache_read_cost + cache_write_cost

        result = {
            "input_cost": input_cost,
            "output_cost": output_cost,
            "total_cost": total_cost,
            "input": input_cost,
            "output": output_cost,
            "total": total_cost,
        }
        if cache_read_tokens > 0:
            result["cache_read_cost"] = cache_read_cost
        if cache_write_tokens > 0:
            result["cache_write_cost"] = cache_write_cost
        return result

    @staticmethod
    def _extract_cache_tokens(usage_obj: Any) -> tuple:
        """
        从 SDK usage 对象（OpenAI / Anthropic / Gemini 等）中提取 cache tokens。

        Returns:
            (cache_read_tokens, cache_creation_tokens)
        """
        cache_read = 0
        cache_creation = 0

        # 1. OpenAI Chat Completions: prompt_tokens_details.cached_tokens
        prompt_details = getattr(usage_obj, "prompt_tokens_details", None)
        if isinstance(prompt_details, dict):
            cache_read = int(prompt_details.get("cached_tokens", 0) or 0)
            cache_creation = int(prompt_details.get("cache_creation_input_tokens", 0) or 0)
        elif prompt_details is not None:
            cache_read = int(getattr(prompt_details, "cached_tokens", 0) or 0)
            cache_creation = int(getattr(prompt_details, "cache_creation_input_tokens", 0) or 0)

        # 2. OpenAI Responses API: input_tokens_details.cached_tokens
        if cache_read <= 0:
            input_details = getattr(usage_obj, "input_tokens_details", None)
            if isinstance(input_details, dict):
                cache_read = int(input_details.get("cached_tokens", 0) or 0)
                if cache_creation <= 0:
                    cache_creation = int(input_details.get("cache_creation_input_tokens", 0) or 0)
            elif input_details is not None:
                cache_read = int(getattr(input_details, "cached_tokens", 0) or 0)
                if cache_creation <= 0:
                    cache_creation = int(getattr(input_details, "cache_creation_input_tokens", 0) or 0)

        # 3. 顶层字段（某些兼容 API）
        if cache_read <= 0:
            cache_read = int(getattr(usage_obj, "cached_tokens", 0) or 0)
        if cache_creation <= 0:
            cache_creation = int(getattr(usage_obj, "cache_creation_input_tokens", 0) or 0)

        # 4. Anthropic SDK: cache_read_input_tokens / cache_creation_input_tokens
        if cache_read <= 0:
            cache_read = int(getattr(usage_obj, "cache_read_input_tokens", 0) or 0)

        # 5. Gemini: usage_metadata.cached_content_token_count
        if cache_read <= 0:
            usage_metadata = getattr(usage_obj, "usage_metadata", None)
            if usage_metadata is not None:
                cache_read = int(getattr(usage_metadata, "cached_content_token_count", 0) or 0)
            if cache_read <= 0:
                cache_read = int(getattr(usage_obj, "cached_content_token_count", 0) or 0)

        return (cache_read, cache_creation)

    @staticmethod
    def _extract_cache_tokens_from_dict(usage_data: dict) -> tuple:
        """
        从原始 dict 格式的 usage 中提取 cache tokens（用于非 SDK 响应）。

        Returns:
            (cache_read_tokens, cache_creation_tokens)
        """
        cache_read = 0
        cache_creation = 0

        prompt_details = usage_data.get("prompt_tokens_details") or {}
        if isinstance(prompt_details, dict):
            cache_read = int(prompt_details.get("cached_tokens", 0) or 0)
            cache_creation = int(prompt_details.get("cache_creation_input_tokens", 0) or 0)

        if cache_read <= 0:
            input_details = usage_data.get("input_tokens_details") or {}
            if isinstance(input_details, dict):
                cache_read = int(input_details.get("cached_tokens", 0) or 0)
                if cache_creation <= 0:
                    cache_creation = int(input_details.get("cache_creation_input_tokens", 0) or 0)

        if cache_read <= 0:
            cache_read = int(usage_data.get("cached_tokens", 0) or 0)
        if cache_creation <= 0:
            cache_creation = int(usage_data.get("cache_creation_input_tokens", 0) or 0)
        if cache_read <= 0:
            cache_read = int(usage_data.get("cache_read_input_tokens", 0) or 0)
        if cache_read <= 0:
            cache_read = int(usage_data.get("cached_content_token_count", 0) or 0)

        if cache_read <= 0:
            usage_metadata = usage_data.get("usage_metadata")
            if isinstance(usage_metadata, dict):
                cache_read = int(usage_metadata.get("cached_content_token_count", 0) or 0)

        return (cache_read, cache_creation)

    @staticmethod
    def _enrich_usage_with_cache(usage: dict, cache_read: int, cache_creation: int) -> dict:
        """将 cache tokens 写入 usage dict。"""
        if cache_read > 0:
            usage["cache_read_input_tokens"] = cache_read
        if cache_creation > 0:
            usage["cache_creation_input_tokens"] = cache_creation
        return usage

    @classmethod
    def prepare_proxy_request(
        cls,
        body: Dict[str, Any],
        *,
        session_id: str = "",
        incoming_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """由具体 Provider 为直连代理补充厂商请求策略。"""
        del session_id
        del incoming_body
        return dict(body or {})

    @staticmethod
    def _inject_prompt_cache_payload(extra_body: Dict[str, Any], kwargs: Dict[str, Any]) -> Dict[str, Any]:
        """将 prompt caching 相关字段安全放入 extra_body，避免 SDK 参数兼容问题。"""
        payload = dict(extra_body or {})

        prompt_cache_key = kwargs.get("prompt_cache_key")
        if prompt_cache_key is None and isinstance(payload.get("prompt_cache_key"), (str, int)):
            prompt_cache_key = payload.get("prompt_cache_key")
        if prompt_cache_key is not None:
            normalized_key = str(prompt_cache_key).strip()
            if normalized_key:
                payload["prompt_cache_key"] = normalized_key
            else:
                payload.pop("prompt_cache_key", None)

        prompt_cache_retention = kwargs.get("prompt_cache_retention")
        if prompt_cache_retention is None and payload.get("prompt_cache_retention") is not None:
            prompt_cache_retention = payload.get("prompt_cache_retention")
        if prompt_cache_retention is not None:
            normalized_retention = str(prompt_cache_retention).strip()
            if normalized_retention:
                payload["prompt_cache_retention"] = normalized_retention
            else:
                payload.pop("prompt_cache_retention", None)

        return payload

    @staticmethod
    def _usage_input_includes_cache(usage: Dict[str, Any]) -> bool:
        include_value = usage.get("input_tokens_include_cache")
        if isinstance(include_value, bool):
            return include_value

        exclude_value = usage.get("input_tokens_excludes_cache")
        if isinstance(exclude_value, bool):
            return not exclude_value

        # OpenAI 兼容响应里 prompt_tokens 通常是包含 cached 的总输入。
        prompt_tokens = usage.get("prompt_tokens")
        input_tokens = usage.get("input_tokens")
        try:
            if prompt_tokens is not None and input_tokens is not None:
                return int(prompt_tokens) == int(input_tokens)
        except (TypeError, ValueError):
            pass

        # 默认按“包含 cache”处理，避免重复计费。
        return True

    def _check_provider_rate_limit(
        self,
        *,
        service_tag: str = "llm",
    ) -> Optional[Dict[str, Any]]:
        """
        渠道级每分钟限流。
        委托到共享的 rate_limiter 模块，保持向后兼容。
        """
        from apps.services.llm.services.rate_limiter import check_provider_rate_limit_from_obj
        return check_provider_rate_limit_from_obj(
            self.provider, service_tag=service_tag,
        )

    def _execute_chat_with_retry(
        self,
        messages: List[Dict[str, str]],
        max_output_tokens: int,
        kwargs: Dict[str, Any],
    ) -> Dict[str, Any]:
        """统一重试策略（唯一重试层）：瞬态错误指数退避 + token limit 截断重试。

        子类 _do_chat 不应自行重试（_retry_on_failure 仅保留给流式路径）。
        本方法同时处理 _do_chat 返回的瞬态错误 dict 和抛出的瞬态异常。
        """
        result: Dict[str, Any] = {}
        for attempt in range(self.max_retries + 1):
            try:
                result = self._do_chat(messages, **kwargs)
            except Exception as exc:
                if self._is_task_time_limit_exception(exc):
                    logger.warning(
                        "%s chat() reached task time limit: %s",
                        self.provider_name, exc,
                    )
                    return self._build_error_result(exc)
                if attempt < self.max_retries and self._is_transient_exception(exc):
                    wait_time = self.retry_delay * (2 ** attempt)
                    logger.warning(
                        "%s 瞬态异常，第 %d/%d 次重试（等待 %ss）: %s",
                        self.provider_name, attempt + 1, self.max_retries, wait_time, exc,
                    )
                    time.sleep(wait_time)
                    continue
                logger.error("%s chat() 异常: %s", self.provider_name, exc, exc_info=True)
                return self._build_error_result(exc)

            if self._should_retry_for_token_limit(result):
                return self._retry_on_token_limit(messages, max_output_tokens, kwargs)

            if attempt < self.max_retries and self._is_transient_error_result(result):
                wait_time = self.retry_delay * (2 ** attempt)
                logger.warning(
                    "%s 瞬态错误，第 %d/%d 次重试（等待 %ss）: %s",
                    self.provider_name, attempt + 1, self.max_retries, wait_time,
                    result.get("error", ""),
                )
                time.sleep(wait_time)
                continue

            return result

        return result

    def _is_transient_exception(self, exc: Exception) -> bool:
        """判断异常是否为可重试的瞬态错误（429/5xx/超时/连接失败）。"""
        if self._is_task_time_limit_exception(exc):
            return False
        from apps.services.llm.errors import LLMErrorCode
        classified = self._classify_error(exc)
        return classified.code in (
            LLMErrorCode.RATE_LIMIT,
            LLMErrorCode.PROVIDER_DOWN,
            LLMErrorCode.TIMEOUT,
        )

    def _is_transient_error_result(self, result: Dict[str, Any]) -> bool:
        """判断 _do_chat 返回的结果是否为可重试的瞬态错误。

        Token limit 错误由 _retry_on_token_limit 专门处理，不视为瞬态。
        """
        if not isinstance(result, dict) or result.get("success"):
            return False
        if self._is_token_limit_error(result):
            return False

        if result.get("retryable") is False:
            return False
        if result.get("retryable"):
            return True

        from apps.services.llm.errors import LLMErrorCode
        error_code = str(result.get("error_code", ""))
        if error_code in (LLMErrorCode.RATE_LIMIT, LLMErrorCode.PROVIDER_DOWN, LLMErrorCode.TIMEOUT):
            return True

        status_code = result.get("status_code")
        if isinstance(status_code, int) and (status_code >= 500 or status_code == 429):
            return True

        return False

    def _retry_on_failure(self, func, *args, **kwargs):
        """指数退避重试——仅供流式路径（_do_chat_stream）使用。

        非流式路径的重试由 _execute_chat_with_retry 统一处理，
        _do_chat 中不应调用本方法，否则会产生双层重试叠加。
        """
        last_exception = None

        for attempt in range(self.max_retries + 1):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                last_exception = e

                if attempt < self.max_retries and self._is_transient_exception(e):
                    wait_time = max(self.retry_delay * (2 ** attempt), 1.0)
                    logger.warning("第 %d 次尝试失败，%s秒后重试: %s", attempt + 1, wait_time, e)
                    time.sleep(wait_time)
                else:
                    logger.error("重试 %d 次后仍然失败: %s", self.max_retries, e)
                    break

        raise last_exception

    @staticmethod
    def _is_task_time_limit_exception(exc: BaseException) -> bool:
        """Return True for Celery time-limit exceptions, even when wrapped."""
        try:
            from billiard.exceptions import SoftTimeLimitExceeded, TimeLimitExceeded
        except Exception:
            SoftTimeLimitExceeded = TimeLimitExceeded = ()  # type: ignore[assignment]

        seen: set[int] = set()
        stack: list[BaseException] = [exc]
        while stack:
            current = stack.pop()
            if id(current) in seen:
                continue
            seen.add(id(current))
            if SoftTimeLimitExceeded and isinstance(current, SoftTimeLimitExceeded):
                return True
            if TimeLimitExceeded and isinstance(current, TimeLimitExceeded):
                return True
            for next_exc in (
                getattr(current, "__cause__", None),
                getattr(current, "__context__", None),
            ):
                if next_exc is not None:
                    stack.append(next_exc)
        return False

    def _validate_messages(self, messages: List[Dict[str, Any]]) -> None:
        """
        验证消息格式

        Args:
            messages: 消息列表

        Raises:
            ValueError: 消息格式无效时
        """
        if not messages:
            raise ValueError("消息列表不能为空")

        for i, message in enumerate(messages):
            if not isinstance(message, dict):
                raise ValueError(f"消息 {i} 必须是字典格式")

            if 'role' not in message:
                raise ValueError(f"消息 {i} 缺少 'role' 字段")

            if 'content' not in message:
                raise ValueError(f"消息 {i} 缺少 'content' 字段")

            if message['role'] not in ['system', 'user', 'assistant', 'tool']:
                raise ValueError(f"消息 {i} 的 role '{message['role']}' 无效")

    def _validate_json_response(self, response_text: str) -> Dict[str, Any]:
        """
        验证并解析JSON响应

        Args:
            response_text: 响应文本

        Returns:
            Dict: 解析后的JSON

        Raises:
            ValueError: JSON格式无效时
        """
        try:
            # 尝试直接解析JSON
            return json.loads(response_text)
        except json.JSONDecodeError:
            # 查找JSON代码块
            json_match = re.search(r'```json\s*(\{.*?\})\s*```', response_text, re.DOTALL)
            if json_match:
                try:
                    return json.loads(json_match.group(1))
                except json.JSONDecodeError:
                    pass

            # 查找纯JSON对象
            json_match = re.search(r'(\{.*\})', response_text, re.DOTALL)
            if json_match:
                try:
                    return json.loads(json_match.group(1))
                except json.JSONDecodeError:
                    pass

            logger.error("无法解析JSON响应: %s...", response_text[:500])
            raise ValueError("LLM返回的响应不是有效的JSON格式")

    def get_supported_models(self) -> List[Dict[str, Any]]:
        """
        获取支持的模型列表

        Returns:
            List: 模型列表
        """
        return []

    def _record_llm_event(
        self,
        messages: List[Dict[str, str]],
        params: Dict[str, Any],
        result: Dict[str, Any],
        start_time: Optional[float],
        error: Optional[str] = None,
        is_stream: bool = False,
    ) -> None:
        """
        记录 LLM 调用事件（Trace）。
        对 params 做敏感字段清洗，防止 api_key / token 等写入 Trace。
        """
        try:
            from apps.services.common.observability.trace import TraceRecorder, get_current_parent_event_id
        except Exception:
            return

        duration_ms = None
        if start_time is not None:
            duration_ms = int((time.time() - start_time) * 1000)

        safe_params = _sanitize_dict(params) if isinstance(params, dict) else params

        input_data = {
            "messages": messages,
            "params": safe_params,
            "provider": self.provider_name,
            "model": (params or {}).get("model", self.model_name),
            "stream": is_stream,
        }
        try:
            from apps.services.llm.context import get_llm_request_id, get_llm_source
            _ctx_request_id = get_llm_request_id()
            _ctx_source = get_llm_source()
            if _ctx_request_id:
                input_data["request_id"] = _ctx_request_id
            if _ctx_source:
                input_data["source"] = _ctx_source
        except Exception:
            pass
        TraceRecorder.record_event(
            event_type="llm",
            name=(params or {}).get("model", self.model_name),
            input_data=input_data,
            output_data=result,
            error=error,
            usage=result.get("usage") if isinstance(result, dict) else None,
            duration_ms=duration_ms,
            parent_event_id=get_current_parent_event_id(),
        )

    def _classify_error(self, exc: Exception) -> 'LLMServiceError':
        """
        将 Provider 原始异常映射到统一 LLMServiceError。

        子类应覆写此方法以精确分类各 SDK 的异常类型。
        基类提供通用兜底分类。
        """
        from apps.services.llm.errors import LLMServiceError, LLMErrorCode

        code = LLMErrorCode.SERVICE_ERROR
        status_code = getattr(exc, 'status_code', None)
        error_type = getattr(exc, 'type', None)
        error_details = getattr(exc, 'body', None)
        msg = str(exc)

        if isinstance(exc, (TimeoutError, OSError)) and 'timed out' in msg.lower():
            code = LLMErrorCode.TIMEOUT
        elif isinstance(exc, TimeoutError):
            code = LLMErrorCode.TIMEOUT
        elif status_code == 401 or status_code == 403:
            code = LLMErrorCode.AUTH_FAILED
        elif status_code == 429:
            code = LLMErrorCode.RATE_LIMIT
        elif status_code == 413:
            code = LLMErrorCode.TOKEN_LIMIT
        elif status_code == 404:
            code = LLMErrorCode.MODEL_NOT_FOUND
        elif status_code is not None and 500 <= status_code <= 599:
            code = LLMErrorCode.PROVIDER_DOWN

        return LLMServiceError(
            code=code,
            message=msg,
            status_code=status_code,
            provider_error=exc,
            error_type=str(error_type) if error_type else None,
            error_details=error_details if isinstance(error_details, dict) else None,
        )

    def _build_error_result(self, exc: Exception, response_time: float = 0) -> Dict[str, Any]:
        """
        从异常构建标准错误响应字典，确保 error_code 不为 None。
        """
        from apps.services.llm.errors import LLMErrorCode, LLMServiceError

        if self._is_task_time_limit_exception(exc):
            svc_err = LLMServiceError(
                code=LLMErrorCode.TIMEOUT,
                message="模型上游响应超时，任务已停止。请稍后重试或换一个模型。",
                provider_error=exc,
                error_type="task_timeout",
                retryable=False,
            )
            return svc_err.to_error_result(response_time=response_time)

        if isinstance(exc, LLMServiceError):
            svc_err = exc
        else:
            svc_err = self._classify_error(exc)

        return svc_err.to_error_result(response_time=response_time)

    def _build_stream_error_result(self, exc: Exception, start_time: float) -> Dict[str, Any]:
        """流式场景的标准错误响应，在 _build_error_result 基础上补充 finished 标记。"""
        result = self._build_error_result(exc, response_time=time.time() - start_time)
        result["finished"] = True
        return result

    def _get_token_counter(self):
        """
        获取 Token 计数器实例
        """
        from apps.services.llm.utils.token_counter import TokenCounterFactory
        return TokenCounterFactory.create_counter(self.provider_name, self.model_name)

    def _count_tokens(self, messages: List[Dict[str, str]]) -> int:
        """
        计算消息列表的 Token 数量
        """
        counter = self._get_token_counter()
        return counter.count_messages_tokens(messages)

    @classmethod
    def _strip_images_for_token_count(cls, messages: List[Dict]) -> tuple:
        """将 image_url 内容替换为占位文本，返回 (精简消息, 图片 token 估算)。"""
        stripped = []
        image_count = 0
        for msg in messages:
            content = msg.get("content")
            if not isinstance(content, list):
                stripped.append(msg)
                continue
            new_parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    new_parts.append({"type": "text", "text": "[image]"})
                    image_count += 1
                else:
                    new_parts.append(part)
            stripped.append({**msg, "content": new_parts})
        return stripped, image_count * cls.IMAGE_TOKEN_ESTIMATE

    def _check_and_truncate_messages(
        self,
        messages: List[Dict[str, str]],
        max_output_tokens: int
    ) -> List[Dict[str, str]]:
        """
        检查并截断消息列表，确保不超过上下文上限。

        流程：
        1. 无限制配置 → 原样返回
        2. 未超限 → 原样返回
        3. 超限 → 计算预算并截断
        """
        if not self.context_window_tokens and self.max_input_tokens is None:
            return messages

        counter = self._get_token_counter()
        stripped_msgs, image_tokens = self._strip_images_for_token_count(messages)
        input_tokens = counter.count_messages_tokens(stripped_msgs) + image_tokens

        if not self._is_over_limit(input_tokens, max_output_tokens):
            logger.debug(
                "[TokenCheck] input=%s, output=%s, limit=%s ✅",
                input_tokens, max_output_tokens, self.context_window_tokens,
            )
            return messages

        max_input = self._compute_input_budget(max_output_tokens)
        if max_input is None:
            return messages

        return self._do_truncate(messages, input_tokens, max_output_tokens, max_input)

    def _is_over_limit(self, input_tokens: int, max_output_tokens: int) -> bool:
        """判断当前输入是否超过上下文/输入上限。"""
        if self.context_window_tokens:
            total_tokens = input_tokens + max_output_tokens
            if total_tokens > self.context_window_tokens:
                return True
            if self.max_input_tokens is not None and input_tokens > self.max_input_tokens:
                return True
            return False

        # 无 context_window 但有 max_input_tokens
        return input_tokens > (self.max_input_tokens or 0)

    def _compute_input_budget(self, max_output_tokens: int) -> Optional[int]:
        """计算截断后允许的最大输入 token 数。"""
        max_input: Optional[int] = None

        if self.context_window_tokens:
            max_input = self.context_window_tokens - max_output_tokens

        if self.max_input_tokens is not None:
            max_input = min(max_input, self.max_input_tokens) if max_input is not None else self.max_input_tokens

        if max_input is not None and max_input <= 0:
            raise ValueError(
                f"max_output_tokens ({max_output_tokens}) 已超过上下文容量 ({self.context_window_tokens})"
            )

        return max_input

    def _do_truncate(
        self,
        messages: List[Dict[str, str]],
        input_tokens: int,
        max_output_tokens: int,
        max_input: int,
    ) -> List[Dict[str, str]]:
        """执行截断并记录日志。"""
        logger.warning(
            "[TokenCheck] 超限！input=%s, output=%s, limit=%s ❌",
            input_tokens, max_output_tokens, self.context_window_tokens,
        )

        truncated_messages = self._truncate_messages(messages, max_input)

        counter = self._get_token_counter()
        truncated_tokens = counter.count_messages_tokens(truncated_messages)
        logger.info(
            "[TokenCheck] 截断完成：%s → %s tokens", input_tokens, truncated_tokens,
        )

        return truncated_messages

    def _truncate_messages(self, messages: List[Dict[str, str]], max_input_tokens: int) -> List[Dict[str, str]]:
        """
        使用剪枝器截断消息列表。
        """
        from apps.services.llm.utils.content_pruner import SimpleContentPruner
        pruner = SimpleContentPruner(self.provider_name, self.model_name)
        return pruner.prune_messages(messages, max_input_tokens)

    def _should_retry_for_token_limit(self, result: Dict[str, Any]) -> bool:
        """
        判断是否需要针对 token limit 错误重试。
        """
        if not isinstance(result, dict):
            return False
        if result.get("success"):
            return False
        return self._is_token_limit_error(result)

    def _is_token_limit_error(self, result: Dict[str, Any]) -> bool:
        """
        识别 token / context length 超限错误。

        使用模块级 ``_OVERFLOW_PATTERNS`` 统一匹配，
        覆盖所有主流供应商的已知错误文案，无需 per-provider 分组。
        """
        from apps.services.llm.errors import LLMErrorCode

        # 1. 统一错误码快速判断
        error_code_raw = str(result.get("error_code", ""))
        if error_code_raw == LLMErrorCode.TOKEN_LIMIT:
            return True

        # 2. 结构化字段
        error_text = str(result.get("error", ""))
        error_code = str(result.get("error_code", "")).lower()
        status_code = result.get("status_code")
        error_details = result.get("error_details") or {}

        if isinstance(error_details, dict):
            error_code = str(error_details.get("code", error_code)).lower()
            detail_msg = str(error_details.get("message", ""))
            if detail_msg:
                error_text = f"{error_text} {detail_msg}"

        if status_code in {413}:
            return True

        if error_code in {"context_length_exceeded", "max_tokens", "token_limit"}:
            return True

        # 3. 排除配额耗尽类错误（Gemini resource exhausted 等），避免误分类为 TOKEN_LIMIT
        if re.search(r"resource[\s_]exhausted", error_text, re.I):
            return False

        # 4. 通用正则扫描（provider 无关）
        return any(p.search(error_text) for p in _OVERFLOW_PATTERNS)

    def _retry_on_token_limit(
        self,
        messages: List[Dict[str, str]],
        max_output_tokens: int,
        kwargs: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        针对 token limit 错误进行截断重试。
        """
        if not self.context_window_tokens and self.max_input_tokens is None:
            return {
                "success": False,
                "error": "Token limit exceeded (context window not configured)",
                "error_code": "TOKEN_LIMIT",
            }

        current_messages = messages
        current_max_output = max_output_tokens

        for attempt in range(1, self.max_retries + 1):
            current_max_output = max(1, int(current_max_output * 0.9))
            max_input_budget = (
                self.context_window_tokens - current_max_output
                if self.context_window_tokens
                else self.max_input_tokens
            )
            if max_input_budget is None or max_input_budget <= 0:
                break

            if self.max_input_tokens is not None:
                max_input_budget = min(max_input_budget, self.max_input_tokens)
            max_input_budget = int(max_input_budget * 0.9)
            current_messages = self._truncate_messages(current_messages, max_input_budget)

            retry_kwargs = dict(kwargs)
            retry_kwargs["max_tokens"] = current_max_output

            result = self._do_chat(current_messages, **retry_kwargs)
            if not self._should_retry_for_token_limit(result):
                return result

        return {
            "success": False,
            "error": "Token limit exceeded after retries",
            "error_code": "TOKEN_LIMIT",
        }

    def _resolve_max_output_tokens(self, kwargs: Dict[str, Any]) -> int:
        """
        解析最终输出 token 上限。
        优先级：kwargs > DB 配置 > Registry ProviderMetadata.default_max_output_tokens
        """
        max_tokens = kwargs.get('max_tokens')
        if max_tokens is not None:
            if self.max_output_tokens is not None:
                max_tokens = min(max_tokens, self.max_output_tokens)
            if self.context_window_tokens is not None:
                max_tokens = min(max_tokens, self.context_window_tokens)
            return max_tokens

        if self.max_output_tokens is not None:
            return self.max_output_tokens

        from apps.services.llm.registry import ProviderRegistry
        meta = ProviderRegistry.get(self.provider_name)
        resolved = meta.default_max_output_tokens if meta else 4096
        if self.context_window_tokens is not None:
            resolved = min(resolved, self.context_window_tokens)
        return resolved

    def __str__(self):
        return f"{self.provider_name}Service(model={self.model_name})"

    def __repr__(self):
        return self.__str__()

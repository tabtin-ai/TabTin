"""
OpenAI服务实现
"""

from typing import Dict, Any, List, Generator, Optional, Tuple
import logging
import time
import json
import asyncio
import uuid

import httpx
import openai
import requests
from decimal import Decimal

from apps.services.llm.services.base import BaseLLMService
from apps.services.llm.utils.capabilities import ModelCapabilities

logger = logging.getLogger(__name__)


class OpenAIService(BaseLLMService):
    """OpenAI API服务实现"""

    CAPABILITIES = ModelCapabilities(
        supports_streaming=True,
        supports_function_calling=True,
        supports_vision=True,
        supports_document_input=False,
        supports_prompt_caching=True,
        supports_reasoning=False,
        supports_json_mode=True,
        supports_responses_api=True,
        supports_token_estimate=False,
        supports_tool_choice=True,
        supports_parallel_function_calling=True,
    ).to_dict()

    @classmethod
    def validate_provider_config(cls, provider_name: str, config: dict) -> None:
        base_url = config.get('base_url', '')
        api_key = config.get('api_key', '')

        if provider_name == 'zenmux':
            if 'zenmux.ai' not in base_url:
                logger.warning("ZenMux base_url 建议为 https://zenmux.ai/api/v1")
            return

        if not base_url.startswith('https://') and not any(
            h in base_url for h in ('localhost', '127.0.0.1', '0.0.0.0', '[::1]')
        ):
            logger.warning("%s base_url 建议使用HTTPS", provider_name)

        if provider_name == 'openai' and not api_key.startswith('sk-'):
            logger.warning("OpenAI API密钥格式可能不正确")

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)

        request_timeout = self._resolve_request_timeout()
        self.client = openai.OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=httpx.Timeout(float(request_timeout), connect=10.0),
            max_retries=0,
        )

        # OpenAI特定配置
        self.default_model = provider_config.get('model_name', 'gpt-4')
        self.organization = provider_config.get('organization')

        if self.organization:
            self.client.organization = self.organization

    def _classify_error(self, exc: Exception) -> 'LLMServiceError':
        from apps.services.llm.utils.error_classifier import OpenAIErrorClassifier
        return OpenAIErrorClassifier.classify(exc)

    def _do_chat(self, messages: List[Dict[str, str]], **kwargs) -> Dict[str, Any]:
        """实际聊天接口实现（由 Base Service 的 chat 调用）"""
        start_time = time.time()
        params = None

        try:
            use_responses_api, is_explicit_variant = self._resolve_responses_api_mode(kwargs)
            result = None

            if use_responses_api:
                params = self._prepare_responses_params(messages, stream=False, **kwargs)

                try:
                    if self._should_use_codex_gateway(kwargs):
                        response = self._request_codex_response_json(params, kwargs)
                    else:
                        response = self.client.responses.create(**params)
                    result = self._process_responses_chat_response(response, start_time)
                except Exception as resp_err:
                    if self._can_fallback_from_responses_error(resp_err, is_explicit_variant):
                        logger.warning("Responses API 不可用，自动回退 chat.completions: %s", resp_err)
                        use_responses_api = False
                    else:
                        raise

            if result is None and not use_responses_api:
                params = self._prepare_chat_params(messages, **kwargs)
                response = self.client.chat.completions.create(**params)

                # 处理响应
                result = self._process_chat_response(response, start_time)

            self._record_llm_event(
                messages=messages,
                params=params,
                result=result,
                start_time=start_time,
                error=None,
                is_stream=False,
            )

            logger.info(
                "OpenAI聊天完成: tokens=%s, cost=$%s, time=%.2fs",
                result['usage']['total_tokens'], result['cost']['total_cost'], result['response_time'],
            )

            return result

        except Exception as e:
            logger.error("OpenAI服务异常: %s", e, exc_info=True)
            result = self._build_error_result(e, response_time=time.time() - start_time)
            self._record_llm_event(
                messages=messages,
                params=params or {"model": self.default_model},
                result=result,
                start_time=start_time,
                error=str(e),
                is_stream=False,
            )
            return result

    def _do_chat_stream(self, messages: List[Dict[str, str]], **kwargs) -> Generator[Dict[str, Any], None, None]:
        """流式聊天实现（由基类 chat_stream 调用，消息已经过校验、限流和截断）。"""
        start_time = time.time()
        params = None

        try:
            use_responses_api, is_explicit_variant = self._resolve_responses_api_mode(kwargs)

            if use_responses_api:
                params = self._prepare_responses_params(messages, stream=True, **kwargs)
                has_yielded = False
                try:
                    if self._should_use_codex_gateway(kwargs):
                        if self._should_use_codex_websocket(kwargs):
                            stream = self._iter_codex_websocket_events(params, kwargs)
                        else:
                            stream = self._iter_codex_sse_events(params, kwargs)
                    else:
                        def _make_responses_stream_request():
                            return self.client.responses.create(**params)

                        stream = self._retry_on_failure(_make_responses_stream_request)
                    for chunk in self._stream_responses_events(
                        stream=stream,
                        messages=messages,
                        params=params,
                        start_time=start_time,
                    ):
                        has_yielded = True
                        yield chunk
                    return
                except Exception as resp_err:
                    if has_yielded:
                        logger.error(
                            "Responses API 流式中途失败，已发出部分数据无法回退: %s",
                            resp_err, exc_info=True,
                        )
                        yield self._build_stream_error_result(resp_err, start_time)
                        return
                    if self._can_fallback_from_responses_error(resp_err, is_explicit_variant):
                        logger.warning("Responses API 流式不可用，自动回退 chat.completions: %s", resp_err)
                    else:
                        raise

            # 回退或默认走 Chat Completions Stream
            params = self._prepare_chat_params(messages, stream=True, **kwargs)

            def _make_stream_request():
                return self.client.chat.completions.create(**params)

            stream = self._retry_on_failure(_make_stream_request)

            full_content = ""
            usage_info = None
            tool_calls_acc: List[Dict[str, Any]] = []

            for chunk in stream:
                chunk_data = self._process_stream_chunk(chunk)

                if chunk_data.get('content'):
                    full_content += chunk_data['content']

                deltas = chunk_data.get("tool_calls_delta") or []
                if deltas:
                    self._merge_stream_tool_calls(tool_calls_acc, deltas)
                    chunk_data["tool_calls"] = tool_calls_acc

                if chunk_data.get('usage'):
                    usage_info = chunk_data['usage']

                yield chunk_data

            if not usage_info:
                usage_info = self._estimate_stream_usage(messages, full_content)

            final_chunk = {
                "success": True,
                "content": "",
                "finished": True,
                "response_time": time.time() - start_time,
                "model": params.get('model', self.default_model),
            }
            if usage_info:
                final_chunk["usage"] = usage_info
                final_chunk["cost"] = self._calculate_cost_from_usage(usage_info)
            if tool_calls_acc:
                final_chunk["tool_calls"] = tool_calls_acc

            yield final_chunk
            self._record_llm_event(
                messages=messages,
                params=params,
                result={
                    "success": True,
                    "content": full_content,
                    "usage": usage_info,
                    "tool_calls": tool_calls_acc or None,
                    "response_time": final_chunk.get("response_time"),
                    "model": final_chunk.get("model"),
                },
                start_time=start_time,
                error=None,
                is_stream=True,
            )

            if usage_info:
                logger.info(
                    "OpenAI流式聊天完成: tokens=%s, time=%.2fs%s",
                    usage_info.get("total_tokens", 0),
                    final_chunk["response_time"],
                    " (estimated)" if usage_info.get("estimated") else "",
                )

        except Exception as e:
            logger.error("OpenAI流式服务异常: %s", e, exc_info=True)
            result = self._build_stream_error_result(e, start_time)
            self._record_llm_event(
                messages=messages,
                params=params or {"model": self.default_model},
                result=result,
                start_time=start_time,
                error=str(e),
                is_stream=True,
            )
            yield result

    def chat_with_images(self, messages: List[Dict[str, str]],
                        images: List[str], **kwargs) -> Dict[str, Any]:
        """带图片的聊天接口（委托给基类消息管道）。"""
        return super().chat_with_images(messages, images, **kwargs)

    def _validate_connection(self) -> Dict[str, Any]:
        """验证OpenAI连接（支持本地模型冷启动的长超时）"""
        timeout = 5
        try:
            from apps.services.llm.registry import ProviderRegistry
            meta = ProviderRegistry.get(self.provider_name)
            if meta:
                timeout = meta.connection_timeout
        except Exception:
            pass

        try:
            models = self.client.with_options(
                timeout=httpx.Timeout(float(timeout), connect=float(timeout)),
            ).models.list()

            return {
                "valid": True,
                "details": {
                    "models_count": len(models.data),
                    "available_models": [model.id for model in models.data[:5]]
                }
            }
        except openai.APITimeoutError as e:
            classified = self._classify_error(e)
            return {
                "valid": False,
                "error": f"连接超时（{timeout}s），本地模型可能正在加载中",
                "error_code": classified.code,
                "status_code": classified.status_code,
            }
        except openai.APIError as e:
            classified = self._classify_error(e)
            return {
                "valid": False,
                "error": f"OpenAI API连接失败: {str(e)}",
                "error_code": classified.code,
                "status_code": classified.status_code,
            }
        except Exception as e:
            classified = self._classify_error(e)
            return {
                "valid": False,
                "error": f"连接验证异常: {str(e)}",
                "error_code": classified.code,
                "status_code": classified.status_code,
            }

    def _prepare_chat_params(self, messages: List[Dict[str, str]], **kwargs) -> Dict[str, Any]:
        """准备聊天请求参数"""
        # ✅ 使用配置的 max_output_tokens（优先级：kwargs > 配置 > 默认值）
        max_tokens = kwargs.get('max_tokens')
        if max_tokens is None and self.max_output_tokens:
            max_tokens = self.max_output_tokens
        if max_tokens is None:
            max_tokens = 2000  # 最终默认值

        model_name = kwargs.get('model', self.default_model) or ''

        params: Dict[str, Any] = {
            'model': model_name,
            'messages': messages,
            'max_tokens': max_tokens,
        }

        if not kwargs.get('use_model_default_sampling', False):
            temperature = kwargs.get('temperature', 0.7)
            params['temperature'] = temperature
            params['top_p'] = kwargs.get('top_p', 1.0)
            params['frequency_penalty'] = kwargs.get('frequency_penalty', 0.0)
            params['presence_penalty'] = kwargs.get('presence_penalty', 0.0)

        # 流式参数
        if kwargs.get('stream', False):
            params['stream'] = True
            params['stream_options'] = {"include_usage": True}

        # JSON模式（如果模型支持）
        if kwargs.get('response_format') == 'json_object':
            if self._model_supports_json_mode(params['model']):
                params['response_format'] = {'type': 'json_object'}
        elif kwargs.get('response_format'):
            params['response_format'] = kwargs['response_format']

        # 函数调用（如果提供）
        if kwargs.get('functions'):
            params['functions'] = kwargs['functions']

        if kwargs.get('function_call'):
            params['function_call'] = kwargs['function_call']

        if kwargs.get('tools'):
            params['tools'] = kwargs['tools']

        if kwargs.get('tool_choice') is not None:
            params['tool_choice'] = kwargs['tool_choice']

        if kwargs.get('metadata') and isinstance(kwargs.get('metadata'), dict):
            params['metadata'] = kwargs['metadata']

        extra_body = kwargs.get('extra_body')
        if not isinstance(extra_body, dict):
            extra_body = {}
        if kwargs.get('thinking') is not None:
            extra_body['thinking'] = kwargs['thinking']
        extra_body = self._inject_prompt_cache_payload(extra_body, kwargs)
        if extra_body:
            params['extra_body'] = extra_body

        from apps.services.llm.utils.param_adaptor import adapt_params
        return adapt_params(params, model_name, model_obj=self.model)

    def _resolve_responses_api_mode(self, kwargs: Dict[str, Any]) -> Tuple[bool, bool]:
        """
        解析是否启用 Responses API。

        Returns:
            (use_responses_api, is_explicit_variant)
        """
        api_variant = kwargs.get("api_variant")
        if api_variant is not None:
            normalized = str(api_variant).strip().lower()
            return normalized in {"responses", "response"}, True

        use_flag = kwargs.get("use_responses_api")
        if use_flag is not None:
            return bool(use_flag), True

        model_obj = self.model
        capabilities = {}
        if model_obj is not None:
            capabilities = getattr(model_obj, "capabilities_config", None) or {}

        if not capabilities and isinstance(self.config.get("capabilities_config"), dict):
            capabilities = self.config.get("capabilities_config") or {}

        truthy_keys = (
            "supports_responses_api",
            "supports_response_api",
            "use_responses_api",
            "supports_openai_responses",
        )
        for key in truthy_keys:
            if self._is_truthy(capabilities.get(key)):
                return True, False

        variant_keys = ("api_variant", "default_api_variant", "openai_api_variant")
        for key in variant_keys:
            raw = capabilities.get(key)
            if not raw:
                continue
            normalized = str(raw).strip().lower()
            if normalized in {"responses", "response"}:
                return True, False

        if self._is_codex_provider():
            return True, False

        return False, False

    def _is_codex_provider(self) -> bool:
        provider_name = str(self.provider_name or "").strip().lower()
        if provider_name == "codex":
            return True

        provider_obj = self.provider
        provider_key = ""
        if provider_obj is not None:
            provider_key = str(getattr(provider_obj, "provider_key", "") or "")
        if not provider_key:
            provider_key = str(self.config.get("provider_key", "") or "")
        provider_key = provider_key.strip().lower()
        return provider_key in {"codex", "openai-codex", "openai_codex"}

    @staticmethod
    def _is_truthy(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return False

    @staticmethod
    def _can_fallback_from_responses(error: openai.APIError, is_explicit_variant: bool) -> bool:
        """隐式启用 Responses 时可回退；显式要求时不回退。"""
        if is_explicit_variant:
            return False

        status_code = getattr(error, "status_code", None)
        if status_code in {400, 404, 405, 501}:
            return True

        text = str(error).lower()
        fallback_patterns = (
            "responses",
            "not found",
            "unsupported",
            "unknown endpoint",
        )
        return any(pattern in text for pattern in fallback_patterns)

    def _can_fallback_from_responses_error(self, error: Exception, is_explicit_variant: bool) -> bool:
        if isinstance(error, openai.APIError):
            return self._can_fallback_from_responses(error, is_explicit_variant)
        if is_explicit_variant:
            return False

        text = str(error).lower()
        fallback_patterns = (
            "responses api",
            "responses endpoint",
            "not found",
            "unsupported",
            "unknown endpoint",
        )
        return any(pattern in text for pattern in fallback_patterns)

    def _should_use_codex_gateway(self, kwargs: Dict[str, Any]) -> bool:
        if not self._is_codex_provider():
            return False
        if self._is_truthy(kwargs.get("codex_gateway")):
            return True
        base_url = self._resolve_codex_base_url(kwargs)
        return "chatgpt.com/backend-api/codex" in base_url.lower()

    def _should_use_codex_websocket(self, kwargs: Dict[str, Any]) -> bool:
        transport = str(kwargs.get("codex_transport") or "").strip().lower()
        if transport == "websocket":
            return True
        if transport in {"http", "sse"}:
            return False

        if kwargs.get("codex_websocket") is not None:
            return bool(kwargs.get("codex_websocket"))
        if self.config.get("codex_websocket") is not None:
            return bool(self.config.get("codex_websocket"))
        return False

    def _resolve_codex_base_url(self, kwargs: Dict[str, Any]) -> str:
        override = kwargs.get("codex_base_url")
        if override:
            return str(override).strip().rstrip("/")
        base = str(self.base_url or "").strip().rstrip("/")
        if base:
            return base
        return "https://chatgpt.com/backend-api/codex"

    def _resolve_codex_websocket_url(self, kwargs: Dict[str, Any]) -> str:
        override = kwargs.get("codex_websocket_url")
        if override:
            return str(override).strip()
        base_url = self._resolve_codex_base_url(kwargs).rstrip("/")
        if base_url.startswith("https://"):
            return "wss://" + base_url[len("https://"):].rstrip("/") + "/responses"
        if base_url.startswith("http://"):
            return "ws://" + base_url[len("http://"):].rstrip("/") + "/responses"
        return base_url.rstrip("/") + "/responses"

    def _resolve_codex_access_token(self, kwargs: Dict[str, Any]) -> str:
        token = (
            kwargs.get("codex_access_token")
            or kwargs.get("access_token")
            or self.config.get("codex_access_token")
            or self.api_key
            or ""
        )
        token = str(token).strip()
        if token.lower().startswith("bearer "):
            token = token[7:].strip()

        if not token:
            raise ValueError("Codex 网关缺少 access token（请配置 api_key 或 codex_access_token）")
        return token

    def _build_codex_headers(self, kwargs: Dict[str, Any], *, include_content_type: bool = True) -> Dict[str, str]:
        token = self._resolve_codex_access_token(kwargs)
        headers: Dict[str, str] = {
            "Authorization": f"Bearer {token}",
        }
        if include_content_type:
            headers["Content-Type"] = "application/json"

        originator = kwargs.get("codex_originator") or self.config.get("codex_originator") or "tabtin"
        session_id = kwargs.get("codex_session_id") or self.config.get("codex_session_id") or str(uuid.uuid4())
        headers["originator"] = str(originator)
        headers["session_id"] = str(session_id)

        account_id = kwargs.get("codex_account_id") or self.config.get("codex_account_id")
        if account_id:
            headers["ChatGPT-Account-Id"] = str(account_id)

        user_agent = kwargs.get("codex_user_agent") or self.config.get("codex_user_agent")
        if user_agent:
            headers["User-Agent"] = str(user_agent)

        ws_beta = kwargs.get("codex_websocket_beta") or self.config.get("codex_websocket_beta")
        if ws_beta:
            headers["OpenAI-Beta"] = str(ws_beta)

        extra_headers = kwargs.get("codex_headers")
        if isinstance(extra_headers, dict):
            for key, value in extra_headers.items():
                if key and value is not None:
                    headers[str(key)] = str(value)

        return headers

    def _request_codex_response_json(self, params: Dict[str, Any], kwargs: Dict[str, Any]) -> Dict[str, Any]:
        url = self._resolve_codex_base_url(kwargs).rstrip("/") + "/responses"
        payload = dict(params)
        payload["stream"] = False

        timeout = kwargs.get("codex_timeout_seconds", 120)
        headers = self._build_codex_headers(kwargs, include_content_type=True)
        response = requests.post(url, headers=headers, json=payload, timeout=timeout)
        if response.status_code >= 400:
            detail = response.text.strip()
            raise RuntimeError(f"Codex HTTP 请求失败: status={response.status_code}, detail={detail}")
        return response.json()

    def _iter_codex_sse_events(self, params: Dict[str, Any], kwargs: Dict[str, Any]) -> Generator[Dict[str, Any], None, None]:
        url = self._resolve_codex_base_url(kwargs).rstrip("/") + "/responses"
        timeout = kwargs.get("codex_timeout_seconds", 180)
        read_timeout = kwargs.get("codex_read_timeout_seconds", 90)
        headers = self._build_codex_headers(kwargs, include_content_type=True)

        with requests.post(
            url, headers=headers, json=params,
            timeout=(min(timeout, 30), read_timeout),
            stream=True,
        ) as response:
            if response.status_code >= 400:
                detail = response.text.strip()
                raise RuntimeError(f"Codex SSE 请求失败: status={response.status_code}, detail={detail}")

            for raw_line in response.iter_lines(decode_unicode=True):
                if raw_line is None:
                    continue
                line = str(raw_line).strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    event = json.loads(data)
                except Exception:
                    logger.debug("Codex SSE 非 JSON 事件，已忽略: %s", data[:200])
                    continue
                if isinstance(event, dict):
                    yield event

    def _iter_codex_websocket_events(
        self,
        params: Dict[str, Any],
        kwargs: Dict[str, Any],
    ) -> Generator[Dict[str, Any], None, None]:
        try:
            import aiohttp  # type: ignore
        except Exception as exc:
            raise RuntimeError("Codex websocket 模式依赖 aiohttp，请先安装后再启用 codex_transport=websocket") from exc

        ws_url = self._resolve_codex_websocket_url(kwargs)
        timeout = kwargs.get("codex_timeout_seconds", 180)
        read_timeout = kwargs.get("codex_read_timeout_seconds", 90)
        headers = self._build_codex_headers(kwargs, include_content_type=False)
        if "OpenAI-Beta" not in headers:
            headers["OpenAI-Beta"] = "responses_websockets=2026-02-06"

        owns_loop = False
        try:
            asyncio.get_running_loop()
            loop = asyncio.new_event_loop()
            owns_loop = True
        except RuntimeError:
            loop = asyncio.new_event_loop()
            owns_loop = True

        session = None
        ws = None
        prev_loop = None
        try:
            if owns_loop:
                try:
                    prev_loop = asyncio.get_event_loop()
                except RuntimeError:
                    prev_loop = None
                asyncio.set_event_loop(loop)

            session_timeout = aiohttp.ClientTimeout(total=float(timeout))
            session = aiohttp.ClientSession(timeout=session_timeout)
            ws = loop.run_until_complete(
                session.ws_connect(ws_url, headers=headers, heartbeat=30)
            )
            payload = dict(params)
            payload["type"] = "response.create"
            loop.run_until_complete(ws.send_json(payload))

            while True:
                message = loop.run_until_complete(
                    asyncio.wait_for(ws.receive(), timeout=read_timeout)
                )
                if message.type == aiohttp.WSMsgType.TEXT:
                    try:
                        event = json.loads(message.data)
                    except Exception:
                        logger.debug("Codex WS 非 JSON 事件，已忽略: %s", str(message.data)[:200])
                        continue
                    if not isinstance(event, dict):
                        continue
                    yield event
                    event_type = str(event.get("type", "")).strip().lower()
                    if event_type in {"response.completed", "response.done", "response.failed"}:
                        break
                    if event_type == "error":
                        error_message = (
                            event.get("error", {}).get("message")
                            if isinstance(event.get("error"), dict)
                            else event.get("message")
                        ) or "Codex websocket 返回错误"
                        raise RuntimeError(str(error_message))
                elif message.type in {aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED}:
                    break
                elif message.type == aiohttp.WSMsgType.ERROR:
                    raise RuntimeError(f"Codex websocket 错误: {ws.exception()}")
        finally:
            if ws is not None:
                try:
                    loop.run_until_complete(ws.close())
                except Exception:
                    pass
            if session is not None:
                try:
                    loop.run_until_complete(session.close())
                except Exception:
                    pass
            if owns_loop:
                try:
                    loop.close()
                except Exception:
                    pass
                if prev_loop is not None:
                    asyncio.set_event_loop(prev_loop)
                else:
                    asyncio.set_event_loop(None)

    def _prepare_responses_params(self, messages: List[Dict[str, Any]], **kwargs) -> Dict[str, Any]:
        """准备 Responses API 请求参数。"""
        input_items, instructions = self._convert_messages_to_responses_input(messages)
        max_output_tokens = self._resolve_max_output_tokens(kwargs)

        params: Dict[str, Any] = {
            "model": kwargs.get("model", self.default_model),
            "input": input_items,
            "stream": bool(kwargs.get("stream", False)),
            "max_output_tokens": max_output_tokens,
        }

        if instructions:
            params["instructions"] = instructions

        if (
            not kwargs.get("use_model_default_sampling", False)
            and kwargs.get("temperature") is not None
        ):
            params["temperature"] = kwargs.get("temperature")
        if (
            not kwargs.get("use_model_default_sampling", False)
            and kwargs.get("top_p") is not None
        ):
            params["top_p"] = kwargs.get("top_p")

        if kwargs.get("metadata") and isinstance(kwargs.get("metadata"), dict):
            params["metadata"] = kwargs["metadata"]

        if kwargs.get("store") is not None:
            params["store"] = bool(kwargs.get("store"))

        previous_response_id = kwargs.get("previous_response_id")
        if previous_response_id:
            params["previous_response_id"] = str(previous_response_id)

        include = kwargs.get("include")
        if isinstance(include, list) and include:
            params["include"] = include

        reasoning = self._build_responses_reasoning(kwargs.get("thinking"))
        if reasoning:
            params["reasoning"] = reasoning

        response_tools = self._build_responses_tools(kwargs)
        if response_tools:
            params["tools"] = response_tools

        tool_choice = kwargs.get("tool_choice")
        if tool_choice is not None:
            params["tool_choice"] = tool_choice

        text_format = self._build_responses_text_format(kwargs.get("response_format"))
        if text_format:
            params["text"] = {"format": text_format}

        extra_body = kwargs.get("extra_body")
        if not isinstance(extra_body, dict):
            extra_body = {}
        extra_body = self._inject_prompt_cache_payload(extra_body, kwargs)
        if extra_body:
            params["extra_body"] = extra_body

        return params

    def _build_responses_reasoning(self, thinking: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(thinking, dict):
            return None

        effort = thinking.get("effort") or thinking.get("reasoning_effort")
        summary = thinking.get("summary")
        reasoning: Dict[str, Any] = {}
        if effort:
            reasoning["effort"] = effort
        if summary:
            reasoning["summary"] = summary
        return reasoning or None

    def _build_responses_tools(self, kwargs: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
        tools = kwargs.get("tools")
        if isinstance(tools, list) and tools:
            converted = []
            for item in tools:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "function" and isinstance(item.get("function"), dict):
                    fn = item["function"]
                    if not fn.get("name"):
                        continue
                    converted.append(
                        {
                            "type": "function",
                            "name": fn.get("name"),
                            "description": fn.get("description", ""),
                            "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
                            "strict": fn.get("strict", False),
                        }
                    )
                    continue

                name = item.get("name")
                if not name:
                    continue
                converted.append(
                    {
                        "type": "function",
                        "name": name,
                        "description": item.get("description", ""),
                        "parameters": item.get("parameters")
                        or item.get("input_schema")
                        or {"type": "object", "properties": {}},
                        "strict": item.get("strict", False),
                    }
                )
            return converted or None

        functions = kwargs.get("functions")
        if not isinstance(functions, list) or not functions:
            return None

        converted = []
        for fn in functions:
            if not isinstance(fn, dict):
                continue
            if not fn.get("name"):
                continue
            converted.append(
                {
                    "type": "function",
                    "name": fn.get("name"),
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
                    "strict": fn.get("strict", False),
                }
            )
        return converted or None

    def _build_responses_text_format(self, response_format: Any) -> Optional[Dict[str, Any]]:
        if response_format is None:
            return None

        if response_format == "json_object":
            return {"type": "json_object"}

        if isinstance(response_format, dict):
            rf_type = response_format.get("type")
            if rf_type == "json_object":
                return {"type": "json_object"}

            if rf_type == "json_schema":
                json_schema = response_format.get("json_schema") or {}
                name = json_schema.get("name") or "response"
                schema = json_schema.get("schema") or {"type": "object", "properties": {}}
                return {
                    "type": "json_schema",
                    "name": name,
                    "schema": schema,
                    "strict": json_schema.get("strict", True),
                }

        return None

    def _convert_messages_to_responses_input(
        self,
        messages: List[Dict[str, Any]],
    ) -> Tuple[List[Dict[str, Any]], str]:
        """将 Chat 格式消息转换为 Responses input items。"""
        instructions_parts: List[str] = []
        input_items: List[Dict[str, Any]] = []

        for message in messages:
            role = str(message.get("role") or "user").strip().lower()
            content = message.get("content", "")

            if role == "system":
                text = self._stringify_text_content(content)
                if text:
                    instructions_parts.append(text)
                continue

            if role == "tool":
                call_id = message.get("tool_use_id") or message.get("tool_call_id")
                output = self._stringify_content(content)
                if call_id:
                    input_items.append(
                        {
                            "type": "function_call_output",
                            "call_id": str(call_id),
                            "output": output,
                        }
                    )
                elif output:
                    input_items.append(
                        {
                            "role": "user",
                            "content": [{"type": "input_text", "text": output}],
                        }
                    )
                continue

            normalized_role = "assistant" if role == "assistant" else "user"

            if normalized_role == "assistant":
                tool_calls = message.get("tool_calls") or []
                if isinstance(tool_calls, list):
                    for tool_call in tool_calls:
                        converted = self._convert_chat_tool_call_to_response_item(tool_call)
                        if converted:
                            input_items.append(converted)

            content_items, side_items = self._convert_message_content_to_responses(
                role=normalized_role,
                content=content,
            )
            input_items.extend(side_items)
            if content_items:
                input_items.append({"role": normalized_role, "content": content_items})

        if not input_items:
            logger.warning("消息列表转换后为空（可能全为 system 消息），注入最小占位 user 消息")
            input_items = [{"role": "user", "content": [{"type": "input_text", "text": "."}]}]

        return input_items, "\n\n".join(instructions_parts).strip()

    def _convert_message_content_to_responses(
        self,
        *,
        role: str,
        content: Any,
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        content_items: List[Dict[str, Any]] = []
        side_items: List[Dict[str, Any]] = []

        def _text_item(text: str) -> Dict[str, Any]:
            return {
                "type": "output_text" if role == "assistant" else "input_text",
                "text": text,
            }

        if isinstance(content, str):
            if content:
                content_items.append(_text_item(content))
            return content_items, side_items

        if not isinstance(content, list):
            text = self._stringify_content(content)
            if text:
                content_items.append(_text_item(text))
            return content_items, side_items

        for item in content:
            if not isinstance(item, dict):
                text = self._stringify_content(item)
                if text:
                    content_items.append(_text_item(text))
                continue

            item_type = item.get("type")

            if item_type in {"text", "input_text", "output_text"}:
                text = str(item.get("text", ""))
                if text:
                    content_items.append(_text_item(text))
                continue

            if item_type == "tool_result":
                call_id = item.get("tool_use_id") or item.get("tool_call_id")
                if call_id:
                    side_items.append(
                        {
                            "type": "function_call_output",
                            "call_id": str(call_id),
                            "output": self._stringify_content(item.get("content", "")),
                        }
                    )
                continue

            if role == "user" and item_type in {"image_url", "input_image"}:
                raw_image = item.get("image_url")
                if isinstance(raw_image, dict):
                    raw_image = raw_image.get("url")
                if raw_image:
                    content_items.append(
                        {
                            "type": "input_image",
                            "image_url": raw_image,
                            "detail": "auto",
                        }
                    )
                continue

            if role == "user" and item_type == "image":
                source = item.get("source") or {}
                media_type = source.get("media_type")
                data = source.get("data")
                if media_type and data:
                    content_items.append(
                        {
                            "type": "input_image",
                            "image_url": f"data:{media_type};base64,{data}",
                            "detail": "auto",
                        }
                    )
                    continue

            text = self._stringify_content(item)
            if text:
                content_items.append(_text_item(text))

        return content_items, side_items

    def _convert_chat_tool_call_to_response_item(self, tool_call: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(tool_call, dict):
            return None
        fn = tool_call.get("function") or {}
        name = fn.get("name")
        if not name:
            return None

        arguments = fn.get("arguments") or "{}"
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments, ensure_ascii=False)

        call_id = tool_call.get("call_id") or tool_call.get("id") or name
        item = {
            "type": "function_call",
            "call_id": str(call_id),
            "name": name,
            "arguments": arguments,
        }
        if tool_call.get("id"):
            item["id"] = tool_call["id"]
        return item

    @staticmethod
    def _stringify_content(content: Any) -> str:
        if content is None:
            return ""
        if isinstance(content, str):
            return content
        if isinstance(content, (dict, list)):
            return json.dumps(content, ensure_ascii=False)
        return str(content)

    def _stringify_text_content(self, content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            chunks: List[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") in {"text", "input_text", "output_text"}:
                    chunks.append(str(item.get("text", "")))
            return "\n".join(chunk for chunk in chunks if chunk).strip()
        return self._stringify_content(content)

    @staticmethod
    def _safe_get(obj: Any, key: str, default: Any = None) -> Any:
        if isinstance(obj, dict):
            return obj.get(key, default)
        return getattr(obj, key, default)

    @staticmethod
    def _safe_list(value: Any) -> List[Any]:
        if isinstance(value, list):
            return value
        if value is None:
            return []
        return list(value) if isinstance(value, (tuple, set)) else []

    def _process_responses_chat_response(self, response: Any, start_time: float) -> Dict[str, Any]:
        output_items = self._safe_list(self._safe_get(response, "output", []))
        content = self._safe_get(response, "output_text", None) or self._extract_text_from_responses_output(output_items)
        usage = self._extract_responses_usage(self._safe_get(response, "usage", None))
        cost = self._calculate_cost_from_usage(usage)
        tool_calls = self._extract_tool_calls_from_responses_output(output_items)
        reasoning_details = self._extract_reasoning_from_responses_output(output_items)

        finish_reason = "tool_calls" if tool_calls else "stop"
        if self._safe_get(response, "status", None) == "incomplete":
            finish_reason = "length"

        result: Dict[str, Any] = {
            "success": True,
            "content": content,
            "usage": usage,
            "cost": cost,
            "response_time": time.time() - start_time,
            "model": self._safe_get(response, "model", self.default_model),
            "finish_reason": finish_reason,
        }
        if tool_calls:
            result["tool_calls"] = tool_calls
        if reasoning_details:
            result["reasoning_details"] = reasoning_details
        response_id = self._safe_get(response, "id", None)
        if response_id:
            result["response_id"] = response_id
        return result

    def _stream_responses_events(
        self,
        *,
        stream: Any,
        messages: List[Dict[str, Any]],
        params: Dict[str, Any],
        start_time: float,
    ) -> Generator[Dict[str, Any], None, None]:
        full_content = ""
        usage_info = None
        response_id = None
        tool_calls: List[Dict[str, Any]] = []
        tool_calls_seen = set()
        reasoning_details: List[Dict[str, Any]] = []
        finish_reason = "stop"

        for event in stream:
            event_type = self._safe_get(event, "type", "")

            if event_type == "response.output_text.delta":
                delta = self._safe_get(event, "delta", "") or ""
                if delta:
                    full_content += delta
                    yield {
                        "success": True,
                        "content": delta,
                        "finished": False,
                    }
                continue

            if event_type in {"response.reasoning_summary_text.delta", "response.reasoning_text.delta"}:
                delta = self._safe_get(event, "delta", "") or ""
                if delta:
                    reasoning_details.append({"type": "reasoning.delta", "text": delta})
                continue

            if event_type == "response.function_call_arguments.done":
                name = self._safe_get(event, "name", None)
                arguments = self._safe_get(event, "arguments", None)
                item_id = self._safe_get(event, "item_id", None)
                if name and arguments is not None:
                    call = {
                        "id": item_id or name,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False),
                        },
                    }
                    identity = call["id"]
                    if identity not in tool_calls_seen:
                        tool_calls.append(call)
                        tool_calls_seen.add(identity)
                continue

            if event_type == "response.output_item.done":
                item = self._safe_get(event, "item", None)
                if item is None:
                    continue

                item_type = self._safe_get(item, "type", None)
                if item_type == "function_call":
                    identity = (
                        self._safe_get(item, "id", None)
                        or self._safe_get(item, "call_id", None)
                        or self._safe_get(item, "name", None)
                    )
                    call = {
                        "id": identity,
                        "type": "function",
                        "function": {
                            "name": self._safe_get(item, "name", "") or "",
                            "arguments": self._safe_get(item, "arguments", "{}") or "{}",
                        },
                    }
                    if identity and identity not in tool_calls_seen:
                        tool_calls.append(call)
                        tool_calls_seen.add(identity)
                    continue

                if item_type == "reasoning":
                    reasoning_details.extend(self._extract_reasoning_from_responses_output([item]))
                    continue

                if item_type == "message" and not full_content:
                    full_content = self._extract_text_from_responses_output([item]) or full_content
                continue

            if event_type == "response.completed":
                response_obj = self._safe_get(event, "response", None)
                if response_obj is None:
                    continue

                response_id = self._safe_get(response_obj, "id", None)
                usage_info = self._extract_responses_usage(self._safe_get(response_obj, "usage", None))

                if not full_content:
                    full_content = self._safe_get(response_obj, "output_text", None) or self._extract_text_from_responses_output(
                        self._safe_list(self._safe_get(response_obj, "output", []))
                    )

                if not tool_calls:
                    tool_calls = self._extract_tool_calls_from_responses_output(
                        self._safe_list(self._safe_get(response_obj, "output", []))
                    )

                if not reasoning_details:
                    reasoning_details = self._extract_reasoning_from_responses_output(
                        self._safe_list(self._safe_get(response_obj, "output", []))
                    )

            if event_type == "response.failed":
                response_obj = self._safe_get(event, "response", None)
                error_msg = "LLM 响应失败"
                if response_obj:
                    response_id = self._safe_get(response_obj, "id", None) or response_id
                    raw_usage = self._safe_get(response_obj, "usage", None)
                    if raw_usage:
                        usage_info = self._extract_responses_usage(raw_usage)
                    error_info = self._safe_get(response_obj, "error", None)
                    if isinstance(error_info, dict):
                        error_msg = self._safe_get(error_info, "message", error_msg) or error_msg
                    elif error_info is not None:
                        error_msg = str(error_info)

                logger.error("OpenAI Responses API 流式失败: %s", error_msg)
                if not usage_info:
                    usage_info = self._estimate_stream_usage(messages, full_content)

                error_chunk: Dict[str, Any] = {
                    "success": False,
                    "content": "",
                    "finished": True,
                    "error": error_msg,
                    "finish_reason": "error",
                    "response_time": time.time() - start_time,
                    "model": params.get("model", self.default_model),
                }
                if usage_info:
                    error_chunk["usage"] = usage_info
                    error_chunk["cost"] = self._calculate_cost_from_usage(usage_info)
                if response_id:
                    error_chunk["response_id"] = response_id
                yield error_chunk
                self._record_llm_event(
                    messages=messages,
                    params=params,
                    result={
                        "success": False,
                        "content": full_content,
                        "error": error_msg,
                        "usage": usage_info,
                        "model": params.get("model", self.default_model),
                        "response_time": time.time() - start_time,
                    },
                    start_time=start_time,
                    error=error_msg,
                    is_stream=True,
                )
                return

            if event_type == "error":
                error_info = self._safe_get(event, "error", None)
                error_msg = "LLM 响应错误"
                if isinstance(error_info, dict):
                    error_msg = self._safe_get(error_info, "message", error_msg) or error_msg
                elif error_info is not None:
                    error_msg = str(error_info)
                logger.error("OpenAI Responses API SSE error 事件: %s", error_msg)
                if not usage_info:
                    usage_info = self._estimate_stream_usage(messages, full_content)
                error_chunk: Dict[str, Any] = {
                    "success": False,
                    "content": "",
                    "finished": True,
                    "error": error_msg,
                    "finish_reason": "error",
                    "response_time": time.time() - start_time,
                    "model": params.get("model", self.default_model),
                }
                if usage_info:
                    error_chunk["usage"] = usage_info
                    error_chunk["cost"] = self._calculate_cost_from_usage(usage_info)
                if response_id:
                    error_chunk["response_id"] = response_id
                yield error_chunk
                self._record_llm_event(
                    messages=messages,
                    params=params,
                    result={
                        "success": False,
                        "content": full_content,
                        "error": error_msg,
                        "usage": usage_info,
                        "model": params.get("model", self.default_model),
                        "response_time": time.time() - start_time,
                    },
                    start_time=start_time,
                    error=error_msg,
                    is_stream=True,
                )
                return

            if event_type == "response.incomplete":
                response_obj = self._safe_get(event, "response", None)
                if response_obj:
                    response_id = self._safe_get(response_obj, "id", None) or response_id
                    raw_usage = self._safe_get(response_obj, "usage", None)
                    if raw_usage:
                        usage_info = self._extract_responses_usage(raw_usage)
                    if not full_content:
                        full_content = (
                            self._safe_get(response_obj, "output_text", None)
                            or self._extract_text_from_responses_output(
                                self._safe_list(self._safe_get(response_obj, "output", []))
                            )
                        )
                    if not tool_calls:
                        tool_calls = self._extract_tool_calls_from_responses_output(
                            self._safe_list(self._safe_get(response_obj, "output", []))
                        )
                    if not reasoning_details:
                        reasoning_details = self._extract_reasoning_from_responses_output(
                            self._safe_list(self._safe_get(response_obj, "output", []))
                        )
                incomplete_details = (
                    self._safe_get(response_obj, "incomplete_details", None)
                    if response_obj else None
                )
                reason = (
                    self._safe_get(incomplete_details, "reason", "unknown")
                    if isinstance(incomplete_details, dict) else "unknown"
                )
                logger.warning("OpenAI Responses API 流式响应不完整 (reason=%s)", reason)
                finish_reason = "length"
                break

        if not usage_info:
            usage_info = self._estimate_stream_usage(messages, full_content)

        final_chunk: Dict[str, Any] = {
            "success": True,
            "content": "",
            "finished": True,
            "finish_reason": finish_reason,
            "response_time": time.time() - start_time,
            "model": params.get("model", self.default_model),
        }
        if usage_info:
            final_chunk["usage"] = usage_info
            final_chunk["cost"] = self._calculate_cost_from_usage(usage_info)
        if tool_calls:
            final_chunk["tool_calls"] = tool_calls
        if reasoning_details:
            final_chunk["reasoning_details"] = reasoning_details
        if response_id:
            final_chunk["response_id"] = response_id

        yield final_chunk
        self._record_llm_event(
            messages=messages,
            params=params,
            result={
                "success": True,
                "content": full_content,
                "usage": usage_info,
                "tool_calls": tool_calls or None,
                "reasoning_details": reasoning_details or None,
                "model": final_chunk.get("model"),
                "response_time": final_chunk.get("response_time"),
            },
            start_time=start_time,
            error=None,
            is_stream=True,
        )

    def _extract_text_from_responses_output(self, output_items: List[Any]) -> str:
        texts: List[str] = []
        for item in output_items:
            if self._safe_get(item, "type", None) != "message":
                continue
            content = self._safe_list(self._safe_get(item, "content", []))
            for part in content:
                part_type = self._safe_get(part, "type", None)
                if part_type in {"output_text", "text"}:
                    text = self._safe_get(part, "text", "") or ""
                    if text:
                        texts.append(text)
        return "\n".join(texts).strip()

    def _extract_tool_calls_from_responses_output(self, output_items: List[Any]) -> List[Dict[str, Any]]:
        tool_calls: List[Dict[str, Any]] = []
        for item in output_items:
            if self._safe_get(item, "type", None) != "function_call":
                continue
            item_id = (
                self._safe_get(item, "id", None)
                or self._safe_get(item, "call_id", None)
                or self._safe_get(item, "name", None)
            )
            tool_calls.append(
                {
                    "id": item_id,
                    "type": "function",
                    "function": {
                        "name": self._safe_get(item, "name", "") or "",
                        "arguments": self._safe_get(item, "arguments", "{}") or "{}",
                    },
                }
            )
        return tool_calls

    def _extract_reasoning_from_responses_output(self, output_items: List[Any]) -> List[Dict[str, Any]]:
        reasoning_details: List[Dict[str, Any]] = []
        for item in output_items:
            if self._safe_get(item, "type", None) != "reasoning":
                continue

            encrypted = self._safe_get(item, "encrypted_content", None)
            if encrypted:
                reasoning_details.append({"type": "reasoning.encrypted", "data": encrypted})

            summary = self._safe_list(self._safe_get(item, "summary", []))
            for part in summary:
                part_type = self._safe_get(part, "type", None) or "summary_text"
                text = self._safe_get(part, "text", None)
                if text:
                    reasoning_details.append({"type": part_type, "text": text})
        return reasoning_details

    def _extract_responses_usage(self, usage_obj: Any) -> Dict[str, int]:
        if usage_obj is None:
            return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

        input_tokens = int(self._safe_get(usage_obj, "input_tokens", 0) or 0)
        output_tokens = int(self._safe_get(usage_obj, "output_tokens", 0) or 0)
        total_tokens = int(self._safe_get(usage_obj, "total_tokens", 0) or 0)
        if total_tokens <= 0:
            total_tokens = input_tokens + output_tokens

        usage = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "input_tokens_include_cache": True,
        }

        if isinstance(usage_obj, dict):
            cache_read, cache_creation = self._extract_cache_tokens_from_dict(usage_obj)
        else:
            cache_read, cache_creation = self._extract_cache_tokens(usage_obj)
        self._enrich_usage_with_cache(usage, cache_read, cache_creation)

        output_details = self._safe_get(usage_obj, "output_tokens_details", None)
        reasoning_tokens = 0
        if isinstance(output_details, dict):
            reasoning_tokens = int(output_details.get("reasoning_tokens", 0) or 0)
        elif output_details is not None:
            reasoning_tokens = int(self._safe_get(output_details, "reasoning_tokens", 0) or 0)
        if reasoning_tokens > 0:
            usage["reasoning_tokens"] = reasoning_tokens

        return usage

    def _process_chat_response(self, response, start_time: float) -> Dict[str, Any]:
        """处理聊天响应"""
        from apps.services.llm.errors import LLMServiceError, LLMErrorCode

        if not response.choices:
            usage = self._extract_usage(response.usage) if response.usage else {
                "input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
                "prompt_tokens": 0, "completion_tokens": 0,
            }
            raise LLMServiceError(
                code=LLMErrorCode.CONTENT_FILTERED,
                message="API 返回空 choices，可能触发内容过滤",
                status_code=getattr(response, "status_code", None),
            )

        choice = response.choices[0]
        message = choice.message
        content = message.content or ""

        usage = self._extract_usage(response.usage)
        cost = self._calculate_cost_from_usage(usage)

        result: Dict[str, Any] = {
            "success": True,
            "content": content,
            "usage": usage,
            "cost": cost,
            "response_time": time.time() - start_time,
            "model": response.model,
            "finish_reason": choice.finish_reason
        }
        tool_calls = self._extract_chat_tool_calls(message)
        if tool_calls:
            result["tool_calls"] = tool_calls
        reasoning_details = self._extract_reasoning_from_message(message)
        if reasoning_details:
            result["reasoning_details"] = reasoning_details
        return result

    def _extract_chat_tool_calls(self, message: Any) -> List[Dict[str, Any]]:
        tool_calls: List[Dict[str, Any]] = []
        for tool_call in getattr(message, "tool_calls", None) or []:
            fn = getattr(tool_call, "function", None)
            if not fn:
                continue
            name = getattr(fn, "name", None)
            if not name:
                continue
            arguments = getattr(fn, "arguments", "{}") or "{}"
            tool_calls.append(
                {
                    "id": getattr(tool_call, "id", None) or name,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": arguments,
                    },
                }
            )
        return tool_calls

    def _process_stream_chunk(self, chunk) -> Dict[str, Any]:
        """处理流式响应片段"""
        if not chunk.choices:
            return {"success": True, "content": "", "finished": False}

        choice = chunk.choices[0]
        delta = choice.delta

        result = {
            "success": True,
            "content": delta.content or "",
            "finished": choice.finish_reason is not None
        }

        if getattr(delta, "tool_calls", None):
            tool_calls_delta = []
            for tc in delta.tool_calls:
                fn = getattr(tc, "function", None)
                tool_calls_delta.append(
                    {
                        "index": int(getattr(tc, "index", 0) or 0),
                        "id": getattr(tc, "id", None),
                        "type": getattr(tc, "type", "function"),
                        "function": {
                            "name": getattr(fn, "name", None) if fn else None,
                            "arguments": getattr(fn, "arguments", "") if fn else "",
                        },
                    }
                )
            if tool_calls_delta:
                result["tool_calls_delta"] = tool_calls_delta

        if hasattr(chunk, 'usage') and chunk.usage:
            result["usage"] = self._extract_usage(chunk.usage)

        return result

    @staticmethod
    def _merge_stream_tool_calls(
        accumulated: List[Dict[str, Any]],
        deltas: List[Dict[str, Any]],
    ) -> None:
        for delta in deltas:
            idx = int(delta.get("index", 0) or 0)
            while len(accumulated) <= idx:
                accumulated.append(
                    {
                        "id": "",
                        "type": "function",
                        "function": {"name": "", "arguments": ""},
                    }
                )

            entry = accumulated[idx]
            if delta.get("id"):
                entry["id"] = delta["id"]
            if delta.get("type"):
                entry["type"] = delta["type"]

            fn = delta.get("function") or {}
            fn_name = fn.get("name")
            fn_args = fn.get("arguments")
            if fn_name:
                entry["function"]["name"] = (entry["function"].get("name") or "") + fn_name
            if fn_args:
                entry["function"]["arguments"] = (entry["function"].get("arguments") or "") + fn_args

    def _extract_usage(self, usage_obj: Any) -> Dict[str, int]:
        """兼容 OpenAI 以及兼容厂商的 usage 字段差异。"""
        input_tokens = int(getattr(usage_obj, "prompt_tokens", 0) or 0)
        output_tokens = int(getattr(usage_obj, "completion_tokens", 0) or 0)
        total_tokens = int(getattr(usage_obj, "total_tokens", 0) or 0)
        if total_tokens <= 0:
            total_tokens = input_tokens + output_tokens

        usage = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "input_tokens_include_cache": True,
        }

        cache_read, cache_creation = self._extract_cache_tokens(usage_obj)
        self._enrich_usage_with_cache(usage, cache_read, cache_creation)
        return usage

    def _calculate_cost_from_usage(self, usage: Dict[str, int]) -> Dict[str, Decimal]:
        """从使用量计算成本（优先使用模型配置价格）。"""
        return super()._calculate_cost_from_usage(usage)

    def _model_supports_vision(self, model: str) -> bool:
        if super()._model_supports_vision(model):
            return True
        name = (model or "").lower()
        return any(kw in name for kw in ("gpt-4-vision", "gpt-4o", "gpt-5", "o1", "o3", "o4"))

    def _model_supports_json_mode(self, model: str) -> bool:
        if self.model is not None:
            return super()._model_supports_json_mode(model)
        name = (model or "").lower()
        return any(kw in name for kw in ("gpt-4", "gpt-3.5", "gpt-5", "o1", "o3", "o4"))

    def get_supported_models(self) -> List[Dict[str, Any]]:
        """获取支持的模型列表"""
        try:
            models = self.client.models.list()

            supported_models = []
            for model in models.data:
                model_info = {
                    "id": model.id,
                    "name": model.id,
                    "provider": "openai",
                    "supports_vision": self._model_supports_vision(model.id),
                    "supports_json": self._model_supports_json_mode(model.id),
                    "created": model.created
                }
                supported_models.append(model_info)

            return sorted(supported_models, key=lambda x: x['created'], reverse=True)

        except Exception as e:
            logger.error("获取OpenAI模型列表失败: %s", e)
            return []

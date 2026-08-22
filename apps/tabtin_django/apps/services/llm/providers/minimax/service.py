"""
MiniMax 服务实现（Anthropic SDK）
"""

from typing import Dict, Any, List, Generator, Optional
import json
import logging
import time
from decimal import Decimal

import httpx

from apps.services.llm.services.base import BaseLLMService
from apps.services.llm.utils.capabilities import ModelCapabilities

logger = logging.getLogger(__name__)


class MiniMaxService(BaseLLMService):
    """
    MiniMax API 服务实现（通过 Anthropic SDK）。

    参考：
    - base_url: https://api.minimaxi.com/anthropic
    - model: MiniMax-M2.5
    """

    CAPABILITIES = ModelCapabilities(
        supports_streaming=True,
        supports_function_calling=True,
        supports_vision=False,
        supports_document_input=False,
        supports_prompt_caching=True,
        supports_reasoning=True,
        supports_json_mode=True,
        supports_responses_api=False,
        supports_token_estimate=False,
        supports_tool_choice=True,
        supports_parallel_function_calling=False,
    ).to_dict()

    @classmethod
    def validate_provider_config(cls, provider_name: str, config: dict) -> None:
        base_url = config.get('base_url', '')
        if 'minimax' not in base_url and 'minimaxi' not in base_url:
            logger.warning("MiniMax base_url 建议为 https://api.minimaxi.com/anthropic")

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)

        try:
            import anthropic
        except ImportError as exc:
            raise ValueError("未安装 anthropic SDK，请先安装 anthropic 依赖") from exc

        self._anthropic = anthropic
        request_timeout = self._resolve_request_timeout()
        self.client = anthropic.Anthropic(
            api_key=self.api_key,
            auth_token=self.api_key,
            base_url=self.base_url,
            timeout=httpx.Timeout(float(request_timeout), connect=10.0),
        )
        self.default_model = provider_config.get('model_name', 'MiniMax-M2.5')

        logger.info("初始化 MiniMax 服务: model=%s, base_url=%s", self.default_model, self.base_url)

    def _classify_error(self, exc: Exception) -> 'LLMServiceError':
        from apps.services.llm.utils.error_classifier import AnthropicErrorClassifier
        return AnthropicErrorClassifier.classify(exc, anthropic_module=self._anthropic)

    def _do_chat(self, messages: List[Dict[str, Any]], **kwargs) -> Dict[str, Any]:
        start_time = time.time()
        params = None

        try:
            params = self._prepare_chat_params(messages, **kwargs)
            response = self.client.messages.create(**params)
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
                "MiniMax 聊天完成: tokens=%s, time=%.2fs",
                result.get("usage", {}).get("total_tokens"),
                result.get("response_time", 0),
            )
            return result
        except Exception as e:
            logger.error("MiniMax 服务异常: %s", e, exc_info=True)
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

    def _do_chat_stream(self, messages: List[Dict[str, Any]], **kwargs) -> Generator[Dict[str, Any], None, None]:
        """流式聊天实现（由基类 chat_stream 调用，消息已经过校验、限流和截断）。"""
        start_time = time.time()
        params = None
        full_content = ""
        _stream_event_recorded = False

        try:
            params = self._prepare_chat_params(messages, **kwargs)

            # Anthropic SDK 的 stream API
            if hasattr(self.client.messages, "stream"):
                with self.client.messages.stream(**params) as stream:
                    for text in stream.text_stream:
                        full_content += text
                        yield {
                            "success": True,
                            "content": text,
                            "finished": False,
                        }

                    final_message = stream.get_final_message()
                    record_result = {
                        "success": True,
                        "content": full_content,
                        "response_time": time.time() - start_time,
                        "model": params.get("model", self.default_model),
                    }
                    _stream_error = None
                    try:
                        usage = self._build_usage_from_response(final_message)
                        if usage.get("total_tokens", 0) <= 0:
                            usage = self._estimate_stream_usage(messages, full_content) or usage

                        content_blocks = getattr(final_message, "content", []) or []
                        tool_calls = self._extract_tool_calls_from_content_blocks(content_blocks)
                        reasoning_details = self._extract_reasoning_from_content_blocks(content_blocks)

                        finish_reason = self._map_finish_reason(
                            getattr(final_message, "stop_reason", None),
                            has_tool_calls=bool(tool_calls),
                        )

                        final_chunk = {
                            "success": True,
                            "content": "",
                            "finished": True,
                            "usage": usage,
                            "cost": self._calculate_cost_from_usage(usage),
                            "response_time": time.time() - start_time,
                            "model": params.get("model", self.default_model),
                            "finish_reason": finish_reason,
                        }
                        if tool_calls:
                            final_chunk["tool_calls"] = tool_calls
                        if reasoning_details:
                            final_chunk["reasoning_details"] = reasoning_details

                        yield final_chunk

                        record_result = {
                            "success": True,
                            "content": full_content,
                            "usage": usage,
                            "response_time": final_chunk["response_time"],
                            "model": final_chunk["model"],
                            "finish_reason": finish_reason,
                        }
                        if tool_calls:
                            record_result["tool_calls"] = tool_calls
                        if reasoning_details:
                            record_result["reasoning_details"] = reasoning_details
                    except Exception as post_err:
                        _stream_error = str(post_err)
                        raise
                    finally:
                        self._record_llm_event(
                            messages=messages,
                            params=params,
                            result=record_result,
                            start_time=start_time,
                            error=_stream_error,
                            is_stream=True,
                        )
                        _stream_event_recorded = True
                    return

            logger.warning("MiniMax SDK 不支持 stream API，降级为单次输出")
            non_stream_result = self._do_chat(messages, **kwargs)
            yield {
                "success": bool(non_stream_result.get("success")),
                "content": non_stream_result.get("content", ""),
                "finished": True,
                "usage": non_stream_result.get("usage"),
                "cost": non_stream_result.get("cost"),
                "response_time": non_stream_result.get("response_time"),
                "model": non_stream_result.get("model"),
                "finish_reason": non_stream_result.get("finish_reason"),
                "tool_calls": non_stream_result.get("tool_calls"),
                "reasoning_details": non_stream_result.get("reasoning_details"),
            }

        except Exception as e:
            logger.error("MiniMax 流式服务异常: %s", e, exc_info=True)
            if not _stream_event_recorded:
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

    def chat_with_images(self, messages: List[Dict[str, Any]], images: List[str], **kwargs) -> Dict[str, Any]:
        """带图片的聊天接口（委托给基类消息管道，自动降级）。"""
        return super().chat_with_images(messages, images, **kwargs)

    def _validate_connection(self) -> Dict[str, Any]:
        try:
            response = self.client.messages.create(
                model=self.default_model,
                max_tokens=8,
                messages=[
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": "ping"}],
                    }
                ],
            )
            usage = self._build_usage_from_response(response)
            return {
                "valid": True,
                "details": {
                    "model": self.default_model,
                    "api_base": self.base_url,
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                },
            }
        except Exception as e:
            return {
                "valid": False,
                "error": f"MiniMax API连接失败: {str(e)}",
            }

    def _prepare_chat_params(self, messages: List[Dict[str, Any]], **kwargs) -> Dict[str, Any]:
        max_tokens = kwargs.get('max_tokens')
        if max_tokens is None and self.max_output_tokens:
            max_tokens = self.max_output_tokens
        if max_tokens is None:
            max_tokens = 4096

        system_prompt, anthropic_messages = self._convert_messages(messages)

        params: Dict[str, Any] = {
            "model": kwargs.get("model", self.default_model),
            "messages": anthropic_messages,
            "max_tokens": max_tokens,
        }

        use_model_default_sampling = kwargs.get("use_model_default_sampling", False)
        if not use_model_default_sampling:
            temperature = kwargs.get("temperature", 0.7)
            if temperature is not None:
                params["temperature"] = temperature

        top_p = kwargs.get("top_p")
        if top_p is not None:
            params["top_p"] = top_p

        if system_prompt:
            params["system"] = system_prompt

        tools = self._resolve_tools(kwargs)
        if tools:
            params["tools"] = tools
            if kwargs.get("tool_choice") is not None:
                params["tool_choice"] = kwargs.get("tool_choice")

        if kwargs.get("response_format") == "json_object":
            json_mode_hint = (
                "请严格返回一个合法 JSON Object，"
                "不要输出额外解释、不要输出 Markdown、不要输出 JSON 数组。"
            )
            if params.get("system"):
                params["system"] = f"{params['system']}\n\n{json_mode_hint}"
            else:
                params["system"] = json_mode_hint

        if kwargs.get("thinking") is not None:
            params["thinking"] = kwargs.get("thinking")
            if not use_model_default_sampling:
                params["temperature"] = 1
            params.pop("top_p", None)
        if kwargs.get("metadata") and isinstance(kwargs.get("metadata"), dict):
            params["metadata"] = kwargs.get("metadata")

        from apps.services.llm.utils.param_adaptor import adapt_params
        return adapt_params(params, params.get("model", ""), model_obj=self.model)

    def _convert_messages(self, messages: List[Dict[str, Any]]) -> tuple[str, List[Dict[str, Any]]]:
        system_parts: List[str] = []
        converted: List[Dict[str, Any]] = []

        for message in messages:
            role = (message.get("role") or "user").strip()
            content = message.get("content", "")

            if role == "system":
                text_content = self._stringify_content(content)
                if text_content:
                    system_parts.append(text_content)
                continue

            if role == "tool":
                tool_use_id = message.get("tool_use_id") or message.get("tool_call_id")
                converted.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": self._stringify_content(content),
                        }
                    ],
                })
                continue

            if role not in {"user", "assistant"}:
                role = "user"

            converted_item = {
                "role": role,
                "content": self._to_anthropic_content_blocks(content),
            }
            converted.append(converted_item)

        if not converted:
            converted = [{
                "role": "user",
                "content": [{"type": "text", "text": "你好"}],
            }]

        return "\n\n".join(system_parts).strip(), converted

    def _to_anthropic_content_blocks(self, content: Any) -> List[Dict[str, Any]]:
        if isinstance(content, str):
            return [{"type": "text", "text": content}]

        blocks: List[Dict[str, Any]] = []
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    blocks.append({"type": "text", "text": str(item)})
                    continue

                item_type = item.get("type")
                if item_type == "text":
                    blocks.append({"type": "text", "text": str(item.get("text", ""))})
                elif item_type == "tool_result":
                    tool_use_id = item.get("tool_use_id") or item.get("tool_call_id")
                    blocks.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": self._stringify_content(item.get("content", "")),
                    })
                elif item_type == "tool_use":
                    blocks.append({
                        "type": "tool_use",
                        "id": item.get("id"),
                        "name": item.get("name"),
                        "input": item.get("input") or {},
                    })
                elif item_type == "thinking":
                    blocks.append({
                        "type": "thinking",
                        "thinking": item.get("thinking") or item.get("text") or "",
                    })
                else:
                    blocks.append({"type": "text", "text": self._stringify_content(item)})

        if not blocks:
            blocks = [{"type": "text", "text": self._stringify_content(content)}]

        return blocks

    def _stringify_content(self, content: Any) -> str:
        if content is None:
            return ""
        if isinstance(content, str):
            return content
        if isinstance(content, (dict, list)):
            return json.dumps(content, ensure_ascii=False)
        return str(content)

    def _resolve_tools(self, kwargs: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
        tools = kwargs.get("tools")
        if isinstance(tools, list) and tools:
            resolved_tools: List[Dict[str, Any]] = []
            for tool in tools:
                if not isinstance(tool, dict):
                    continue
                if tool.get("type") == "function" and isinstance(tool.get("function"), dict):
                    fn = tool["function"]
                    fn_name = fn.get("name")
                    if not fn_name:
                        continue
                    resolved_tools.append({
                        "name": fn_name,
                        "description": fn.get("description", ""),
                        "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
                    })
                    continue

                fn_name = tool.get("name")
                if not fn_name:
                    continue
                resolved_tools.append({
                    "name": fn_name,
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("input_schema") or {"type": "object", "properties": {}},
                })

            return resolved_tools or None

        functions = kwargs.get("functions")
        if not isinstance(functions, list) or not functions:
            return None

        resolved_tools: List[Dict[str, Any]] = []
        for fn in functions:
            if not isinstance(fn, dict):
                continue
            fn_name = fn.get("name")
            if not fn_name:
                continue
            resolved_tools.append({
                "name": fn_name,
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
            })
        return resolved_tools or None

    def _process_chat_response(self, response: Any, start_time: float) -> Dict[str, Any]:
        usage = self._build_usage_from_response(response)
        content_blocks = getattr(response, "content", []) or []
        reasoning_details = self._extract_reasoning_from_content_blocks(content_blocks)
        tool_calls = self._extract_tool_calls_from_content_blocks(content_blocks)

        text_blocks: List[str] = []
        for block in content_blocks:
            if getattr(block, "type", None) == "text":
                text_blocks.append(getattr(block, "text", "") or "")

        content = "\n".join(item for item in text_blocks if item).strip()
        if not content and reasoning_details and not tool_calls:
            logger.info("[MiniMax] 模型仅返回 thinking 内容，content 保留为空")

        finish_reason = self._map_finish_reason(
            getattr(response, "stop_reason", None),
            has_tool_calls=bool(tool_calls),
        )

        result: Dict[str, Any] = {
            "success": True,
            "content": content,
            "usage": usage,
            "cost": self._calculate_cost_from_usage(usage),
            "response_time": time.time() - start_time,
            "model": getattr(response, "model", self.default_model),
            "finish_reason": finish_reason,
        }

        if tool_calls:
            result["tool_calls"] = tool_calls
        if reasoning_details:
            result["reasoning_details"] = reasoning_details

        return result

    def _build_usage_from_response(self, response: Any) -> Dict[str, int]:
        usage_obj = getattr(response, "usage", None)
        input_tokens = int(getattr(usage_obj, "input_tokens", 0) or 0)
        output_tokens = int(getattr(usage_obj, "output_tokens", 0) or 0)
        total_tokens = input_tokens + output_tokens

        usage = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "input_tokens_include_cache": False,
        }

        cache_read, cache_creation = self._extract_cache_tokens(usage_obj)
        self._enrich_usage_with_cache(usage, cache_read, cache_creation)
        return usage

    @staticmethod
    def _extract_tool_calls_from_content_blocks(content_blocks: Any) -> List[Dict[str, Any]]:
        """从 Anthropic 风格 content blocks 中提取 tool_use 调用。"""
        tool_calls: List[Dict[str, Any]] = []
        for block in content_blocks or []:
            if getattr(block, "type", None) != "tool_use":
                continue
            tool_name = getattr(block, "name", "")
            tool_input = getattr(block, "input", {}) or {}
            tool_calls.append({
                "id": getattr(block, "id", None),
                "type": "function",
                "function": {
                    "name": tool_name,
                    "arguments": json.dumps(tool_input, ensure_ascii=False),
                },
            })
        return tool_calls

    def _map_finish_reason(self, stop_reason: Optional[str], has_tool_calls: bool) -> str:
        if has_tool_calls:
            return "tool_calls"
        if stop_reason in {"end_turn", "stop_sequence"}:
            return "stop"
        if stop_reason == "max_tokens":
            return "length"
        return stop_reason or "stop"

    def _calculate_cost_from_usage(self, usage: Dict[str, int]) -> Dict[str, Decimal]:
        """从使用量计算成本（优先使用模型配置价格，含 cache 读写成本）。"""
        return super()._calculate_cost_from_usage(usage)

    def _model_supports_vision(self, model: str) -> bool:
        if super()._model_supports_vision(model):
            return True
        return "vision" in (model or "").lower()

    def _model_supports_json_mode(self, model: str) -> bool:
        if self.model is not None:
            return super()._model_supports_json_mode(model)
        return True

    def get_supported_models(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": "MiniMax-M2.5",
                "name": "MiniMax-M2.5",
                "provider": "minimax",
                "supports_vision": self._model_supports_vision("MiniMax-M2.5"),
                "supports_json": True,
                "supports_prompt_cache": False,
            }
        ]

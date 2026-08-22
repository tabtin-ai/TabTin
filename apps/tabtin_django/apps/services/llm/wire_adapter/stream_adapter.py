"""LLM Wire Adapter · Stream Adapter(W1b 占位,W2 真实实装)。

W1b 范围:adapt_stream 仅作为占位返回原 SSE chunk(透传)。

W2 范围(总控 § 4 / § 8):

- Stream 形态归一:OpenAI delta SSE / Anthropic event-name SSE / Gemini SSE 三家
  统一成内部规范化 chunk
- Reasoning 归一(4 派系):
  * OpenAI hidden(不出 reasoning)
  * Claude thinking_block content_block
  * Moonshot/Qwen delta.reasoning_content 字段
  * MiniMax ``<think>...</think>`` tag inline state machine
- Tool calls 流式累计 / parallel tool 切片归一
- usage 归一(各家字段名差异,在 stream 末尾统一 dict)

W1b 接口签名先定下,W2 直接 inplace 升级。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Generator, Optional

from .resolved_capabilities import ResolvedCapabilities

logger = logging.getLogger(__name__)


def adapt_stream(
    upstream_chunks: Generator[str, None, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
) -> Generator[str, None, Any]:
    """把上游 SSE chunk 归一成内部规范化 chunk。

    W1b 占位:直接透传 upstream_chunks(等同 W0 行为)。
    W2 范围:按 caps.wire.streaming_protocol 分支(openai_delta /
    anthropic_sse / gemini_sse)做归一。

    Args:
        upstream_chunks: 上游 httpx 流式响应的 line generator(已含 'data: ...' 前缀)
        caps: ResolvedCapabilities
        ctx: 可选 ProxyContext

    Yields:
        SSE 格式 string(``data: ...\\n\\n``)
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    logger.debug(
        "[wire_adapter][adapt_stream] passthrough (W1b stub) request_id=%s "
        "streaming_protocol=%s",
        request_id, caps.wire.streaming_protocol or "openai_delta",
    )
    last_value: Any = None
    try:
        while True:
            chunk = next(upstream_chunks)
            yield chunk
    except StopIteration as si:
        last_value = si.value
    return last_value


__all__ = ["adapt_stream"]

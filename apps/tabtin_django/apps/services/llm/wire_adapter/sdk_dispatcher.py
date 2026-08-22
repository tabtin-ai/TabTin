"""LLM Wire Adapter · SDK Dispatcher(W1b 占位,W2 真实分发)。

W1b 范围:统一返回"不分发,走 httpx 透传",由 LLMProxy 走默认 OpenAI 兼容路径。

W2 范围(总控 § D7 SDK 白名单引入):

- ``anthropic`` SDK 路径(MiniMax 必须 + 未来 Claude 原生端点):用 ``AsyncAnthropic.messages.stream``
  替代 httpx,得到 SSE 解析 + reasoning thinking_block + cache_control 全套支持
- ``google-genai`` SDK 不引入(Gemini 走 OpenAI 兼容层够用,见决议 D7)
- ``openai`` SDK 不引入(httpx 透传足够,引入 SDK 反而绕过 capability 适配)

W1b 接口签名先定下,W2 inplace 升级。
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .resolved_capabilities import ResolvedCapabilities

logger = logging.getLogger(__name__)


def select_sdk_dispatch(
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
) -> Optional[str]:
    """根据 caps 选择 SDK 路径。

    W1b 占位:始终返回 None(不分发,走默认 httpx)。
    W2 范围:返回 ``"anthropic"`` 时 LLMProxy 改走 anthropic SDK。

    Returns:
        SDK 名(``"anthropic"`` / ``None``)。None = 默认 httpx 透传。
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    # W1b 占位:始终默认 httpx
    logger.debug(
        "[wire_adapter][sdk_dispatcher] W1b stub: no SDK dispatch request_id=%s",
        request_id,
    )
    return None


__all__ = ["select_sdk_dispatch"]

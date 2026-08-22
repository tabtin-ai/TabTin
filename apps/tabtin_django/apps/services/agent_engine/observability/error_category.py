"""
Agent 错误分类枚举、统一错误信封、结构化错误记录。

ErrorEnvelope 是贯穿引擎层到 WS 层的统一错误表示，替代此前
ISE.ERROR dict / RoutingError / tool phase / persist_error / WS payload
五种不同格式。
"""

from __future__ import annotations

import logging
import traceback
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class AgentErrorCategory(str, Enum):
    LLM_CALL = "llm_call"
    LLM_CALL_RETRY = "llm_call_retry"
    LLM_TIMEOUT = "llm_timeout"
    RATE_LIMITED = "rate_limited"
    AUTH_ERROR = "auth_error"
    TOOL_EXEC = "tool_exec"
    TOOL_TIMEOUT = "tool_timeout"
    TOOL_RETRY = "tool_retry"
    MIDDLEWARE = "middleware"
    DOOM_LOOP = "doom_loop"
    CONTEXT_OVERFLOW = "context_overflow"
    CONTEXT_RECOVERY = "context_recovery"
    RESUME_FAILED = "resume_failed"
    CANCELLED = "cancelled"
    MAX_ITERATIONS = "max_iterations"
    UNKNOWN = "unknown"

    @classmethod
    def from_string(cls, value: str) -> "AgentErrorCategory":
        """将字符串安全映射为枚举值，未知值归入 UNKNOWN 并记录。"""
        try:
            return cls(value)
        except ValueError:
            logger.warning(
                "[AgentErrorCategory] Unknown category %r, mapping to UNKNOWN",
                value,
            )
            return cls.UNKNOWN


PERSIST_ERROR = "persist_error"
BILLING_ERROR = "billing_error"


def _is_llm_timeout(exc: Exception) -> bool:
    """检查异常链中是否存在 httpx 超时异常（支持 litellm 等中间层的包装）。"""
    try:
        import httpx as _httpx
        _timeout_types = (_httpx.ReadTimeout, _httpx.ConnectTimeout)
    except ImportError:
        _timeout_types = ()

    current: BaseException | None = exc
    while current is not None:
        if _timeout_types and isinstance(current, _timeout_types):
            return True
        current = current.__cause__ or current.__context__
        if current is exc:
            break

    msg = str(exc).lower()
    return any(kw in msg for kw in ("readtimeout", "read operation timed out", "connecttimeout"))


def classify_agent_error(exc: Exception) -> str:
    """将异常分类为 AgentErrorCategory 值字符串。

    使用 ProviderProfile 聚合的关键词覆盖所有模型族的错误格式。

    SYNC: Frontend ERROR_CODE_MAP in MessageBubble.tsx must have
    matching i18n keys for every category returned here.
    """
    from apps.services.agent_engine.exceptions import RunCancelledError
    msg = str(exc).lower()

    if isinstance(exc, RunCancelledError):
        return AgentErrorCategory.CANCELLED.value

    try:
        from apps.services.tools.domains.model_family import get_all_overflow_keywords
        overflow_kw = get_all_overflow_keywords()
    except Exception:
        logger.debug("[classify_agent_error] get_all_overflow_keywords failed, using defaults", exc_info=True)
        from apps.services.tools.domains.model_family import DEFAULT_OVERFLOW_KEYWORDS
        overflow_kw = DEFAULT_OVERFLOW_KEYWORDS
    if any(kw in msg for kw in overflow_kw):
        return AgentErrorCategory.CONTEXT_OVERFLOW.value

    if _is_llm_timeout(exc):
        return AgentErrorCategory.LLM_TIMEOUT.value

    timeout_kw = ("timed out", "timeout", "deadline exceeded")
    if any(kw in msg for kw in timeout_kw):
        return AgentErrorCategory.TOOL_TIMEOUT.value

    if "tool" in msg and ("not found" in msg or "failed" in msg):
        return AgentErrorCategory.TOOL_EXEC.value

    _status = getattr(exc, "status_code", None)
    if _status == 429 or any(kw in msg for kw in ("rate limit", "429", "ratelimit")):
        return AgentErrorCategory.RATE_LIMITED.value

    if _status in (401, 403) or any(
        kw in msg for kw in ("unauthorized", "authentication", "invalid api key", "invalid_api_key", "permission denied", "403")
    ):
        return AgentErrorCategory.AUTH_ERROR.value

    llm_kw = ("api error", "api call failed", "openai", "anthropic", "500", "502", "503")
    if _status and _status >= 500:
        return AgentErrorCategory.LLM_CALL.value
    if any(kw in msg for kw in llm_kw):
        return AgentErrorCategory.LLM_CALL.value

    return AgentErrorCategory.UNKNOWN.value


@dataclass(frozen=True)
class ErrorEnvelope:
    """贯穿编排全链路的统一错误信封。

    所有错误产生点（LLM / Tool / 路由 / 持久化 / 中间件）都应构建此对象，
    消费侧通过 ``to_stream_event()`` 转为内部流式事件 dict，
    或通过 ``to_ws_payload()`` 转为前端推送 payload。
    """

    category: str
    message: str
    error_code: Optional[str] = None
    trace_id: Optional[str] = None
    run_id: Optional[str] = None
    retryable: bool = False
    details: Dict[str, Any] = field(default_factory=dict)

    def to_stream_event(self) -> Dict[str, Any]:
        """转为 agent_engine yield 的 ISE.ERROR 格式 dict。"""
        event: Dict[str, Any] = {
            "type": "error",
            "error_category": self.category,
            "error": self.message,
        }
        if self.error_code:
            event["error_code"] = self.error_code
        if self.run_id:
            event["run_id"] = self.run_id
        if self.retryable:
            event["retryable"] = True
        if self.details:
            event.update(self.details)
        return event

    def to_ws_payload(self) -> Dict[str, Any]:
        """转为面向前端 WS 推送的 payload。"""
        payload: Dict[str, Any] = {
            "error_category": self.category,
            "message": self.message,
        }
        if self.error_code:
            payload["error_code"] = self.error_code
        if self.retryable:
            payload["retryable"] = True
        return payload

    @classmethod
    def from_exception(
        cls,
        exc: Exception,
        *,
        category: Optional[str] = None,
        run_id: Optional[str] = None,
        trace_id: Optional[str] = None,
    ) -> "ErrorEnvelope":
        """从异常构建信封，自动分类。"""
        if category is None:
            category = classify_agent_error(exc)
        return cls(
            category=category,
            message=str(exc),
            error_code=getattr(exc, "code", None) or getattr(exc, "error_code", None),
            run_id=run_id,
            trace_id=trace_id,
            retryable=getattr(exc, "retryable", False),
        )

    @classmethod
    def persist_error(
        cls,
        error_msg: str,
        *,
        thread_id: Optional[str] = None,
        has_fallback: bool = False,
    ) -> "ErrorEnvelope":
        """持久化失败专用构造器。"""
        return cls(
            category=PERSIST_ERROR,
            message=error_msg or "State persistence failed",
            details={
                "thread_id": thread_id,
                "has_fallback": has_fallback,
            },
        )


def record_error_event(
    category: AgentErrorCategory,
    message: str,
    *,
    iteration: Optional[int] = None,
    tool_name: Optional[str] = None,
    exc: Optional[Exception] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Optional[int]:
    """将结构化错误记录到 TraceEvent。

    Returns:
        event_id (int | None) — 如果 trace 上下文存在则返回 event_id
    """
    try:
        from apps.services.common.observability.trace import TraceRecorder
    except Exception:
        return None

    input_data: Dict[str, Any] = {
        "category": category.value,
        "iteration": iteration,
    }
    if tool_name:
        input_data["tool_name"] = tool_name
    if extra:
        input_data.update(extra)

    stack = None
    if exc:
        stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))

    return TraceRecorder.record_event(
        event_type="error",
        name=f"error.{category.value}",
        input_data=input_data,
        error=message,
        output_data={"stack_trace": stack} if stack else None,
    )

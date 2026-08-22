"""LLM 调用上下文 — 贯穿 billed_call → chat() → _do_chat() → Provider 的 trace 信息。"""
from __future__ import annotations

from contextvars import ContextVar, Token
from typing import Optional

_llm_request_id_var: ContextVar[Optional[str]] = ContextVar("llm_request_id", default=None)
_llm_trace_id_var: ContextVar[Optional[str]] = ContextVar("llm_trace_id", default=None)
_llm_source_var: ContextVar[Optional[str]] = ContextVar("llm_source", default=None)


def set_llm_request_context(
    request_id: str | None = None,
    trace_id: str | None = None,
    source: str | None = None,
) -> dict[str, Token]:
    tokens: dict[str, Token] = {}
    if request_id is not None:
        tokens["request_id"] = _llm_request_id_var.set(request_id)
    if trace_id is not None:
        tokens["trace_id"] = _llm_trace_id_var.set(trace_id)
    if source is not None:
        tokens["source"] = _llm_source_var.set(source)
    return tokens


def reset_llm_request_context(tokens: dict[str, Token]) -> None:
    _vars = {
        "request_id": _llm_request_id_var,
        "trace_id": _llm_trace_id_var,
        "source": _llm_source_var,
    }
    for name, token in tokens.items():
        var = _vars.get(name)
        if var:
            var.reset(token)


def get_llm_request_id() -> str | None:
    return _llm_request_id_var.get()


def get_llm_trace_id() -> str | None:
    return _llm_trace_id_var.get()


def get_llm_source() -> str | None:
    return _llm_source_var.get()

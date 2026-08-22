"""
BaseTool 标准失败 envelope — 与 agent-runtime ``jsonError()`` 对齐。

唯一推荐出口：工具失败路径应通过 ``build_tool_error`` / ``json_tool_error``
构造结果，保证 LLM / stall detector / UI catalog 都能读到稳定字段：

  {
    "success": false,
    "error": "<human-readable message>",
    "error_kind": "<stable snake_case kind>",
    "hint": "<actionable next step>",
    ... optional context ...
  }

本模块只负责 envelope 形状；error_kind 枚举仍以 TS
``packages/agent-runtime/src/engine/errors/error-kinds.ts`` 为 SSoT。
"""

from __future__ import annotations

import json
from typing import Final, Literal, Mapping, TypeVar, TypedDict

REQUIRED_TOOL_ERROR_KEYS: Final[tuple[str, ...]] = (
    "success",
    "error",
    "error_kind",
    "hint",
)

_RESERVED_CONTEXT_KEYS: Final[frozenset[str]] = frozenset(REQUIRED_TOOL_ERROR_KEYS)
_SuccessResult = TypeVar("_SuccessResult")


class ToolErrorEnvelope(TypedDict):
    """最小必填失败结构（context 字段在运行时附加）。"""

    success: Literal[False]
    error: str
    error_kind: str
    hint: str


def tool_result_success(value: _SuccessResult) -> _SuccessResult:
    """Explicitly mark a dynamically produced value as successful tool content."""
    return value


def build_tool_error(
    error: str,
    *,
    error_kind: str,
    hint: str,
    retryable: bool | None = None,
    upstream_code: str | None = None,
    context: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """构造标准失败 dict（success 恒为 False）。

    Args:
        error: 给人 / LLM 读的错误说明。
        error_kind: 稳定分类标识（snake_case）。
        hint: 可执行的下一步建议。
        retryable: 可选；是否建议重试。
        upstream_code: 可选；上游业务码（非内部 traceback）。
        context: 可选附加字段；不得覆盖 reserved keys。
    """
    if not error_kind or not str(error_kind).strip():
        raise ValueError("error_kind is required")
    if not hint or not str(hint).strip():
        raise ValueError("hint is required")

    payload: dict[str, object] = {
        "success": False,
        "error": error,
        "error_kind": error_kind,
        "hint": hint,
    }
    if retryable is not None:
        payload["retryable"] = retryable
    if upstream_code:
        payload["upstream_code"] = upstream_code
    if context:
        overlap = _RESERVED_CONTEXT_KEYS.intersection(context)
        if overlap:
            raise ValueError(f"context contains reserved keys: {sorted(overlap)}")
        for key, value in context.items():
            payload[key] = value
    return payload


def json_tool_error(
    error: str,
    *,
    error_kind: str,
    hint: str,
    retryable: bool | None = None,
    upstream_code: str | None = None,
    context: Mapping[str, object] | None = None,
) -> str:
    """``build_tool_error`` 的 JSON 字符串形态（多数 BaseTool.run 返回 str）。"""
    return json.dumps(
        build_tool_error(
            error,
            error_kind=error_kind,
            hint=hint,
            retryable=retryable,
            upstream_code=upstream_code,
            context=context,
        ),
        ensure_ascii=False,
    )


def is_standard_tool_error(payload: object) -> bool:
    """判断映射是否满足标准失败 envelope 最小字段集。"""
    if not isinstance(payload, Mapping):
        return False
    if payload.get("success") is not False:
        return False
    for key in ("error", "error_kind", "hint"):
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip():
            return False
    return True


__all__ = [
    "REQUIRED_TOOL_ERROR_KEYS",
    "ToolErrorEnvelope",
    "build_tool_error",
    "json_tool_error",
    "is_standard_tool_error",
    "tool_result_success",
]

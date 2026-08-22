"""State key 类型安全访问器。

为高冲突 state key 提供类型检查和写入追踪。
"""
from __future__ import annotations

import logging
from typing import Literal

logger = logging.getLogger(__name__)

CompactionDirective = Literal[
    "none", "soft_trim", "auto_condense", "summarize", "aggressive", "emergency"
]

_VALID_DIRECTIVES = frozenset(
    {"none", "soft_trim", "auto_condense", "summarize", "aggressive", "emergency"}
)


def get_compaction_directive(state: dict) -> CompactionDirective:
    return state.get("compaction_directive", "none")


def set_compaction_directive(
    state: dict, value: CompactionDirective, *, caller: str
) -> dict:
    """设置 compaction_directive 并记录来源。返回 updates dict。"""
    if value not in _VALID_DIRECTIVES:
        raise ValueError(
            f"Invalid compaction_directive: {value!r}, "
            f"must be one of {_VALID_DIRECTIVES}"
        )
    logger.debug(
        "[CompactionDirective] %s -> %s (caller=%s)",
        state.get("compaction_directive"),
        value,
        caller,
    )
    return {"compaction_directive": value, "_compaction_directive_set_by": caller}


def get_condense_in_progress(state: dict) -> bool:
    return bool(state.get("_condense_in_progress", False))


def set_condense_in_progress(
    state: dict, value: bool, *, caller: str  # noqa: ARG001
) -> dict:
    """设置 _condense_in_progress 并记录来源。返回 updates dict。"""
    return {
        "_condense_in_progress": value,
        "_condense_in_progress_set_by": caller,
    }


PressureLevel = Literal["low", "moderate", "high", "critical"]

_VALID_PRESSURE_LEVELS = frozenset({"low", "moderate", "high", "critical"})


def get_pressure_level(state: dict) -> PressureLevel:
    return state.get("context_pressure_level", "low")


def set_pressure_level(
    state: dict, value: PressureLevel, *, caller: str  # noqa: ARG001
) -> dict:
    if value not in _VALID_PRESSURE_LEVELS:
        raise ValueError(f"Invalid pressure_level: {value!r}")
    return {"context_pressure_level": value}

"""通用工具名称标准化函数。

从 orchestration/agents/subagent/policy.py 抽取的纯函数，
无任何 orchestration 依赖。
"""
from __future__ import annotations

from typing import Any, Iterable, List, Optional


def normalize_tool_name(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def normalize_tool_list(values: Optional[Iterable[Any]]) -> List[str]:
    if not values:
        return []
    seen: set[str] = set()
    normalized: List[str] = []
    for item in values:
        name = normalize_tool_name(str(item) if item is not None else "")
        if not name or name in seen:
            continue
        seen.add(name)
        normalized.append(name)
    return normalized

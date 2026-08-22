"""Aggregate Memory 的 Organization / subject / Agent 隔离契约。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, TypeVar


class CrossWorkspaceCompactionError(ValueError):
    """Compaction 输入不属于同一 Workspace Memory scope。"""


T = TypeVar("T")


@dataclass(frozen=True)
class MemoryAggregationScope:
    """Personal / Team 均使用其真实 Organization UUID 作为数据隔离身份。"""

    organization_id: str
    subject_user_id: str
    agent_id: str

    def matches(self, memory: Any) -> bool:
        return (
            str(_value(memory, "organization_id") or "")
            == str(self.organization_id)
            and str(_value(memory, "owner_id") or "")
            == str(self.subject_user_id)
            and str(_value(memory, "agent_id") or "") == str(self.agent_id)
        )

    def select(self, memories: Iterable[T]) -> list[T]:
        return [memory for memory in memories if self.matches(memory)]


def assert_compaction_group_scope(
    scope: MemoryAggregationScope,
    group: Iterable[Any],
) -> None:
    rows = list(group)
    if not rows or any(not scope.matches(row) for row in rows):
        raise CrossWorkspaceCompactionError(
            "memory_compaction 输入必须全部属于同一 Organization、用户和 Agent"
        )


def _value(record: Any, field: str):
    if isinstance(record, dict):
        return record.get(field)
    return getattr(record, field, None)


__all__ = [
    "CrossWorkspaceCompactionError",
    "MemoryAggregationScope",
    "assert_compaction_group_scope",
]

"""Usage-event query helpers shared by list/export paths.

``biz_type`` filter values are exact on the wire historically, but some ledger
rows share one UI label across multiple stored values (legacy ``llm`` vs
canonical ``llm_call`` both render as「模型调用」). Resolving filter tokens to
an equivalence set keeps the dropdown semantics aligned with the table.
"""

from __future__ import annotations

from typing import Iterable, List, Optional, Sequence

# Each frozenset is one display/filter bucket. Selecting any member matches all.
_BIZ_TYPE_EQUIVALENCE_GROUPS: Sequence[frozenset[str]] = (
    frozenset({"llm_call", "llm"}),
)


def resolve_usage_event_biz_types(biz_type: Optional[str]) -> List[str]:
    """Expand a biz_type query token (or comma-separated tokens) for ``__in``.

    Empty / whitespace-only input → ``[]`` (caller should skip filtering).
    Unknown tokens pass through unchanged. Known aliases expand to the full
    equivalence group. Order is stable (sorted) for deterministic SQL/tests.
    """
    if biz_type is None:
        return []
    raw = str(biz_type).strip()
    if not raw:
        return []

    tokens: list[str] = []
    for part in raw.split(","):
        token = part.strip()
        if token:
            tokens.append(token)

    expanded: set[str] = set()
    for token in tokens:
        expanded.add(token)
        for group in _BIZ_TYPE_EQUIVALENCE_GROUPS:
            if token in group:
                expanded.update(group)
    return sorted(expanded)


def iter_usage_event_biz_type_groups() -> Iterable[frozenset[str]]:
    """Expose equivalence groups for tests / docs."""
    return _BIZ_TYPE_EQUIVALENCE_GROUPS

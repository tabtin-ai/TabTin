"""Spec validation helpers — keep boundary checks consistent across generators.

Generators call these to fail fast with a ``SpecError`` carrying a clear,
field-scoped message before touching any file library.
"""

from __future__ import annotations

from typing import Any, List

from tabtin_filegen.errors import SpecError


def require_mapping(value: Any, field: str) -> dict:
    if not isinstance(value, dict):
        raise SpecError(f"`{field}` must be an object")
    return value


def require_list(value: Any, field: str) -> List[Any]:
    if not isinstance(value, list):
        raise SpecError(f"`{field}` must be an array")
    return value


def as_text(value: Any) -> str:
    """Coerce a cell/scalar to display text. None -> empty string."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def optional_text(mapping: dict, key: str, default: str = "") -> str:
    value = mapping.get(key, default)
    return as_text(value)

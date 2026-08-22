"""
Realtime subscription filter — Python-side record filter evaluator.

Evaluates subscriber filter conditions against record data at delivery time
to support per-subscriber row filtering on ``table.open.record_change`` events.

Filter format (same DSL as TabData views / RLS policies):
    {
        "conjunction": "and",
        "filterSet": [
            {"field": "Status", "operator": "equals", "value": "Active"},
            {"field": "Priority", "operator": "gt", "value": 3}
        ]
    }

Supported operators: equals, not_equals, contains, not_contains,
    gt, gte, lt, lte, is_empty, is_not_empty, in, not_in.

Nested groups (filterSet-in-filterSet) are supported recursively.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_MAX_FILTER_DEPTH = 10


def matches_filter(record: Dict[str, Any], filter_config: Dict[str, Any], _depth: int = 0) -> bool:
    """Check whether *record* satisfies *filter_config*.

    Args:
        record: Event record dict; field values are looked up under
                ``record["fields"]`` first, then top-level keys.
        filter_config: A filter DSL dict with ``conjunction`` and ``filterSet``.

    Returns:
        ``True`` if the record matches (or if filter_config is empty/None).
    """
    if _depth > _MAX_FILTER_DEPTH:
        logger.warning("[RealtimeFilter] filter depth exceeds %d, rejecting", _MAX_FILTER_DEPTH)
        return False

    if not filter_config:
        return True

    conjunction = filter_config.get("conjunction", "and").lower()
    filter_set: List[Dict[str, Any]] = filter_config.get("filterSet", [])

    if not filter_set:
        return True

    results: List[bool] = []
    for item in filter_set:
        # Nested group
        if "filterSet" in item:
            results.append(matches_filter(record, item, _depth + 1))
            continue

        field = item.get("field") or item.get("field_id")
        operator = (item.get("operator") or "").lower()
        value = item.get("value")

        if not field:
            results.append(True)
            continue

        # Resolve record value: first try `record["fields"][field]`, then
        # fall back to `record[field]` for flat payloads.
        fields = record.get("fields")
        if isinstance(fields, dict) and field in fields:
            record_value = fields[field]
        else:
            record_value = record.get(field)

        results.append(_eval_operator(record_value, operator, value))

    if conjunction == "or":
        return any(results) if results else True
    return all(results) if results else True


def validate_filter_config(filter_config: Any, _depth: int = 0) -> Optional[str]:
    """Return an error message if *filter_config* is structurally invalid, else ``None``."""
    if _depth > _MAX_FILTER_DEPTH:
        return f"filter nesting exceeds maximum depth of {_MAX_FILTER_DEPTH}"

    if filter_config is None:
        return None

    if not isinstance(filter_config, dict):
        return "filter must be an object"

    conjunction = filter_config.get("conjunction")
    if conjunction is not None and conjunction not in ("and", "or"):
        return f"unsupported conjunction: {conjunction}"

    filter_set = filter_config.get("filterSet")
    if filter_set is not None:
        if not isinstance(filter_set, list):
            return "filterSet must be a list"
        for idx, item in enumerate(filter_set):
            if not isinstance(item, dict):
                return f"filterSet[{idx}] must be an object"
            # Nested group
            if "filterSet" in item:
                nested_err = validate_filter_config(item, _depth + 1)
                if nested_err:
                    return f"filterSet[{idx}]: {nested_err}"
                continue
            # Leaf condition must have field + operator
            if not (item.get("field") or item.get("field_id")):
                return f"filterSet[{idx}]: missing field"
            if not item.get("operator"):
                return f"filterSet[{idx}]: missing operator"

    return None


# ---------------------------------------------------------------------------
# Operator evaluation
# ---------------------------------------------------------------------------

_NUMERIC_OPS = {"gt", "gte", "lt", "lte"}


def _to_numeric(value: Any):
    """Try to coerce *value* to int or float; return None on failure."""
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            try:
                return float(value)
            except ValueError:
                return None
    return None


def _eval_operator(record_value: Any, operator: str, expected: Any) -> bool:
    """Evaluate a single filter condition."""
    if operator in ("equals", "eq"):
        return _loose_equals(record_value, expected)

    if operator in ("not_equals", "neq"):
        return not _loose_equals(record_value, expected)

    if operator == "contains":
        if record_value is None:
            return False
        return str(expected) in str(record_value)

    if operator == "not_contains":
        if record_value is None:
            return True
        return str(expected) not in str(record_value)

    if operator in ("is_empty", "isempty", "empty"):
        return record_value is None or record_value == "" or record_value == [] or record_value == {}

    if operator in ("is_not_empty", "isnotempty", "not_empty"):
        return record_value is not None and record_value != "" and record_value != [] and record_value != {}

    if operator in _NUMERIC_OPS:
        rv = _to_numeric(record_value)
        ev = _to_numeric(expected)
        if rv is None or ev is None:
            logger.debug(
                "[RealtimeFilter] numeric coercion failed for operator=%s, "
                "record_value=%r, expected=%r",
                operator, record_value, expected,
            )
            return False
        if operator == "gt":
            return rv > ev
        if operator == "gte":
            return rv >= ev
        if operator == "lt":
            return rv < ev
        if operator == "lte":
            return rv <= ev

    if operator == "in":
        if isinstance(expected, list):
            return record_value in expected
        return _loose_equals(record_value, expected)

    if operator == "not_in":
        if isinstance(expected, list):
            return record_value not in expected
        return not _loose_equals(record_value, expected)

    # Unknown operator — reject to avoid accidental data leaks
    logger.warning("[RealtimeFilter] unknown operator '%s', treating as non-match", operator)
    return False


def _loose_equals(a: Any, b: Any) -> bool:
    """Equality with numeric coercion when both sides look numeric."""
    if a == b:
        return True
    na = _to_numeric(a)
    nb = _to_numeric(b)
    if na is not None and nb is not None:
        return na == nb
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return str(a) == str(b)

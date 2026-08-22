"""Explicit Projection-owned field policy; no untrusted dynamic field writes."""

from __future__ import annotations

from copy import deepcopy
from decimal import Decimal, InvalidOperation

from .results import ProjectionOperationRejected

PROVIDER_SCALAR_FIELDS = frozenset({"provider_key", "default_base_url"})
MODEL_SCALAR_FIELDS = frozenset({"model_name", "base_url", "context_window_tokens", "max_output_tokens"})
COMMERCIAL_UNIT_FIELDS = {
    "input-token": "input_price_per_1k",
    "output-token": "output_price_per_1k",
    "request": "price_per_request",
    "second": "price_per_second",
}
FORBIDDEN_FIELD_NAMES = frozenset({
    "encrypted_api_key", "api_key", "routing_enabled", "routing_weight", "priority",
    "runtime_status", "runtime_cooldown_until", "health_consecutive_failures",
})


def _integer(value: str, path: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ProjectionOperationRejected("invalid-managed-value") from exc
    if parsed <= 0:
        raise ProjectionOperationRejected("invalid-managed-value")
    return parsed


def _price(value: str) -> Decimal:
    try:
        amount, currency = value.split(" ", 1)
        parsed = Decimal(amount)
    except (AttributeError, InvalidOperation, ValueError) as exc:
        raise ProjectionOperationRejected("invalid-commercial-value") from exc
    if currency not in {"CNY", "USD"} or parsed < 0:
        raise ProjectionOperationRejected("invalid-commercial-value")
    return parsed


def build_field_patch(revision) -> tuple[dict, dict, dict]:
    provider_patch: dict = {}
    model_patch: dict = {}
    safe_changes: dict = {"provider": [], "model": []}
    for row in revision.generated_factual_fields:
        target, path, proposed = row.get("target"), row.get("path"), row.get("proposed")
        if path in FORBIDDEN_FIELD_NAMES:
            raise ProjectionOperationRejected("field-not-managed")
        if target == "provider" and path in PROVIDER_SCALAR_FIELDS:
            provider_patch[path] = proposed
        elif target == "model" and path in MODEL_SCALAR_FIELDS:
            model_patch[path] = _integer(proposed, path) if path.endswith("_tokens") else proposed
        elif target == "model" and path.startswith("capabilities_config.generated."):
            _set_generated_path(model_patch, "capabilities_config", path.removeprefix("capabilities_config.generated."), proposed)
        else:
            raise ProjectionOperationRejected("field-not-managed")
        safe_changes[target].append(path)
    for row in revision.commercial_fields:
        path = row.get("path", "")
        if row.get("target") != "model" or not path.startswith("pricing."):
            raise ProjectionOperationRejected("field-not-managed")
        field = COMMERCIAL_UNIT_FIELDS.get(path.removeprefix("pricing."))
        if field is None:
            raise ProjectionOperationRejected("commercial-unit-not-managed")
        model_patch[field] = _price(row.get("proposed"))
        safe_changes["model"].append(field)
    return provider_patch, model_patch, {
        key: sorted(set(value)) for key, value in safe_changes.items()
    }


def _set_generated_path(patch: dict, field: str, path: str, value) -> None:
    if not path or any(not part for part in path.split(".")):
        raise ProjectionOperationRejected("invalid-managed-path")
    root = patch.setdefault(field, {})
    cursor = root.setdefault("generated", {})
    parts = path.split(".")
    for part in parts[:-1]:
        child = cursor.setdefault(part, {})
        if not isinstance(child, dict):
            raise ProjectionOperationRejected("managed-structural-collision")
        cursor = child
    cursor[parts[-1]] = value


def merge_generated_json(current: dict, patch: dict) -> dict:
    result = deepcopy(current)
    incoming = patch.get("generated", {})
    existing = result.setdefault("generated", {})
    if not isinstance(existing, dict):
        raise ProjectionOperationRejected("managed-structural-collision")
    _deep_merge(existing, incoming)
    return result


def _deep_merge(current: dict, incoming: dict) -> None:
    for key in sorted(incoming):
        value = incoming[key]
        if isinstance(value, dict):
            existing = current.setdefault(key, {})
            if not isinstance(existing, dict):
                raise ProjectionOperationRejected("managed-structural-collision")
            _deep_merge(existing, value)
        else:
            if isinstance(current.get(key), dict):
                raise ProjectionOperationRejected("managed-structural-collision")
            current[key] = value

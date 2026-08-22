"""Pure PR7 ProjectionPlan-to-persistence boundary; contains no ORM or writes."""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import Any

from .canonical import canonicalize
from .domain.identities import ExactRef
from .projection.compiler import ProjectionPlan


FORBIDDEN_KEYS = frozenset({
    "api_key", "secret_key", "client_secret", "access_key_id", "secret_access_key",
    "private_key", "password", "authorization", "bearer_token", "access_token",
    "refresh_token", "credential_value", "encrypted_secret_payload", "prompt", "messages",
    "tools", "tool_arguments", "raw_error", "raw_exception", "provider_error_body",
    "runtime_status", "runtime_cooldown_until", "health_consecutive_failures",
})


class ProjectionPersistenceValidationError(ValueError):
    pass


def _exact_ref(identity) -> dict[str, Any]:
    return {
        "kind": identity.kind,
        "key": identity.key,
        "revision": identity.revision,
        "expected_hash": identity.canonical_hash,
    }


def validate_exact_closure(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, (list, tuple)):
        raise ProjectionPersistenceValidationError("artifact closure must be a list of ExactRef values")
    normalized = []
    seen = set()
    for reference in value:
        try:
            exact = ExactRef.model_validate(reference, strict=True)
        except Exception as exc:
            raise ProjectionPersistenceValidationError("artifact closure contains a non-ExactRef value") from exc
        reference = exact.model_dump(mode="json")
        identity = (
            reference["kind"], reference["key"], reference["revision"], reference["expected_hash"],
        )
        if identity in seen:
            raise ProjectionPersistenceValidationError("artifact closure contains duplicate ExactRef")
        seen.add(identity)
        normalized.append(dict(reference))
    return tuple(sorted(normalized, key=lambda row: (row["kind"], row["key"], row["revision"], row["expected_hash"])))


def _validate_safe_json(value: Any, path: str = "$") -> None:
    if hasattr(value, "_meta"):
        raise ProjectionPersistenceValidationError(f"ORM object is forbidden at {path}")
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise ProjectionPersistenceValidationError(f"non-string key at {path}")
            if key.casefold() in FORBIDDEN_KEYS:
                raise ProjectionPersistenceValidationError(f"forbidden persistence key at {path}.{key}")
            _validate_safe_json(child, f"{path}.{key}")
        return
    if isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            _validate_safe_json(child, f"{path}[{index}]")
        return
    if value is None or isinstance(value, (str, int, bool, Decimal, datetime)):
        return
    if isinstance(value, float):
        raise ProjectionPersistenceValidationError(f"float is forbidden at {path}")
    raise ProjectionPersistenceValidationError(f"unsupported object at {path}")


def _canonical_json(value: Any) -> Any:
    _validate_safe_json(value)
    return json.loads(canonicalize(value).decode("utf-8"))


def validate_projection_revision_payload(payload: dict[str, Any]) -> None:
    _validate_safe_json(payload)
    validate_exact_closure(payload.get("artifact_closure"))
    secret_rows = payload.get("secret_field_classifications")
    if not isinstance(secret_rows, list) or any(
        not isinstance(row, dict) or set(row) != {"field_name", "status"}
        for row in secret_rows
    ):
        raise ProjectionPersistenceValidationError(
            "secret_field_classifications may contain field names and status only",
        )


def validate_projection_event_payload(payload: dict[str, Any]) -> None:
    _validate_safe_json(payload)
    metadata = payload.get("safe_metadata")
    if not isinstance(metadata, dict):
        raise ProjectionPersistenceValidationError("safe_metadata must be an object")


def validate_current_pointer(binding_id, revision_binding_id) -> None:
    if binding_id is None or revision_binding_id is None or binding_id != revision_binding_id:
        raise ProjectionPersistenceValidationError("current projection must belong to the same Binding")


def serialize_projection_plan(
    plan: ProjectionPlan,
    *,
    prepared_at: datetime,
    prepared_by_actor_id: str,
    source_environment: str,
    review_ticket: str | None = None,
) -> dict[str, Any]:
    if not isinstance(plan, ProjectionPlan):
        raise ProjectionPersistenceValidationError("only validated immutable ProjectionPlan is accepted")
    if prepared_at.tzinfo is None or prepared_at.utcoffset() is None:
        raise ProjectionPersistenceValidationError("prepared_at must be timezone-aware")
    if not prepared_by_actor_id or not source_environment:
        raise ProjectionPersistenceValidationError("actor and source environment are required")

    closure = validate_exact_closure([_exact_ref(identity) for identity in plan.closure_identities])
    generated = []
    commercial = []
    unmanaged = []
    operational_names = []
    secret_rows = []
    for field in plan.fields:
        row = {
            "target": field.target,
            "path": field.path,
            "proposed": field.proposed,
            "source_identity": field.source_ref,
        }
        if field.classification in {"generated_factual", "unchanged"}:
            generated.append(row)
        elif field.classification == "commercial":
            commercial.append(row)
        elif field.classification == "unmanaged":
            unmanaged.append(row)
        elif field.classification == "preserved_operational":
            operational_names.append(f"{field.target}.{field.path}")
        elif field.classification == "secret":
            secret_rows.append({"field_name": f"{field.target}.{field.path}", "status": "not-read"})

    payload = {
        "projection_hash": plan.projection_hash,
        "package_identity": {"package_key": plan.package_key},
        "deployment_ref": _exact_ref(plan.deployment_identity),
        "binding_ref": _exact_ref(plan.binding_identity),
        "artifact_closure": list(closure),
        "generated_factual_fields": sorted(generated, key=lambda row: (row["target"], row["path"])),
        "commercial_fields": sorted(commercial, key=lambda row: (row["target"], row["path"], row["source_identity"])),
        "preserved_operational_field_names": sorted(set(operational_names)),
        "secret_field_classifications": sorted(secret_rows, key=lambda row: row["field_name"]),
        "unmanaged_fields": sorted(unmanaged, key=lambda row: (row["target"], row["path"])),
        "validation_summary": {
            "drift": [
                {"severity": finding.severity, "code": finding.code, "path": finding.path}
                for finding in plan.drift
            ],
            "warnings": list(plan.warnings),
        },
        "behavior_blockers": [],
        "readiness_blockers": list(plan.blocking_issues),
        "projection_metadata": {
            "schema_version": "model-gateway-projection-revision/v1",
            "precedence": list(plan.precedence),
        },
        "prepared_at": prepared_at,
        "prepared_by_actor_id": prepared_by_actor_id,
        "review_ticket": review_ticket,
        "source_environment": source_environment,
    }
    validate_projection_revision_payload({
        key: value for key, value in payload.items()
        if key not in {"projection_hash", "prepared_at", "prepared_by_actor_id", "review_ticket", "source_environment"}
    })
    return _canonical_json(payload)

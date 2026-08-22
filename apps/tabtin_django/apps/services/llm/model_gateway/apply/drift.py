from __future__ import annotations

from .field_policy import build_field_patch
from .results import ProjectionOperationRejected


def _matches(instance, patch: dict) -> bool:
    for field, expected in patch.items():
        if field in {"capabilities_config", "custom_billing_config"}:
            continue
        if getattr(instance, field) != expected:
            return False
    return True


def classify_runtime_state(*, provider, model, target_revision, current_revision) -> str:
    target_provider, target_model, _ = build_field_patch(target_revision)
    if current_revision is None:
        for row in target_revision.generated_factual_fields:
            if row.get("current") is None:
                continue
            instance = provider if row["target"] == "provider" else model
            actual = getattr(instance, row["path"], None)
            expected = int(row["current"]) if row["path"].endswith("_tokens") else row["current"]
            if actual != expected:
                return "managed-factual-drift"
        return "expected-state-matches"
    current_provider, current_model, _ = build_field_patch(current_revision)
    if _matches(provider, target_provider) and _matches(model, target_model):
        return "already-applied-identical"
    if not _matches(provider, current_provider) or not _matches(model, current_model):
        return "pointer-runtime-drift"
    return "expected-state-matches"


def require_expected_runtime_state(**kwargs) -> str:
    outcome = classify_runtime_state(**kwargs)
    if outcome in {"managed-factual-drift", "commercial-drift", "pointer-runtime-drift"}:
        raise ProjectionOperationRejected(outcome)
    return outcome

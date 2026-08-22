from datetime import datetime, timezone

import pytest

from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity
from apps.services.llm.model_gateway.persistence import (
    ProjectionPersistenceValidationError,
    serialize_projection_plan,
    validate_current_pointer,
    validate_exact_closure,
    validate_projection_event_payload,
    validate_projection_revision_payload,
)
from apps.services.llm.model_gateway.projection.compiler import (
    DriftFinding,
    ProjectedField,
    ProjectionPlan,
)
from apps.services.llm.model_gateway.validation.secret_scanner import scan_raw_tree


HASH_A = "sha256:" + "a" * 64
HASH_B = "sha256:" + "b" * 64


def identity(kind: str, key: str, revision: str, hash_value: str = HASH_A) -> ArtifactIdentity:
    return ArtifactIdentity(kind=kind, key=key, revision=revision, canonical_hash=hash_value)


def projection_plan() -> ProjectionPlan:
    deployment = identity("deployment-profile", "safe-deployment", "1")
    binding = identity("model-deployment-binding", "safe-binding", "1", HASH_B)
    return ProjectionPlan(
        package_key="safe-package",
        deployment_identity=deployment,
        binding_identity=binding,
        closure_identities=(binding, deployment),
        provider_managed_target_identity=None,
        model_managed_target_identity=None,
        fields=(
            ProjectedField(target="model", path="context_window_tokens", proposed="128000", current="64000", source_ref="safe-ref", classification="generated_factual"),
            ProjectedField(target="model", path="pricing.input-token", proposed="0.001 CNY", current=None, source_ref="safe-rate", classification="commercial"),
            ProjectedField(target="provider", path="runtime_status", proposed="preserve", current="healthy", source_ref="database-observation", classification="preserved_operational"),
            ProjectedField(target="provider", path="encrypted_api_key", proposed="not-read", current=None, source_ref="redaction-policy", classification="secret"),
        ),
        drift=(DriftFinding(severity="warning", code="managed_factual_drift", path="model.context_window_tokens", message="safe"),),
        blocking_issues=("endpoint-safety-policy-unverified",),
        warnings=("review-required",),
        precedence=("artifact",),
        projection_hash=HASH_A,
    )


def test_exact_closure_is_exact_unique_and_deterministically_sorted():
    refs = [
        {"kind": "model-deployment-binding", "key": "safe-binding", "revision": "1", "expected_hash": HASH_B},
        {"kind": "deployment-profile", "key": "safe-deployment", "revision": "1", "expected_hash": HASH_A},
    ]
    normalized = validate_exact_closure(refs)
    assert [row["kind"] for row in normalized] == ["deployment-profile", "model-deployment-binding"]
    assert normalized == validate_exact_closure(tuple(reversed(refs)))
    with pytest.raises(ProjectionPersistenceValidationError, match="duplicate"):
        validate_exact_closure(refs + [refs[0]])


@pytest.mark.parametrize("bad_ref", [
    {"kind": "deployment-profile", "key": "safe", "revision": "1"},
    {"kind": "deployment-profile", "key": "safe", "revision": "1", "expected_hash": "latest"},
    {"kind": "deployment-profile", "key": "safe", "revision": "0", "expected_hash": HASH_A},
])
def test_exact_closure_rejects_floating_missing_or_nonpositive_refs(bad_ref):
    with pytest.raises(ProjectionPersistenceValidationError):
        validate_exact_closure([bad_ref])


def test_projection_serialization_is_deterministic_safe_and_omits_volatile_values():
    kwargs = dict(
        prepared_at=datetime(2026, 8, 6, tzinfo=timezone.utc),
        prepared_by_actor_id="reviewer-safe",
        source_environment="disposable-pr7",
        review_ticket="review-pr7",
    )
    first = serialize_projection_plan(projection_plan(), **kwargs)
    second = serialize_projection_plan(projection_plan(), **kwargs)
    assert first == second
    assert first["artifact_closure"] == sorted(first["artifact_closure"], key=lambda row: (row["kind"], row["key"], row["revision"], row["expected_hash"]))
    assert first["preserved_operational_field_names"] == ["provider.runtime_status"]
    assert first["secret_field_classifications"] == [{"field_name": "provider.encrypted_api_key", "status": "not-read"}]
    rendered = str(first)
    assert "healthy" not in rendered
    assert "api-key-value" not in rendered
    assert first["prepared_at"] == "2026-08-06T00:00:00Z"
    assert scan_raw_tree(first, "projection-persistence-v1", artifact_kind="projection-revision") == ()


@pytest.mark.parametrize("unsafe", [
    {"api_key": "synthetic-forbidden-value"},
    {"messages": ["synthetic-content"]},
    {"provider_error_body": "synthetic-error"},
    {"amount": 1.5},
])
def test_revision_payload_rejects_credentials_content_errors_and_floats(unsafe):
    payload = {
        "artifact_closure": [],
        "secret_field_classifications": [],
        "projection_metadata": unsafe,
    }
    with pytest.raises(ProjectionPersistenceValidationError):
        validate_projection_revision_payload(payload)


def test_secret_classification_contains_names_and_status_only():
    with pytest.raises(ProjectionPersistenceValidationError, match="names and status"):
        validate_projection_revision_payload({
            "artifact_closure": [],
            "secret_field_classifications": [{"field_name": "provider.api_key", "status": "not-read", "value": "forbidden"}],
        })


def test_current_pointer_rejects_cross_binding_and_accepts_same_binding():
    validate_current_pointer("binding-a", "binding-a")
    with pytest.raises(ProjectionPersistenceValidationError, match="same Binding"):
        validate_current_pointer("binding-a", "binding-b")


def test_event_payload_rejects_raw_error_or_arbitrary_object():
    with pytest.raises(ProjectionPersistenceValidationError):
        validate_projection_event_payload({"safe_metadata": {"raw_error": "forbidden"}})
    with pytest.raises(ProjectionPersistenceValidationError):
        validate_projection_event_payload({"safe_metadata": {"object": object()}})

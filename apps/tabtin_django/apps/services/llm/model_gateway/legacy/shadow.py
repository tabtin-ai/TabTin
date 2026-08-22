"""Pure same-input shadow comparator."""

from __future__ import annotations

from ..canonical import calculate_canonical_hash
from ..domain._base import StrictFrozenModel
from .classification import (
    NON_SEMANTIC_NORMALIZATIONS,
    DifferenceClassification,
    DifferenceSeverity,
    severity_for,
)
from .observations import ArtifactObservation, LegacyObservation, ObservabilityStatus


class ShadowDifference(StrictFrozenModel):
    path: str
    fixture_key: str
    legacy_input_hash: str
    artifact_input_hash: str
    input_hash: str
    legacy_observation_hash: str
    artifact_observation_hash: str
    legacy_summary: str | None
    artifact_summary: str | None
    classification: DifferenceClassification
    severity: DifferenceSeverity
    evidence: tuple[str, ...]
    normalization: str | None
    behavior_blockers: tuple[str, ...]
    readiness_blockers: tuple[str, ...]
    explanation: str
    surface_hash: str


class ShadowComparisonResult(StrictFrozenModel):
    package_key: str
    binding_key: str
    model_key: str
    fixture_key: str
    input_hash: str
    surfaces: tuple[str, ...]
    differences: tuple[ShadowDifference, ...]
    behavior_blockers: tuple[str, ...]
    readiness_blockers: tuple[str, ...]
    unknown_findings: tuple[str, ...]
    comparison_hash: str


def _classification(legacy: LegacyObservation, artifact: ArtifactObservation) -> DifferenceClassification:
    status = legacy.observability
    if status == ObservabilityStatus.NOT_RUNTIME_PRESENT:
        return DifferenceClassification.NOT_RUNTIME_PRESENT
    if status == ObservabilityStatus.UNOBSERVABLE:
        return DifferenceClassification.UNOBSERVABLE
    if status == ObservabilityStatus.UNKNOWN or artifact.observability == ObservabilityStatus.UNKNOWN:
        return DifferenceClassification.UNKNOWN
    if legacy.safe_value == artifact.safe_value:
        return DifferenceClassification.PROVISIONAL if status == ObservabilityStatus.PROVISIONAL else DifferenceClassification.EQUIVALENT
    if legacy.normalization and legacy.normalization == artifact.normalization and legacy.normalization in NON_SEMANTIC_NORMALIZATIONS:
        return DifferenceClassification.REPRESENTATION_ONLY
    if artifact.explanation == "documented-intentional-future-change":
        return DifferenceClassification.INTENTIONAL_FUTURE_DIFFERENCE
    if artifact.explanation == "legacy-compatible-representation":
        return DifferenceClassification.LEGACY_COMPATIBLE_DIFFERENCE
    return DifferenceClassification.BEHAVIOR_BLOCKING_MISMATCH


def _observation_hash(observation: LegacyObservation | ArtifactObservation) -> str:
    payload = observation.model_dump(mode="json")
    return calculate_canonical_hash(payload)


def _surface_readiness(path: str, blockers: tuple[str, ...]) -> tuple[str, ...]:
    relevant = []
    for blocker in blockers:
        if blocker == "max-output-unknown" and path not in {"database.limits", "catalog.shape"}:
            continue
        if blocker == "rate-card-unknown" and path != "billing.configuration":
            continue
        if blocker == "endpoint-safety-policy-unverified" and path not in {
            "database.endpoint_representation", "database.provider_identity", "catalog.shape", "wire.pre", "wire.post",
        }:
            continue
        if blocker == "verified_safety_ceiling_missing" and path not in {"database.limits", "catalog.shape", "wire.pre"}:
            continue
        if blocker == "offline-protocol-contract-provisional" and path not in {
            "catalog.shape", "session.parameter_roundtrip", "wire.pre", "wire.post", "stream.sse",
            "usage.normalization", "downgrade_fallback.events", "errors.sanitized",
        }:
            continue
        relevant.append(blocker)
    return tuple(sorted(set(relevant)))


def compare_observations(
    legacy: tuple[LegacyObservation, ...],
    artifact: tuple[ArtifactObservation, ...],
    *,
    readiness_blockers: tuple[str, ...] = (),
) -> ShadowComparisonResult:
    if not legacy or not artifact:
        raise ValueError("both observation sets are required")
    key = lambda item: (item.surface, item.fixture_key)
    left = {key(item): item for item in legacy}
    right = {key(item): item for item in artifact}
    if set(left) != set(right):
        raise ValueError("observation surfaces must match exactly")
    identities = {(x.package_key, x.binding_key, x.model_key) for x in legacy + artifact}
    if len(identities) != 1:
        raise ValueError("observation identities must match")
    for observation_key in sorted(left):
        if left[observation_key].input_hash != right[observation_key].input_hash:
            raise ValueError(f"same-input guarantee violated for surface {observation_key[0]}")

    differences = []
    for observation_key in sorted(left):
        current = left[observation_key]
        proposed = right[observation_key]
        classification = _classification(current, proposed)
        evidence = (current.evidence_source,) + tuple(proposed.artifact_source_refs)
        behavior = (current.surface,) if classification == DifferenceClassification.BEHAVIOR_BLOCKING_MISMATCH else ()
        surface_readiness = _surface_readiness(current.surface, readiness_blockers)
        surface_payload = {
            "package_key": current.package_key,
            "binding_key": current.binding_key,
            "model_key": current.model_key,
            "surface": current.surface,
            "fixture_key": current.fixture_key,
            "legacy_input_hash": current.input_hash,
            "artifact_input_hash": proposed.input_hash,
            "input_hash": current.input_hash,
            "legacy_observation_hash": _observation_hash(current),
            "artifact_observation_hash": _observation_hash(proposed),
            "legacy_summary": current.safe_value,
            "artifact_summary": proposed.safe_value,
            "classification": classification.value,
            "normalization": current.normalization,
            "evidence": evidence,
            "behavior_blockers": behavior,
            "readiness_blockers": surface_readiness,
        }
        differences.append(ShadowDifference(
            path=current.surface,
            fixture_key=current.fixture_key,
            legacy_input_hash=current.input_hash,
            artifact_input_hash=proposed.input_hash,
            input_hash=current.input_hash,
            legacy_observation_hash=surface_payload["legacy_observation_hash"],
            artifact_observation_hash=surface_payload["artifact_observation_hash"],
            legacy_summary=current.safe_value,
            artifact_summary=proposed.safe_value,
            classification=classification,
            severity=severity_for(classification),
            evidence=evidence,
            normalization=current.normalization,
            behavior_blockers=behavior,
            readiness_blockers=surface_readiness,
            explanation=proposed.explanation or current.explanation or classification.value,
            surface_hash=calculate_canonical_hash(surface_payload),
        ))
    differences.sort(key=lambda item: (item.path, item.classification.value, item.explanation))
    behavior = tuple(item.path for item in differences if item.classification == DifferenceClassification.BEHAVIOR_BLOCKING_MISMATCH)
    unknown = tuple(item.path for item in differences if item.classification in {
        DifferenceClassification.UNKNOWN,
        DifferenceClassification.UNOBSERVABLE,
        DifferenceClassification.NOT_RUNTIME_PRESENT,
    })
    package_key, binding_key, model_key = identities.pop()
    payload = {
        "package_key": package_key,
        "binding_key": binding_key,
        "model_key": model_key,
        "surface_hashes": [item.surface_hash for item in differences],
        "behavior_blockers": behavior,
        "readiness_blockers": sorted(set(readiness_blockers)),
    }
    model_input_hash = calculate_canonical_hash({
        "surface_inputs": [(item.path, item.input_hash) for item in differences],
    })
    return ShadowComparisonResult(
        package_key=package_key,
        binding_key=binding_key,
        model_key=model_key,
        fixture_key="multi-surface-v1",
        input_hash=model_input_hash,
        surfaces=tuple(item.path for item in differences),
        differences=tuple(differences),
        behavior_blockers=behavior,
        readiness_blockers=tuple(sorted(set(readiness_blockers))),
        unknown_findings=unknown,
        comparison_hash=calculate_canonical_hash(payload),
    )

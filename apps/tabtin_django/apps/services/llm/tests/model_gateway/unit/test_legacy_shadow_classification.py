import pytest

from apps.services.llm.model_gateway.legacy.classification import DifferenceClassification
from apps.services.llm.model_gateway.legacy.observations import ArtifactObservation, LegacyObservation, ObservabilityStatus, synthetic_input_hash
from apps.services.llm.model_gateway.legacy.shadow import compare_observations

H = "sha256:" + "a" * 64


def pair(*, left='{"x":1}', right='{"x":1}', status=ObservabilityStatus.OBSERVED, normalization=None, explanation=""):
    common = dict(package_key="p", binding_key="b", model_key="m", surface="wire.post", fixture_key="f", input_hash=H,
                  normalization=normalization, explanation=explanation)
    legacy = LegacyObservation(**common, safe_value=left, observability=status, evidence_source="synthetic legacy")
    artifact = ArtifactObservation(**common, safe_value=right, observability=ObservabilityStatus.OBSERVED,
                                   artifact_source_refs=("model-capability:x:1:sha256:" + "b" * 64,), projection_hash=H)
    return (legacy,), (artifact,)


@pytest.mark.parametrize(("kwargs", "expected"), [
    ({}, DifferenceClassification.EQUIVALENT),
    ({"left": '""', "right": '"https://example.test"', "normalization": "database-empty-endpoint"}, DifferenceClassification.REPRESENTATION_ONLY),
    ({"left": '"legacy"', "right": '"artifact"', "explanation": "legacy-compatible-representation"}, DifferenceClassification.LEGACY_COMPATIBLE_DIFFERENCE),
    ({"left": '"legacy"', "right": '"future"', "explanation": "documented-intentional-future-change"}, DifferenceClassification.INTENTIONAL_FUTURE_DIFFERENCE),
    ({"status": ObservabilityStatus.PROVISIONAL}, DifferenceClassification.PROVISIONAL),
    ({"status": ObservabilityStatus.UNKNOWN}, DifferenceClassification.UNKNOWN),
    ({"status": ObservabilityStatus.UNOBSERVABLE}, DifferenceClassification.UNOBSERVABLE),
    ({"status": ObservabilityStatus.NOT_RUNTIME_PRESENT}, DifferenceClassification.NOT_RUNTIME_PRESENT),
    ({"left": '"a"', "right": '"b"'}, DifferenceClassification.BEHAVIOR_BLOCKING_MISMATCH),
])
def test_every_classification_is_independently_reachable(kwargs, expected):
    legacy, artifact = pair(**kwargs)
    assert compare_observations(legacy, artifact).differences[0].classification == expected


def test_synthetic_input_hash_is_stable_and_clock_is_explicit():
    value = {"clock": "2026-08-06T00:00:00Z", "input": "synthetic"}
    assert synthetic_input_hash("fixture", value) == synthetic_input_hash("fixture", value)
    assert synthetic_input_hash("fixture", value) != synthetic_input_hash("fixture", {**value, "clock": "2026-08-07T00:00:00Z"})

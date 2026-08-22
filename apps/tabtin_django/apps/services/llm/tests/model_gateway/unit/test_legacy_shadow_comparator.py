import pytest

from apps.services.llm.model_gateway.legacy.classification import DifferenceClassification
from apps.services.llm.model_gateway.legacy.observations import ArtifactObservation, LegacyObservation, ObservabilityStatus
from apps.services.llm.model_gateway.legacy.shadow import compare_observations

H = "sha256:" + "a" * 64


def observations(surface="usage", input_hash=H, value='{"total":17}'):
    common = dict(package_key="package", binding_key="binding", model_key="model", surface=surface,
                  fixture_key="fixture", input_hash=input_hash, safe_value=value, observability=ObservabilityStatus.OBSERVED)
    return LegacyObservation(**common, evidence_source="golden"), ArtifactObservation(
        **common, artifact_source_refs=("exact-ref",), projection_hash=H)


def test_same_input_mismatch_is_blocking_contract_error():
    legacy, artifact = observations()
    artifact = artifact.model_copy(update={"input_hash": "sha256:" + "b" * 64})
    with pytest.raises(ValueError, match="same-input"):
        compare_observations((legacy,), (artifact,))


def test_readiness_blocker_is_not_behavior_blocker():
    legacy, artifact = observations()
    result = compare_observations((legacy,), (artifact,), readiness_blockers=("endpoint-safety",))
    assert result.readiness_blockers == ("endpoint-safety",)
    assert result.behavior_blockers == ()


def test_unexplained_difference_is_the_only_behavior_blocker():
    legacy, artifact = observations()
    artifact = artifact.model_copy(update={"safe_value": '{"total":18}'})
    result = compare_observations((legacy,), (artifact,))
    assert result.behavior_blockers == ("usage",)
    assert result.differences[0].classification == DifferenceClassification.BEHAVIOR_BLOCKING_MISMATCH


def test_hash_and_difference_order_are_deterministic():
    first = observations(surface="z")
    second = observations(surface="a")
    left = (first[0], second[0])
    right = (first[1], second[1])
    a = compare_observations(left, right)
    b = compare_observations(tuple(reversed(left)), tuple(reversed(right)))
    assert a == b
    assert a.surfaces == ("a", "z")


def test_surface_and_model_hash_change_together_without_renderer_dependency():
    legacy, artifact = observations(surface="usage.normalization")
    original = compare_observations((legacy,), (artifact,))
    changed = compare_observations(
        (legacy.model_copy(update={"safe_value": '{"total":18}'}),),
        (artifact.model_copy(update={"safe_value": '{"total":18}'}),),
    )
    assert original.differences[0].surface_hash != changed.differences[0].surface_hash
    assert original.comparison_hash != changed.comparison_hash


def test_model_hash_is_derived_from_deterministically_ordered_surface_hashes():
    a = observations(surface="a")
    z = observations(surface="z")
    first = compare_observations((z[0], a[0]), (z[1], a[1]), readiness_blockers=("ready",))
    second = compare_observations((a[0], z[0]), (a[1], z[1]), readiness_blockers=("ready",))
    assert [item.path for item in first.differences] == ["a", "z"]
    assert [item.surface_hash for item in first.differences] == [item.surface_hash for item in second.differences]
    assert first.comparison_hash == second.comparison_hash

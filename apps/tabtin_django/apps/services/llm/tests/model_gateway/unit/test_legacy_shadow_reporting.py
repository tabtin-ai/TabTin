from apps.services.llm.model_gateway.legacy.observations import ArtifactObservation, LegacyObservation, ObservabilityStatus
from apps.services.llm.model_gateway.legacy.reporting import (
    difference_report_records,
    machine_report_records,
    render_results,
    summary_report_record,
)
from apps.services.llm.model_gateway.legacy.shadow import compare_observations

H = "sha256:" + "a" * 64


def result():
    common = dict(package_key="safe-package", binding_key="safe-binding", model_key="safe-model", surface="errors.sanitized",
                  fixture_key="safe-fixture", input_hash=H, safe_value='{"raw":"excluded"}', observability=ObservabilityStatus.PROVISIONAL)
    return compare_observations((LegacyObservation(**common, evidence_source="synthetic"),),
                                (ArtifactObservation(**common, artifact_source_refs=("safe-ref",), projection_hash=H),))


def test_text_json_and_jsonl_are_stable_and_safe():
    item = result()
    for format in ("text", "json", "jsonl"):
        first = render_results((item,), format=format)
        assert first == render_results((item,), format=format)
        assert "Authorization" not in first and "Bearer " not in first
        assert "safe-package" in first


def test_machine_record_contains_the_review_contract_without_raw_payloads():
    record = difference_report_records(result())[0]
    assert set(record) == {
        "record_type", "package_key", "binding_key", "model", "surface", "fixture_key",
        "legacy_input_hash", "artifact_input_hash", "input_hash",
        "legacy_observation_hash", "artifact_observation_hash",
        "classification", "severity", "legacy_summary", "artifact_summary", "evidence_refs",
        "comparison_hash", "readiness_blockers", "behavior_blockers", "normalization_rule", "surface_hash",
    }
    assert record["legacy_input_hash"] == record["artifact_input_hash"] == record["input_hash"]
    rendered = str(record)
    assert "Authorization" not in rendered
    assert "Bearer " not in rendered


def test_summary_is_derived_from_surface_records_and_machine_order_is_stable():
    item = result()
    surfaces = difference_report_records(item)
    summary = summary_report_record(item)
    assert summary["surface_count"] == len(surfaces)
    assert summary["classification_counts"] == {"provisional": 1}
    assert summary["surface_hashes"] == [record["surface_hash"] for record in surfaces]
    records = machine_report_records((item,))
    assert [record["record_type"] for record in records] == ["surface", "model_summary"]
    assert records == machine_report_records((item,))

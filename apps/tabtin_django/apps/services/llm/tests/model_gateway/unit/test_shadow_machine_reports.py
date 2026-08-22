import json
import re
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).parents[3] / "model_gateway" / "artifacts" / "drafts"
SURFACES = {
    "database.provider_identity", "database.model_identity", "database.endpoint_representation",
    "database.limits", "database.operational_fields", "catalog.shape", "session.parameter_roundtrip",
    "wire.pre", "wire.post", "stream.sse", "usage.normalization", "billing.configuration",
    "downgrade_fallback.events", "errors.sanitized",
}
RUNTIME_PRESENT_COUNTS = {"equivalent": 7, "representation_only": 1, "provisional": 6}
NOT_RUNTIME_COUNTS = {"not_runtime_present": 6, "unknown": 1, "provisional": 7}
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", re.I)


def records():
    return [
        json.loads(line)
        for path in sorted(ROOT.glob("*/evidence/shadow-comparison.jsonl"))
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def test_reports_have_one_record_per_surface_and_one_derived_summary_per_model():
    rows = records()
    surfaces = [row for row in rows if row["record_type"] == "surface"]
    summaries = [row for row in rows if row["record_type"] == "model_summary"]
    assert len(surfaces) == 112 and len(summaries) == 8
    grouped = defaultdict(list)
    for row in surfaces:
        grouped[row["package_key"]].append(row)
    assert len(grouped) == 8
    for package_rows in grouped.values():
        assert {row["surface"] for row in package_rows} == SURFACES
        assert len({(row["package_key"], row["surface"]) for row in package_rows}) == 14
    assert all(sum(row["surface"] == "downgrade_fallback.events" for row in surfaces if row["package_key"] == key) == 1 for key in grouped)
    assert all(sum(row["surface"] == "errors.sanitized" for row in surfaces if row["package_key"] == key) == 1 for key in grouped)


def test_summary_counts_hashes_and_blockers_are_derived_from_surface_records():
    rows = records()
    surfaces = [row for row in rows if row["record_type"] == "surface"]
    summaries = {row["package_key"]: row for row in rows if row["record_type"] == "model_summary"}
    for package_key, summary in summaries.items():
        package_rows = sorted((row for row in surfaces if row["package_key"] == package_key), key=lambda row: row["surface"])
        counts = dict(sorted(Counter(row["classification"] for row in package_rows).items()))
        expected = NOT_RUNTIME_COUNTS if "2-1-pro" in package_key or "2-1-turbo" in package_key else RUNTIME_PRESENT_COUNTS
        assert counts == expected == summary["classification_counts"]
        assert summary["surface_hashes"] == [row["surface_hash"] for row in package_rows]
        assert summary["behavior_blocker_count"] == 0
        assert summary["readiness_blocker_count"] == (5 if expected == NOT_RUNTIME_COUNTS else 3)


def test_surface_records_prove_same_input_specific_evidence_and_redaction():
    rows = records()
    surfaces = [row for row in rows if row["record_type"] == "surface"]
    for row in surfaces:
        assert row["legacy_input_hash"] == row["artifact_input_hash"] == row["input_hash"]
        if row["surface"].startswith("database."):
            assert row["fixture_key"].endswith(":database-snapshot-v1")
        else:
            assert row["fixture_key"].endswith(":same-input-v1")
        assert row["evidence_refs"]
        assert row["legacy_observation_hash"].startswith("sha256:")
        assert row["artifact_observation_hash"].startswith("sha256:")
        assert row["surface_hash"].startswith("sha256:")
    rendered = "\n".join(json.dumps(row, sort_keys=True) for row in rows)
    assert not UUID.search(rendered)
    for unsafe in ("Authorization", "Bearer ", "api_key", "database_url", "raw_provider_error", "tool_arguments"):
        assert unsafe not in rendered


def test_runtime_endpoint_is_the_only_representation_normalization():
    surface_rows = [row for row in records() if row["record_type"] == "surface"]
    represented = [row for row in surface_rows if row["classification"] == "representation_only"]
    assert len(represented) == 6
    assert {row["surface"] for row in represented} == {"database.endpoint_representation"}
    assert {row["normalization_rule"] for row in represented} == {"database-empty-endpoint"}

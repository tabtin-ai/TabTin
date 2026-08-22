"""Stable redacted rendering for offline shadow results."""

import json
from collections import Counter
from typing import Literal

from .shadow import ShadowComparisonResult


def result_payload(result: ShadowComparisonResult) -> dict:
    return result.model_dump(mode="json")


def difference_report_records(result: ShadowComparisonResult) -> tuple[dict, ...]:
    """Render one deterministic, redacted machine record per comparison surface."""
    return tuple(
        {
            "record_type": "surface",
            "package_key": result.package_key,
            "binding_key": result.binding_key,
            "model": result.model_key,
            "surface": difference.path,
            "fixture_key": difference.fixture_key,
            "legacy_input_hash": difference.legacy_input_hash,
            "artifact_input_hash": difference.artifact_input_hash,
            "input_hash": difference.input_hash,
            "legacy_observation_hash": difference.legacy_observation_hash,
            "artifact_observation_hash": difference.artifact_observation_hash,
            "classification": difference.classification.value,
            "severity": difference.severity.value,
            "legacy_summary": difference.legacy_summary,
            "artifact_summary": difference.artifact_summary,
            "evidence_refs": list(difference.evidence),
            "comparison_hash": result.comparison_hash,
            "normalization_rule": difference.normalization,
            "readiness_blockers": list(difference.readiness_blockers),
            "behavior_blockers": list(difference.behavior_blockers),
            "surface_hash": difference.surface_hash,
        }
        for difference in result.differences
    )


def summary_report_record(result: ShadowComparisonResult) -> dict:
    surfaces = difference_report_records(result)
    counts = Counter(record["classification"] for record in surfaces)
    return {
        "record_type": "model_summary",
        "package_key": result.package_key,
        "binding_key": result.binding_key,
        "model": result.model_key,
        "classification_counts": dict(sorted(counts.items())),
        "surface_count": len(surfaces),
        "behavior_blocker_count": len(result.behavior_blockers),
        "readiness_blocker_count": len(result.readiness_blockers),
        "behavior_blockers": list(result.behavior_blockers),
        "readiness_blockers": list(result.readiness_blockers),
        "runtime_present": not any(record["classification"] == "not_runtime_present" for record in surfaces),
        "surface_hashes": [record["surface_hash"] for record in surfaces],
        "comparison_hash": result.comparison_hash,
    }


def machine_report_records(results: tuple[ShadowComparisonResult, ...]) -> tuple[dict, ...]:
    ordered = tuple(sorted(results, key=lambda item: (item.package_key, item.model_key)))
    records = [record for result in ordered for record in difference_report_records(result)]
    records.extend(summary_report_record(result) for result in ordered)
    return tuple(records)


def render_results(results: tuple[ShadowComparisonResult, ...], *, format: Literal["text", "json", "jsonl"] = "text") -> str:
    ordered = tuple(sorted(results, key=lambda item: (item.package_key, item.model_key)))
    if format == "json":
        return json.dumps({"results": [result_payload(x) for x in ordered]}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if format == "jsonl":
        records = machine_report_records(ordered)
        return "\n".join(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) for record in records) + ("\n" if records else "")
    lines = []
    for result in ordered:
        lines.extend((
            f"package {result.package_key}",
            f"model {result.model_key}",
            f"fixture {result.fixture_key} {result.input_hash}",
            f"comparison-hash {result.comparison_hash}",
        ))
        for difference in result.differences:
            lines.append(f"{difference.path}: {difference.classification.value} {difference.severity.value}")
        for blocker in result.readiness_blockers:
            lines.append(f"readiness-blocker {blocker}")
        for blocker in result.behavior_blockers:
            lines.append(f"behavior-blocker {blocker}")
    return "\n".join(lines) + ("\n" if lines else "")

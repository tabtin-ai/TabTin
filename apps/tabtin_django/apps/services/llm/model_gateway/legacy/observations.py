"""Immutable comparator DTOs; no ORM, runtime, secrets, or raw payloads."""

from __future__ import annotations

import hashlib
from enum import StrEnum
from typing import Any

from pydantic import field_validator

from ..canonical import canonicalize
from ..domain._base import StrictFrozenModel


class ObservabilityStatus(StrEnum):
    OBSERVED = "observed"
    PROVISIONAL = "provisional"
    UNKNOWN = "unknown"
    UNOBSERVABLE = "unobservable"
    NOT_RUNTIME_PRESENT = "not_runtime_present"


def safe_summary(value: Any) -> str:
    """Canonical JSON summary for already-sanitized, synthetic values."""
    return canonicalize(value).decode("utf-8")


def synthetic_input_hash(fixture_key: str, value: Any) -> str:
    payload = {"fixture_key": fixture_key, "input": value}
    return "sha256:" + hashlib.sha256(canonicalize(payload)).hexdigest()


class _Observation(StrictFrozenModel):
    package_key: str
    binding_key: str
    model_key: str
    surface: str
    fixture_key: str
    input_hash: str
    safe_value: str | None
    observability: ObservabilityStatus
    normalization: str | None = None
    explanation: str = ""

    @field_validator("input_hash")
    @classmethod
    def validate_input_hash(cls, value: str) -> str:
        if not value.startswith("sha256:") or len(value) != 71:
            raise ValueError("input_hash must be sha256")
        return value


class LegacyObservation(_Observation):
    evidence_source: str


class ArtifactObservation(_Observation):
    artifact_source_refs: tuple[str, ...]
    projection_hash: str

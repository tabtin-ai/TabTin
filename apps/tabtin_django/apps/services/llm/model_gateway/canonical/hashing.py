"""Canonical SHA-256 calculation and verification."""

from __future__ import annotations

import hashlib
from typing import Any

from pydantic import BaseModel

from .normalize import canonicalize


def _without_self_hash(value: Any) -> Any:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="python")
    if not isinstance(value, dict):
        return value
    payload = dict(value)
    identity = payload.get("identity")
    if isinstance(identity, dict):
        payload["identity"] = {key: item for key, item in identity.items() if key != "canonical_hash"}
    return payload


def calculate_canonical_hash(artifact: BaseModel | dict[str, Any]) -> str:
    digest = hashlib.sha256(canonicalize(_without_self_hash(artifact))).hexdigest()
    return f"sha256:{digest}"


def verify_canonical_hash(artifact: BaseModel | dict[str, Any], expected_hash: str) -> bool:
    return calculate_canonical_hash(artifact) == expected_hash

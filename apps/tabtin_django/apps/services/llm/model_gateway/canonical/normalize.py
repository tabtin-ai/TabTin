"""Canonical JSON normalization for validated Model Gateway artifacts."""

from __future__ import annotations

import json
import math
import unicodedata
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel


class CanonicalizationError(ValueError):
    pass


def _normalize(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return _normalize(value.model_dump(mode="python"))
    if isinstance(value, Enum):
        return _normalize(value.value)
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise CanonicalizationError("timestamps must include timezone information")
        utc = value.astimezone(timezone.utc)
        text = utc.isoformat(timespec="microseconds").replace("+00:00", "Z")
        return text.replace(".000000Z", "Z")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CanonicalizationError("non-finite numbers are forbidden")
        raise CanonicalizationError("binary floating-point values are forbidden")
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalizationError("object keys must be strings")
            normalized_key = unicodedata.normalize("NFC", key)
            if normalized_key in result:
                raise CanonicalizationError("duplicate keys after Unicode normalization")
            result[normalized_key] = _normalize(item)
        return result
    if isinstance(value, (list, tuple)):
        return [_normalize(item) for item in value]
    raise CanonicalizationError(f"unsupported canonical value type: {type(value).__name__}")


def canonicalize(artifact: BaseModel | dict[str, Any]) -> bytes:
    normalized = _normalize(artifact)
    return json.dumps(
        normalized,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


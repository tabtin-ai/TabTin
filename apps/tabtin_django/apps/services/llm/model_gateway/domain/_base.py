"""Strict, immutable primitives shared by Model Gateway artifacts."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


StableKey = Annotated[str, Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")]
Revision = Annotated[str, Field(pattern=r"^[1-9][0-9]*$")]
CanonicalHash = Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")]
SchemaVersion = Literal["1"]
DecimalString = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]*)(?:\.[0-9]+)?$")]


class StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class SupportState(StrEnum):
    SUPPORTED = "supported"
    UNSUPPORTED = "unsupported"
    CONDITIONAL = "conditional"
    UNKNOWN = "unknown"
    FORCED = "forced"


class LifecycleState(StrEnum):
    DRAFT = "draft"
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    RETIRED = "retired"


class EvidenceRef(StrictFrozenModel):
    source: str
    locator: str


class SourcedValue(StrictFrozenModel):
    value: str | int | bool | None
    evidence: tuple[EvidenceRef, ...]
    verified: bool


class UTCValidityInterval(StrictFrozenModel):
    valid_from: datetime
    valid_until: datetime | None = None

    @field_validator("valid_from", "valid_until")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("timestamp must include timezone information")
        return value


class ConditionNode(StrictFrozenModel):
    operator: Literal["all", "any", "not", "equals", "present"]
    field: str | None = None
    value: str | int | bool | None = None
    children: tuple["ConditionNode", ...] = ()


class FactualValue(StrictFrozenModel):
    key: StableKey
    order: int
    evidence: tuple[EvidenceRef, ...]


class BudgetRange(StrictFrozenModel):
    minimum: int
    default: int
    maximum: int
    step: int


class CredentialPoolRef(StrictFrozenModel):
    pool_key: StableKey


class ArtifactBase(StrictFrozenModel):
    schema_version: SchemaVersion

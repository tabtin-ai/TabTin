from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


class ProjectionOperationRejected(ValueError):
    """Stable, redacted operator-facing rejection."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class ProjectionOperationResult:
    code: Literal["prepared", "already-prepared", "applied", "already-applied", "rolled-back", "already-rolled-back"]
    binding_id: str
    revision_id: str
    projection_hash: str

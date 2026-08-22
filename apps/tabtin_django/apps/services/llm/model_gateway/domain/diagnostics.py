from typing import Literal

from .identities import ArtifactIdentity

from ._base import StrictFrozenModel


class StructuralDiagnostic(StrictFrozenModel):
    severity: Literal["blocking", "warning", "informational"]
    rule_code: str
    artifact: ArtifactIdentity | None = None
    path: str
    message: str
    related: tuple[ArtifactIdentity, ...] = ()
    remediation: str | None = None

from datetime import datetime

from pydantic import field_validator

from ._base import ArtifactBase
from .identities import ArtifactIdentity, ExactRef


class ProjectionMetadata(ArtifactBase):
    identity: ArtifactIdentity
    source_refs: tuple[ExactRef, ...]
    projected_at: datetime
    projector_version: str

    @field_validator("projected_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamp must include timezone information")
        return value

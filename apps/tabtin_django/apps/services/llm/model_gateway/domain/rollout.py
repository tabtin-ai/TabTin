from ._base import ArtifactBase, ConditionNode, LifecycleState
from datetime import datetime

from .identities import ArtifactIdentity, ExactRef


class RolloutPolicy(ArtifactBase):
    identity: ArtifactIdentity
    lifecycle: LifecycleState
    conditions: tuple[ConditionNode, ...]
    percentage_basis_points: int
    sunset_at: datetime | None = None
    replacement_ref: ExactRef | None = None

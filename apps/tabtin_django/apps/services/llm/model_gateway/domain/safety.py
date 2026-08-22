from ._base import ArtifactBase, EvidenceRef, StableKey
from .identities import ArtifactIdentity


class PlatformSafetyPolicy(ArtifactBase):
    identity: ArtifactIdentity
    policy_keys: tuple[StableKey, ...]
    blocked_extension_targets: tuple[str, ...]
    provider_maximum: int | None = None
    provider_maximum_verified: bool = False
    platform_ceiling: int | None = None
    platform_ceiling_verified: bool = False
    platform_ceiling_enforceable: bool = False
    commercial_tier_limit: int | None = None
    evidence: tuple[EvidenceRef, ...] = ()

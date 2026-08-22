"""Stable, side-effect-free Model Gateway artifact interfaces."""

from .canonical import calculate_canonical_hash, canonicalize, verify_canonical_hash
from .domain import (
    ArtifactIdentity,
    DeploymentProfile,
    ExactRef,
    ExtensionTargetAllowlist,
    ModelCapabilitySpec,
    ModelDeploymentBinding,
    PlatformSafetyPolicy,
    ProductControlMapping,
    ProjectionMetadata,
    ProtocolReadinessSpec,
    RateCard,
    RolloutPolicy,
    RuntimeWireMapping,
)

__all__ = ["ArtifactIdentity", "DeploymentProfile", "ExactRef", "ExtensionTargetAllowlist", "ModelCapabilitySpec", "ModelDeploymentBinding", "PlatformSafetyPolicy", "ProductControlMapping", "ProjectionMetadata", "ProtocolReadinessSpec", "RateCard", "RolloutPolicy", "RuntimeWireMapping", "calculate_canonical_hash", "canonicalize", "verify_canonical_hash"]

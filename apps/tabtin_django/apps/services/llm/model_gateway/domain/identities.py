"""Exact, immutable artifact identities. No lookup behavior lives here."""

from typing import Literal

from ._base import CanonicalHash, Revision, StableKey, StrictFrozenModel


ArtifactKind = Literal[
    "model-capability", "product-control-mapping", "runtime-wire-mapping",
    "protocol-readiness", "extension-target-allowlist", "deployment-profile",
    "model-deployment-binding", "rate-card", "platform-safety-policy",
    "rollout-policy", "projection-metadata",
]


class ArtifactIdentity(StrictFrozenModel):
    kind: ArtifactKind
    key: StableKey
    revision: Revision
    canonical_hash: CanonicalHash


class ExactRef(StrictFrozenModel):
    kind: ArtifactKind
    key: StableKey
    revision: Revision
    expected_hash: CanonicalHash


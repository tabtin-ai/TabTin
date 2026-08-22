from datetime import datetime

from ._base import ArtifactBase, CredentialPoolRef, LifecycleState, StableKey
from .identities import ArtifactIdentity, ExactRef


class DeploymentProfile(ArtifactBase):
    identity: ArtifactIdentity
    endpoint_key: StableKey
    endpoint_url: str | None = None
    endpoint_policy_ref: ExactRef | None = None
    region: StableKey | None = None
    protocol_readiness_ref: ExactRef
    credential_pool_ref: CredentialPoolRef
    lifecycle: LifecycleState
    credential_type: str = "bearer"
    deployment_tags: tuple[StableKey, ...] = ()
    sunset_at: datetime | None = None
    replacement_ref: ExactRef | None = None


class ModelDeploymentBinding(ArtifactBase):
    identity: ArtifactIdentity
    model_key: StableKey
    upstream_model_id: str
    capability_ref: ExactRef
    deployment_ref: ExactRef
    rollout_ref: ExactRef

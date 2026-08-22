from typing import Literal

from ._base import ArtifactBase, BudgetRange, ConditionNode, EvidenceRef, FactualValue, StableKey, SupportState
from .identities import ArtifactIdentity, ExactRef


class CapabilityEntry(ArtifactBase):
    name: StableKey
    state: SupportState
    family: Literal["thinking", "performance", "tools", "streaming", "structured-output", "document", "image", "audio", "video", "usage"] | None = None
    shape: Literal["unsupported", "binary_toggle", "effort_ladder", "mode_plus_effort", "forced", "fixed", "token_budget", "model_split", "service_profiles"] | None = None
    user_controllable: bool = False
    conditions: tuple[ConditionNode, ...] = ()
    factual_values: tuple[FactualValue, ...] = ()
    default_value: StableKey | None = None
    budget: BudgetRange | None = None
    runtime_mapping_ref: ExactRef | None = None
    selection_refs: tuple[ExactRef, ...] = ()
    deployment_tags: tuple[StableKey, ...] = ()
    fallback_policy: Literal["deny", "explicit-standard"] | None = None
    eligible_rate_card_refs: tuple[ExactRef, ...] = ()
    profile_capability_refs: tuple[ExactRef, ...] = ()
    native_state: SupportState | None = None
    preprocessing_state: SupportState | None = None
    transports: tuple[StableKey, ...] = ()
    mime_types: tuple[str, ...] = ()
    preprocessing_ref: ExactRef | None = None
    retention_ref: ExactRef | None = None
    evidence: tuple[EvidenceRef, ...] = ()


class ModelCapabilitySpec(ArtifactBase):
    identity: ArtifactIdentity
    model_family: StableKey
    capabilities: tuple[CapabilityEntry, ...]
    context_window: int
    max_output_tokens: int
    modality: Literal["text", "image", "audio", "video", "multimodal"]

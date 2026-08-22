from typing import Literal

from ._base import ArtifactBase, StableKey, SupportState
from .identities import ArtifactIdentity, ExactRef


class ProtocolReadinessSpec(ArtifactBase):
    identity: ArtifactIdentity
    protocol_type: Literal["openai-compatible", "anthropic", "gemini", "custom"]
    readiness: SupportState
    evidence_keys: tuple[StableKey, ...]
    protocol_options_schema: StableKey | None = None
    adapter_key: StableKey | None = None
    adapter_version: str | None = None
    contract_evidence_ref: ExactRef | None = None
    allowlist_ref: ExactRef | None = None
    executable: bool = False


class ExtensionTargetAllowlist(ArtifactBase):
    identity: ArtifactIdentity
    protocol_type: Literal["openai-compatible", "anthropic", "gemini", "custom"]
    targets: tuple[str, ...]
    adapter_key: StableKey | None = None
    adapter_version: str | None = None
    mapping_role: Literal["runtime-extension"] = "runtime-extension"
    mapping_schema_ref: ExactRef | None = None

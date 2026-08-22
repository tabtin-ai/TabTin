from typing import Literal

from ._base import ArtifactBase, ConditionNode, StableKey
from .identities import ArtifactIdentity, ExactRef


class MappingOperation(ArtifactBase):
    operation: Literal["set", "remove", "rename", "copy"]
    source: str | None = None
    target: str
    value: str | int | bool | None = None
    when: ConditionNode | None = None
    input_value: StableKey | None = None


class ProductControlMapping(ArtifactBase):
    identity: ArtifactIdentity
    control_key: StableKey
    capability_ref: ExactRef
    operations: tuple[MappingOperation, ...]
    exposed_values: tuple[StableKey, ...] = ()
    aliases: tuple[tuple[StableKey, StableKey], ...] = ()


class RuntimeExtensionPatch(ArtifactBase):
    namespace: Literal["protocol.request.body", "protocol.request.headers", "protocol.request.query"]
    operations: tuple[MappingOperation, ...]


class RuntimeWireMapping(ArtifactBase):
    identity: ArtifactIdentity
    product_mapping_ref: ExactRef
    patches: tuple[RuntimeExtensionPatch, ...]
    capability_ref: ExactRef | None = None
    mapping_role: Literal["runtime-extension"] = "runtime-extension"

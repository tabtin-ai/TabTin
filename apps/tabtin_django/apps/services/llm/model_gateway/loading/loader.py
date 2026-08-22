"""Safe JSON/YAML loading into immutable typed artifacts."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Type

import yaml
from pydantic import BaseModel, ValidationError
from yaml.constructor import ConstructorError

from ..domain.capabilities import ModelCapabilitySpec
from ..domain.commercial import RateCard
from ..domain.deployments import DeploymentProfile, ModelDeploymentBinding
from ..domain.identities import ArtifactIdentity
from ..domain.mappings import ProductControlMapping, RuntimeWireMapping
from ..domain.projection import ProjectionMetadata
from ..domain.protocols import ExtensionTargetAllowlist, ProtocolReadinessSpec
from ..domain.rollout import RolloutPolicy
from ..domain.safety import PlatformSafetyPolicy


class ArtifactLoadError(ValueError):
    pass


@dataclass(frozen=True)
class LoaderLimits:
    max_bytes: int = 1_048_576
    max_depth: int = 32
    max_collection_items: int = 10_000


ARTIFACT_TYPES: dict[str, Type[BaseModel]] = {
    "model-capability": ModelCapabilitySpec,
    "product-control-mapping": ProductControlMapping,
    "runtime-wire-mapping": RuntimeWireMapping,
    "protocol-readiness": ProtocolReadinessSpec,
    "extension-target-allowlist": ExtensionTargetAllowlist,
    "deployment-profile": DeploymentProfile,
    "model-deployment-binding": ModelDeploymentBinding,
    "rate-card": RateCard,
    "platform-safety-policy": PlatformSafetyPolicy,
    "rollout-policy": RolloutPolicy,
    "projection-metadata": ProjectionMetadata,
}


class _StrictLoader(yaml.SafeLoader):
    pass


def _construct_mapping(loader: _StrictLoader, node: yaml.MappingNode, deep: bool = False) -> dict[str, Any]:
    if any(key_node.tag == "tag:yaml.org,2002:merge" for key_node, _ in node.value):
        raise ArtifactLoadError("YAML merge keys are not allowed")
    result: dict[str, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str):
            raise ArtifactLoadError("mapping keys must be strings")
        if key in result:
            raise ArtifactLoadError(f"duplicate mapping key: {key}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


_StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)


def _reject_tags(loader: _StrictLoader, node: yaml.Node) -> Any:
    raise ArtifactLoadError(f"unsupported YAML tag: {node.tag}")


_StrictLoader.add_multi_constructor("!", _reject_tags)


def _check_limits(value: Any, limits: LoaderLimits, depth: int = 0) -> None:
    if depth > limits.max_depth:
        raise ArtifactLoadError("artifact nesting depth exceeds limit")
    if isinstance(value, dict):
        if len(value) > limits.max_collection_items:
            raise ArtifactLoadError("artifact mapping exceeds item limit")
        for item in value.values(): _check_limits(item, limits, depth + 1)
    elif isinstance(value, list):
        if len(value) > limits.max_collection_items:
            raise ArtifactLoadError("artifact array exceeds item limit")
        for item in value: _check_limits(item, limits, depth + 1)
    elif isinstance(value, float):
        raise ArtifactLoadError("binary floating-point values are forbidden")
    elif value is not None and not isinstance(value, (str, int, bool)):
        raise ArtifactLoadError(f"unsupported scalar type: {type(value).__name__}")


def _tupleize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _tupleize(item) for key, item in value.items()}
    if isinstance(value, list):
        return tuple(_tupleize(item) for item in value)
    return value


def _parse(path: Path) -> Any:
    try:
        if path.suffix == ".json":
            return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_pairs)
        return yaml.load(path.read_text(encoding="utf-8"), Loader=_StrictLoader)
    except (OSError, UnicodeError, json.JSONDecodeError, yaml.YAMLError) as exc:
        raise ArtifactLoadError(f"unable to parse artifact file: {path.name}") from exc


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result: raise ArtifactLoadError(f"duplicate mapping key: {key}")
        if not isinstance(key, str): raise ArtifactLoadError("mapping keys must be strings")
        result[key] = value
    return result


def load_artifact_file(path: Path, *, limits: LoaderLimits | None = None) -> BaseModel:
    path = Path(path)
    limits = limits or LoaderLimits()
    if path.suffix not in {".json", ".yaml", ".yml"}:
        raise ArtifactLoadError("unsupported artifact file type")
    if path.is_symlink():
        raise ArtifactLoadError("symlink artifact files are not allowed")
    if path.stat().st_size > limits.max_bytes:
        raise ArtifactLoadError("artifact file exceeds size limit")
    raw = parse_raw_artifact(path, limits=limits)
    if not isinstance(raw, dict): raise ArtifactLoadError("artifact root must be an object")
    try:
        identity = ArtifactIdentity.model_validate(raw.get("identity"))
        model_type = ARTIFACT_TYPES[identity.kind]
        # JSON-mode validation converts wire enum strings while retaining the
        # PR1 strict primitive contract; YAML has already passed safe parsing.
        return model_type.model_validate_json(json.dumps(raw, ensure_ascii=False))
    except (ValidationError, KeyError, TypeError) as exc:
        raise ArtifactLoadError("artifact failed structural validation") from exc


def parse_raw_artifact(path: Path, *, limits: LoaderLimits | None = None) -> Any:
    """Safely parse a supported file without requiring typed construction."""
    path = Path(path); limits = limits or LoaderLimits()
    if path.suffix not in {".json", ".yaml", ".yml"}: raise ArtifactLoadError("unsupported artifact file type")
    if path.is_symlink(): raise ArtifactLoadError("symlink artifact files are not allowed")
    if path.stat().st_size > limits.max_bytes: raise ArtifactLoadError("artifact file exceeds size limit")
    raw = _parse(path); _check_limits(raw, limits)
    return raw

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.services.llm.model_gateway import calculate_canonical_hash
from apps.services.llm.model_gateway.domain.capabilities import ModelCapabilitySpec
from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity
from apps.services.llm.model_gateway.domain._base import SupportState
from apps.services.llm.model_gateway.loading.loader import ArtifactLoadError, LoaderLimits, load_artifact_file
from apps.services.llm.model_gateway.loading.registry import ArtifactRegistry, RegistryError
from apps.services.llm.model_gateway.reference_graph import ReferenceGraph


ZERO = "sha256:" + "0" * 64


def capability(value="fictional"):
    return ModelCapabilitySpec.model_validate({"schema_version":"1", "identity":{"kind":"model-capability","key":"fictional-model","revision":"1","canonical_hash":ZERO}, "model_family":"fictional-model", "capabilities":({"schema_version":"1","name":"tool-calling","state":SupportState.SUPPORTED},), "context_window":100, "max_output_tokens":10, "modality":"text"})


def write_artifact(root: Path, artifact=None):
    artifact = artifact or capability()
    digest = calculate_canonical_hash(artifact)
    artifact = artifact.model_copy(update={"identity": artifact.identity.model_copy(update={"canonical_hash": digest})})
    path = root / artifact.identity.kind / artifact.identity.key / artifact.identity.revision / "artifact.json"
    path.parent.mkdir(parents=True)
    path.write_text(artifact.model_dump_json())
    return artifact, path


def test_loader_rejects_duplicate_merge_tag_float_and_unknown(tmp_path):
    bad = [('{"a": 1, "a": 2}', ".json"), ("a: &x\n  b: 1\nc:\n  <<: *x\n", ".yaml"), ("value: 1.2\n", ".yaml"), ("identity: {kind: model-capability, key: x, revision: '1', canonical_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}\nextra: 1\n", ".yaml")]
    for index, (body, suffix) in enumerate(bad):
        path = tmp_path / f"bad-{index}{suffix}"; path.write_text(body)
        with pytest.raises(ArtifactLoadError): load_artifact_file(path)


def test_registry_exact_lookup_missing_hash_and_no_latest(tmp_path):
    artifact, path = write_artifact(tmp_path)
    registry = ArtifactRegistry(tmp_path)
    assert registry.load_exact("model-capability", "fictional-model", "1", artifact.identity.canonical_hash).identity == artifact.identity
    with pytest.raises(RegistryError) as missing: registry.load_exact("model-capability", "fictional-model", "latest", artifact.identity.canonical_hash)
    assert missing.value.issue.code == "invalid_exact_reference"
    with pytest.raises(RegistryError) as mismatch: registry.load_exact("model-capability", "fictional-model", "1", ZERO)
    assert mismatch.value.issue.code == "hash_mismatch"
    assert path.exists()


def test_only_root_self_hash_is_excluded_nested_expected_hash_changes_digest():
    artifact = capability()
    original = calculate_canonical_hash(artifact)
    changed = artifact.model_copy(update={"identity": artifact.identity.model_copy(update={"canonical_hash": "sha256:" + "f" * 64})})
    assert calculate_canonical_hash(changed) == original
    nested = {"schema_version":"1", "identity":{"kind":"model-capability","key":"fictional-model","revision":"1","canonical_hash":ZERO}, "model_family":"fictional-model", "capabilities":[], "context_window":100, "max_output_tokens":10, "modality":"text", "reference":{"expected_hash":"sha256:" + "b" * 64}}
    assert calculate_canonical_hash(nested) != calculate_canonical_hash({**nested, "reference":{"expected_hash":"sha256:" + "c" * 64}})


def test_reference_graph_cycle_and_reverse_index_are_deterministic(tmp_path):
    artifact, _ = write_artifact(tmp_path)
    graph = ReferenceGraph(ArtifactRegistry(tmp_path)); closure = graph.build([artifact])
    assert [item.identity.key for item in closure] == ["fictional-model"]
    assert graph.issues == ()


def test_path_and_identity_mismatch_is_blocking(tmp_path):
    artifact, path = write_artifact(tmp_path)
    wrong = tmp_path / "model-capability" / "other-model" / "1" / "artifact.json"
    wrong.parent.mkdir(parents=True); wrong.write_bytes(path.read_bytes()); path.unlink()
    assert "path_identity_mismatch" in {issue.code for issue in ArtifactRegistry(tmp_path).issues}


def test_symlink_escape_is_blocking(tmp_path):
    outside = tmp_path.parent / "outside-artifact.json"; outside.write_text("{}")
    link = tmp_path / "model-capability" / "fictional-model" / "1" / "artifact.json"
    link.parent.mkdir(parents=True); link.symlink_to(outside)
    assert {issue.code for issue in ArtifactRegistry(tmp_path).issues} & {"path_escape", "load_error"}


def test_duplicate_and_conflicting_identity_are_distinct(tmp_path):
    artifact, path = write_artifact(tmp_path)
    duplicate = path.with_name("duplicate.json"); duplicate.write_bytes(path.read_bytes())
    assert "duplicate_identity" in {issue.code for issue in ArtifactRegistry(tmp_path).issues}
    duplicate.write_text(artifact.model_copy(update={"context_window": 101}).model_dump_json())
    assert "conflicting_identity" in {issue.code for issue in ArtifactRegistry(tmp_path).issues}


@pytest.mark.parametrize("body,limits",[
    ('{"x":"'+'a'*64+'"}',LoaderLimits(max_bytes=8)),
    ('[[[[[0]]]]]',LoaderLimits(max_depth=2)),
    ('[1,2,3]',LoaderLimits(max_collection_items=2)),
])
def test_loader_resource_limits_are_deterministic(tmp_path, body, limits):
    path=tmp_path/"artifact.json"; path.write_text(body)
    with pytest.raises(ArtifactLoadError): load_artifact_file(path,limits=limits)

from datetime import datetime, timezone
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.services.llm.model_gateway.domain._base import CredentialPoolRef, LifecycleState, SupportState, UTCValidityInterval
from apps.services.llm.model_gateway.domain.capabilities import CapabilityEntry, ModelCapabilitySpec
from apps.services.llm.model_gateway.domain.commercial import RateCard, RateLine
from apps.services.llm.model_gateway.domain.deployments import DeploymentProfile, ModelDeploymentBinding
from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity, ExactRef
from apps.services.llm.model_gateway.domain.mappings import MappingOperation, ProductControlMapping, RuntimeExtensionPatch, RuntimeWireMapping
from apps.services.llm.model_gateway.domain.projection import ProjectionMetadata
from apps.services.llm.model_gateway.domain.protocols import ExtensionTargetAllowlist, ProtocolReadinessSpec
from apps.services.llm.model_gateway.domain.rollout import RolloutPolicy
from apps.services.llm.model_gateway.domain.safety import PlatformSafetyPolicy


HASH = "sha256:" + "a" * 64
def identity(kind): return ArtifactIdentity(kind=kind, key="fictional-artifact", revision="1", canonical_hash=HASH)
def ref(kind): return ExactRef(kind=kind, key="fictional-artifact", revision="1", expected_hash=HASH)


def examples():
    operation = MappingOperation(schema_version="1", operation="set", target="thinking.type", value="enabled")
    return [
        ModelCapabilitySpec(schema_version="1", identity=identity("model-capability"), model_family="fictional-model", capabilities=(CapabilityEntry(schema_version="1", name="tool-calling", state=SupportState.SUPPORTED),), context_window=1000, max_output_tokens=100, modality="text"),
        ProductControlMapping(schema_version="1", identity=identity("product-control-mapping"), control_key="thinking-mode", capability_ref=ref("model-capability"), operations=(operation,)),
        RuntimeWireMapping(schema_version="1", identity=identity("runtime-wire-mapping"), product_mapping_ref=ref("product-control-mapping"), patches=(RuntimeExtensionPatch(schema_version="1", namespace="protocol.request.body", operations=(operation,)),)),
        ProtocolReadinessSpec(schema_version="1", identity=identity("protocol-readiness"), protocol_type="openai-compatible", readiness=SupportState.SUPPORTED, evidence_keys=("fictional-evidence",)),
        ExtensionTargetAllowlist(schema_version="1", identity=identity("extension-target-allowlist"), protocol_type="openai-compatible", targets=("thinking.type",)),
        DeploymentProfile(schema_version="1", identity=identity("deployment-profile"), endpoint_key="fictional-endpoint", protocol_readiness_ref=ref("protocol-readiness"), credential_pool_ref=CredentialPoolRef(pool_key="fictional-pool"), lifecycle=LifecycleState.ACTIVE),
        ModelDeploymentBinding(schema_version="1", identity=identity("model-deployment-binding"), model_key="fictional-model", upstream_model_id="fictional-v1", capability_ref=ref("model-capability"), deployment_ref=ref("deployment-profile"), rollout_ref=ref("rollout-policy")),
        RateCard(schema_version="1", identity=identity("rate-card"), binding_ref=ref("model-deployment-binding"), validity=UTCValidityInterval(valid_from=datetime(2026,1,1,tzinfo=timezone.utc)), rates=(RateLine(schema_version="1", unit="input-token", amount="0.0100", currency="CNY"),)),
        PlatformSafetyPolicy(schema_version="1", identity=identity("platform-safety-policy"), policy_keys=("no-secrets",), blocked_extension_targets=("protocol.request.headers.authorization",)),
        RolloutPolicy(schema_version="1", identity=identity("rollout-policy"), lifecycle=LifecycleState.ACTIVE, conditions=(), percentage_basis_points=10000),
        ProjectionMetadata(schema_version="1", identity=identity("projection-metadata"), source_refs=(ref("model-deployment-binding"),), projected_at=datetime(2026,1,1,tzinfo=timezone.utc), projector_version="fixture-1"),
    ]


def test_valid_fictional_example_for_every_artifact_family():
    assert len(examples()) == 11


def test_unknown_fields_missing_fields_and_wrong_types_rejected():
    with pytest.raises(ValidationError): ArtifactIdentity.model_validate({"kind":"model-capability","key":"x","revision":"1","canonical_hash":HASH,"extra":1})
    with pytest.raises(ValidationError): ArtifactIdentity.model_validate({"kind":"model-capability","key":"x","revision":1,"canonical_hash":HASH})
    with pytest.raises(ValidationError): DeploymentProfile.model_validate({"schema_version":"1"})


def test_deployment_and_binding_fact_separation():
    assert "model_key" not in DeploymentProfile.model_fields
    assert "endpoint_key" not in ModelDeploymentBinding.model_fields
    assert "credential_pool_ref" not in ModelDeploymentBinding.model_fields


def test_decimal_strings_timezone_and_extension_namespace_are_strict():
    with pytest.raises(ValidationError): RateLine(schema_version="1", unit="input-token", amount=0.01, currency="CNY")
    with pytest.raises(ValidationError): UTCValidityInterval(valid_from=datetime(2026,1,1))
    with pytest.raises(ValidationError): RuntimeExtensionPatch(schema_version="1", namespace="request.body", operations=())


def test_versioned_schema_files_cover_all_artifacts_and_forbid_secret_properties():
    schema_dir = Path(__file__).parents[3] / "model_gateway" / "schemas" / "v1"
    schemas = sorted(schema_dir.glob("*.schema.json"))
    assert len(schemas) == 11
    forbidden = {"api_key", "authorization", "access_token", "secret", "ak", "sk", "credential_payload"}
    for path in schemas:
        schema = json.loads(path.read_text())
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert schema["additionalProperties"] is False
        property_names = set()
        def collect(value):
            if isinstance(value, dict):
                property_names.update(value.get("properties", {}))
                for child in value.values(): collect(child)
            elif isinstance(value, list):
                for child in value: collect(child)
        collect(schema)
        assert property_names.isdisjoint(forbidden)

import json
import subprocess
import sys
from uuid import UUID

import pytest
from pydantic import ValidationError

from apps.services.llm.model_gateway.domain._base import CredentialPoolRef, LifecycleState
from apps.services.llm.model_gateway.domain.deployments import DeploymentProfile, ModelDeploymentBinding
from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity, ExactRef
from apps.services.llm.model_gateway.projection.identities import (
    ManagedDatabaseTargetIdentity,
    ReviewedBindingMapping,
    discover_bindings,
    managed_database_target_identity,
)
from apps.services.llm.model_gateway.projection.snapshot import DatabaseSnapshot, ModelSnapshot, ProviderSnapshot

H = "sha256:" + "a" * 64
P = UUID("11111111-1111-4111-8111-111111111111")
M = UUID("22222222-2222-4222-8222-222222222222")


def ident(kind, key, revision="1"):
    return ArtifactIdentity(kind=kind, key=key, revision=revision, canonical_hash=H)


def ref(kind, key):
    return ExactRef(kind=kind, key=key, revision="1", expected_hash=H)


def artifacts(revision="1", upstream="fictional-v1", url="https://api.example.test"):
    deployment = DeploymentProfile(
        schema_version="1",
        identity=ident("deployment-profile", "fictional-deployment"),
        endpoint_key="fictional-provider",
        endpoint_url=url,
        protocol_readiness_ref=ref("protocol-readiness", "fictional-ready"),
        credential_pool_ref=CredentialPoolRef(pool_key="fictional-pool"),
        lifecycle=LifecycleState.ACTIVE,
    )
    binding = ModelDeploymentBinding(
        schema_version="1",
        identity=ident("model-deployment-binding", "fictional-binding", revision),
        model_key="fictional-model",
        upstream_model_id=upstream,
        capability_ref=ref("model-capability", "fictional-capability"),
        deployment_ref=ref("deployment-profile", "fictional-deployment"),
        rollout_ref=ref("rollout-policy", "fictional-rollout"),
    )
    return deployment, binding


def snapshot(duplicate_provider=False, duplicate_model=False):
    provider = ProviderSnapshot(id=P, name="fictional", provider_key="fictional-provider", display_name="Old", default_base_url="https://old.test", capability_domains=("chat",), scope="global", organization_id=None, user_id=None, routing_enabled=True, priority=1, routing_weight=100, runtime_status="healthy", runtime_cooldown_until=None, health_consecutive_failures=0)
    model = ModelSnapshot(id=M, provider_id=P, model_name="fictional-v1", display_name="Old", base_url="https://old.test", capability_domain="chat", context_window_tokens=100, max_input_tokens=None, max_output_tokens=10, billing_type="token", input_price_per_1k="0.01", output_price_per_1k="0.02", price_per_request="0", price_per_second="0", custom_billing_config=(), capabilities_config=(), wave_status="stable")
    providers = (provider, provider.model_copy(update={"id": UUID("33333333-3333-4333-8333-333333333333")})) if duplicate_provider else (provider,)
    models = (model, model.model_copy(update={"id": UUID("44444444-4444-4444-8444-444444444444")})) if duplicate_model else (model,)
    return DatabaseSnapshot(providers=providers, models=models)


def test_explicit_reviewed_provider_and_model_targets():
    deployment, binding = artifacts()
    mapping = ReviewedBindingMapping(database_alias="tenant-a", provider_uuid=P, model_uuid=M)
    result = discover_bindings(deployment, binding, snapshot(), database_alias="tenant-a", reviewed_mapping=mapping)
    assert result.provider.outcome == "exact_reviewed_binding"
    assert result.model.outcome == "exact_reviewed_binding"


def test_unique_bootstrap_candidate_is_not_reviewed():
    deployment, binding = artifacts()
    result = discover_bindings(deployment, binding, snapshot())
    assert result.provider.outcome == "unique_bootstrap_candidate"
    assert result.model.outcome == "unique_bootstrap_candidate"


def test_ambiguous_bootstrap_candidate_is_blocking():
    deployment, binding = artifacts()
    result = discover_bindings(deployment, binding, snapshot(duplicate_provider=True))
    assert result.provider.outcome == "ambiguous_bootstrap_candidate"
    assert result.provider.blocking is True


def test_no_existing_candidate_does_not_allocate_uuid():
    deployment, binding = artifacts()
    result = discover_bindings(deployment, binding, DatabaseSnapshot(providers=(), models=()))
    assert result.provider.outcome == "no_existing_candidate"
    assert result.provider.existing_database_uuid is None


def test_reviewed_uuid_conflict_is_blocking():
    deployment, binding = artifacts()
    mapping = ReviewedBindingMapping(database_alias="default", provider_uuid=P, model_uuid=UUID("99999999-9999-4999-8999-999999999999"))
    result = discover_bindings(deployment, binding, snapshot(), reviewed_mapping=mapping)
    assert result.model.outcome == "conflict"
    assert result.model.blocking is True


@pytest.mark.parametrize(
    ("revision", "upstream", "url"),
    (("2", "fictional-v1", "https://api.example.test"), ("1", "renamed-v2", "https://api.example.test"), ("1", "fictional-v1", "https://new.test")),
    ids=("binding-revision", "upstream-model-id", "base-url"),
)
def test_reviewed_uuid_survives_artifact_fact_changes(revision, upstream, url):
    deployment, binding = artifacts(revision=revision, upstream=upstream, url=url)
    mapping = ReviewedBindingMapping(database_alias="default", provider_uuid=P, model_uuid=M)
    result = discover_bindings(deployment, binding, snapshot(), reviewed_mapping=mapping)
    assert result.provider.existing_database_uuid == P
    assert result.model.existing_database_uuid == M


def test_database_alias_separates_managed_identity():
    default = ManagedDatabaseTargetIdentity(database_alias="default", target_type="llm-provider", existing_database_uuid=P)
    replica = default.model_copy(update={"database_alias": "replica"})
    assert default != replica


def test_provider_and_model_target_types_cannot_collide():
    provider = ManagedDatabaseTargetIdentity(database_alias="default", target_type="llm-provider", existing_database_uuid=P)
    model = ManagedDatabaseTargetIdentity(database_alias="default", target_type="llm-model", existing_database_uuid=P)
    assert provider != model


def test_existing_uuid_and_create_candidate_are_mutually_exclusive():
    with pytest.raises(ValidationError):
        ManagedDatabaseTargetIdentity(database_alias="default", target_type="llm-model", existing_database_uuid=M, create_candidate_key="candidate")


def test_create_candidate_identity_is_deterministic_and_type_scoped():
    deployment, binding = artifacts()
    discovery = discover_bindings(deployment, binding, DatabaseSnapshot(providers=(), models=()))
    provider = managed_database_target_identity(package_key="pkg", deployment_key=deployment.identity.key, binding_key=binding.identity.key, candidate=discovery.provider)
    model = managed_database_target_identity(package_key="pkg", deployment_key=deployment.identity.key, binding_key=binding.identity.key, candidate=discovery.model)
    assert provider.create_candidate_key != model.create_candidate_key
    assert provider.existing_database_uuid is None


def test_binding_identity_is_not_managed_target_identity():
    deployment, binding = artifacts()
    discovery = discover_bindings(deployment, binding, snapshot())
    target = managed_database_target_identity(package_key="pkg", deployment_key=deployment.identity.key, binding_key=binding.identity.key, candidate=discovery.model)
    assert target.model_dump(mode="json") != binding.identity.model_dump(mode="json")


def test_create_candidate_identity_is_stable_in_fresh_process():
    code = """
import json
from apps.services.llm.model_gateway.projection.identities import BindingCandidate, managed_database_target_identity
c=BindingCandidate(outcome='no_existing_candidate',database_alias='default',target_type='llm-model',blocking=False)
print(json.dumps(managed_database_target_identity(package_key='pkg',deployment_key='dep',binding_key='binding',candidate=c).model_dump(mode='json'),sort_keys=True))
"""
    first = subprocess.check_output([sys.executable, "-c", code], text=True).strip()
    second = subprocess.check_output([sys.executable, "-c", code], text=True).strip()
    assert json.loads(first) == json.loads(second)

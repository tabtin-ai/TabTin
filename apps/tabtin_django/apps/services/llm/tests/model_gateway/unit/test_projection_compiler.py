from datetime import datetime, timezone
from uuid import UUID

from apps.services.llm.model_gateway.domain._base import CredentialPoolRef, LifecycleState
from apps.services.llm.model_gateway.domain.capabilities import ModelCapabilitySpec
from apps.services.llm.model_gateway.domain.deployments import DeploymentProfile, ModelDeploymentBinding
from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity, ExactRef
from apps.services.llm.model_gateway.projection.compiler import ProjectionPackage, compile_projection
from apps.services.llm.model_gateway.projection.diff import render_projection_diff
from apps.services.llm.model_gateway.projection.identities import ReviewedBindingMapping, discover_bindings
from apps.services.llm.model_gateway.projection.snapshot import DatabaseSnapshot, ModelSnapshot, ProviderSnapshot

H="sha256:"+"a"*64; P=UUID("11111111-1111-4111-8111-111111111111"); M=UUID("22222222-2222-4222-8222-222222222222")
def ident(kind,key,revision="1"): return ArtifactIdentity(kind=kind,key=key,revision=revision,canonical_hash=H)
def ref(kind,key): return ExactRef(kind=kind,key=key,revision="1",expected_hash=H)
def artifacts(revision="1",upstream="fictional-v1",url="https://api.example.test"):
    d=DeploymentProfile(schema_version="1",identity=ident("deployment-profile","fictional-deployment"),endpoint_key="fictional-provider",endpoint_url=url,protocol_readiness_ref=ref("protocol-readiness","fictional-ready"),credential_pool_ref=CredentialPoolRef(pool_key="fictional-pool"),lifecycle=LifecycleState.ACTIVE)
    b=ModelDeploymentBinding(schema_version="1",identity=ident("model-deployment-binding","fictional-binding",revision),model_key="fictional-model",upstream_model_id=upstream,capability_ref=ref("model-capability","fictional-capability"),deployment_ref=ref("deployment-profile","fictional-deployment"),rollout_ref=ref("rollout-policy","fictional-rollout")); return d,b
def snapshot():
    p=ProviderSnapshot(id=P,name="fictional",provider_key="fictional-provider",display_name="Old",default_base_url="https://old.test",capability_domains=("chat",),scope="global",organization_id=None,user_id=None,routing_enabled=True,priority=1,routing_weight=100,runtime_status="healthy",runtime_cooldown_until=None,health_consecutive_failures=0)
    m=ModelSnapshot(id=M,provider_id=P,model_name="fictional-v1",display_name="Old",base_url="https://old.test",capability_domain="chat",context_window_tokens=100,max_input_tokens=None,max_output_tokens=10,billing_type="token",input_price_per_1k="0.01",output_price_per_1k="0.02",price_per_request="0",price_per_second="0",custom_billing_config=(),capabilities_config=(),wave_status="stable"); return DatabaseSnapshot(providers=(p,),models=(m,))


def capability(): return ModelCapabilitySpec(schema_version="1",identity=ident("model-capability","fictional-capability"),model_family="fictional-model",capabilities=(),context_window=200,max_output_tokens=20,modality="text")


def plan(db=None,revision="1",database_alias="default",reviewed_mapping=None,deployment=None,binding=None):
    default_deployment,default_binding=artifacts(revision=revision); deployment=deployment or default_deployment; binding=binding or default_binding; db=db or snapshot(); discovery=discover_bindings(deployment,binding,db,database_alias=database_alias,reviewed_mapping=reviewed_mapping); package=ProjectionPackage(package_key="fictional-package",deployment=deployment,binding=binding,closure=(deployment,binding,capability()))
    return compile_projection(package,db,discovery,clock=datetime(2026,1,1,tzinfo=timezone.utc))


def test_projection_is_deterministic_idempotent_and_has_sources():
    first=plan(); second=plan(); assert first==second
    assert all(field.source_ref for field in first.fields) and first.projection_hash.startswith("sha256:")


def test_managed_change_changes_hash_but_operational_change_does_not():
    original=snapshot(); changed_operational=original.model_copy(update={"providers":(original.providers[0].model_copy(update={"runtime_status":"degraded","health_consecutive_failures":9}),)})
    assert plan(original).projection_hash==plan(changed_operational).projection_hash
    assert plan().projection_hash!=plan(revision="2").projection_hash


def test_field_classification_and_precedence_are_explicit():
    result=plan(); classes={field.classification for field in result.fields}
    assert {"generated_factual","preserved_operational","secret"}<=classes
    assert result.precedence==("emergency-restrict-only","runtime-health-cooldown","published-generated-projection")


def test_environment_existing_uuid_changes_projection_hash():
    alternate_model = UUID("55555555-5555-4555-8555-555555555555")
    current = snapshot()
    alternate = current.model_copy(update={"models": (current.models[0].model_copy(update={"id": alternate_model}),)})
    first_mapping = ReviewedBindingMapping(database_alias="default", provider_uuid=P, model_uuid=M)
    second_mapping = ReviewedBindingMapping(database_alias="default", provider_uuid=P, model_uuid=alternate_model)
    assert plan(current, reviewed_mapping=first_mapping).projection_hash != plan(alternate, reviewed_mapping=second_mapping).projection_hash


def test_database_alias_changes_projection_hash():
    assert plan(database_alias="default").projection_hash != plan(database_alias="tenant-a").projection_hash


def test_managed_factual_proposal_changes_projection_hash():
    deployment, binding = artifacts()
    changed = deployment.model_copy(update={"endpoint_url": "https://changed.example.test"})
    assert plan(deployment=deployment, binding=binding).projection_hash != plan(deployment=changed, binding=binding).projection_hash


def test_reviewed_identity_survives_display_base_url_and_upstream_changes():
    mapping = ReviewedBindingMapping(database_alias="default", provider_uuid=P, model_uuid=M)
    original = plan(reviewed_mapping=mapping)
    deployment, binding = artifacts(upstream="renamed-v2", url="https://new.example.test")
    changed = plan(reviewed_mapping=mapping, deployment=deployment, binding=binding)
    assert original.provider_managed_target_identity == changed.provider_managed_target_identity
    assert original.model_managed_target_identity == changed.model_managed_target_identity


def test_snapshot_query_order_does_not_change_projection_hash():
    current = snapshot()
    extra = current.providers[0].model_copy(update={"id": UUID("66666666-6666-4666-8666-666666666666"), "provider_key": "unrelated"})
    first = current.model_copy(update={"providers": (extra, current.providers[0])})
    second = current.model_copy(update={"providers": tuple(reversed(first.providers))})
    assert plan(first).projection_hash == plan(second).projection_hash


def test_renderer_formatting_does_not_change_projection_hash():
    result = plan()
    before = result.projection_hash
    render_projection_diff(result, format="text")
    render_projection_diff(result, format="json")
    assert result.projection_hash == before


def test_validation_blocking_and_warning_propagate():
    deployment, binding = artifacts()
    current = snapshot()
    discovery = discover_bindings(deployment, binding, current)
    package = ProjectionPackage(package_key="fictional-package", deployment=deployment, binding=binding, closure=(deployment,binding,capability()), blocking_issues=("blocked",), warnings=("warned",))
    result = compile_projection(package, current, discovery, clock=datetime(2026,1,1,tzinfo=timezone.utc))
    assert result.blocking_issues == ("blocked",)
    assert result.warnings == ("warned",)


def test_explicit_unknown_max_output_sentinel_is_unmanaged_and_preserves_database_value():
    deployment, binding = artifacts()
    current = snapshot()
    unknown_capability = capability().model_copy(update={"max_output_tokens": 0})
    discovery = discover_bindings(deployment, binding, current)
    package = ProjectionPackage(
        package_key="fictional-package",
        deployment=deployment,
        binding=binding,
        closure=(deployment, binding, unknown_capability),
        blocking_issues=("max-output-unknown",),
    )

    result = compile_projection(package, current, discovery, clock=datetime(2026, 1, 1, tzinfo=timezone.utc))
    output = next(field for field in result.fields if field.path == "max_output_tokens")

    assert output.classification == "unmanaged"
    assert output.proposed == "unknown"
    assert output.current == "10"
    assert "max-output-unknown" in result.blocking_issues


def test_numeric_zero_without_approved_unknown_state_remains_a_regular_proposal():
    deployment, binding = artifacts()
    current = snapshot()
    zero_capability = capability().model_copy(update={"max_output_tokens": 0})
    discovery = discover_bindings(deployment, binding, current)
    package = ProjectionPackage(
        package_key="fictional-package",
        deployment=deployment,
        binding=binding,
        closure=(deployment, binding, zero_capability),
    )

    result = compile_projection(package, current, discovery, clock=datetime(2026, 1, 1, tzinfo=timezone.utc))
    output = next(field for field in result.fields if field.path == "max_output_tokens")

    assert output.classification == "generated_factual"
    assert output.proposed == "0"


def test_explicit_missing_rate_card_projects_no_commercial_fields_or_prices():
    deployment, binding = artifacts()
    current = snapshot()
    discovery = discover_bindings(deployment, binding, current)
    package = ProjectionPackage(
        package_key="fictional-package",
        deployment=deployment,
        binding=binding,
        closure=(deployment, binding, capability()),
        blocking_issues=("rate-card-unknown",),
    )

    result = compile_projection(package, current, discovery, clock=datetime(2026, 1, 1, tzinfo=timezone.utc))

    assert not [field for field in result.fields if field.classification == "commercial"]
    pricing = next(field for field in result.fields if field.path == "pricing")
    assert pricing.classification == "unmanaged"
    assert pricing.proposed == "unknown"
    assert "rate-card-unknown" in result.blocking_issues

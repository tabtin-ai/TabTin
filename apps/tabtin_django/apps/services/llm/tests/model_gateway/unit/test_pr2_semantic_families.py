from datetime import datetime, timedelta, timezone

import pytest

from apps.services.llm.model_gateway.domain._base import BudgetRange, ConditionNode, EvidenceRef, FactualValue, SupportState
from apps.services.llm.model_gateway.domain.capabilities import CapabilityEntry, ModelCapabilitySpec
from apps.services.llm.model_gateway.domain.commercial import RateCard, RateLine
from apps.services.llm.model_gateway.domain.deployments import DeploymentProfile
from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity, ExactRef
from apps.services.llm.model_gateway.domain.protocols import ProtocolReadinessSpec
from apps.services.llm.model_gateway.domain.safety import PlatformSafetyPolicy
from apps.services.llm.model_gateway.domain._base import CredentialPoolRef, LifecycleState, UTCValidityInterval
from apps.services.llm.model_gateway.validation import validate_artifacts

H="sha256:"+"a"*64
def ident(kind,key="fictional-artifact"): return ArtifactIdentity(kind=kind,key=key,revision="1",canonical_hash=H)
def ref(kind): return ExactRef(kind=kind,key="fictional-artifact",revision="1",expected_hash=H)
def codes(artifact): return {x.rule_code for x in validate_artifacts([artifact])}
def cap(entry): return ModelCapabilitySpec(schema_version="1",identity=ident("model-capability"),model_family="fictional-model",capabilities=(entry,),context_window=100,max_output_tokens=10,modality="text")
def evidence(): return (EvidenceRef(source="fictional-spec",locator="section-1"),)


@pytest.mark.parametrize("family",["tools","streaming","structured-output","document","image","audio","video","usage"])
def test_forced_rejected_for_non_forced_capability_families(family):
    entry=CapabilityEntry(schema_version="1",name=family,state=SupportState.FORCED,family=family)
    assert "forced_state_illegal" in codes(cap(entry))


def test_conditional_requires_restricted_non_empty_intrinsic_conditions():
    entry=CapabilityEntry(schema_version="1",name="thinking",state=SupportState.CONDITIONAL,family="thinking",conditions=(ConditionNode(operator="equals",field="credential.id",value="fixture"),))
    result=codes(cap(entry)); assert "condition_axis_forbidden" in result and "condition_concrete_identity" in result


@pytest.mark.parametrize("shape",["unsupported","binary_toggle","effort_ladder","mode_plus_effort","forced","fixed","token_budget","model_split"])
def test_all_thinking_shapes_are_validated_independently(shape):
    values=(FactualValue(key="off",order=0,evidence=evidence()),FactualValue(key="on",order=1,evidence=evidence()))
    entry=CapabilityEntry(schema_version="1",name="thinking",state=SupportState.SUPPORTED,family="thinking",shape=shape,factual_values=values,default_value="off",budget=BudgetRange(minimum=0,default=10,maximum=20,step=5) if shape=="token_budget" else None,selection_refs=(ref("model-deployment-binding"),) if shape=="model_split" else (),runtime_mapping_ref=ref("runtime-wire-mapping"))
    result=codes(cap(entry))
    if shape=="unsupported": assert "thinking_shape_state_mismatch" in result
    else: assert "thinking_shape_state_mismatch" not in result


def test_performance_requires_service_profiles_abstract_tags_and_explicit_fallback():
    entry=CapabilityEntry(schema_version="1",name="performance",state=SupportState.SUPPORTED,family="performance",shape="fixed",deployment_tags=("endpoint-fast",))
    result=codes(cap(entry)); assert {"performance_shape_invalid","performance_concrete_tag","performance_fallback_missing"} <= result


@pytest.mark.parametrize("credential_type",["ak-sk","oauth","service-account","multi-field"])
def test_credential_declarations_fail_closed(credential_type):
    artifact=DeploymentProfile(schema_version="1",identity=ident("deployment-profile"),endpoint_key="fictional-endpoint",protocol_readiness_ref=ref("protocol-readiness"),credential_pool_ref=CredentialPoolRef(pool_key="fictional-pool"),lifecycle=LifecycleState.ACTIVE,credential_type=credential_type)
    assert "credential_type_fail_closed" in codes(artifact)


def test_protocol_custom_is_non_executable_and_readiness_bindings_are_required():
    artifact=ProtocolReadinessSpec(schema_version="1",identity=ident("protocol-readiness"),protocol_type="custom",readiness=SupportState.SUPPORTED,evidence_keys=(),executable=True)
    assert "custom_protocol_fail_closed" in codes(artifact)


def test_rate_card_overlap_blocks_but_adjacency_is_allowed():
    start=datetime(2026,1,1,tzinfo=timezone.utc); middle=start+timedelta(days=1); end=middle+timedelta(days=1)
    def card(key,a,b): return RateCard(schema_version="1",identity=ident("rate-card",key),binding_ref=ref("model-deployment-binding"),validity=UTCValidityInterval(valid_from=a,valid_until=b),rates=(RateLine(schema_version="1",unit="input-token",amount="0.01",currency="CNY"),))
    assert "rate_card_overlap" not in {x.rule_code for x in validate_artifacts([card("rate-one",start,middle),card("rate-two",middle,end)])}
    assert "rate_card_overlap" in {x.rule_code for x in validate_artifacts([card("rate-one",start,end),card("rate-two",middle,end)])}


def test_verified_safety_ceiling_required_and_guessed_4096_rejected():
    artifact=PlatformSafetyPolicy(schema_version="1",identity=ident("platform-safety-policy"),policy_keys=(),blocked_extension_targets=(),provider_maximum=4096)
    assert {"verified_safety_ceiling_missing","guessed_limit_forbidden"} <= codes(artifact)


def test_media_native_and_preprocessing_support_are_separate():
    entry=CapabilityEntry(schema_version="1",name="document",state=SupportState.SUPPORTED,family="document",native_state=SupportState.UNKNOWN,preprocessing_state=SupportState.SUPPORTED,transports=("file",),mime_types=("application/pdf",))
    assert "media_preprocessing_ref" in codes(cap(entry))

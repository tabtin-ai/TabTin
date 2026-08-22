"""Pure projection-plan compiler. Contains no ORM or filesystem access."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from ..canonical import calculate_canonical_hash
from ..domain._base import StrictFrozenModel
from ..domain.capabilities import ModelCapabilitySpec
from ..domain.commercial import RateCard
from ..domain.deployments import DeploymentProfile, ModelDeploymentBinding
from ..domain.identities import ArtifactIdentity
from .identities import (
    BindingDiscovery,
    ManagedDatabaseTargetIdentity,
    managed_database_target_identity,
)
from .snapshot import DatabaseSnapshot


class ProjectionPackage(StrictFrozenModel):
    package_key: str
    deployment: DeploymentProfile
    binding: ModelDeploymentBinding
    closure: tuple[Any,...]
    blocking_issues: tuple[str,...] = ()
    warnings: tuple[str,...] = ()


class ProjectedField(StrictFrozenModel):
    target: Literal["provider","model"]
    path: str
    proposed: str
    current: str | None
    source_ref: str
    classification: Literal["generated_factual","commercial","preserved_operational","secret","unmanaged","unchanged"]


class DriftFinding(StrictFrozenModel):
    severity: Literal["blocking","warning","informational"]
    code: str
    path: str
    message: str


class ProjectionPlan(StrictFrozenModel):
    package_key: str
    deployment_identity: ArtifactIdentity
    binding_identity: ArtifactIdentity
    closure_identities: tuple[ArtifactIdentity,...]
    provider_managed_target_identity: ManagedDatabaseTargetIdentity | None
    model_managed_target_identity: ManagedDatabaseTargetIdentity | None
    fields: tuple[ProjectedField,...]
    drift: tuple[DriftFinding,...]
    blocking_issues: tuple[str,...]
    warnings: tuple[str,...]
    precedence: tuple[str,...]
    projection_hash: str


def _ref(identity: ArtifactIdentity) -> str: return f"{identity.kind}:{identity.key}:{identity.revision}:{identity.canonical_hash}"


def compile_projection(package: ProjectionPackage, current_database_snapshot: DatabaseSnapshot, binding_discovery: BindingDiscovery, *, clock: datetime) -> ProjectionPlan:
    deployment=package.deployment; binding=package.binding
    provider=next((x for x in current_database_snapshot.providers if x.id==binding_discovery.provider.existing_database_uuid),None)
    model=next((x for x in current_database_snapshot.models if x.id==binding_discovery.model.existing_database_uuid),None)
    capability=next((x for x in package.closure if isinstance(x,ModelCapabilitySpec) and x.identity.key==binding.capability_ref.key and x.identity.revision==binding.capability_ref.revision),None)
    rate_cards=[x for x in package.closure if isinstance(x,RateCard) and x.binding_ref.key==binding.identity.key and x.validity.valid_from<=clock and (x.validity.valid_until is None or clock<x.validity.valid_until)]
    proposed=[("provider","provider_key",deployment.endpoint_key,provider.provider_key if provider else None,_ref(deployment.identity)),("provider","default_base_url",deployment.endpoint_url or "",provider.default_base_url if provider else None,_ref(deployment.identity)),("model","model_name",binding.upstream_model_id,model.model_name if model else None,_ref(binding.identity)),("model","base_url",deployment.endpoint_url or "",model.base_url if model else None,_ref(deployment.identity))]
    unknown_max_output = bool(
        capability
        and capability.max_output_tokens == 0
        and "max-output-unknown" in package.blocking_issues
    )
    if capability:
        proposed.append(("model","context_window_tokens",str(capability.context_window),str(model.context_window_tokens) if model else None,_ref(capability.identity)))
        if not unknown_max_output:
            proposed.append(("model","max_output_tokens",str(capability.max_output_tokens),str(model.max_output_tokens) if model and model.max_output_tokens is not None else None,_ref(capability.identity)))
    fields=[]; drift=[]
    for target,path,value,current,source in proposed:
        value=str(value); classification="unchanged" if current==value else "generated_factual"
        fields.append(ProjectedField(target=target,path=path,proposed=value,current=current,source_ref=source,classification=classification))
        if current is not None and current!=value: drift.append(DriftFinding(severity="warning",code="managed_factual_drift",path=f"{target}.{path}",message="managed factual field differs from artifact proposal"))
    for card in sorted(rate_cards,key=lambda x:(x.identity.key,x.identity.revision)):
        for rate in card.rates: fields.append(ProjectedField(target="model",path=f"pricing.{rate.unit}",proposed=f"{rate.amount} {rate.currency}",current=None,source_ref=_ref(card.identity),classification="commercial"))
    if unknown_max_output:
        fields.append(ProjectedField(target="model",path="max_output_tokens",proposed="unknown",current=str(model.max_output_tokens) if model and model.max_output_tokens is not None else None,source_ref=_ref(capability.identity),classification="unmanaged"))
    if "rate-card-unknown" in package.blocking_issues and not rate_cards:
        fields.append(ProjectedField(target="model",path="pricing",proposed="unknown",current=None,source_ref="missing-reviewed-rate-card",classification="unmanaged"))
    if len(rate_cards)>1: drift.append(DriftFinding(severity="blocking",code="rate_card_validity_conflict",path="commercial",message="multiple active RateCards apply"))
    if provider:
        for path,value in (("runtime_status",provider.runtime_status),("runtime_cooldown_until",provider.runtime_cooldown_until or ""),("health_consecutive_failures",str(provider.health_consecutive_failures))): fields.append(ProjectedField(target="provider",path=path,proposed="preserve",current=value,source_ref="database-observation",classification="preserved_operational"))
    for path in ("encrypted_api_key","api_key","authorization"): fields.append(ProjectedField(target="provider",path=path,proposed="not-read",current=None,source_ref="redaction-policy",classification="secret"))
    blocking=list(package.blocking_issues)
    if binding_discovery.provider.blocking or binding_discovery.model.blocking: blocking.append("binding_discovery_blocking")
    if binding_discovery.provider.outcome=="no_existing_candidate": drift.append(DriftFinding(severity="informational",code="provider_create_candidate",path="provider",message="no existing provider candidate"))
    if binding_discovery.model.outcome=="no_existing_candidate": drift.append(DriftFinding(severity="informational",code="model_create_candidate",path="model",message="no existing model candidate"))
    provider_target = managed_database_target_identity(
        package_key=package.package_key,
        deployment_key=deployment.identity.key,
        binding_key=binding.identity.key,
        candidate=binding_discovery.provider,
    )
    model_target = managed_database_target_identity(
        package_key=package.package_key,
        deployment_key=deployment.identity.key,
        binding_key=binding.identity.key,
        candidate=binding_discovery.model,
    )
    closure_ids=tuple(sorted((x.identity for x in package.closure if hasattr(x,"identity")),key=lambda x:(x.kind,x.key,x.revision)))
    payload={"package_key":package.package_key,"deployment_identity":deployment.identity.model_dump(mode="json"),"binding_identity":binding.identity.model_dump(mode="json"),"closure_identities":[x.model_dump(mode="json") for x in closure_ids],"provider_managed_target_identity":provider_target.model_dump(mode="json") if provider_target else None,"model_managed_target_identity":model_target.model_dump(mode="json") if model_target else None,"binding_discovery":{"provider":binding_discovery.provider.model_dump(mode="json"),"model":binding_discovery.model.model_dump(mode="json")},"fields":[x.model_dump(mode="json") for x in fields if x.classification not in {"preserved_operational","secret"}],"drift":[x.model_dump(mode="json") for x in drift],"blocking_issues":sorted(set(blocking)),"warnings":sorted(set(package.warnings))}
    projection_hash=calculate_canonical_hash(payload)
    return ProjectionPlan(package_key=package.package_key,deployment_identity=deployment.identity,binding_identity=binding.identity,closure_identities=closure_ids,provider_managed_target_identity=provider_target,model_managed_target_identity=model_target,fields=tuple(sorted(fields,key=lambda x:(x.classification,x.target,x.path))),drift=tuple(sorted(drift,key=lambda x:(x.severity,x.code,x.path))),blocking_issues=tuple(sorted(set(blocking))),warnings=tuple(sorted(set(package.warnings))),precedence=("emergency-restrict-only","runtime-health-cooldown","published-generated-projection"),projection_hash=projection_hash)

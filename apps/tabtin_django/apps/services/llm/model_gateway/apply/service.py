from __future__ import annotations

from django.db import transaction

from apps.services.llm.models import ModelGatewayProjectionBinding, ModelGatewayProjectionEvent, ModelGatewayProjectionRevision
from .drift import require_expected_runtime_state
from .field_policy import build_field_patch, merge_generated_json
from .gates import require_write_gate
from .locking import lock_operation_rows
from .repository import create_event
from .results import ProjectionOperationRejected, ProjectionOperationResult


def _require_apply_contract(revision, evaluation_time) -> None:
    metadata = revision.projection_metadata or {}
    contract = metadata.get("apply_contract", {})
    if revision.behavior_blockers:
        raise ProjectionOperationRejected("behavior-blocked")
    if revision.readiness_blockers:
        raise ProjectionOperationRejected("readiness-blocked")
    required = ("approved", "published", "publishable", "protocol_executable", "security_valid")
    if not all(contract.get(key) is True for key in required):
        raise ProjectionOperationRejected("apply-contract-not-publishable")
    if contract.get("runtime_enabled") is not False or contract.get("traffic_weight") != 0:
        raise ProjectionOperationRejected("non-traffic-contract-required")
    valid_from = contract.get("rate_card_valid_from")
    valid_until = contract.get("rate_card_valid_until")
    if revision.commercial_fields and not valid_from:
        raise ProjectionOperationRejected("rate-card-missing")
    iso = evaluation_time.isoformat().replace("+00:00", "Z")
    if valid_from and iso < valid_from:
        raise ProjectionOperationRejected("rate-card-not-effective")
    if valid_until and iso >= valid_until:
        raise ProjectionOperationRejected("rate-card-expired")


def _apply_patch(*, provider, model, provider_patch: dict, model_patch: dict, using: str, failure_injector=None):
    for field, value in provider_patch.items():
        setattr(provider, field, value)
    if provider_patch:
        provider.full_clean(exclude=("encrypted_api_key",))
        provider.save(using=using, update_fields=sorted(provider_patch))
    if failure_injector:
        failure_injector("after-provider-patch")
    nested = model_patch.pop("capabilities_config", None)
    if nested is not None:
        model_patch["capabilities_config"] = merge_generated_json(model.capabilities_config or {}, nested)
    for field, value in model_patch.items():
        setattr(model, field, value)
    if model_patch:
        model.full_clean()
        model.save(using=using, update_fields=sorted(model_patch))
    if failure_injector:
        failure_injector("after-model-patch")


def apply_projection_revision(*, database_alias: str, binding_identity: tuple[str, str, str],
                              revision_number: int, expected_projection_hash: str,
                              expected_current_revision: int | None, actor: str, ticket: str,
                              evaluation_time, confirmation_hash: str,
                              failure_injector=None) -> ProjectionOperationResult:
    require_write_gate(database_alias=database_alias, actor=actor, ticket=ticket)
    if confirmation_hash != expected_projection_hash:
        raise ProjectionOperationRejected("confirmation-hash-mismatch")
    lookup = dict(zip(("package_key", "deployment_key", "binding_key"), binding_identity, strict=True))
    try:
        unlocked_binding = ModelGatewayProjectionBinding.objects.using(database_alias).get(
            database_alias=database_alias, **lookup,
        )
        target = ModelGatewayProjectionRevision.objects.using(database_alias).get(
            binding=unlocked_binding, projection_revision=revision_number,
            projection_hash=expected_projection_hash,
        )
    except (ModelGatewayProjectionBinding.DoesNotExist, ModelGatewayProjectionRevision.DoesNotExist) as exc:
        raise ProjectionOperationRejected("exact-revision-not-found") from exc
    if unlocked_binding.provider_create_candidate_key:
        raise ProjectionOperationRejected("provider-create-not-supported")
    if unlocked_binding.model_create_candidate_key:
        raise ProjectionOperationRejected("model-create-not-supported")
    _require_apply_contract(target, evaluation_time)
    revision_ids = tuple(filter(None, (target.id, unlocked_binding.current_projection_revision_id)))
    with transaction.atomic(using=database_alias):
        binding, revisions, provider, model = lock_operation_rows(
            using=database_alias, binding_id=unlocked_binding.id, revision_ids=revision_ids,
            provider_id=unlocked_binding.existing_provider_uuid,
            model_id=unlocked_binding.existing_model_uuid,
        )
        current = revisions.get(binding.current_projection_revision_id)
        actual_current = current.projection_revision if current else None
        if current and current.id == target.id:
            outcome = require_expected_runtime_state(
                provider=provider, model=model, target_revision=target, current_revision=current,
            )
            if outcome != "already-applied-identical":
                raise ProjectionOperationRejected("pointer-runtime-drift")
            return ProjectionOperationResult("already-applied", str(binding.id), str(target.id), target.projection_hash)
        if actual_current != expected_current_revision:
            raise ProjectionOperationRejected("current-revision-conflict")
        outcome = require_expected_runtime_state(
            provider=provider, model=model, target_revision=target, current_revision=current,
        )
        provider_patch, model_patch, safe_changes = build_field_patch(target)
        _apply_patch(provider=provider, model=model, provider_patch=provider_patch,
                     model_patch=model_patch, using=database_alias, failure_injector=failure_injector)
        binding.current_projection_revision = target
        binding.lifecycle = ModelGatewayProjectionBinding.Lifecycle.DRAFT
        binding.save(using=database_alias, update_fields=("current_projection_revision", "lifecycle", "updated_at"))
        if failure_injector:
            failure_injector("after-pointer-update")
            failure_injector("before-succeeded-event")
        create_event(
            using=database_alias, binding=binding, projection_revision=target,
            previous_projection_revision=current, action=ModelGatewayProjectionEvent.Action.APPLY,
            result=ModelGatewayProjectionEvent.Result.SUCCEEDED, actor_id=actor,
            ticket_reference=ticket, safe_reason="projection applied",
            safe_metadata={"managed_paths": safe_changes},
        )
        if failure_injector:
            failure_injector("after-succeeded-event-before-commit")
    return ProjectionOperationResult("applied", str(binding.id), str(target.id), target.projection_hash)

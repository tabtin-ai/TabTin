from __future__ import annotations

from django.db import transaction

from apps.services.llm.models import ModelGatewayProjectionBinding, ModelGatewayProjectionEvent, ModelGatewayProjectionRevision
from .field_policy import build_field_patch
from .gates import require_write_gate
from .locking import lock_operation_rows
from .repository import create_event
from .results import ProjectionOperationRejected, ProjectionOperationResult
from .service import _apply_patch, _require_apply_contract


def rollback_projection_revision(*, database_alias: str, binding_identity: tuple[str, str, str],
                                 target_revision: int, expected_current_revision: int,
                                 expected_current_hash: str, actor: str, ticket: str,
                                 evaluation_time, confirmation_hash: str,
                                 failure_injector=None) -> ProjectionOperationResult:
    require_write_gate(database_alias=database_alias, actor=actor, ticket=ticket)
    if confirmation_hash != expected_current_hash:
        raise ProjectionOperationRejected("confirmation-hash-mismatch")
    lookup = dict(zip(("package_key", "deployment_key", "binding_key"), binding_identity, strict=True))
    try:
        unlocked = ModelGatewayProjectionBinding.objects.using(database_alias).get(database_alias=database_alias, **lookup)
        current = ModelGatewayProjectionRevision.objects.using(database_alias).get(
            binding=unlocked, projection_revision=expected_current_revision,
            projection_hash=expected_current_hash,
        )
        target = ModelGatewayProjectionRevision.objects.using(database_alias).get(
            binding=unlocked, projection_revision=target_revision,
        )
    except (ModelGatewayProjectionBinding.DoesNotExist, ModelGatewayProjectionRevision.DoesNotExist) as exc:
        raise ProjectionOperationRejected("exact-revision-not-found") from exc
    if target.projection_revision >= current.projection_revision:
        raise ProjectionOperationRejected("rollback-target-not-historical")
    _require_apply_contract(target, evaluation_time)
    with transaction.atomic(using=database_alias):
        binding, revisions, provider, model = lock_operation_rows(
            using=database_alias, binding_id=unlocked.id,
            revision_ids=(target.id, current.id), provider_id=unlocked.existing_provider_uuid,
            model_id=unlocked.existing_model_uuid,
        )
        if binding.current_projection_revision_id != current.id:
            if binding.current_projection_revision_id == target.id:
                return ProjectionOperationResult("already-rolled-back", str(binding.id), str(target.id), target.projection_hash)
            raise ProjectionOperationRejected("current-revision-conflict")
        current_provider, current_model, _ = build_field_patch(current)
        for field, expected in current_provider.items():
            if getattr(provider, field) != expected:
                raise ProjectionOperationRejected("pointer-runtime-drift")
        for field, expected in current_model.items():
            if field not in {"capabilities_config", "custom_billing_config"} and getattr(model, field) != expected:
                raise ProjectionOperationRejected("pointer-runtime-drift")
        provider_patch, model_patch, safe_changes = build_field_patch(target)
        _apply_patch(provider=provider, model=model, provider_patch=provider_patch,
                     model_patch=model_patch, using=database_alias, failure_injector=failure_injector)
        binding.current_projection_revision = target
        binding.save(using=database_alias, update_fields=("current_projection_revision", "updated_at"))
        if failure_injector:
            failure_injector("after-pointer-update")
            failure_injector("before-succeeded-event")
        create_event(
            using=database_alias, binding=binding, projection_revision=target,
            previous_projection_revision=current, action=ModelGatewayProjectionEvent.Action.ROLLBACK,
            result=ModelGatewayProjectionEvent.Result.SUCCEEDED, actor_id=actor,
            ticket_reference=ticket, safe_reason="projection rolled back",
            safe_metadata={"managed_paths": safe_changes},
        )
        if failure_injector:
            failure_injector("after-succeeded-event-before-commit")
    return ProjectionOperationResult("rolled-back", str(binding.id), str(target.id), target.projection_hash)

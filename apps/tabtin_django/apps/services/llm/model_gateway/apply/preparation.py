from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from django.db import IntegrityError, transaction

from apps.services.llm.models import LLMModel, LLMProvider, ModelGatewayProjectionBinding, ModelGatewayProjectionEvent
from ..persistence import serialize_projection_plan
from ..projection.compiler import ProjectionPlan
from .gates import require_write_gate
from .repository import create_event, create_or_read_revision
from .results import ProjectionOperationRejected, ProjectionOperationResult


@dataclass(frozen=True, slots=True)
class ReviewedBindingMapping:
    database_alias: str
    package_key: str
    deployment_key: str
    binding_key: str
    existing_provider_uuid: UUID | None = None
    provider_create_candidate_key: str | None = None
    existing_model_uuid: UUID | None = None
    model_create_candidate_key: str | None = None

    def validate(self) -> None:
        if (self.existing_provider_uuid is None) == (self.provider_create_candidate_key is None):
            raise ProjectionOperationRejected("provider-target-xor")
        if (self.existing_model_uuid is None) == (self.model_create_candidate_key is None):
            raise ProjectionOperationRejected("model-target-xor")

    @classmethod
    def from_json(cls, value: dict) -> "ReviewedBindingMapping":
        expected = {field.name for field in __import__("dataclasses").fields(cls)}
        if set(value) != expected:
            raise ProjectionOperationRejected("mapping-schema-invalid")
        try:
            normalized = dict(value)
            normalized["existing_provider_uuid"] = UUID(value["existing_provider_uuid"]) if value["existing_provider_uuid"] else None
            normalized["existing_model_uuid"] = UUID(value["existing_model_uuid"]) if value["existing_model_uuid"] else None
            return cls(**normalized)
        except (TypeError, ValueError) as exc:
            raise ProjectionOperationRejected("mapping-schema-invalid") from exc


def prepare_projection_revision(*, plan: ProjectionPlan, mapping: ReviewedBindingMapping,
                                revision_number: int, expected_projection_hash: str,
                                actor: str, ticket: str, prepared_at) -> ProjectionOperationResult:
    using = mapping.database_alias
    require_write_gate(database_alias=using, actor=actor, ticket=ticket)
    mapping.validate()
    if revision_number <= 0 or plan.projection_hash != expected_projection_hash:
        raise ProjectionOperationRejected("projection-hash-mismatch")
    if (mapping.package_key, mapping.deployment_key, mapping.binding_key) != (
        plan.package_key, plan.deployment_identity.key, plan.binding_identity.key,
    ):
        raise ProjectionOperationRejected("binding-identity-mismatch")
    if mapping.existing_provider_uuid and not LLMProvider.objects.using(using).filter(pk=mapping.existing_provider_uuid).exists():
        raise ProjectionOperationRejected("provider-target-missing")
    if mapping.existing_model_uuid and not LLMModel.objects.using(using).filter(pk=mapping.existing_model_uuid, provider_id=mapping.existing_provider_uuid).exists():
        raise ProjectionOperationRejected("model-target-relation-conflict")
    values = mapping.__dict__ if hasattr(mapping, "__dict__") else {
        name: getattr(mapping, name) for name in mapping.__dataclass_fields__
    }
    with transaction.atomic(using=using):
        try:
            binding, created = ModelGatewayProjectionBinding.objects.using(using).get_or_create(
                database_alias=using, package_key=mapping.package_key,
                deployment_key=mapping.deployment_key, binding_key=mapping.binding_key,
                defaults={key: values[key] for key in (
                    "existing_provider_uuid", "provider_create_candidate_key",
                    "existing_model_uuid", "model_create_candidate_key",
                )},
            )
        except IntegrityError as exc:
            raise ProjectionOperationRejected("binding-conflict") from exc
        for field in ("existing_provider_uuid", "provider_create_candidate_key", "existing_model_uuid", "model_create_candidate_key"):
            if getattr(binding, field) != values[field]:
                raise ProjectionOperationRejected("binding-conflict")
        payload = serialize_projection_plan(
            plan, prepared_at=prepared_at, prepared_by_actor_id=actor,
            source_environment=using, review_ticket=ticket,
        )
        revision, revision_created = create_or_read_revision(
            using=using, binding=binding, number=revision_number,
            projection_hash=expected_projection_hash, payload=payload,
        )
        if revision_created:
            create_event(
                using=using, binding=binding, projection_revision=revision,
                action=ModelGatewayProjectionEvent.Action.PREPARED,
                result=ModelGatewayProjectionEvent.Result.SUCCEEDED, actor_id=actor,
                ticket_reference=ticket, safe_reason="projection revision prepared",
                safe_metadata={"revision": revision_number},
            )
    return ProjectionOperationResult(
        code="prepared" if revision_created else "already-prepared",
        binding_id=str(binding.id), revision_id=str(revision.id), projection_hash=revision.projection_hash,
    )

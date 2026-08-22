"""Create-only immutable metadata repository."""

from django.db import IntegrityError, transaction
from django.utils.dateparse import parse_datetime

from apps.services.llm.models import ModelGatewayProjectionEvent, ModelGatewayProjectionRevision

from .results import ProjectionOperationRejected


REVISION_FIELDS = (
    "package_identity", "deployment_ref", "binding_ref", "artifact_closure",
    "generated_factual_fields", "commercial_fields", "preserved_operational_field_names",
    "secret_field_classifications", "unmanaged_fields", "validation_summary",
    "behavior_blockers", "readiness_blockers", "projection_metadata", "prepared_at",
    "prepared_by_actor_id", "review_ticket", "source_environment",
)


def create_or_read_revision(*, using: str, binding, number: int, projection_hash: str, payload: dict):
    create_payload = dict(payload)
    if isinstance(create_payload.get("prepared_at"), str):
        create_payload["prepared_at"] = parse_datetime(create_payload["prepared_at"])
    try:
        with transaction.atomic(using=using):
            revision = ModelGatewayProjectionRevision.objects.using(using).create(
                binding=binding, projection_revision=number, projection_hash=projection_hash,
                **{field: create_payload[field] for field in REVISION_FIELDS},
            )
            revision.full_clean(exclude={
                field for field in (
                    "generated_factual_fields", "commercial_fields", "preserved_operational_field_names",
                    "secret_field_classifications", "unmanaged_fields", "behavior_blockers", "readiness_blockers",
                ) if not getattr(revision, field)
            })
            return revision, True
    except IntegrityError:
        revision = ModelGatewayProjectionRevision.objects.using(using).filter(
            binding=binding, projection_revision=number,
        ).first()
        if revision is None or revision.projection_hash != projection_hash:
            raise ProjectionOperationRejected("projection-revision-conflict")
        if any(getattr(revision, field) != create_payload[field] for field in REVISION_FIELDS):
            raise ProjectionOperationRejected("projection-revision-conflict")
        return revision, False


def create_event(*, using: str, **values):
    event = ModelGatewayProjectionEvent(**values)
    event.full_clean()
    event.save(using=using, force_insert=True)
    return event

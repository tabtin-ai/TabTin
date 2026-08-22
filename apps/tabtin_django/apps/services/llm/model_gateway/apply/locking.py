"""The single PR8 lock order: Binding -> Revisions -> Provider -> Model."""

from apps.services.llm.models import (
    LLMModel, LLMProvider, ModelGatewayProjectionBinding, ModelGatewayProjectionRevision,
)

from .results import ProjectionOperationRejected


def lock_operation_rows(*, using: str, binding_id, revision_ids: tuple, provider_id, model_id):
    binding = ModelGatewayProjectionBinding.objects.using(using).select_for_update().get(pk=binding_id)
    revisions = {
        row.id: row for row in ModelGatewayProjectionRevision.objects.using(using)
        .select_for_update().filter(id__in=revision_ids).order_by("projection_revision", "id")
    }
    try:
        provider = LLMProvider.objects.using(using).select_for_update().get(pk=provider_id)
        model = LLMModel.objects.using(using).select_for_update().get(pk=model_id)
    except (LLMProvider.DoesNotExist, LLMModel.DoesNotExist) as exc:
        raise ProjectionOperationRejected("target-missing") from exc
    if model.provider_id != provider.id:
        raise ProjectionOperationRejected("target-relation-conflict")
    return binding, revisions, provider, model

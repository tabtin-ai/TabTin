import inspect

from apps.services.llm.models import (
    LLMModel,
    LLMProvider,
    ModelGatewayProjectionBinding,
    ModelGatewayProjectionEvent,
    ModelGatewayProjectionRevision,
)


def test_runtime_targets_are_environment_local_uuid_fields_without_foreign_keys():
    for name in ("existing_provider_uuid", "existing_model_uuid"):
        field = ModelGatewayProjectionBinding._meta.get_field(name)
        assert field.get_internal_type() == "UUIDField"
        assert not field.is_relation
    assert ModelGatewayProjectionBinding._meta.get_field("existing_provider_uuid").related_model is None


def test_existing_provider_and_model_contracts_are_unchanged_by_metadata_models():
    provider_model_field = LLMModel._meta.get_field("provider")
    assert provider_model_field.remote_field.model is LLMProvider
    assert provider_model_field.remote_field.on_delete.__name__ == "PROTECT"
    assert LLMProvider._meta.db_table == "services_llm_provider"
    assert LLMModel._meta.db_table == "services_llm_model"


def test_revision_and_event_are_append_only_schema_shapes():
    revision_fields = {field.name for field in ModelGatewayProjectionRevision._meta.fields}
    event_fields = {field.name for field in ModelGatewayProjectionEvent._meta.fields}
    assert "created_at" not in revision_fields and "updated_at" not in revision_fields
    assert "prepared_at" in revision_fields
    assert "created_at" in event_fields and "updated_at" not in event_fields
    assert not hasattr(ModelGatewayProjectionRevision, "update")
    assert not hasattr(ModelGatewayProjectionEvent, "update")


def test_current_pointer_is_nullable_protected_and_has_no_update_service():
    field = ModelGatewayProjectionBinding._meta.get_field("current_projection_revision")
    assert field.null is True
    assert field.remote_field.on_delete.__name__ == "PROTECT"
    source = inspect.getsource(ModelGatewayProjectionBinding)
    assert ".save(" not in source and ".update(" not in source


def test_allowed_event_actions_and_results_are_frozen():
    assert set(ModelGatewayProjectionEvent.Action.values) == {"prepared", "apply", "rollback", "retire", "failed"}
    assert set(ModelGatewayProjectionEvent.Result.values) == {"succeeded", "failed", "rejected"}

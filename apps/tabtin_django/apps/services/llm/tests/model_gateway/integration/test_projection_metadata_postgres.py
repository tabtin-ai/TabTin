import uuid
from contextlib import contextmanager

import pytest
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.services.llm.models import (
    ModelGatewayProjectionBinding,
    ModelGatewayProjectionEvent,
    ModelGatewayProjectionRevision,
)


HASH_A = "sha256:" + "a" * 64
HASH_B = "sha256:" + "b" * 64


@contextmanager
def rollback_only(django_db_blocker):
    with django_db_blocker.unblock(), transaction.atomic():
        yield
        transaction.set_rollback(True)


def binding_kwargs(suffix="one"):
    return {
        "database_alias": "pr7-disposable",
        "package_key": f"safe-package-{suffix}",
        "deployment_key": f"safe-deployment-{suffix}",
        "binding_key": f"safe-binding-{suffix}",
        "existing_provider_uuid": uuid.uuid4(),
        "provider_create_candidate_key": None,
        "existing_model_uuid": uuid.uuid4(),
        "model_create_candidate_key": None,
    }


def exact_ref(kind, key, hash_value=HASH_A):
    return {"kind": kind, "key": key, "revision": "1", "expected_hash": hash_value}


def revision_kwargs(binding, number=1, hash_value=HASH_A):
    deployment = exact_ref("deployment-profile", "safe-deployment")
    model_binding = exact_ref("model-deployment-binding", "safe-binding", HASH_B)
    return {
        "binding": binding,
        "projection_revision": number,
        "projection_hash": hash_value,
        "package_identity": {"package_key": "safe-package"},
        "deployment_ref": deployment,
        "binding_ref": model_binding,
        "artifact_closure": [deployment, model_binding],
        "generated_factual_fields": [],
        "commercial_fields": [],
        "preserved_operational_field_names": ["provider.runtime_status"],
        "secret_field_classifications": [{"field_name": "provider.encrypted_api_key", "status": "not-read"}],
        "unmanaged_fields": [],
        "validation_summary": {},
        "behavior_blockers": [],
        "readiness_blockers": ["review-required"],
        "projection_metadata": {"schema_version": "model-gateway-projection-revision/v1"},
        "prepared_at": timezone.now(),
        "prepared_by_actor_id": "reviewer-safe",
        "source_environment": "pr7-disposable",
    }


def test_fresh_migration_has_zero_metadata_rows_and_target_forms_work(django_db_blocker):
    with rollback_only(django_db_blocker):
        assert ModelGatewayProjectionBinding.objects.count() == 0
        assert ModelGatewayProjectionRevision.objects.count() == 0
        assert ModelGatewayProjectionEvent.objects.count() == 0
        existing = ModelGatewayProjectionBinding.objects.create(**binding_kwargs("existing"))
        candidate_values = binding_kwargs("candidate") | {
            "existing_provider_uuid": None,
            "provider_create_candidate_key": "provider-candidate-safe",
            "existing_model_uuid": None,
            "model_create_candidate_key": "model-candidate-safe",
        }
        candidate = ModelGatewayProjectionBinding.objects.create(**candidate_values)
        assert existing.existing_provider_uuid and existing.existing_model_uuid
        assert candidate.provider_create_candidate_key and candidate.model_create_candidate_key


def test_binding_identity_xor_empty_and_environment_constraints(django_db_blocker):
    with rollback_only(django_db_blocker):
        original = ModelGatewayProjectionBinding.objects.create(**binding_kwargs())
        with pytest.raises(IntegrityError), transaction.atomic():
            ModelGatewayProjectionBinding.objects.create(**binding_kwargs())
        other_environment = ModelGatewayProjectionBinding.objects.create(
            **(binding_kwargs() | {"database_alias": "pr7-other"}),
        )
        assert original.id != other_environment.id
        with pytest.raises(IntegrityError), transaction.atomic():
            ModelGatewayProjectionBinding.objects.create(**(
                binding_kwargs("bad-xor") | {"provider_create_candidate_key": "also-present"}
            ))
        with pytest.raises(IntegrityError), transaction.atomic():
            ModelGatewayProjectionBinding.objects.create(**(
                binding_kwargs("bad-empty") | {
                    "existing_provider_uuid": None,
                    "provider_create_candidate_key": "",
                }
            ))


def test_revision_constraints_previous_and_current_pointer_contract(django_db_blocker):
    with rollback_only(django_db_blocker):
        binding = ModelGatewayProjectionBinding.objects.create(**binding_kwargs("revision"))
        other = ModelGatewayProjectionBinding.objects.create(**binding_kwargs("other"))
        first = ModelGatewayProjectionRevision.objects.create(**revision_kwargs(binding))
        assert binding.current_projection_revision_id is None
        second = ModelGatewayProjectionRevision.objects.create(
            **revision_kwargs(binding, number=2, hash_value=HASH_B), previous_revision=first,
        )
        binding.refresh_from_db()
        assert binding.current_projection_revision_id is None
        with pytest.raises(IntegrityError), transaction.atomic():
            ModelGatewayProjectionRevision.objects.create(**revision_kwargs(binding, number=1, hash_value="sha256:" + "c" * 64))
        with pytest.raises(IntegrityError), transaction.atomic():
            ModelGatewayProjectionRevision.objects.create(**revision_kwargs(binding, number=3, hash_value=HASH_A))
        with pytest.raises(IntegrityError), transaction.atomic():
            ModelGatewayProjectionRevision.objects.create(**revision_kwargs(binding, number=0, hash_value="sha256:" + "d" * 64))
        cross = ModelGatewayProjectionRevision(**revision_kwargs(other, number=1, hash_value="sha256:" + "e" * 64), previous_revision=second)
        with pytest.raises(ValidationError, match="same Binding"):
            cross.full_clean(validate_unique=False, validate_constraints=False)
        binding.current_projection_revision = second
        binding.full_clean(validate_unique=False, validate_constraints=False)
        other.current_projection_revision = second
        with pytest.raises(ValidationError, match="same Binding"):
            other.full_clean(validate_unique=False, validate_constraints=False)


def test_event_contract_relations_and_safe_payload(django_db_blocker):
    with rollback_only(django_db_blocker):
        binding = ModelGatewayProjectionBinding.objects.create(**binding_kwargs("event"))
        other = ModelGatewayProjectionBinding.objects.create(**binding_kwargs("event-other"))
        revision = ModelGatewayProjectionRevision.objects.create(**revision_kwargs(binding))
        event = ModelGatewayProjectionEvent(
            binding=binding,
            projection_revision=revision,
            action=ModelGatewayProjectionEvent.Action.PREPARED,
            result=ModelGatewayProjectionEvent.Result.SUCCEEDED,
            actor_id="reviewer-safe",
            ticket_reference="review-pr7",
            safe_reason="schema verification",
            safe_metadata={"source": "synthetic"},
        )
        event.full_clean()
        event.save()
        assert ModelGatewayProjectionEvent.objects.count() == 1
        event.binding = other
        with pytest.raises(ValidationError, match="same Binding"):
            event.full_clean(validate_unique=False, validate_constraints=False)
        event.binding = binding
        event.safe_metadata = {"raw_error": "forbidden"}
        with pytest.raises(ValidationError, match="forbidden"):
            event.full_clean(validate_unique=False, validate_constraints=False)

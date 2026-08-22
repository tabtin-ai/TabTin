from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
import threading

import pytest
from django.test import override_settings
from django.db import connection, connections

from apps.services.llm.model_gateway.apply import (
    ReviewedBindingMapping, apply_projection_revision, prepare_projection_revision,
    rollback_projection_revision,
)
from apps.services.llm.model_gateway.apply.results import ProjectionOperationRejected
from apps.services.llm.model_gateway.apply.field_policy import build_field_patch
from apps.services.llm.model_gateway.apply import rollback as rollback_module
from apps.services.llm.model_gateway.apply import service as service_module
from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity
from apps.services.llm.model_gateway.projection.compiler import ProjectedField, ProjectionPlan
from apps.services.llm.models import (
    LLMModel, LLMProvider, ModelGatewayProjectionBinding,
    ModelGatewayProjectionEvent, ModelGatewayProjectionRevision,
)

HASH_1 = "sha256:" + "1" * 64
HASH_2 = "sha256:" + "2" * 64
HASH_3 = "sha256:" + "3" * 64
EVALUATION_TIME = datetime(2026, 8, 6, tzinfo=timezone.utc)
CONTRACT = {
    "schema_version": "model-gateway-projection-revision/v1",
    "apply_contract": {
        "approved": True, "published": True, "publishable": True,
        "protocol_executable": True, "security_valid": True,
        "runtime_enabled": False, "traffic_weight": 0,
        "rate_card_valid_from": "2026-01-01T00:00:00Z",
        "rate_card_valid_until": "2027-01-01T00:00:00Z",
    },
}


def _exact_ref(kind, key, hash_value):
    return {"kind": kind, "key": key, "revision": "1", "expected_hash": hash_value}


def _revision(binding, number, hash_value, endpoint, context, input_price, *, blockers=()):
    deployment = _exact_ref("deployment-profile", "fictional-deployment", HASH_1)
    model_binding = _exact_ref("model-deployment-binding", "fictional-binding", HASH_2)
    return ModelGatewayProjectionRevision.objects.create(
        binding=binding, projection_revision=number, projection_hash=hash_value,
        package_identity={"package_key": "fictional-package"}, deployment_ref=deployment,
        binding_ref=model_binding, artifact_closure=[deployment, model_binding],
        generated_factual_fields=[
            {"target": "provider", "path": "default_base_url", "proposed": endpoint, "current": None, "source_identity": "safe"},
            {"target": "model", "path": "base_url", "proposed": endpoint, "current": None, "source_identity": "safe"},
            {"target": "model", "path": "context_window_tokens", "proposed": str(context), "current": None, "source_identity": "safe"},
        ],
        commercial_fields=[{"target": "model", "path": "pricing.input-token", "proposed": f"{input_price} CNY", "current": None, "source_identity": "safe"}],
        preserved_operational_field_names=["provider.runtime_status", "provider.routing_weight"],
        secret_field_classifications=[{"field_name": "provider.encrypted_api_key", "status": "not-read"}],
        unmanaged_fields=[], validation_summary={}, behavior_blockers=[], readiness_blockers=list(blockers),
        projection_metadata=deepcopy(CONTRACT), prepared_at=EVALUATION_TIME,
        prepared_by_actor_id="operator-safe", review_ticket="review-pr8", source_environment="default",
    )


@pytest.fixture
def projection_rows(db):
    return _create_projection_rows()


def _create_projection_rows():
    provider = LLMProvider.objects.create(
        name="fictional-provider", provider_key="fictional-provider", display_name="Fictional",
        default_base_url="https://old.example.test/v1", encrypted_api_key="",
        capability_domains=["chat"], routing_enabled=False, routing_weight=77, runtime_status="healthy",
    )
    model = LLMModel.objects.create(
        provider=provider, model_name="fictional-model", display_name="Fictional model",
        base_url="https://old.example.test/v1", capability_domain="chat", context_window_tokens=64000,
        max_output_tokens=4096, input_price_per_1k=Decimal("0.100000"),
        capabilities_config={"unmanaged": {"keep": True}}, custom_billing_config={"keep": "safe"},
    )
    binding = ModelGatewayProjectionBinding.objects.create(
        database_alias="default", package_key="fictional-package", deployment_key="fictional-deployment",
        binding_key="fictional-binding", existing_provider_uuid=provider.id, existing_model_uuid=model.id,
    )
    first = _revision(binding, 1, HASH_1, "https://old.example.test/v1", 64000, "0.100000")
    binding.current_projection_revision = first
    binding.save(update_fields=("current_projection_revision", "updated_at"))
    second = _revision(binding, 2, HASH_2, "https://new.example.test/v1", 128000, "0.200000")
    return provider, model, binding, first, second


def _apply():
    return apply_projection_revision(
        database_alias="default", binding_identity=("fictional-package", "fictional-deployment", "fictional-binding"),
        revision_number=2, expected_projection_hash=HASH_2, expected_current_revision=1,
        actor="operator-safe", ticket="review-pr8", evaluation_time=EVALUATION_TIME,
        confirmation_hash=HASH_2,
    )


def _apply_revision(number, hash_value, expected_current):
    return apply_projection_revision(
        database_alias="default", binding_identity=("fictional-package", "fictional-deployment", "fictional-binding"),
        revision_number=number, expected_projection_hash=hash_value, expected_current_revision=expected_current,
        actor="operator-safe", ticket="review-pr8", evaluation_time=EVALUATION_TIME,
        confirmation_hash=hash_value,
    )


def _rollback_to_first():
    return rollback_projection_revision(
        database_alias="default", binding_identity=("fictional-package", "fictional-deployment", "fictional-binding"),
        target_revision=1, expected_current_revision=2, expected_current_hash=HASH_2,
        actor="operator-safe", ticket="review-pr8", evaluation_time=EVALUATION_TIME,
        confirmation_hash=HASH_2,
    )


def _cleanup_concurrency_rows():
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE services_llm_gateway_projection_binding SET current_projection_revision_id = NULL "
            "WHERE package_key = %s", ["fictional-package"],
        )
        cursor.execute(
            "DELETE FROM services_llm_gateway_projection_event WHERE binding_id IN "
            "(SELECT id FROM services_llm_gateway_projection_binding WHERE package_key = %s)",
            ["fictional-package"],
        )
        cursor.execute(
            "DELETE FROM services_llm_gateway_projection_revision WHERE binding_id IN "
            "(SELECT id FROM services_llm_gateway_projection_binding WHERE package_key = %s)",
            ["fictional-package"],
        )
        cursor.execute("DELETE FROM services_llm_gateway_projection_binding WHERE package_key = %s", ["fictional-package"])
        cursor.execute("DELETE FROM services_llm_model WHERE model_name = %s", ["fictional-model"])
        cursor.execute("DELETE FROM services_llm_provider WHERE provider_key = %s", ["fictional-provider"])


def assert_runtime_matches_current_projection(*, operational=("healthy", 77), unmanaged=None):
    binding = ModelGatewayProjectionBinding.objects.select_related("current_projection_revision").get(
        package_key="fictional-package",
    )
    assert binding.current_projection_revision is not None
    provider = LLMProvider.objects.get(pk=binding.existing_provider_uuid)
    model = LLMModel.objects.get(pk=binding.existing_model_uuid)
    provider_patch, model_patch, _ = build_field_patch(binding.current_projection_revision)
    for field, expected in provider_patch.items():
        assert getattr(provider, field) == expected, (binding.current_projection_revision.projection_revision, field)
    for field, expected in model_patch.items():
        if field not in {"capabilities_config", "custom_billing_config"}:
            assert getattr(model, field) == expected, (binding.current_projection_revision.projection_revision, field)
    assert (provider.runtime_status, provider.routing_weight) == operational
    assert model.capabilities_config == (unmanaged or {"unmanaged": {"keep": True}})
    assert model.custom_billing_config == {"keep": "safe"}
    succeeded = list(
        ModelGatewayProjectionEvent.objects.filter(binding=binding, result="succeeded")
        .order_by("created_at", "id")
    )
    for event in succeeded:
        assert event.projection_revision.binding_id == binding.id
        assert event.actor_id == "operator-safe"
        assert event.ticket_reference == "review-pr8"
        assert event.safe_reason in {"projection applied", "projection rolled back"}
    return binding, provider, model, succeeded


def _run_controlled_race(monkeypatch, *, operations, winner):
    barrier = threading.Barrier(len(operations), timeout=5)
    winner_committed = threading.Event()
    traces = {name: [] for name in operations}
    outcomes = {}
    original_apply_lock = service_module.lock_operation_rows
    original_rollback_lock = rollback_module.lock_operation_rows

    def controlled_lock(original):
        def wrapped(**kwargs):
            barrier.wait()
            if threading.current_thread().name != winner:
                assert winner_committed.wait(timeout=5), "winning transaction did not finish"
            return original(**kwargs)
        return wrapped

    monkeypatch.setattr(service_module, "lock_operation_rows", controlled_lock(original_apply_lock))
    monkeypatch.setattr(rollback_module, "lock_operation_rows", controlled_lock(original_rollback_lock))

    def worker(name, operation):
        connections.close_all()
        worker_connection = connections["default"]

        def capture(execute, sql, params, many, context):
            result = execute(sql, params, many, context)
            if "FOR UPDATE" in sql.upper():
                traces[name].append(" ".join(sql.split()))
            return result

        try:
            with worker_connection.cursor() as cursor:
                cursor.execute("SET lock_timeout TO '3s'")
                cursor.execute("SET statement_timeout TO '10s'")
                cursor.execute("SET deadlock_timeout TO '1s'")
            with worker_connection.execute_wrapper(capture):
                try:
                    outcomes[name] = operation().code
                except ProjectionOperationRejected as exc:
                    outcomes[name] = exc.code
        finally:
            if name == winner:
                winner_committed.set()
            connections.close_all()

    threads = [threading.Thread(target=worker, name=name, args=(name, operation)) for name, operation in operations.items()]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=12)
        assert not thread.is_alive(), f"worker timeout: {thread.name}"
    assert set(outcomes) == set(operations)
    return outcomes, traces


def _assert_lock_trace(trace):
    expected = [
        "services_llm_gateway_projection_binding",
        "services_llm_gateway_projection_revision",
        "services_llm_provider",
        "services_llm_model",
    ]
    observed = []
    for sql in trace:
        for table in expected:
            if f'FROM "{table}"' in sql:
                observed.append(table)
                if table == "services_llm_gateway_projection_revision":
                    assert 'ORDER BY "services_llm_gateway_projection_revision"."projection_revision" ASC' in sql
                    assert '"services_llm_gateway_projection_revision"."id" ASC' in sql
                break
        assert "pg_advisory" not in sql.lower() and "lock table" not in sql.lower()
    assert observed == expected


@override_settings(MODEL_GATEWAY_PROJECTION_WRITE_ENABLED=True)
def test_apply_exact_fields_pointer_event_and_idempotency(projection_rows):
    provider, model, binding, _, second = projection_rows
    result = _apply()
    assert result.code == "applied"
    provider.refresh_from_db(); model.refresh_from_db(); binding.refresh_from_db()
    assert provider.default_base_url == "https://new.example.test/v1"
    assert provider.routing_weight == 77 and provider.runtime_status == "healthy"
    assert model.context_window_tokens == 128000
    assert model.input_price_per_1k == Decimal("0.200000")
    assert model.capabilities_config == {"unmanaged": {"keep": True}}
    assert binding.current_projection_revision_id == second.id
    assert ModelGatewayProjectionEvent.objects.filter(action="apply", result="succeeded").count() == 1
    repeated = apply_projection_revision(
        database_alias="default", binding_identity=("fictional-package", "fictional-deployment", "fictional-binding"),
        revision_number=2, expected_projection_hash=HASH_2, expected_current_revision=2,
        actor="operator-safe", ticket="review-pr8", evaluation_time=EVALUATION_TIME, confirmation_hash=HASH_2,
    )
    assert repeated.code == "already-applied"
    assert ModelGatewayProjectionEvent.objects.filter(action="apply", result="succeeded").count() == 1


@override_settings(MODEL_GATEWAY_PROJECTION_WRITE_ENABLED=True)
def test_exact_rollback_restores_managed_and_preserves_operational_unmanaged(projection_rows):
    provider, model, binding, first, _ = projection_rows
    _apply()
    model.capabilities_config["after_apply"] = "preserve"
    model.save(update_fields=("capabilities_config",))
    result = rollback_projection_revision(
        database_alias="default", binding_identity=("fictional-package", "fictional-deployment", "fictional-binding"),
        target_revision=1, expected_current_revision=2, expected_current_hash=HASH_2,
        actor="operator-safe", ticket="review-pr8", evaluation_time=EVALUATION_TIME, confirmation_hash=HASH_2,
    )
    assert result.code == "rolled-back"
    provider.refresh_from_db(); model.refresh_from_db(); binding.refresh_from_db()
    assert provider.default_base_url == "https://old.example.test/v1"
    assert model.context_window_tokens == 64000 and model.input_price_per_1k == Decimal("0.100000")
    assert model.capabilities_config["after_apply"] == "preserve"
    assert binding.current_projection_revision_id == first.id
    assert ModelGatewayProjectionEvent.objects.filter(action="rollback", result="succeeded").count() == 1


@pytest.mark.parametrize("stage", [
    "after-provider-patch", "after-model-patch", "after-pointer-update",
    "before-succeeded-event", "after-succeeded-event-before-commit",
])
@override_settings(MODEL_GATEWAY_PROJECTION_WRITE_ENABLED=True)
def test_failure_injection_rolls_back_all_state_and_succeeded_event(projection_rows, stage):
    provider, model, binding, first, _ = projection_rows
    def inject(actual):
        if actual == stage:
            raise RuntimeError("synthetic failure")
    with pytest.raises(RuntimeError, match="synthetic failure"):
        apply_projection_revision(
            database_alias="default", binding_identity=("fictional-package", "fictional-deployment", "fictional-binding"),
            revision_number=2, expected_projection_hash=HASH_2, expected_current_revision=1,
            actor="operator-safe", ticket="review-pr8", evaluation_time=EVALUATION_TIME,
            confirmation_hash=HASH_2, failure_injector=inject,
        )
    provider.refresh_from_db(); model.refresh_from_db(); binding.refresh_from_db()
    assert provider.default_base_url == "https://old.example.test/v1"
    assert model.context_window_tokens == 64000
    assert binding.current_projection_revision_id == first.id
    assert ModelGatewayProjectionEvent.objects.filter(action="apply", result="succeeded").count() == 0


@override_settings(MODEL_GATEWAY_PROJECTION_WRITE_ENABLED=True)
def test_blocked_revision_and_candidate_targets_fail_closed(projection_rows):
    _, _, binding, _, _ = projection_rows
    blocked = _revision(
        binding, 3, "sha256:" + "3" * 64,
        "https://blocked.example.test/v1", 256000, "0.300000",
        blockers=("draft", "publishable-false"),
    )
    with pytest.raises(ProjectionOperationRejected, match="readiness-blocked"):
        apply_projection_revision(
            database_alias="default", binding_identity=("fictional-package", "fictional-deployment", "fictional-binding"),
            revision_number=3, expected_projection_hash=blocked.projection_hash, expected_current_revision=1,
            actor="operator-safe", ticket="review-pr8", evaluation_time=EVALUATION_TIME,
            confirmation_hash=blocked.projection_hash,
        )
    binding.existing_provider_uuid = None
    binding.provider_create_candidate_key = "fictional-provider-candidate"
    binding.save(update_fields=("existing_provider_uuid", "provider_create_candidate_key", "updated_at"))
    with pytest.raises(ProjectionOperationRejected, match="provider-create-not-supported"):
        _apply()


@override_settings(MODEL_GATEWAY_PROJECTION_WRITE_ENABLED=True)
def test_two_identical_apply_operations_serialize_without_duplicate_event(django_db_blocker, monkeypatch):
    with django_db_blocker.unblock():
        _cleanup_concurrency_rows()
        try:
            _create_projection_rows()
            outcomes, traces = _run_controlled_race(
                monkeypatch,
                operations={"first": _apply, "second": _apply},
                winner="first",
            )
            assert sorted(outcomes.values()) == ["already-applied", "applied"]
            binding, _, _, events = assert_runtime_matches_current_projection()
            assert binding.current_projection_revision.projection_revision == 2
            assert len(events) == 1
            assert events[0].action == "apply" and events[0].previous_projection_revision.projection_revision == 1
            for trace in traces.values():
                _assert_lock_trace(trace)
        finally:
            _cleanup_concurrency_rows()


@pytest.mark.parametrize("winner", ["apply-b", "apply-c"])
@override_settings(MODEL_GATEWAY_PROJECTION_WRITE_ENABLED=True)
def test_competing_revisions_race_has_one_exact_winner(django_db_blocker, monkeypatch, winner):
    with django_db_blocker.unblock():
        _cleanup_concurrency_rows()
        try:
            _, _, binding, first, second = _create_projection_rows()
            third = _revision(binding, 3, HASH_3, "https://third.example.test/v1", 256000, "0.300000")
            immutable_before = {
                revision.id: (revision.projection_hash, deepcopy(revision.generated_factual_fields), deepcopy(revision.commercial_fields))
                for revision in (first, second, third)
            }
            outcomes, traces = _run_controlled_race(
                monkeypatch,
                operations={
                    "apply-b": lambda: _apply_revision(2, HASH_2, 1),
                    "apply-c": lambda: _apply_revision(3, HASH_3, 1),
                },
                winner=winner,
            )
            loser = "apply-c" if winner == "apply-b" else "apply-b"
            assert outcomes == {winner: "applied", loser: "current-revision-conflict"}
            current, _, _, events = assert_runtime_matches_current_projection()
            assert current.current_projection_revision.projection_revision == (2 if winner == "apply-b" else 3)
            assert len(events) == 1 and events[0].action == "apply"
            assert events[0].previous_projection_revision_id == first.id
            assert events[0].projection_revision_id == current.current_projection_revision_id
            assert ModelGatewayProjectionEvent.objects.filter(result="succeeded").count() == 1
            for revision in ModelGatewayProjectionRevision.objects.filter(binding=binding):
                assert immutable_before[revision.id] == (
                    revision.projection_hash, revision.generated_factual_fields, revision.commercial_fields,
                )
            for trace in traces.values():
                _assert_lock_trace(trace)
        finally:
            _cleanup_concurrency_rows()


@pytest.mark.parametrize("winner", ["apply-c", "rollback-a"])
@override_settings(MODEL_GATEWAY_PROJECTION_WRITE_ENABLED=True)
def test_apply_versus_rollback_race_rechecks_pointer_after_lock(django_db_blocker, monkeypatch, winner):
    with django_db_blocker.unblock():
        _cleanup_concurrency_rows()
        try:
            provider, model, binding, first, second = _create_projection_rows()
            assert _apply().code == "applied"
            model.capabilities_config = {"unmanaged": {"keep": True}, "after-b": "preserve"}
            model.save(update_fields=("capabilities_config",))
            third = _revision(binding, 3, HASH_3, "https://third.example.test/v1", 256000, "0.300000")
            baseline_events = ModelGatewayProjectionEvent.objects.filter(binding=binding, result="succeeded").count()
            immutable_before = {
                revision.id: (revision.projection_hash, deepcopy(revision.generated_factual_fields), deepcopy(revision.commercial_fields))
                for revision in (first, second, third)
            }
            outcomes, traces = _run_controlled_race(
                monkeypatch,
                operations={
                    "apply-c": lambda: _apply_revision(3, HASH_3, 2),
                    "rollback-a": _rollback_to_first,
                },
                winner=winner,
            )
            loser = "rollback-a" if winner == "apply-c" else "apply-c"
            expected_code = "applied" if winner == "apply-c" else "rolled-back"
            assert outcomes == {winner: expected_code, loser: "current-revision-conflict"}
            current, final_provider, final_model, events = assert_runtime_matches_current_projection(
                unmanaged={"unmanaged": {"keep": True}, "after-b": "preserve"},
            )
            expected_revision = 3 if winner == "apply-c" else 1
            assert current.current_projection_revision.projection_revision == expected_revision
            assert final_provider.default_base_url == final_model.base_url
            assert len(events) == baseline_events + 1
            transition = events[-1]
            assert transition.action == ("apply" if winner == "apply-c" else "rollback")
            assert transition.previous_projection_revision_id == second.id
            assert transition.projection_revision_id == current.current_projection_revision_id
            assert ModelGatewayProjectionEvent.objects.filter(binding=binding, result="succeeded").count() == 2
            if winner == "apply-c":
                assert not ModelGatewayProjectionEvent.objects.filter(binding=binding, action="rollback").exists()
            for revision in ModelGatewayProjectionRevision.objects.filter(binding=binding):
                assert immutable_before[revision.id] == (
                    revision.projection_hash, revision.generated_factual_fields, revision.commercial_fields,
                )
            for trace in traces.values():
                _assert_lock_trace(trace)
        finally:
            _cleanup_concurrency_rows()


@override_settings(MODEL_GATEWAY_PROJECTION_WRITE_ENABLED=True)
def test_prepare_is_create_only_idempotent_and_leaves_pointer_unchanged(projection_rows):
    provider, model, _, _, _ = projection_rows
    deployment = ArtifactIdentity(kind="deployment-profile", key="prepare-deployment", revision="1", canonical_hash=HASH_1)
    binding_identity = ArtifactIdentity(kind="model-deployment-binding", key="prepare-binding", revision="1", canonical_hash=HASH_2)
    plan = ProjectionPlan(
        package_key="prepare-package", deployment_identity=deployment, binding_identity=binding_identity,
        closure_identities=(deployment, binding_identity), provider_managed_target_identity=None,
        model_managed_target_identity=None,
        fields=(ProjectedField(target="model", path="context_window_tokens", proposed="64000", current="64000", source_ref="safe", classification="unchanged"),),
        drift=(), blocking_issues=("draft",), warnings=(), precedence=("artifact",),
        projection_hash="sha256:" + "4" * 64,
    )
    mapping = ReviewedBindingMapping(
        database_alias="default", package_key="prepare-package", deployment_key="prepare-deployment",
        binding_key="prepare-binding", existing_provider_uuid=provider.id, existing_model_uuid=model.id,
    )
    kwargs = dict(
        plan=plan, mapping=mapping, revision_number=1, expected_projection_hash=plan.projection_hash,
        actor="operator-safe", ticket="review-pr8", prepared_at=EVALUATION_TIME,
    )
    assert prepare_projection_revision(**kwargs).code == "prepared"
    assert prepare_projection_revision(**kwargs).code == "already-prepared"
    prepared_binding = ModelGatewayProjectionBinding.objects.get(package_key="prepare-package")
    assert prepared_binding.current_projection_revision_id is None
    assert prepared_binding.projection_revisions.count() == 1
    assert prepared_binding.projection_events.filter(action="prepared", result="succeeded").count() == 1

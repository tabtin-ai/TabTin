import inspect
from uuid import UUID

import pytest
from pydantic import ValidationError

from apps.services.llm.model_gateway.projection.snapshot import (
    MODEL_FIELDS,
    PROVIDER_FIELDS,
    DatabaseSnapshot,
    ModelSnapshot,
    ProviderSnapshot,
    read_database_snapshot,
)

P = UUID("11111111-1111-4111-8111-111111111111")
M = UUID("22222222-2222-4222-8222-222222222222")


def provider():
    return ProviderSnapshot(id=P, name="fictional", provider_key="fictional-provider", display_name="Fictional", default_base_url="https://api.example.test", capability_domains=("chat",), scope="global", organization_id=None, user_id=None, routing_enabled=True, priority=1, routing_weight=100, runtime_status="healthy", runtime_cooldown_until=None, health_consecutive_failures=0)


def model():
    return ModelSnapshot(id=M, provider_id=P, model_name="fictional-model", display_name="Fictional", base_url="https://api.example.test", capability_domain="chat", context_window_tokens=100, max_input_tokens=None, max_output_tokens=10, billing_type="token", input_price_per_1k="0.01", output_price_per_1k="0.02", price_per_request="0", price_per_second="0", custom_billing_config=(), capabilities_config=(), wave_status="stable")


def test_provider_snapshot_allowlist_is_explicit():
    assert tuple(ProviderSnapshot.model_fields) == PROVIDER_FIELDS


def test_model_snapshot_allowlist_is_explicit():
    assert tuple(ModelSnapshot.model_fields) == MODEL_FIELDS


def test_snapshot_dtos_are_immutable():
    with pytest.raises(ValidationError):
        provider().provider_key = "changed"


def test_database_snapshot_contains_no_lazy_queryset():
    snapshot = DatabaseSnapshot(providers=(provider(),), models=(model(),))
    assert isinstance(snapshot.providers, tuple)
    assert isinstance(snapshot.models, tuple)


def test_snapshot_allowlists_exclude_credentials():
    selected = set(PROVIDER_FIELDS) | set(MODEL_FIELDS)
    assert selected.isdisjoint({"encrypted_api_key", "api_key", "authorization", "secret", "encrypted_secret_payload"})


def test_snapshot_source_never_queries_provider_key_or_decryption_helpers():
    source = inspect.getsource(read_database_snapshot)
    assert "LLMProviderKey" not in source
    assert "decrypt" not in source.lower()
    assert ".api_key" not in source


def test_snapshot_source_uses_stable_explicit_ordering_and_eager_materialization():
    source = inspect.getsource(read_database_snapshot)
    assert 'order_by("provider_key","id")' in source
    assert 'order_by("provider_id","model_name","id")' in source
    assert "list(providers" in source
    assert "list(models" in source

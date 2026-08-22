from decimal import Decimal

import pytest

from apps.services.llm.model_gateway.apply.field_policy import build_field_patch, merge_generated_json
from apps.services.llm.model_gateway.apply.results import ProjectionOperationRejected


class Revision:
    generated_factual_fields = [
        {"target": "provider", "path": "default_base_url", "proposed": "https://safe.example.test/v1"},
        {"target": "model", "path": "context_window_tokens", "proposed": "128000"},
        {"target": "model", "path": "capabilities_config.generated.tools.enabled", "proposed": "true"},
    ]
    commercial_fields = [
        {"target": "model", "path": "pricing.input-token", "proposed": "0.001000 CNY"},
    ]


def test_explicit_field_policy_and_commercial_conversion_are_deterministic():
    provider, model, safe = build_field_patch(Revision())
    assert provider == {"default_base_url": "https://safe.example.test/v1"}
    assert model["context_window_tokens"] == 128000
    assert model["input_price_per_1k"] == Decimal("0.001000")
    assert safe == {
        "model": ["capabilities_config.generated.tools.enabled", "context_window_tokens", "input_price_per_1k"],
        "provider": ["default_base_url"],
    }


def test_generated_nested_merge_preserves_unmanaged_siblings_and_orders_keys():
    merged = merge_generated_json(
        {"unmanaged": {"keep": True}, "generated": {"vision": {"enabled": False}}},
        {"generated": {"tools": {"enabled": "true"}}},
    )
    assert merged["unmanaged"] == {"keep": True}
    assert merged["generated"] == {"vision": {"enabled": False}, "tools": {"enabled": "true"}}


@pytest.mark.parametrize("current,patch", [
    ({"generated": "scalar"}, {"generated": {"tools": {"enabled": True}}}),
    ({"generated": {"tools": "scalar"}}, {"generated": {"tools": {"enabled": True}}}),
])
def test_nested_structural_collisions_fail_closed(current, patch):
    with pytest.raises(ProjectionOperationRejected, match="managed-structural-collision"):
        merge_generated_json(current, patch)


def test_unknown_or_forbidden_field_is_never_written():
    class Unsafe:
        generated_factual_fields = [{"target": "provider", "path": "routing_weight", "proposed": "999"}]
        commercial_fields = []
    with pytest.raises(ProjectionOperationRejected, match="field-not-managed"):
        build_field_patch(Unsafe())

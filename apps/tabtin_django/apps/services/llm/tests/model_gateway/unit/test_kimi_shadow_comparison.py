from pathlib import Path

from apps.services.llm.model_gateway.domain.mappings import ProductControlMapping, RuntimeWireMapping
from apps.services.llm.model_gateway.loading.registry import ArtifactRegistry

ROOT = Path(__file__).parents[3] / "model_gateway" / "artifacts" / "drafts"


def items(kind, prefix):
    return [item for item in ArtifactRegistry(ROOT).items() if isinstance(item, kind) and item.identity.key.startswith(prefix)]


def operation_map(item):
    return {operation.input_value: operation.value for operation in item.operations}


def wire_rows(item):
    return [(operation.input_value, operation.target, operation.value) for patch in item.patches for operation in patch.operations]


def test_k25_and_k26_preserve_binary_fold_without_effort_ladder():
    for prefix in ("kimi-k2-5", "kimi-k2-6"):
        product = items(ProductControlMapping, prefix)[0]
        runtime = items(RuntimeWireMapping, prefix)[0]
        assert operation_map(product) == {"off": "off", "standard": "on", "deep": "on"}
        assert set(wire_rows(runtime)) == {("off", "thinking.type", "disabled"), ("on", "thinking.type", "enabled")}
        assert not any(target == "reasoning_effort" for _, target, _ in wire_rows(runtime))


def test_k27_forced_thinking_has_no_off_control_or_disable_operation():
    product = items(ProductControlMapping, "kimi-k2-7-code")[0]
    runtime = items(RuntimeWireMapping, "kimi-k2-7-code")[0]
    assert "off" not in product.exposed_values
    assert not any(value == "disabled" for _, _, value in wire_rows(runtime))


def test_k3_preserves_top_level_effort_domain_and_no_thinking_disable():
    runtime = items(RuntimeWireMapping, "kimi-k3")[0]
    rows = wire_rows(runtime)
    assert {(value, target) for value, target, _ in rows} == {("low", "reasoning_effort"), ("high", "reasoning_effort"), ("max", "reasoning_effort")}
    assert not any(target == "thinking.type" for _, target, _ in rows)

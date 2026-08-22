import json
from pathlib import Path

from apps.services.llm.model_gateway.domain.mappings import ProductControlMapping, RuntimeWireMapping
from apps.services.llm.model_gateway.loading.registry import ArtifactRegistry

ROOT = Path(__file__).parents[3] / "model_gateway" / "artifacts" / "drafts"


def test_all_doubao_mappings_preserve_type_plus_effort_and_never_invent_fast():
    registry = ArtifactRegistry(ROOT)
    runtime = [item for item in registry.items() if isinstance(item, RuntimeWireMapping) and item.identity.key.startswith("doubao-")]
    assert len(runtime) == 4
    for item in runtime:
        targets = {operation.target for patch in item.patches for operation in patch.operations}
        assert targets == {"thinking.type", "reasoning_effort"}
        assert "service_tier" not in targets
        assert all("fast" not in str(operation.value).lower() for patch in item.patches for operation in patch.operations)


def test_doubao_product_mapping_preserves_off_standard_deep_semantics():
    registry = ArtifactRegistry(ROOT)
    products = [item for item in registry.items() if isinstance(item, ProductControlMapping) and item.identity.key.startswith("doubao-")]
    assert len(products) == 4
    for item in products:
        mapping = {operation.input_value: operation.value for operation in item.operations}
        assert mapping == {"off": "off", "standard": "medium", "deep": "high"}


def test_pro_and_turbo_unknowns_remain_explicit_and_have_no_rate_card():
    rows = []
    for line in (ROOT / "doubao/packages/index.jsonl").read_text().splitlines():
        rows.append(json.loads(line))
    for row in rows:
        if row["model_name"] not in {"doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628"}:
            continue
        assert {"max-output-unknown", "rate-card-unknown"} <= set(row["blocking_reasons"])
        assert not any(reference["kind"] == "rate-card" for reference in row["artifact_refs"])

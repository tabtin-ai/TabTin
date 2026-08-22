import json
import re
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from apps.services.llm.model_gateway.canonical import calculate_canonical_hash
from apps.services.llm.model_gateway.domain.commercial import RateCard
from apps.services.llm.model_gateway.domain.deployments import DeploymentProfile, ModelDeploymentBinding
from apps.services.llm.model_gateway.domain.protocols import ProtocolReadinessSpec
from apps.services.llm.model_gateway.domain.rollout import RolloutPolicy
from apps.services.llm.model_gateway.loading.registry import ArtifactRegistry
from apps.services.llm.model_gateway.projection.compiler import ProjectionPackage, compile_projection
from apps.services.llm.model_gateway.projection.identities import ReviewedBindingMapping, discover_bindings
from apps.services.llm.model_gateway.projection.snapshot import DatabaseSnapshot, ModelSnapshot, ProviderSnapshot
from apps.services.llm.model_gateway.reference_graph import ReferenceGraph
from apps.services.llm.model_gateway.validation.endpoints import validate_endpoint
from apps.services.llm.model_gateway.validation.secret_scanner import scan_artifact_file
from apps.services.llm.model_gateway.domain.security import EndpointSecurityPolicy
from apps.services.llm.model_gateway.validation.semantic import validate_artifacts

ROOT = Path(__file__).parents[3] / "model_gateway" / "artifacts" / "drafts"
FIXTURES = Path(__file__).parents[1] / "fixtures" / "legacy"
EXPECTED_MODELS = {
    "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3",
    "doubao-seed-2-0-lite-260428", "doubao-seed-evolving",
    "doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628",
}
APPROVED_CLASSIFICATIONS = {
    "explicit_repository_configuration", "current_database_projection",
    "inferred_legacy_behavior", "provisional_evidence", "unknown",
}


def registry():
    return ArtifactRegistry(ROOT)


def jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def package_rows():
    return jsonl(ROOT / "kimi/packages/index.jsonl") + jsonl(ROOT / "doubao/packages/index.jsonl")


def evidence_rows():
    return jsonl(ROOT / "kimi/evidence/index.jsonl") + jsonl(ROOT / "doubao/evidence/index.jsonl")


def test_pr5_inventory_contains_exactly_eight_legacy_models():
    assert {row["model_name"] for row in package_rows()} == EXPECTED_MODELS


def test_all_packages_are_draft_non_runtime_non_published():
    for row in package_rows():
        assert row["status"] == "draft"
        assert row["runtime_enabled"] is False
        assert row["published"] is False
        assert row["publishable"] is False


def test_shared_deployments_are_reused_by_channel():
    items = registry().items()
    deployments = [item for item in items if isinstance(item, DeploymentProfile)]
    bindings = [item for item in items if isinstance(item, ModelDeploymentBinding)]
    assert len(deployments) == 3
    assert len({binding.deployment_ref.key for binding in bindings}) == 3


def test_registry_paths_and_canonical_hashes_are_exact():
    result = registry()
    assert result.issues == ()
    assert all(calculate_canonical_hash(item) == item.identity.canonical_hash for item in result.items())


def test_all_exact_references_resolve_and_closures_have_no_cycles():
    result = registry()
    graph = ReferenceGraph(result)
    for root in result.items():
        graph.build([root])
        assert graph.issues == ()


def test_rehash_and_closure_order_are_deterministic():
    first = registry()
    second = registry()
    assert [(x.identity, calculate_canonical_hash(x)) for x in first.items()] == [(x.identity, calculate_canonical_hash(x)) for x in second.items()]


def test_every_artifact_has_approved_evidence_classification():
    rows = evidence_rows()
    covered = {(row["artifact"]["kind"], row["artifact"]["key"], row["artifact"]["revision"]) for row in rows}
    package_specific = {key for row in package_rows() for key in [(ref["kind"], ref["key"], ref["revision"]) for ref in row["artifact_refs"]]}
    assert covered <= package_specific
    for row in rows:
        assert row["default_classification"] in APPROVED_CLASSIFICATIONS
        assert set(row["overrides"].values()) <= APPROVED_CLASSIFICATIONS
        assert row["official_vendor_fact"] is False


def test_no_local_uuid_enters_factual_artifacts():
    uuid_pattern = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", re.I)
    for path in ROOT.rglob("artifact.json"):
        assert uuid_pattern.search(path.read_text(encoding="utf-8")) is None


def test_secret_scanner_finds_no_draft_artifact_secret():
    findings = [finding for path in ROOT.rglob("artifact.json") for finding in scan_artifact_file(path)]
    assert findings == []


def test_credentials_are_opaque_bearer_references_only():
    for deployment in (item for item in registry().items() if isinstance(item, DeploymentProfile)):
        assert deployment.credential_type == "bearer"
        assert deployment.credential_pool_ref.pool_key.endswith("opaque-pool")


def test_endpoint_static_validation_uses_separately_trusted_policy():
    policies = {
        "api.moonshot.cn": EndpointSecurityPolicy(exact_hosts=("api.moonshot.cn",), approved_regions=("cn",), require_dns_verification=False),
        "ark.cn-beijing.volces.com": EndpointSecurityPolicy(exact_hosts=("ark.cn-beijing.volces.com",), approved_regions=("cn-beijing",), require_dns_verification=False),
    }
    for deployment in (item for item in registry().items() if isinstance(item, DeploymentProfile)):
        host = deployment.endpoint_url.split("/")[2]
        report = validate_endpoint(deployment.endpoint_url, region=deployment.region, policy=policies[host])
        assert report.static_endpoint_valid is True
        assert not any(issue.severity == "blocking" for issue in report.diagnostics)


def test_protocol_and_rollout_are_fail_closed():
    for item in registry().items():
        if isinstance(item, ProtocolReadinessSpec):
            assert item.executable is False
            assert item.readiness.value == "conditional"
        if isinstance(item, RolloutPolicy):
            assert item.lifecycle.value == "draft"
            assert item.percentage_basis_points == 0


def test_known_semantic_blocks_are_explicit_and_only_expected_unknowns():
    issues = validate_artifacts(registry().items())
    keys = {(issue.rule_code, issue.artifact.key) for issue in issues}
    assert keys == {
        ("verified_safety_ceiling_missing", "kimi-draft-endpoint-safety"),
        ("verified_safety_ceiling_missing", "doubao-draft-endpoint-safety"),
        ("verified_safety_ceiling_missing", "doubao-seed-2-1-pro-draft-output-safety"),
        ("verified_safety_ceiling_missing", "doubao-seed-2-1-turbo-draft-output-safety"),
    }


def test_rate_cards_use_exact_decimal_strings_and_do_not_overlap():
    cards = [item for item in registry().items() if isinstance(item, RateCard)]
    assert len(cards) == 6
    for card in cards:
        assert card.validity.valid_until is None
        for rate in card.rates:
            assert Decimal(rate.amount) >= 0
            assert rate.currency == "CNY"
    assert not any(issue.rule_code == "rate_card_overlap" for issue in validate_artifacts(cards))


def test_unknown_doubao_21_prices_and_output_limits_remain_blocking():
    rows = {row["model_name"]: row for row in package_rows()}
    for name in ("doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628"):
        assert {"max-output-unknown", "rate-card-unknown"} <= set(rows[name]["blocking_reasons"])
        assert not any(ref["kind"] == "rate-card" for ref in rows[name]["artifact_refs"])


def test_doubao_21_unknowns_never_project_zero_output_or_inherited_prices():
    result = registry()
    graph = ReferenceGraph(result)
    rows = {row["model_name"]: row for row in package_rows()}
    provider_id = UUID("11111111-1111-4111-8111-111111111111")
    model_ids = {
        "doubao-seed-2-1-pro-260628": UUID("22222222-2222-4222-8222-222222222222"),
        "doubao-seed-2-1-turbo-260628": UUID("33333333-3333-4333-8333-333333333333"),
    }
    provider = ProviderSnapshot(
        id=provider_id,
        name="volcengine-doubao",
        provider_key="volcengine_doubao",
        display_name="Synthetic local provider",
        default_base_url="https://ark.cn-beijing.volces.com/api/v3",
        capability_domains=("chat",),
        scope="global",
        organization_id=None,
        user_id=None,
        routing_enabled=True,
        priority=1,
        routing_weight=100,
        runtime_status="healthy",
        runtime_cooldown_until=None,
        health_consecutive_failures=0,
    )
    models = tuple(
        ModelSnapshot(
            id=model_id,
            provider_id=provider_id,
            model_name=model_name,
            display_name="Synthetic local model",
            base_url="https://ark.cn-beijing.volces.com/api/v3",
            capability_domain="chat",
            context_window_tokens=262144,
            max_input_tokens=None,
            max_output_tokens=65536,
            billing_type="token",
            input_price_per_1k="9.99",
            output_price_per_1k="19.99",
            price_per_request="7.77",
            price_per_second="6.66",
            custom_billing_config=(("$.provider_default", '"must-not-inherit"'),),
            capabilities_config=(),
            wave_status="stable",
        )
        for model_name, model_id in model_ids.items()
    )
    snapshot = DatabaseSnapshot(providers=(provider,), models=models)

    for model_name, model_id in model_ids.items():
        row = rows[model_name]
        binding = next(
            item
            for item in result.items()
            if isinstance(item, ModelDeploymentBinding) and item.upstream_model_id == model_name
        )
        closure = graph.build([binding])
        deployment = next(item for item in closure if isinstance(item, DeploymentProfile))
        discovery = discover_bindings(
            deployment,
            binding,
            snapshot,
            reviewed_mapping=ReviewedBindingMapping(
                database_alias="default",
                provider_uuid=provider_id,
                model_uuid=model_id,
            ),
        )
        package = ProjectionPackage(
            package_key=binding.identity.key,
            deployment=deployment,
            binding=binding,
            closure=closure,
            blocking_issues=tuple(row["blocking_reasons"]),
        )
        plan = compile_projection(
            package,
            snapshot,
            discovery,
            clock=datetime(2026, 8, 6, tzinfo=timezone.utc),
        )

        output = next(field for field in plan.fields if field.path == "max_output_tokens")
        assert output.classification == "unmanaged"
        assert output.proposed == "unknown"
        assert output.current == "65536"
        assert not [field for field in plan.fields if field.classification == "commercial"]
        assert not [field for field in plan.fields if field.proposed in {"0", "0.0", "0.000000", "9.99", "19.99", "7.77", "6.66"}]
        assert {"max-output-unknown", "rate-card-unknown"} <= set(plan.blocking_issues)


def test_pr0_equivalent_kimi_model_values_match_golden():
    golden = json.loads((FIXTURES / "kimi/baseline.json").read_text(encoding="utf-8"))
    expected = {entry["value"]["model_name"]: entry["value"] for entry in golden["stable_golden"]["models"] if "context_window_tokens" in entry["value"]}
    capabilities = {item.model_family.replace("-k2-", "-k2."): item for item in registry().items() if item.identity.kind == "model-capability" and item.model_family.startswith("kimi-")}
    for model_name, values in expected.items():
        key = model_name.replace("kimi-k2.", "kimi-k2-")
        item = next(cap for cap in capabilities.values() if cap.model_family == key)
        assert item.context_window == values["context_window_tokens"]
        assert item.max_output_tokens == values["max_output_tokens"]


def test_pr0_equivalent_doubao_lite_values_match_golden():
    golden = json.loads((FIXTURES / "doubao/baseline.json").read_text(encoding="utf-8"))
    legacy = golden["stable_golden"]["models"][0]["value"]
    item = next(x for x in registry().items() if x.identity.kind == "model-capability" and x.model_family == "doubao-seed-2-0-lite")
    assert item.context_window == legacy["context_window_tokens"]
    assert item.max_output_tokens == legacy["max_output_tokens"]

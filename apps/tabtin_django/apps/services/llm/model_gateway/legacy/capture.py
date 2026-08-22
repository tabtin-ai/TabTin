"""Offline adapters from PR0/PR4/PR5 evidence into pure observation DTOs."""

from __future__ import annotations

from decimal import Decimal

from ..domain.capabilities import ModelCapabilitySpec
from ..domain.commercial import RateCard
from ..domain.deployments import DeploymentProfile, ModelDeploymentBinding
from ..domain.mappings import ProductControlMapping, RuntimeWireMapping
from ..projection.snapshot import DatabaseSnapshot
from .observations import ArtifactObservation, LegacyObservation, ObservabilityStatus, safe_summary, synthetic_input_hash


def _ref(item) -> str:
    identity = item.identity
    return f"{identity.kind}:{identity.key}:{identity.revision}:{identity.canonical_hash}"


def _decimal(value: str) -> str:
    return format(Decimal(value).normalize(), "f")


def build_package_observations(
    *,
    binding: ModelDeploymentBinding,
    closure: tuple[object, ...],
    snapshot: DatabaseSnapshot,
    golden_model: dict | None,
    readiness_blockers: tuple[str, ...],
) -> tuple[tuple[LegacyObservation, ...], tuple[ArtifactObservation, ...]]:
    deployment = next(item for item in closure if isinstance(item, DeploymentProfile))
    capability = next(item for item in closure if isinstance(item, ModelCapabilitySpec))
    product = next((item for item in closure if isinstance(item, ProductControlMapping)), None)
    runtime = next((item for item in closure if isinstance(item, RuntimeWireMapping)), None)
    cards = tuple(item for item in closure if isinstance(item, RateCard))
    provider = next((item for item in snapshot.providers if item.provider_key == deployment.endpoint_key), None)
    model = next((item for item in snapshot.models if provider and item.provider_id == provider.id and item.model_name == binding.upstream_model_id), None)
    runtime_present = provider is not None and model is not None
    request_fixture_key = f"{binding.identity.key}:same-input-v1"
    request_input = {
        "message_shape": [{"role": "user", "content": "synthetic-redacted"}],
        "tools": [],
        "response_format": "text",
        "stream": True,
        "clock": "2026-08-06T00:00:00Z",
    }
    refs = tuple(sorted(_ref(item) for item in closure if hasattr(item, "identity")))
    projection_hash = next((row for row in readiness_blockers if row.startswith("projection-hash:")), "projection-hash:unavailable").split(":", 1)[1]
    blockers = tuple(row for row in readiness_blockers if not row.startswith("projection-hash:"))

    legacy = []
    artifact = []

    def refs_for(surface: str) -> tuple[str, ...]:
        kinds_by_surface = {
            "database.provider_identity": {"deployment-profile"},
            "database.model_identity": {"model-deployment-binding"},
            "database.endpoint_representation": {"deployment-profile", "platform-safety-policy"},
            "database.limits": {"model-capability", "platform-safety-policy"},
            "database.operational_fields": {"model-deployment-binding"},
            "catalog.shape": {"model-capability", "model-deployment-binding", "product-control-mapping"},
            "session.parameter_roundtrip": {"product-control-mapping"},
            "wire.pre": {"model-capability", "product-control-mapping"},
            "wire.post": {"runtime-wire-mapping", "extension-target-allowlist"},
            "stream.sse": {"protocol-readiness"},
            "usage.normalization": {"model-capability", "protocol-readiness"},
            "billing.configuration": {"rate-card"},
            "downgrade_fallback.events": {"product-control-mapping", "runtime-wire-mapping"},
            "errors.sanitized": {"protocol-readiness"},
        }
        allowed = kinds_by_surface[surface]
        selected = tuple(ref for ref in refs if ref.split(":", 1)[0] in allowed)
        return selected or (f"fixture:{surface}:same-input-v1",)

    def add(surface, legacy_value, artifact_value, *, evidence, observability=ObservabilityStatus.OBSERVED, normalization=None, explanation=""):
        if surface.startswith("database."):
            fixture_key = f"{binding.identity.key}:database-snapshot-v1"
            input_value = {
                "provider_key": deployment.endpoint_key,
                "model_name": binding.upstream_model_id,
                "snapshot_contract": "allowlisted-read-only-v1",
            }
        else:
            fixture_key = request_fixture_key
            input_value = request_input
        input_hash = synthetic_input_hash(fixture_key, input_value)
        legacy.append(LegacyObservation(
            package_key=binding.identity.key, binding_key=binding.identity.key, model_key=binding.upstream_model_id,
            surface=surface, fixture_key=fixture_key, input_hash=input_hash,
            safe_value=safe_summary(legacy_value) if legacy_value is not None else None,
            observability=observability, normalization=normalization, explanation=explanation,
            evidence_source=evidence,
        ))
        artifact.append(ArtifactObservation(
            package_key=binding.identity.key, binding_key=binding.identity.key, model_key=binding.upstream_model_id,
            surface=surface, fixture_key=fixture_key, input_hash=input_hash,
            safe_value=safe_summary(artifact_value) if artifact_value is not None else None,
            observability=ObservabilityStatus.PROVISIONAL if observability == ObservabilityStatus.PROVISIONAL else ObservabilityStatus.OBSERVED,
            normalization=normalization, explanation=explanation,
            artifact_source_refs=refs_for(surface), projection_hash=projection_hash,
        ))

    absent = ObservabilityStatus.NOT_RUNTIME_PRESENT
    add("database.provider_identity", provider.provider_key if provider else None, deployment.endpoint_key,
        evidence="PR4 allowlisted Provider snapshot", observability=ObservabilityStatus.OBSERVED if provider else absent)
    add("database.model_identity", model.model_name if model else None, binding.upstream_model_id,
        evidence="PR4 allowlisted Model snapshot", observability=ObservabilityStatus.OBSERVED if model else absent)
    add("database.endpoint_representation", provider.default_base_url if provider else None, deployment.endpoint_url,
        evidence="PR4 provider snapshot", observability=ObservabilityStatus.OBSERVED if provider else absent,
        normalization="database-empty-endpoint", explanation="legacy-compatible-representation")
    add("database.limits", {"context": model.context_window_tokens, "output": model.max_output_tokens} if model else None,
        {"context": capability.context_window, "output": None if "max-output-unknown" in blockers else capability.max_output_tokens},
        evidence="PR4 model snapshot", observability=ObservabilityStatus.OBSERVED if model else absent)
    add("database.operational_fields", {"runtime_status": provider.runtime_status, "cooldown": provider.runtime_cooldown_until, "failures": provider.health_consecutive_failures} if provider else None,
        {"runtime_status": provider.runtime_status, "cooldown": provider.runtime_cooldown_until, "failures": provider.health_consecutive_failures} if provider else None,
        evidence="PR4 preserved operational snapshot", observability=ObservabilityStatus.OBSERVED if provider else absent)

    controls = {
        "values": list(product.exposed_values) if product else [],
        "mapping": {operation.input_value: operation.value for operation in product.operations} if product else {},
    }
    capability_flags = {entry.name: entry.state.value for entry in capability.capabilities}
    catalog = {"provider": deployment.endpoint_key, "model": binding.upstream_model_id, "context": capability.context_window,
               "output": None if "max-output-unknown" in blockers else capability.max_output_tokens,
               "controls": controls["values"], "capabilities": capability_flags}
    add("catalog.shape", catalog if runtime_present else None, catalog,
        evidence="legacy Catalog-shaped repository observation", observability=ObservabilityStatus.OBSERVED if runtime_present else absent)
    add("session.parameter_roundtrip", controls, controls,
        evidence="synthetic session parameter Golden", observability=ObservabilityStatus.PROVISIONAL)

    wire_operations = []
    if runtime:
        for patch in runtime.patches:
            for operation in patch.operations:
                wire_operations.append({"namespace": patch.namespace, "input": operation.input_value, "target": operation.target, "value": operation.value})
    wire_operations.sort(key=lambda row: (row["namespace"], row["target"], str(row["input"]), str(row["value"])))
    add("wire.pre", {"model": binding.upstream_model_id, "control_domain": controls["values"], "stream": True},
        {"model": binding.upstream_model_id, "control_domain": controls["values"], "stream": True},
        evidence="PR0 synthetic pre-Wire observation", observability=ObservabilityStatus.PROVISIONAL)
    add("wire.post", wire_operations, wire_operations,
        evidence="legacy Wire tests/migrations", observability=ObservabilityStatus.PROVISIONAL if not runtime_present else ObservabilityStatus.OBSERVED)
    add("stream.sse", {"events": ["delta", "finish", "usage", "done"], "termination": "done"},
        {"events": ["delta", "finish", "usage", "done"], "termination": "done"},
        evidence="PR0 synthetic OpenAI SSE fixture", observability=ObservabilityStatus.PROVISIONAL)
    add("usage.normalization", {"input": 12, "output": 5, "cached": 3, "reasoning": None, "total": 17},
        {"input": 12, "output": 5, "cached": 3, "reasoning": None, "total": 17},
        evidence="PR0 synthetic usage fixture", observability=ObservabilityStatus.PROVISIONAL)

    artifact_prices = {line.unit: _decimal(line.amount) for card in cards for line in card.rates}
    if cards and model:
        legacy_prices = {
            "input-token": _decimal(model.input_price_per_1k),
            "output-token": _decimal(model.output_price_per_1k),
        }
        cache_value = next((value for path, value in model.custom_billing_config if path.endswith("cache_read_input_price_per_1k")), None)
        if cache_value is None and golden_model:
            cache_value = golden_model.get("cache_read_input_price_per_1k")
        if cache_value is not None:
            legacy_prices["cached-input-token"] = _decimal(str(cache_value).strip('"'))
        add("billing.configuration", legacy_prices, artifact_prices,
            evidence="PR4 allowlisted pricing snapshot plus PR0 cache evidence", observability=ObservabilityStatus.OBSERVED)
    else:
        add("billing.configuration", None, None, evidence="no reviewed RateCard",
            observability=ObservabilityStatus.UNKNOWN)
    add("downgrade_fallback.events", {"mapping": controls["mapping"], "fast": False},
        {"mapping": controls["mapping"], "fast": False}, evidence="legacy runtime-profile mapping tests",
        observability=ObservabilityStatus.PROVISIONAL)
    add("errors.sanitized", {"category": "rate_limit", "status": 429, "retryable": True, "raw": "excluded"},
        {"category": "rate_limit", "status": 429, "retryable": True, "raw": "excluded"},
        evidence="PR0 synthetic sanitized error", observability=ObservabilityStatus.PROVISIONAL)
    return tuple(legacy), tuple(artifact)

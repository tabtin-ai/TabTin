"""Offline semantic validation; no provider or runtime execution."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Iterable

from ..domain._base import ConditionNode, SupportState
from ..domain.capabilities import ModelCapabilitySpec
from ..domain.commercial import RateCard
from ..domain.deployments import DeploymentProfile, ModelDeploymentBinding
from ..domain.diagnostics import StructuralDiagnostic
from ..domain.mappings import ProductControlMapping, RuntimeWireMapping
from ..domain.protocols import ExtensionTargetAllowlist, ProtocolReadinessSpec
from ..domain.rollout import RolloutPolicy


def _issue(code: str, artifact, path: str, message: str, severity: str = "blocking") -> StructuralDiagnostic:
    return StructuralDiagnostic(severity=severity, rule_code=code, artifact=artifact.identity, path=path, message=message)


def validate_artifacts(artifacts: Iterable[object]) -> tuple[StructuralDiagnostic, ...]:
    artifacts = tuple(artifacts)
    issues: list[StructuralDiagnostic] = []
    for artifact in sorted(artifacts, key=lambda a: (a.identity.kind, a.identity.key, a.identity.revision)):
        if artifact.schema_version != "1": issues.append(_issue("unknown_schema_version", artifact, "schema_version", "schema version is not supported"))
        if getattr(artifact, "lifecycle", None) and str(artifact.lifecycle) == "deprecated" and (getattr(artifact, "sunset_at", None) is None or getattr(artifact, "replacement_ref", None) is None):
            issues.append(_issue("deprecated_metadata_missing", artifact, "lifecycle", "deprecated artifacts require sunset and exact replacement metadata"))
        if isinstance(artifact, ModelCapabilitySpec):
            names = {entry.name: entry for entry in artifact.capabilities}
            if len(names) != len(artifact.capabilities): issues.append(_issue("duplicate_capability", artifact, "capabilities", "capability names must be unique"))
            for entry in artifact.capabilities:
                path = f"capabilities.{entry.name}"
                family = entry.family or entry.name
                if entry.state == SupportState.FORCED and family not in {"thinking", "performance"}:
                    issues.append(_issue("forced_state_illegal", artifact, path, "forced is not legal for this capability family"))
                if entry.state == SupportState.FORCED and entry.user_controllable:
                    issues.append(_issue("forced_user_control", artifact, path, "forced capability cannot be user controllable"))
                if entry.state == SupportState.CONDITIONAL:
                    if not entry.conditions: issues.append(_issue("conditional_without_conditions", artifact, path, "conditional requires non-empty conditions"))
                    for condition in entry.conditions: issues.extend(_validate_condition(artifact, path, condition))
                if entry.state == SupportState.UNKNOWN and (entry.default_value or entry.runtime_mapping_ref):
                    issues.append(_issue("unknown_executable_default", artifact, path, "unknown state cannot carry executable defaults"))
                if entry.state == SupportState.UNSUPPORTED and (entry.user_controllable or entry.runtime_mapping_ref or entry.factual_values):
                    issues.append(_issue("unsupported_executable_surface", artifact, path, "unsupported capability cannot expose controls or mappings"))
                if family == "thinking": issues.extend(_validate_thinking(artifact, path, entry))
                if family == "performance": issues.extend(_validate_performance(artifact, path, entry))
                if family in {"document", "image", "audio", "video"}: issues.extend(_validate_media(artifact, path, entry))
        elif isinstance(artifact, ProtocolReadinessSpec) and artifact.protocol_type == "custom":
            issues.append(_issue("custom_protocol_fail_closed", artifact, "protocol_type", "custom protocol is reserved and non-executable in v1"))
        elif isinstance(artifact, ProtocolReadinessSpec):
            for field in ("protocol_options_schema", "adapter_key", "adapter_version", "contract_evidence_ref", "allowlist_ref"):
                if getattr(artifact, field) is None: issues.append(_issue("readiness_binding_missing", artifact, field, "protocol readiness requires exact offline binding"))
            if any(token in (artifact.adapter_key or "") for token in ("provider", "sdk", "domain")):
                issues.append(_issue("readiness_identity_inference", artifact, "adapter_key", "adapter identity cannot infer provider, endpoint domain, or SDK"))
        elif isinstance(artifact, RuntimeWireMapping):
            if artifact.capability_ref is None: issues.append(_issue("runtime_capability_binding_missing", artifact, "capability_ref", "runtime mapping requires exact capability binding"))
            for index, patch in enumerate(artifact.patches):
                inputs = [op.input_value for op in patch.operations if op.input_value]
                if len(inputs) != len(set(inputs)): issues.append(_issue("overlapping_mapping_branch", artifact, f"patches[{index}]", "mapping input branches must not overlap"))
                for op in patch.operations:
                    if op.target.split(".", 1)[0] in {"model", "messages", "stream", "tools", "tool_choice", "auth", "path", "method"}:
                        issues.append(_issue("base_field_denied", artifact, f"patches[{index}].operations", "base protocol fields cannot be extension targets"))
                    if op.target.startswith("request."):
                        issues.append(_issue("generic_namespace_denied", artifact, f"patches[{index}].operations", "generic request namespace is not allowed"))
                    if op.operation in {"rename", "copy"} and op.target in {"model", "deployment"}:
                        issues.append(_issue("selection_operation_denied", artifact, f"patches[{index}].operations", "wire mapping cannot select model or deployment"))
        elif isinstance(artifact, ProductControlMapping):
            if any(op.target.startswith(("request.", "protocol.")) for op in artifact.operations):
                issues.append(_issue("product_mapping_protocol_dependency", artifact, "operations", "product mapping must be protocol independent"))
            mapped = [op.input_value for op in artifact.operations if op.input_value]
            for value in artifact.exposed_values:
                if mapped.count(value) != 1: issues.append(_issue("product_value_mapping_cardinality", artifact, "exposed_values", "each product value must map exactly once"))
        elif isinstance(artifact, ExtensionTargetAllowlist):
            denied = {"model", "messages", "stream", "tools", "tool_choice", "path", "method", "auth", "usage"}
            if denied.intersection(artifact.targets): issues.append(_issue("allowlist_base_field_denied", artifact, "targets", "base protocol fields are permanently denied"))
            if artifact.protocol_type == "custom": issues.append(_issue("custom_protocol_fail_closed", artifact, "protocol_type", "custom protocol is reserved and non-executable in v1"))
            for field in ("adapter_key", "adapter_version", "mapping_schema_ref"):
                if getattr(artifact, field) is None: issues.append(_issue("allowlist_binding_missing", artifact, field, "allowlist requires exact adapter and schema binding"))
        elif isinstance(artifact, ModelDeploymentBinding):
            if not artifact.upstream_model_id.strip(): issues.append(_issue("empty_upstream_model_id", artifact, "upstream_model_id", "upstream model ID is required"))
        elif isinstance(artifact, DeploymentProfile):
            if artifact.endpoint_url and artifact.endpoint_policy_ref is None:
                issues.append(_issue("endpoint_policy_ref_missing", artifact, "endpoint_policy_ref", "deployment endpoint requires an exact trusted security policy reference"))
            if artifact.credential_type not in {"bearer", "single-token"}:
                issues.append(_issue("credential_type_fail_closed", artifact, "credential_type", "only bearer and single-token credential declarations are supported"))
            if any(marker in artifact.credential_pool_ref.pool_key for marker in ("secret", "token-value", "api-key", "ak-sk", "oauth", "service-account")):
                issues.append(_issue("credential_payload_forbidden", artifact, "credential_pool_ref", "credential pool must be an opaque reference"))
        elif isinstance(artifact, RateCard):
            if artifact.validity.valid_until and artifact.validity.valid_from >= artifact.validity.valid_until:
                issues.append(_issue("invalid_rate_interval", artifact, "validity", "rate validity interval must be half-open and increasing"))
            for index, line in enumerate(artifact.rates):
                try: Decimal(line.amount)
                except InvalidOperation: issues.append(_issue("invalid_decimal", artifact, f"rates[{index}].amount", "rate amount must be a decimal string"))
            if artifact.pricing_scheme == "non-billed" and not artifact.non_billed_reason:
                issues.append(_issue("non_billed_reason_missing", artifact, "non_billed_reason", "non-billed pricing requires an explicit exemption reason"))
            if artifact.pricing_scheme == "metered" and not artifact.rates:
                issues.append(_issue("metered_rates_missing", artifact, "rates", "metered pricing requires rate lines"))
        elif hasattr(artifact, "provider_maximum_verified"):
            if not (artifact.provider_maximum_verified and artifact.provider_maximum is not None) and not (artifact.platform_ceiling_verified and artifact.platform_ceiling_enforceable and artifact.platform_ceiling is not None):
                issues.append(_issue("verified_safety_ceiling_missing", artifact, "safety", "base readiness requires a verified provider maximum or enforceable platform ceiling"))
            if artifact.provider_maximum == 4096 and not artifact.provider_maximum_verified:
                issues.append(_issue("guessed_limit_forbidden", artifact, "provider_maximum", "unverified guessed hard limit cannot be executable"))
        elif isinstance(artifact, RolloutPolicy) and not 0 <= artifact.percentage_basis_points <= 10000:
            issues.append(_issue("invalid_rollout_percentage", artifact, "percentage_basis_points", "rollout must be between 0 and 10000 basis points"))
    issues.extend(_validate_rate_overlaps(artifacts))
    issues.extend(_validate_cross_artifact_bindings(artifacts))
    return tuple(sorted(issues, key=lambda i: (i.artifact.kind if i.artifact else "", i.artifact.key if i.artifact else "", i.rule_code, i.path)))


def _validate_condition(artifact, path: str, node: ConditionNode) -> list[StructuralDiagnostic]:
    issues = []
    intrinsic = {"request.modality", "request.input_tokens", "request.has_tools", "organization.tier", "deployment.tags"}
    if node.operator in {"equals", "present"} and node.field not in intrinsic:
        issues.append(_issue("condition_axis_forbidden", artifact, path, "condition uses a non-intrinsic axis"))
    if node.operator in {"all", "any", "not"} and not node.children:
        issues.append(_issue("condition_children_missing", artifact, path, "logical condition requires children"))
    if node.field and any(x in node.field for x in ("channel", "account", "credential", "endpoint", "provider", "deployment.id")):
        issues.append(_issue("condition_concrete_identity", artifact, path, "condition cannot contain concrete deployment identities"))
    for child in node.children: issues.extend(_validate_condition(artifact, path, child))
    return issues


def _validate_thinking(artifact, path, entry):
    issues = []
    keys = [value.key for value in entry.factual_values]
    orders = [value.order for value in entry.factual_values]
    if entry.shape == "unsupported" and entry.state != SupportState.UNSUPPORTED: issues.append(_issue("thinking_shape_state_mismatch", artifact, path, "unsupported shape requires unsupported state"))
    if entry.shape == "binary_toggle" and keys != ["off", "on"]: issues.append(_issue("thinking_binary_domain", artifact, path, "binary thinking domain must be exactly off/on"))
    if entry.shape == "effort_ladder" and (len(keys) < 2 or len(keys) != len(set(keys))): issues.append(_issue("thinking_effort_domain", artifact, path, "effort ladder requires at least two unique values"))
    if len(orders) != len(set(orders)): issues.append(_issue("thinking_value_order", artifact, path, "factual value order must be unique"))
    if entry.default_value and entry.default_value not in keys: issues.append(_issue("thinking_default_outside_domain", artifact, path, "default must exist in factual domain"))
    if entry.shape in {"forced", "fixed"} and entry.user_controllable: issues.append(_issue("thinking_fixed_user_control", artifact, path, "forced/fixed thinking cannot be user controlled"))
    if entry.shape == "token_budget":
        b = entry.budget
        if not b or not (0 <= b.minimum <= b.default <= b.maximum) or b.step <= 0: issues.append(_issue("thinking_budget_invalid", artifact, path, "token budget min/default/max/step are inconsistent"))
    if entry.shape == "model_split" and not entry.selection_refs: issues.append(_issue("thinking_model_split_refs", artifact, path, "model_split requires exact selection references"))
    if entry.user_controllable and entry.state not in {SupportState.UNSUPPORTED, SupportState.UNKNOWN} and entry.runtime_mapping_ref is None: issues.append(_issue("thinking_runtime_mapping_missing", artifact, path, "executable thinking control requires exact runtime mapping"))
    if any(not value.evidence for value in entry.factual_values): issues.append(_issue("thinking_evidence_missing", artifact, path, "factual values require evidence"))
    return issues


def _validate_performance(artifact, path, entry):
    issues = []
    if entry.shape != "service_profiles": issues.append(_issue("performance_shape_invalid", artifact, path, "performance requires explicit service profile shape"))
    if any(tag.startswith(("model-", "endpoint-", "provider-")) for tag in entry.deployment_tags): issues.append(_issue("performance_concrete_tag", artifact, path, "performance deployment requirements must use abstract tags"))
    if entry.fallback_policy is None: issues.append(_issue("performance_fallback_missing", artifact, path, "performance fallback policy must be explicit"))
    if entry.runtime_mapping_ref is not None: issues.append(_issue("performance_request_mapping", artifact, path, "dedicated performance selection cannot be represented as vendor request fields"))
    if entry.user_controllable and not entry.eligible_rate_card_refs: issues.append(_issue("performance_rate_card_refs", artifact, path, "exposed performance profiles require exact eligible RateCard references"))
    return issues


def _validate_media(artifact, path, entry):
    issues = []
    if entry.native_state is None or entry.preprocessing_state is None: issues.append(_issue("media_support_separation", artifact, path, "native and preprocessing support must be declared separately"))
    if entry.preprocessing_state == SupportState.SUPPORTED and entry.preprocessing_ref is None: issues.append(_issue("media_preprocessing_ref", artifact, path, "preprocessing support requires an exact profile reference"))
    if entry.preprocessing_state == SupportState.SUPPORTED and entry.retention_ref is None: issues.append(_issue("media_retention_ref", artifact, path, "preprocessing support requires an exact retention/lifecycle reference"))
    if entry.state == SupportState.SUPPORTED and not entry.transports: issues.append(_issue("media_transport_missing", artifact, path, "supported media requires explicit transports"))
    if entry.state == SupportState.SUPPORTED and not entry.mime_types: issues.append(_issue("media_mime_missing", artifact, path, "supported media requires MIME declarations"))
    if entry.preprocessing_state == SupportState.SUPPORTED and entry.native_state == SupportState.SUPPORTED and not entry.evidence: issues.append(_issue("native_support_evidence_missing", artifact, path, "preprocessing cannot establish native support without evidence"))
    return issues


def _validate_rate_overlaps(artifacts):
    cards = [item for item in artifacts if isinstance(item, RateCard)]
    issues = []
    for index, left in enumerate(cards):
        for right in cards[index + 1:]:
            if (left.binding_ref, left.deployment_ref, left.service_profile) != (right.binding_ref, right.deployment_ref, right.service_profile): continue
            l_end = left.validity.valid_until or datetime.max.replace(tzinfo=left.validity.valid_from.tzinfo)
            r_end = right.validity.valid_until or datetime.max.replace(tzinfo=right.validity.valid_from.tzinfo)
            if left.validity.valid_from < r_end and right.validity.valid_from < l_end:
                issues.append(_issue("rate_card_overlap", right, "validity", "rate cards overlap for identical commercial dimensions"))
    return issues


def _validate_cross_artifact_bindings(artifacts):
    index = {(item.identity.kind, item.identity.key, item.identity.revision): item for item in artifacts}
    issues = []
    for item in artifacts:
        if isinstance(item, ProtocolReadinessSpec) and item.allowlist_ref:
            target = index.get((item.allowlist_ref.kind, item.allowlist_ref.key, item.allowlist_ref.revision))
            if isinstance(target, ExtensionTargetAllowlist):
                if target.protocol_type != item.protocol_type or target.adapter_key != item.adapter_key or target.adapter_version != item.adapter_version:
                    issues.append(_issue("readiness_allowlist_incompatible", item, "allowlist_ref", "readiness and allowlist protocol/adapter bindings must agree"))
        if isinstance(item, RuntimeWireMapping) and item.capability_ref:
            target = index.get((item.capability_ref.kind, item.capability_ref.key, item.capability_ref.revision))
            if isinstance(target, ModelCapabilitySpec):
                factual = {value.key for entry in target.capabilities for value in entry.factual_values}
                consumed = {op.input_value for patch in item.patches for op in patch.operations if op.input_value}
                if factual and factual != consumed:
                    issues.append(_issue("runtime_factual_coverage", item, "patches", "runtime mapping must cover the declared factual input domain exactly"))
    return issues

"""Completely read-only, offline legacy-versus-Draft comparison."""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from ...model_gateway.domain.commercial import RateCard
from ...model_gateway.domain.deployments import DeploymentProfile, ModelDeploymentBinding
from ...model_gateway.domain.mappings import ProductControlMapping, RuntimeWireMapping
from ...model_gateway.legacy.capture import build_package_observations
from ...model_gateway.legacy.reporting import render_results
from ...model_gateway.legacy.shadow import compare_observations
from ...model_gateway.loading.registry import ArtifactRegistry
from ...model_gateway.projection.snapshot import DatabaseSnapshot, read_database_snapshot
from ...model_gateway.reference_graph import ReferenceGraph
from ...model_gateway.validation.semantic import validate_artifacts


class Command(BaseCommand):
    help = "Compare legacy observations with Draft Artifacts without runtime or write side effects."

    def add_arguments(self, parser):
        parser.add_argument("--artifact-root", required=True)
        parser.add_argument("--legacy-fixture-root", required=True)
        parser.add_argument("--package")
        parser.add_argument("--database", default="default")
        parser.add_argument("--format", choices=("text", "json", "jsonl"), default="text")

    def handle(self, *args, **options):
        artifact_root = Path(options["artifact_root"]).resolve()
        fixture_root = Path(options["legacy_fixture_root"]).resolve()
        if not artifact_root.is_dir() or not fixture_root.is_dir():
            raise CommandError("artifact and fixture roots must be directories")
        registry = ArtifactRegistry(artifact_root)
        if registry.issues:
            raise CommandError("artifact registry is invalid")
        bindings = [item for item in registry.items() if isinstance(item, ModelDeploymentBinding)]
        if options.get("package"):
            bindings = [item for item in bindings if item.identity.key == options["package"]]
        bindings.sort(key=lambda item: item.identity.key)
        if not bindings:
            self.stdout.write(render_results((), format=options["format"]), ending="")
            return

        package_rows = _package_rows(artifact_root)
        golden_models = _golden_models(fixture_root)
        prepared = []
        graph = ReferenceGraph(registry)
        for binding in bindings:
            closure = graph.build([binding])
            related = tuple(item for item in registry.items() if _exact_related(item, binding))
            closure = tuple(sorted(set(closure + related), key=lambda item: (item.identity.kind, item.identity.key, item.identity.revision)))
            deployment = next(item for item in closure if isinstance(item, DeploymentProfile))
            prepared.append((binding, deployment, closure))
        snapshot = read_database_snapshot(
            provider_keys=tuple(sorted({deployment.endpoint_key for _, deployment, _ in prepared})),
            model_names=tuple(sorted({binding.upstream_model_id for binding, _, _ in prepared})),
            using=options["database"],
        ) if prepared else DatabaseSnapshot(providers=(), models=())

        results = []
        for binding, _deployment, closure in prepared:
            row = package_rows.get(binding.identity.key, {})
            semantic = validate_artifacts(closure)
            readiness = set(row.get("blocking_reasons", ()))
            readiness.update(issue.rule_code for issue in semantic if issue.severity == "blocking")
            projection_hash = row.get("projection_hash")
            if projection_hash:
                readiness.add(f"projection-hash:{projection_hash}")
            legacy, artifact = build_package_observations(
                binding=binding,
                closure=closure,
                snapshot=snapshot,
                golden_model=golden_models.get(binding.upstream_model_id),
                readiness_blockers=tuple(sorted(readiness)),
            )
            results.append(compare_observations(
                legacy,
                artifact,
                readiness_blockers=tuple(sorted(item for item in readiness if not item.startswith("projection-hash:"))),
            ))
        output = render_results(tuple(results), format=options["format"])
        self.stdout.write(output, ending="")
        if any(result.behavior_blockers for result in results):
            raise CommandError("behavior-blocking mismatch found")


def _exact_related(item, binding) -> bool:
    if isinstance(item, RateCard):
        reference = item.binding_ref
        target = binding.identity
    elif isinstance(item, (ProductControlMapping, RuntimeWireMapping)):
        reference = item.capability_ref
        target = binding.capability_ref
        if reference is None:
            return False
        return (
            reference.kind == target.kind
            and reference.key == target.key
            and reference.revision == target.revision
            and reference.expected_hash == target.expected_hash
        )
    else:
        return False
    return (
        reference.kind == target.kind
        and reference.key == target.key
        and reference.revision == target.revision
        and reference.expected_hash == target.canonical_hash
    )


def _package_rows(root: Path) -> dict[str, dict]:
    rows = {}
    for path in sorted(root.glob("*/packages/index.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            binding = next(ref for ref in row["artifact_refs"] if ref["kind"] == "model-deployment-binding")
            rows[binding["key"]] = row
    for path in sorted(root.glob("*/evidence/local-diff-summary.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            for binding_key, package in rows.items():
                if package["package_key"] == row["package_key"]:
                    package["projection_hash"] = row.get("projection_hash")
    return rows


def _golden_models(root: Path) -> dict[str, dict]:
    models = {}
    for path in sorted(root.rglob("baseline.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        for row in payload.get("stable_golden", {}).get("models", ()):
            value = row.get("value", {})
            if value.get("model_name"):
                models[value["model_name"]] = value
    return models

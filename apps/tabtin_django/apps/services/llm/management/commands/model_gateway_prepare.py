import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from ...model_gateway.apply import ReviewedBindingMapping, prepare_projection_revision
from ...model_gateway.apply.results import ProjectionOperationRejected
from ...model_gateway.domain.commercial import RateCard
from ...model_gateway.domain.deployments import ModelDeploymentBinding
from ...model_gateway.loading.registry import ArtifactRegistry
from ...model_gateway.projection.compiler import ProjectionPackage, compile_projection
from ...model_gateway.projection.identities import ReviewedBindingMapping as CompilerMapping, discover_bindings
from ...model_gateway.projection.snapshot import read_database_snapshot
from ...model_gateway.reference_graph import ReferenceGraph
from ...model_gateway.validation.secret_scanner import scan_raw_tree
from ...model_gateway.validation.semantic import validate_artifacts
from ._model_gateway_write import emit_result, reject_safely


class Command(BaseCommand):
    help = "Prepare one exact immutable Model Gateway projection revision."

    def add_arguments(self, parser):
        parser.add_argument("--artifact-root", required=True)
        parser.add_argument("--package", required=True)
        parser.add_argument("--mapping-file", required=True)
        parser.add_argument("--database", required=True)
        parser.add_argument("--revision", required=True, type=int)
        parser.add_argument("--expected-projection-hash", required=True)
        parser.add_argument("--actor", required=True)
        parser.add_argument("--ticket", required=True)
        parser.add_argument("--confirm-hash", required=True)

    def handle(self, *args, **options):
        if options["confirm_hash"] != options["expected_projection_hash"]:
            raise CommandError("confirmation-hash-mismatch")
        try:
            raw_mapping = json.loads(Path(options["mapping_file"]).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CommandError("mapping-file-invalid") from exc
        if scan_raw_tree(raw_mapping, "reviewed-binding-mapping"):
            raise CommandError("mapping-secret-scan-blocked")
        try:
            mapping = ReviewedBindingMapping.from_json(raw_mapping)
            if mapping.database_alias != options["database"]:
                raise ProjectionOperationRejected("mapping-database-mismatch")
            if mapping.existing_provider_uuid is None or mapping.existing_model_uuid is None:
                raise ProjectionOperationRejected("create-target-not-supported")
            root = Path(options["artifact_root"]).resolve()
            registry = ArtifactRegistry(root)
            bindings = [item for item in registry.items() if isinstance(item, ModelDeploymentBinding) and item.identity.key == options["package"]]
            if len(bindings) != 1:
                raise ProjectionOperationRejected("exact-package-not-found")
            binding = bindings[0]
            closure = ReferenceGraph(registry).build([binding])
            closure += tuple(
                item for item in registry.items() if isinstance(item, RateCard)
                and item.binding_ref.key == binding.identity.key
                and item.binding_ref.revision == binding.identity.revision
                and item.binding_ref.expected_hash == binding.identity.canonical_hash
            )
            closure = tuple(sorted(set(closure), key=lambda item: (item.identity.kind, item.identity.key, item.identity.revision)))
            deployment = next((item for item in closure if item.identity.kind == "deployment-profile"), None)
            if deployment is None:
                raise ProjectionOperationRejected("deployment-missing")
            snapshot = read_database_snapshot(
                provider_keys=(deployment.endpoint_key,), model_names=(binding.upstream_model_id,), using=options["database"],
            )
            discovery = discover_bindings(
                deployment, binding, snapshot, database_alias=options["database"],
                reviewed_mapping=CompilerMapping(
                    database_alias=options["database"], provider_uuid=mapping.existing_provider_uuid,
                    model_uuid=mapping.existing_model_uuid,
                ),
            )
            semantic = validate_artifacts(closure)
            blockers = tuple(sorted({issue.rule_code for issue in semantic if issue.severity == "blocking"}))
            warnings = tuple(sorted({issue.rule_code for issue in semantic if issue.severity == "warning"}))
            plan = compile_projection(
                ProjectionPackage(package_key=mapping.package_key, deployment=deployment, binding=binding,
                                  closure=closure, blocking_issues=blockers, warnings=warnings),
                snapshot, discovery, clock=timezone.now(),
            )
            result = prepare_projection_revision(
                plan=plan, mapping=mapping, revision_number=options["revision"],
                expected_projection_hash=options["expected_projection_hash"], actor=options["actor"],
                ticket=options["ticket"], prepared_at=timezone.now(),
            )
        except ProjectionOperationRejected as exc:
            reject_safely(exc)
        emit_result(self, result)

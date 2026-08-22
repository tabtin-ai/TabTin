"""Read-only Model Gateway artifact/database projection diff."""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from ...model_gateway.domain.deployments import ModelDeploymentBinding
from ...model_gateway.domain.commercial import RateCard
from ...model_gateway.domain.security import EndpointSecurityPolicy
from ...model_gateway.loading.registry import ArtifactRegistry
from ...model_gateway.reference_graph import ReferenceGraph
from ...model_gateway.projection.compiler import ProjectionPackage, compile_projection
from ...model_gateway.projection.diff import render_projection_diff
from ...model_gateway.projection.identities import discover_bindings
from ...model_gateway.projection.snapshot import read_database_snapshot
from ...model_gateway.projection.snapshot import DatabaseSnapshot
from ...model_gateway.validation.semantic import validate_artifacts
from ...model_gateway.validation.endpoints import validate_endpoint
from ...model_gateway.validation.secret_scanner import scan_artifact_file


class Command(BaseCommand):
    help="Render a read-only database projection proposal."

    def add_arguments(self,parser):
        parser.add_argument("--artifact-root",required=True)
        parser.add_argument("--package")
        parser.add_argument("--format",choices=("text","json"),default="text")
        parser.add_argument("--database",default="default")

    def handle(self,*args,**options):
        root=Path(options["artifact_root"]).resolve()
        if not root.is_dir(): raise CommandError("artifact root must be an existing directory")
        registry=ArtifactRegistry(root); roots=[x for x in registry.items() if isinstance(x,ModelDeploymentBinding)]
        if options.get("package"): roots=[x for x in roots if x.identity.key==options["package"]]
        provider_keys=[]; model_names=[]; prepared=[]; blocking=[issue.code for issue in registry.issues]
        for path in sorted(item for item in root.rglob("*") if item.is_file() and item.suffix in {".json",".yaml",".yml"}): blocking.extend(finding.rule_code for finding in scan_artifact_file(path) if finding.severity=="blocking")
        endpoint_policy=getattr(self,"endpoint_policy",EndpointSecurityPolicy()); endpoint_resolver=getattr(self,"endpoint_resolver",None)
        for binding in roots:
            graph=ReferenceGraph(registry); closure=graph.build([binding]); blocking.extend(issue.code for issue in graph.issues)
            rate_cards = tuple(
                item
                for item in registry.items()
                if isinstance(item, RateCard)
                and item.binding_ref.kind == binding.identity.kind
                and item.binding_ref.key == binding.identity.key
                and item.binding_ref.revision == binding.identity.revision
                and item.binding_ref.expected_hash == binding.identity.canonical_hash
            )
            closure = tuple(sorted(set(closure + rate_cards), key=lambda item: (item.identity.kind, item.identity.key, item.identity.revision)))
            deployment=next((x for x in closure if x.identity.kind=="deployment-profile"),None)
            if deployment is None: blocking.append(f"{binding.identity.key}:deployment-missing"); continue
            if deployment.endpoint_url:
                endpoint_result=validate_endpoint(deployment.endpoint_url,region=deployment.region,policy=endpoint_policy,resolver=endpoint_resolver)
                blocking.extend(issue.rule_code for issue in endpoint_result.diagnostics if issue.severity=="blocking")
            provider_keys.append(deployment.endpoint_key); model_names.append(binding.upstream_model_id); prepared.append((binding,deployment,closure))
        snapshot=read_database_snapshot(provider_keys=tuple(sorted(set(provider_keys))),model_names=tuple(sorted(set(model_names))),using=options["database"]) if prepared else DatabaseSnapshot(providers=(),models=())
        plans=[]
        for binding,deployment,closure in prepared:
            semantic=validate_artifacts(closure); issues=tuple(sorted({x.rule_code for x in semantic if x.severity=="blocking"}|set(blocking)))
            warnings=tuple(sorted({x.rule_code for x in semantic if x.severity=="warning"}))
            reviewed_mappings = getattr(self, "reviewed_mappings", {})
            discovery=discover_bindings(
                deployment,
                binding,
                snapshot,
                database_alias=options["database"],
                reviewed_mapping=reviewed_mappings.get(binding.identity.key),
            )
            package=ProjectionPackage(package_key=binding.identity.key,deployment=deployment,binding=binding,closure=closure,blocking_issues=issues,warnings=warnings)
            plans.append(compile_projection(package,snapshot,discovery,clock=timezone.now()))
        plans.sort(key=lambda x:x.package_key)
        if options["format"]=="json": self.stdout.write(json.dumps({"plans":[json.loads(render_projection_diff(plan,format="json")) for plan in plans],"blocking":bool(blocking) or any(plan.blocking_issues for plan in plans)},ensure_ascii=False,sort_keys=True,separators=(",",":")))
        else:
            for plan in plans: self.stdout.write(render_projection_diff(plan,format="text"),ending="")
            for issue in sorted(set(blocking)): self.stdout.write(f"blocking {issue}")
        if blocking or any(plan.blocking_issues for plan in plans): raise CommandError("blocking projection issues found")

"""Filesystem-only Model Gateway validation command."""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from ...model_gateway.loading.registry import ArtifactRegistry
from ...model_gateway.reference_graph import ReferenceGraph
from ...model_gateway.validation.semantic import validate_artifacts
from ...model_gateway.validation.endpoints import validate_endpoint
from ...model_gateway.validation.secret_scanner import scan_artifact_file
from ...model_gateway.domain.deployments import DeploymentProfile
from ...model_gateway.domain.security import EndpointSecurityPolicy


class Command(BaseCommand):
    help = "Validate Model Gateway artifacts from a filesystem root without DB or network access."

    def add_arguments(self, parser):
        parser.add_argument("--artifact-root", required=True)
        parser.add_argument("--format", choices=("text", "json"), default="text")

    def handle(self, *args, **options):
        root = Path(options["artifact_root"]).resolve()
        if not root.is_dir(): raise CommandError("artifact root must be an existing directory")
        registry = ArtifactRegistry(root)
        diagnostics = [{"severity": "blocking", "rule_code": issue.code, "path": issue.path, "message": issue.message} for issue in registry.issues]
        for path in sorted(item for item in root.rglob("*") if item.is_file() and item.suffix in {".json", ".yaml", ".yml"}):
            diagnostics.extend({"severity": finding.severity, "rule_code": finding.rule_code, "path": finding.path or finding.source, "message": "potential secret material must be removed", "fingerprint": finding.fingerprint, "line": finding.line, "column": finding.column, "remediation": finding.remediation} for finding in scan_artifact_file(path))
        artifacts = list(registry.items())
        diagnostics.extend(issue.model_dump(mode="json") for issue in validate_artifacts(artifacts))
        trusted_endpoint_policy = getattr(self, "endpoint_policy", EndpointSecurityPolicy())
        endpoint_resolver = getattr(self, "endpoint_resolver", None)
        for artifact in artifacts:
            if isinstance(artifact, DeploymentProfile) and artifact.endpoint_url:
                result=validate_endpoint(artifact.endpoint_url,region=artifact.region,policy=trusted_endpoint_policy,resolver=endpoint_resolver)
                diagnostics.extend({"severity": issue.severity,"rule_code":issue.rule_code,"path":issue.path,"message":issue.message} for issue in result.diagnostics)
        graph = ReferenceGraph(registry)
        graph.build(artifacts)
        diagnostics.extend({"severity": "blocking", "rule_code": issue.code, "path": issue.path, "message": issue.message} for issue in graph.issues)
        diagnostics.sort(key=lambda issue: (issue["rule_code"], issue.get("path") or "", issue["message"]))
        if options["format"] == "json":
            self.stdout.write(json.dumps({"blocking": any(i["severity"] == "blocking" for i in diagnostics), "issues": diagnostics}, ensure_ascii=False, sort_keys=True))
        else:
            if diagnostics:
                for issue in diagnostics: self.stdout.write(f"{issue['severity']} {issue['rule_code']} {issue.get('path') or '-'}: {issue['message']}")
            else: self.stdout.write("OK")
        if any(issue["severity"] == "blocking" for issue in diagnostics): raise CommandError("blocking Model Gateway validation issues found")

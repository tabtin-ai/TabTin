import json
from pathlib import Path
from django.core.management.base import BaseCommand, CommandError
from ...protocol_adapters.reporting import render_shadow
from ...protocol_adapters.shadow import compare_protocol_observations
from ...protocol_adapters.types import ProtocolType

class Command(BaseCommand):
    help = "Compare same-input protocol observations offline; performs no database or network access."
    requires_system_checks = []
    def add_arguments(self, parser):
        parser.add_argument("--artifact-root",required=True)
        parser.add_argument("--legacy-fixture-root",required=True)
        parser.add_argument("--package",required=True)
        parser.add_argument("--protocol-type",required=True)
        parser.add_argument("--format",choices=("text","json","jsonl"),default="text")
    def handle(self,*args,**options):
        if options["protocol_type"] != ProtocolType.OPENAI_COMPATIBLE.value: raise CommandError("unsupported-protocol-type")
        fixture=Path(options["legacy_fixture_root"])/(options["package"]+".json")
        if not fixture.is_file(): raise CommandError("exact-package-fixture-not-found")
        payload=json.loads(fixture.read_text(encoding="utf-8"))
        required={"fixture_key","same_input","legacy_observation","adapter_observation"}
        if set(payload)<required: raise CommandError("protocol-shadow-fixture-incomplete")
        result=compare_protocol_observations(package=options["package"],protocol_type=options["protocol_type"],fixture_key=payload["fixture_key"],same_input=payload["same_input"],legacy=payload["legacy_observation"],adapter=payload["adapter_observation"],evidence_refs=payload.get("evidence_refs",()))
        self.stdout.write(render_shadow(result,options["format"]))
        if result.has_blocker: raise CommandError("protocol-shadow-behavior-blocker")

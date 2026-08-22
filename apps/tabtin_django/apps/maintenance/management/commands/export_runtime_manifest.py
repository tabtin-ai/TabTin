from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from tabtin.runtime.exporters import DEFAULT_MARKDOWN_PATH, export_runtime_manifest_markdown
from tabtin.runtime.validators import validate_runtime_manifest


class Command(BaseCommand):
    help = "导出 Runtime / Queue / Worker / Beat 台账文档。"

    def add_arguments(self, parser):
        parser.add_argument(
            "--format",
            choices=("markdown",),
            default="markdown",
            help="导出格式。本次支持 markdown。",
        )
        parser.add_argument(
            "--output",
            default=str(DEFAULT_MARKDOWN_PATH),
            help="输出路径。",
        )

    def handle(self, *args, **options):
        if options["format"] != "markdown":
            raise CommandError("only markdown export is supported")
        validation = validate_runtime_manifest()
        path = export_runtime_manifest_markdown(
            output_path=options["output"],
            validation_result=validation,
        )
        self.stdout.write(self.style.SUCCESS(f"exported runtime manifest: {path}"))
        self.stdout.write(f"validation: {validation.status}")


from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from tabtin.runtime.validators import validate_runtime_manifest


class Command(BaseCommand):
    help = "校验 Runtime / Queue / Worker / Beat / Celery route 台账。"

    def handle(self, *args, **options):
        result = validate_runtime_manifest()
        self.stdout.write(result.status)
        for item in result.passed:
            self.stdout.write(self.style.SUCCESS(f"PASS {item}"))
        for item in result.warnings:
            self.stdout.write(self.style.WARNING(f"WARN {item}"))
        for item in result.failures:
            self.stderr.write(self.style.ERROR(f"FAIL {item}"))
        if not result.ok:
            raise CommandError("runtime manifest validation failed")


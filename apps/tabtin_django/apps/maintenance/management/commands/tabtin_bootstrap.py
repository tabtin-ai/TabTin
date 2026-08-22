from __future__ import annotations

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.maintenance.community_bootstrap import apply_community_bootstrap


class Command(BaseCommand):
    help = "Initialize the idempotent TabTin Community system catalog and installation marker."

    def add_arguments(self, parser):
        parser.add_argument("--edition", required=True, choices=("community",))

    def handle(self, *args, **options):
        requested_edition = options["edition"]
        configured_edition = getattr(settings, "TABTIN_EDITION", "saas")
        if requested_edition != configured_edition:
            raise CommandError(
                "--edition must match the resolved TABTIN_EDITION setting"
            )
        try:
            result = apply_community_bootstrap()
        except RuntimeError as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(
            self.style.SUCCESS(
                "Community bootstrap complete "
                f"revision={result.revision} "
                f"already_complete={str(result.already_complete).lower()} "
                f"removed_migration_defaults={result.removed_migration_defaults}"
            )
        )

from __future__ import annotations

import json

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.users.auth.admin_api import (
    compute_user_legacy_admin_flags,
    sync_user_legacy_admin_flags,
)
from apps.users.auth.models import AdminAccount


class Command(BaseCommand):
    help = (
        "Backfill User.is_staff / is_superuser from AdminAccount RBAC "
        "(fixes historical super_admin without legacy flags)."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only report mismatches; do not write User rows.",
        )

    def handle(self, *args, **options):
        dry_run = bool(options.get("dry_run"))
        scanned = 0
        changed = 0
        mismatches = []

        accounts = (
            AdminAccount.objects.select_related("user")
            .prefetch_related("role_assignments__role")
            .order_by("id")
        )
        for account in accounts:
            scanned += 1
            user = account.user
            desired = compute_user_legacy_admin_flags(account)
            before = {
                "is_staff": bool(user.is_staff),
                "is_superuser": bool(user.is_superuser),
            }
            after = {
                "is_staff": bool(desired["is_staff"]),
                "is_superuser": bool(desired["is_superuser"]),
            }
            if before == after:
                continue
            mismatches.append(
                {
                    "admin_account_id": str(account.id),
                    "user_id": str(user.id),
                    "before": before,
                    "after": after,
                    "role_codes": desired["role_codes"],
                }
            )
            if dry_run:
                continue
            with transaction.atomic():
                result = sync_user_legacy_admin_flags(account)
            if result.get("updated_fields"):
                changed += 1

        self.stdout.write(
            json.dumps(
                {
                    "dry_run": dry_run,
                    "scanned": scanned,
                    "changed": changed if not dry_run else 0,
                    "mismatch_count": len(mismatches),
                    "mismatches": mismatches[:50],
                },
                ensure_ascii=False,
            )
        )

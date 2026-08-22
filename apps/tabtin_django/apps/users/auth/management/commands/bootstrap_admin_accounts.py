from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.users.auth.models import AdminAccount, AdminAccountRole, AdminRole

SUPER_ADMIN_ROLE_CODE = "super_admin"
STAFF_FALLBACK_ROLE_CODES = ("operator", "support_agent")


class Command(BaseCommand):
    help = "Bootstrap AdminAccount and role bindings for staff users (idempotent)."

    def handle(self, *args, **options):
        User = get_user_model()
        counts = {
            "created_admin_accounts": 0,
            "skipped_existing_admin_accounts": 0,
            "created_role_bindings": 0,
            "skipped_existing_role_bindings": 0,
            "missing_roles": [],
        }
        missing_roles = set()

        super_admin_role = AdminRole.objects.filter(
            code=SUPER_ADMIN_ROLE_CODE,
            is_active=True,
        ).first()
        if super_admin_role is None:
            raise CommandError("Super Admin 角色不存在或未激活（code=super_admin）")

        fallback_roles = {
            role.code: role
            for role in AdminRole.objects.filter(
                code__in=STAFF_FALLBACK_ROLE_CODES,
                is_active=True,
            )
        }
        fallback_role = None
        for code in STAFF_FALLBACK_ROLE_CODES:
            if code in fallback_roles:
                fallback_role = fallback_roles[code]
                break
        if fallback_role is None:
            missing_roles.update(STAFF_FALLBACK_ROLE_CODES)

        with transaction.atomic():
            staff_users = User.objects.filter(is_staff=True).order_by("id")
            for user in staff_users:
                account, created = AdminAccount.objects.get_or_create(
                    user=user,
                    defaults={
                        "display_name": user.get_display_name(),
                        "status": AdminAccount.STATUS_ACTIVE,
                        "admin_login_enabled": True,
                        "created_by": user,
                    },
                )
                if created:
                    counts["created_admin_accounts"] += 1
                else:
                    counts["skipped_existing_admin_accounts"] += 1
                    update_fields = []
                    if account.status != AdminAccount.STATUS_ACTIVE:
                        account.status = AdminAccount.STATUS_ACTIVE
                        update_fields.append("status")
                    if not account.admin_login_enabled:
                        account.admin_login_enabled = True
                        update_fields.append("admin_login_enabled")
                    if update_fields:
                        update_fields.append("updated_at")
                        account.save(update_fields=update_fields)

                if user.is_superuser:
                    target_role = super_admin_role
                else:
                    target_role = fallback_role
                    if target_role is None:
                        continue

                _, role_created = AdminAccountRole.objects.get_or_create(
                    admin_account=account,
                    role=target_role,
                    defaults={"reason": "bootstrap_admin_accounts"},
                )
                if role_created:
                    counts["created_role_bindings"] += 1
                else:
                    counts["skipped_existing_role_bindings"] += 1

        counts["missing_roles"] = sorted(missing_roles)
        self.stdout.write(json.dumps(counts, ensure_ascii=False))

"""为历史 webhook Tracker 补全 HMAC secret。"""

from __future__ import annotations

import secrets

from django.core.management.base import BaseCommand

from apps.services.common.db_router import postgres_app_db_alias
from apps.tracker.models import Tracker


class Command(BaseCommand):
    help = "为所有 trigger_type='webhook' 且缺少 secret 的 Tracker 生成 HMAC secret"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="仅输出受影响数量，不做修改",
        )

    def handle(self, *args, **options):
        dry_run: bool = options["dry_run"]

        goals = list(
            Tracker.objects.using(postgres_app_db_alias())
            .filter(trigger_type="webhook", status="active")
        )

        missing: list[Tracker] = []
        for goal in goals:
            cfg = goal.trigger_config or {}
            if not cfg.get("secret"):
                missing.append(goal)

        self.stdout.write(
            f"共 {len(goals)} 个 webhook Goal，其中 {len(missing)} 个缺少 secret"
        )

        if dry_run or not missing:
            return

        updated = 0
        for goal in missing:
            cfg = goal.trigger_config or {}
            cfg["secret"] = secrets.token_hex(32)
            goal.trigger_config = cfg
            goal.save(using=postgres_app_db_alias(), update_fields=["trigger_config"])
            updated += 1

        self.stdout.write(self.style.SUCCESS(f"已为 {updated} 个 Tracker 生成 secret"))

"""为缺 timezone 的 cron Tracker 补齐时区（ 运维入口，可 dry-run）。"""

from __future__ import annotations

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.services.common.db_router import postgres_app_db_alias
from apps.tracker.models import Tracker
from apps.tracker.utils import compute_next_run_at, default_cron_timezone, ensure_cron_timezone


class Command(BaseCommand):
    help = (
        "为 trigger_type=cron 且缺少 timezone 的 Tracker 写入默认时区，"
        "并对 active/paused 重算 next_run_at"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只统计受影响数量，不写库",
        )
        parser.add_argument(
            "--timezone",
            default="",
            help=f"覆盖默认时区（默认 settings.TIME_ZONE={settings.TIME_ZONE!r}）",
        )

    def handle(self, *args, **options):
        dry_run: bool = options["dry_run"]
        override = (options.get("timezone") or "").strip()
        default_tz = override or default_cron_timezone()
        alias = postgres_app_db_alias()

        trackers = list(
            Tracker.objects.using(alias).filter(trigger_type="cron").only(
                "id", "status", "trigger_config", "next_run_at", "name",
            )
        )
        missing: list[Tracker] = []
        for tracker in trackers:
            cfg = tracker.trigger_config if isinstance(tracker.trigger_config, dict) else {}
            tz = cfg.get("timezone")
            if not (isinstance(tz, str) and tz.strip()):
                missing.append(tracker)

        self.stdout.write(
            f"共 {len(trackers)} 个 cron Tracker，其中 {len(missing)} 个缺 timezone"
            f"（将写入 {default_tz!r}）"
        )
        if dry_run or not missing:
            return

        updated = 0
        for tracker in missing:
            if override:
                cfg = dict(tracker.trigger_config or {})
                cfg["timezone"] = default_tz
            else:
                cfg = ensure_cron_timezone("cron", tracker.trigger_config)
            fields = ["trigger_config"]
            tracker.trigger_config = cfg
            if tracker.status in ("active", "paused"):
                tracker.next_run_at = compute_next_run_at("cron", cfg, fail_loud=False)
                fields.append("next_run_at")
            tracker.save(using=alias, update_fields=fields)
            updated += 1

        self.stdout.write(self.style.SUCCESS(f"已回填 {updated} 个 Tracker"))

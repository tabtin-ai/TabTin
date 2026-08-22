"""Audit or conservatively sweep orphan Celery pidbox reply lists."""

from __future__ import annotations

import json

import redis
from django.conf import settings
from django.core.management.base import BaseCommand

from apps.maintenance.celery_pidbox_replies import (
    collect_pidbox_reply_metrics,
    sweep_orphan_pidbox_replies,
)


class Command(BaseCommand):
    help = "Audit finite Celery pidbox reply lifetimes; optionally sweep safe orphans"

    def add_arguments(self, parser) -> None:
        default_safe_age = max(1, int(settings.CELERY_CONTROL_QUEUE_TTL) * 2)
        parser.add_argument("--sweep", action="store_true")
        parser.add_argument("--safe-idle-seconds", type=int, default=default_safe_age)
        parser.add_argument("--scan-count", type=int, default=100)
        parser.add_argument("--max-scanned-keys", type=int, default=10_000)
        parser.add_argument("--max-deleted", type=int, default=100)
        parser.add_argument("--time-budget-seconds", type=float, default=1.0)

    def handle(self, *args, **options) -> None:
        transport_options = settings.CELERY_BROKER_TRANSPORT_OPTIONS or {}
        global_keyprefix = str(transport_options.get("global_keyprefix") or "")
        client = redis.Redis.from_url(
            settings.CELERY_BROKER_URL,
            socket_connect_timeout=1.0,
            socket_timeout=1.0,
        )
        common = {
            "global_keyprefix": global_keyprefix,
            "safe_idle_seconds": options["safe_idle_seconds"],
            "scan_count": options["scan_count"],
            "max_scanned_keys": options["max_scanned_keys"],
            "time_budget_seconds": options["time_budget_seconds"],
        }
        if options["sweep"]:
            result = sweep_orphan_pidbox_replies(
                client,
                max_deleted=options["max_deleted"],
                **common,
            )
            metrics = result.metrics_before
            deleted_count = result.deleted_count
            race_skipped_count = result.race_skipped_count
        else:
            metrics = collect_pidbox_reply_metrics(client, **common)
            deleted_count = 0
            race_skipped_count = 0

        payload = {
            "celery_pidbox_reply_key_count": metrics.reply_key_count,
            "celery_pidbox_reply_total_bytes": metrics.total_bytes,
            "celery_pidbox_reply_without_ttl": metrics.without_ttl_count,
            "celery_pidbox_reply_orphan_candidate": metrics.orphan_candidate_count,
            "celery_pidbox_reply_oldest_idle_seconds": metrics.oldest_idle_seconds,
            "scanned_key_count": metrics.scanned_key_count,
            "scan_complete": metrics.scan_complete,
            "sweep_applied": bool(options["sweep"]),
            "deleted_count": deleted_count,
            "race_skipped_count": race_skipped_count,
        }
        self.stdout.write(json.dumps(payload, ensure_ascii=False, sort_keys=True))

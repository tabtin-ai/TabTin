"""手动 / 补跑历史 agent_id=NULL 画像清偿。

用法::

    python manage.py migrate_legacy_user_portraits
    python manage.py migrate_legacy_user_portraits --dry-run
    python manage.py migrate_legacy_user_portraits --skip-memories
"""

from __future__ import annotations

import json

from django.core.management.base import BaseCommand

from apps.user_portrait.services.legacy_migration import run_legacy_portrait_migration


class Command(BaseCommand):
    help = (
        "清偿历史 agent_id=NULL 用户画像（填入默认/空 per-Agent 画像后删除孤儿行）；"
        "可选将停用 Agent 上的记忆改挂到默认 Agent。"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只统计将要发生的变更，不写库",
        )
        parser.add_argument(
            "--skip-memories",
            action="store_true",
            help="不改挂停用 Agent 上的 AgentMemory",
        )

    def handle(self, *args, **options):
        dry_run = bool(options["dry_run"])
        stats = run_legacy_portrait_migration(
            dry_run=dry_run,
            reassign_inactive_memories=not bool(options["skip_memories"]),
        )
        self.stdout.write(json.dumps(stats.as_dict(), ensure_ascii=False, indent=2))
        if dry_run:
            self.stdout.write(self.style.WARNING("dry-run: 未写入数据库"))
        else:
            self.stdout.write(self.style.SUCCESS("legacy portrait migration finished"))

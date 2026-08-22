"""
agent_config v2 dry-run 预览命令（W2.1 实施 Agent 加 / W2.1.0 §4.4）。

用法：
    python manage.py migrate_agent_config_v2 --dry-run
    python manage.py migrate_agent_config_v2 --dry-run --limit 5

只读：扫描所有 Agent.agent_config，对每行调 ``migrate_v1_to_v2`` 纯函数
（不写库）打印 before/after diff。

实际写库请走 ``python manage.py migrate tabtinspace --database=postgresql``，
其中 0044_agent_config_v2 migration 会调用同一份纯函数。
"""

from __future__ import annotations

import json
from typing import Any, Dict

from django.core.management.base import BaseCommand

from apps.tabtinspace.agent_config_v2 import (
    V2_SCHEMA_VERSION,
    migrate_v1_to_v2,
)
from apps.tabtinspace.models import Agent
from apps.services.common.db_router import postgres_app_db_alias


class Command(BaseCommand):
    help = "Dry-run 预览 agent_config v1→v2 数据迁移（不写库）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只读：扫描并打印将发生的变更，不写库（默认）",
        )
        parser.add_argument(
            "--apply",
            action="store_true",
            help="实际写库（仅紧急修复用，正常应通过 migrate 命令）",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=0,
            help="只处理前 N 行（0 = 不限）",
        )
        parser.add_argument(
            "--show-diff",
            action="store_true",
            help="打印每行 before/after JSON（默认仅打印汇总）",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"] or not options["apply"]
        if options["apply"] and dry_run:
            # --apply 默认是 dry_run=False
            dry_run = False
        limit = options["limit"]
        show_diff = options["show_diff"]

        self.stdout.write(self.style.NOTICE(
            "[migrate_agent_config_v2] mode: %s" % ("dry-run" if dry_run else "APPLY")
        ))

        # ── Agent.agent_config ─────────────────────────────────────
        self.stdout.write("\n[Agent.agent_config]")
        stats_a = self._process_agent_configs(dry_run, limit, show_diff)

        # ── 汇总 ──────────────────────────────────────────────────
        self.stdout.write("\n" + self.style.SUCCESS("─── 汇总 ───"))
        self.stdout.write(
            f"Agent: 扫描 {stats_a['total']} / 跳过(已 v2) {stats_a['skipped']} / "
            f"待迁移 {stats_a['changed']}"
        )
        if dry_run:
            self.stdout.write(self.style.WARNING(
                "（dry-run 模式，未写库；实际迁移请运行 "
                "`python manage.py migrate tabtinspace --database=postgresql`）"
            ))
        else:
            self.stdout.write(self.style.SUCCESS("（已写库）"))

    def _process_agent_configs(
        self, dry_run: bool, limit: int, show_diff: bool
    ) -> Dict[str, int]:
        stats = {"total": 0, "skipped": 0, "changed": 0}
        qs = Agent.objects.using(postgres_app_db_alias()).all().order_by("created_at")
        if limit:
            qs = qs[:limit]

        for agent in qs.iterator(chunk_size=100):
            stats["total"] += 1
            cfg = agent.agent_config
            if isinstance(cfg, dict) and cfg.get("schema_version") == V2_SCHEMA_VERSION:
                stats["skipped"] += 1
                continue

            new_cfg = migrate_v1_to_v2(cfg)
            stats["changed"] += 1

            if show_diff:
                self.stdout.write(f"\n→ Agent {agent.id} ({agent.name})")
                self._print_diff(cfg, new_cfg)

            if not dry_run:
                agent.agent_config = new_cfg
                agent.save(using=postgres_app_db_alias(), update_fields=["agent_config", "updated_at"])

        return stats

    def _print_diff(self, before: Any, after: Any) -> None:
        self.stdout.write(
            self.style.WARNING("  [BEFORE] ") +
            json.dumps(before, ensure_ascii=False, default=str)[:200] + "..."
        )
        self.stdout.write(
            self.style.SUCCESS("  [AFTER]  ") +
            json.dumps(after, ensure_ascii=False, default=str)[:200] + "..."
        )

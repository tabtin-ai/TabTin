"""
Hilt W4 · 一次性数据迁移：agent_config 旧授权字段 → 新形状

遍历所有 Agent，清退役字段（复用纯函数 ``strip_retired_agent_config_fields``，
与数据迁移 0055 同源），并补本命令专属处理：pop ``permission_mode``、确保
``security.allow_yolo_mode`` 存在、truncate ``approval_memo.entries``（dev 数据
无价值——**仅本命令行为，生产数据迁移 0055 不会清 memo**）。

退役字段清理逻辑收敛在 ``agent_config_v2.strip_retired_agent_config_fields``，
避免与 0055 两处漂移。

Usage:
    python manage.py migrate_auth_to_v3
    python manage.py migrate_auth_to_v3 --dry-run
"""

import logging

from django.core.management.base import BaseCommand
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

# 命令专属清理：strip 纯函数不涉及的 v1 已废弃顶层字段。
_OLD_FIELDS_TO_POP = [
    "permission_mode",
]


class Command(BaseCommand):
    help = "Hilt W4: 迁移 agent_config 旧授权字段到新形状（一次性）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="仅打印将执行的操作，不实际写入",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]

        from apps.tabtinspace.agent_config_v2 import (
            strip_retired_agent_config_fields,
        )
        from apps.tabtinspace.models import Agent

        agents = Agent.objects.using(postgres_app_db_alias()).all()
        migrated = 0
        skipped = 0

        for agent in agents.iterator():
            cfg = agent.agent_config
            if not isinstance(cfg, dict):
                skipped += 1
                continue

            # 退役字段清理 + authorization_preset → allow_yolo_mode 推断（共用纯函数）。
            new_cfg, changed = strip_retired_agent_config_fields(cfg)

            # 命令专属：pop v1 已废弃顶层字段。
            for field in _OLD_FIELDS_TO_POP:
                if field in new_cfg:
                    new_cfg.pop(field)
                    changed = True

            # 命令专属：保证 security.allow_yolo_mode 一定存在（strip 仅在旧 preset
            # 存在时推断；这里对无 preset 的行兜底为 False）。
            sec = new_cfg.get("security")
            if not isinstance(sec, dict):
                new_cfg["security"] = {"allow_yolo_mode": False}
                changed = True
            elif "allow_yolo_mode" not in sec:
                sec["allow_yolo_mode"] = False
                changed = True

            # 命令专属：truncate approval_memo entries（dev 数据无价值）。
            # ⚠️ 这是本命令独有行为；生产数据迁移 0055 不清 memo。
            memo = new_cfg.get("approval_memo")
            if isinstance(memo, dict) and memo.get("entries"):
                memo["entries"] = {}
                memo["generation"] = (memo.get("generation") or 0) + 1
                changed = True

            if not changed:
                skipped += 1
                continue

            new_cfg["schema_version"] = 2

            if dry_run:
                self.stdout.write(
                    f"  [MIGRATE] Agent {agent.id}: "
                    f"allow_yolo_mode={new_cfg['security']['allow_yolo_mode']}"
                )
            else:
                agent.agent_config = new_cfg
                agent.save(using=postgres_app_db_alias(), update_fields=["agent_config"])

            migrated += 1

        summary = f"完成: {migrated} 迁移, {skipped} 跳过"
        if dry_run:
            summary += " (dry-run)"
        self.stdout.write(self.style.SUCCESS(summary))

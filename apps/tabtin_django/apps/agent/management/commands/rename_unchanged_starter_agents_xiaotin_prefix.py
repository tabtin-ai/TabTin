"""手动把未改名的模板分身统一为「小Tin xxx版」。

只处理 ``template_id`` 对应且 ``name`` 仍等于旧出厂名的行；系统默认
「小Tin」、用户已改名、历史 owner 前缀名一律跳过。

用法::

    cd apps/tabtin_django
    python manage.py rename_unchanged_starter_agents_xiaotin_prefix --dry-run
    python manage.py rename_unchanged_starter_agents_xiaotin_prefix
    python manage.py rename_unchanged_starter_agents_xiaotin_prefix --organization-id <uuid>
"""
from __future__ import annotations

from uuid import UUID

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.agent.services.xiaotin_prefixed_agent_names import (
    LEGACY_TEMPLATE_AGENT_NAMES,
    XIAOTIN_PREFIXED_TEMPLATE_AGENT_NAMES,
    rename_unchanged_legacy_template_agents,
)
from apps.services.common.db_router import postgres_app_db_alias


class Command(BaseCommand):
    help = (
        "将未改名的模板分身（如「代码版」）重命名为「小Tin 代码版」。"
        "默认 dry-run；加 --execute 才写库。"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--execute",
            action="store_true",
            help="真正写库；缺省仅预览",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="显式预览（默认行为，可省略）",
        )
        parser.add_argument(
            "--organization-id",
            type=str,
            default=None,
            help="只处理指定组织",
        )
        parser.add_argument(
            "--limit-print",
            type=int,
            default=50,
            help="最多打印多少条匹配明细（默认 50）",
        )

    def handle(self, *args, **options):
        execute = bool(options["execute"])
        dry_run = not execute
        organization_id_raw = options.get("organization_id")
        limit_print = max(0, int(options["limit_print"] or 0))

        organization_id = None
        if organization_id_raw:
            try:
                organization_id = UUID(organization_id_raw)
            except (TypeError, ValueError) as exc:
                raise CommandError(
                    f"无效 organization-id: {organization_id_raw}"
                ) from exc

        if dry_run:
            self.stdout.write(self.style.WARNING("[DRY-RUN] 预览模式，不会写库"))
        else:
            self.stdout.write(self.style.WARNING("[EXECUTE] 将写入数据库"))

        self.stdout.write("映射：")
        for template_id, legacy in LEGACY_TEMPLATE_AGENT_NAMES.items():
            self.stdout.write(
                f"  {template_id}: {legacy!r} → "
                f"{XIAOTIN_PREFIXED_TEMPLATE_AGENT_NAMES[template_id]!r}"
            )

        alias = postgres_app_db_alias()
        with transaction.atomic(using=alias):
            stats = rename_unchanged_legacy_template_agents(
                dry_run=dry_run,
                organization_id=organization_id,
            )
            if dry_run:
                transaction.set_rollback(True, using=alias)

        for match in (stats.matches or [])[:limit_print]:
            self.stdout.write(
                f"  {match.old_name!r} → {match.new_name!r} "
                f"agent={match.agent_id} org={match.organization_id} "
                f"template={match.template_id}"
            )
        remaining = max(0, stats.matched - limit_print)
        if remaining:
            self.stdout.write(f"  … 另有 {remaining} 条未打印")

        style = self.style.SUCCESS if execute else self.style.WARNING
        self.stdout.write(
            style(
                f"完成: matched={stats.matched} updated={stats.updated} "
                f"dry_run={dry_run}"
            )
        )
        if dry_run and stats.matched:
            self.stdout.write(
                "确认无误后执行: "
                "python manage.py rename_unchanged_starter_agents_xiaotin_prefix --execute"
            )

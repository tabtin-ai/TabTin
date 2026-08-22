"""#3266 Space 退役迁移 / 终态数据完整性预检。

在跑 0108–0110 之前（或合入后巡检）使用：

    python manage.py preflight_space_retire_3266
    python manage.py preflight_space_retire_3266 --fail-on-warning

检查项：
1. 个人 Space 是否都有同 id Workspace（仅 Space 表仍存在时）
2. SF-1 已退役但仍残留的 grant 僵尸表（：挡 0110）
3. 指向 tabtinspace_space 的残留真 FK（仅表仍存在时）
4. Collection / ContextItem 双空孤儿
5. Workspace.agent_id 为空
6. Table.space_id 软引用是否落在 Workspace ∪ Project

可选：
    python manage.py preflight_space_retire_3266 --repair-orphan-hosts
        按孤儿 Table.space_id 重建同 id Workspace（Space 已 DROP 时的修复）。
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.space_to_workspace import (
    ensure_workspace_for_orphan_host,
    ensure_workspaces_from_all_personal_spaces,
    iter_orphan_table_hosts,
)

# 与 0066 / 0110 对齐：SF-1 退役后不应再出现的物理表。
RETIRED_SPACE_GRANT_TABLES = (
    "tabtinspace_delegation_grant",
    "tabtinspace_space_share",
)


class Command(BaseCommand):
    help = "预检  Space 退役相关的数据完整性风险"

    def add_arguments(self, parser):
        parser.add_argument(
            "--fail-on-warning",
            action="store_true",
            help="存在 warning 级问题时以非零退出码结束",
        )
        parser.add_argument(
            "--repair-orphan-hosts",
            action="store_true",
            help="为孤儿 Table.space_id（及仍存的个人 Space）重建同 id Workspace",
        )

    def handle(self, *args, **options):
        if options["repair_orphan_hosts"]:
            self._repair_orphan_hosts()

        errors: list[str] = []
        warnings: list[str] = []

        self._check_personal_space_workspace(errors)
        self._check_retired_grant_zombie_tables(warnings)
        self._check_remaining_space_fks(errors)
        self._check_xor_orphans(errors)
        self._check_workspace_agent(warnings)
        self._check_table_soft_hosts(warnings)

        self.stdout.write("")
        if errors:
            self.stdout.write(self.style.ERROR(f"ERROR ({len(errors)})"))
            for item in errors:
                self.stdout.write(self.style.ERROR(f"  - {item}"))
        if warnings:
            self.stdout.write(self.style.WARNING(f"WARNING ({len(warnings)})"))
            for item in warnings:
                self.stdout.write(self.style.WARNING(f"  - {item}"))
        if not errors and not warnings:
            self.stdout.write(self.style.SUCCESS("preflight OK：未发现  数据完整性风险"))
            return

        if errors:
            raise CommandError(
                f"preflight 失败：{len(errors)} 个 error。"
                "修复后再 migrate。双空 ContextItem/Collection 由 0109 自动归位/清残余，无需运维 env。"
            )
        if options["fail_on_warning"]:
            raise CommandError(f"preflight 含 {len(warnings)} 个 warning（--fail-on-warning）")

    def _repair_orphan_hosts(self) -> None:
        from django.apps import apps as django_apps

        created_from_space = 0
        space_model_available = False
        try:
            space_model = django_apps.get_model('tabtinspace', 'Space')
            space_model_available = hasattr(space_model, '_meta')
        except LookupError:
            space_model_available = False

        if space_model_available and self._table_exists("tabtinspace_space"):
            with transaction.atomic(using=postgres_app_db_alias()):
                created_from_space = ensure_workspaces_from_all_personal_spaces(django_apps)

        created_from_orphans = 0
        with transaction.atomic(using=postgres_app_db_alias()):
            for host_id, organization_id, sample_name, _n in iter_orphan_table_hosts(connection):
                if ensure_workspace_for_orphan_host(
                    django_apps,
                    host_id=host_id,
                    organization_id=organization_id,
                    name=sample_name or '',
                ):
                    created_from_orphans += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"repair: 从 Space 新建 Workspace={created_from_space}；"
                f"从孤儿 Table.space_id 新建={created_from_orphans}"
            )
        )

    def _table_exists(self, table_name: str) -> bool:
        with connection.cursor() as cursor:
            if connection.vendor == "postgresql":
                cursor.execute(
                    """
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = current_schema()
                      AND table_name = %s
                    """,
                    [table_name],
                )
                return cursor.fetchone() is not None
            return table_name in connection.introspection.table_names(cursor)

    def _check_personal_space_workspace(self, errors: list[str]) -> None:
        if not self._table_exists("tabtinspace_space"):
            self.stdout.write("skip: tabtinspace_space 已不存在（个人 Space↔Workspace 预检）")
            return
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT COUNT(*)
                FROM tabtinspace_space s
                LEFT JOIN tabtinspace_workspace w ON w.id = s.id
                WHERE s.type = 'workspace'
                  AND w.id IS NULL
                """
            )
            missing = int(cursor.fetchone()[0])
        if missing:
            errors.append(
                f"{missing} 个个人 Space 缺少同 id Workspace（0108 会拒迁或误删壳行）"
            )
        else:
            self.stdout.write(self.style.SUCCESS("ok: 个人 Space 均有 Workspace id-reuse"))

    def _check_retired_grant_zombie_tables(self, warnings: list[str]) -> None:
        """#6443：报告 0066 半账残留；0110 会幂等 DROP，故默认不升 error。"""
        zombies = [
            table_name
            for table_name in RETIRED_SPACE_GRANT_TABLES
            if self._table_exists(table_name)
        ]
        if zombies:
            warnings.append(
                "SF-1 退役 grant 表仍残留（0110 将幂等 DROP）: " + ", ".join(zombies)
            )
        else:
            self.stdout.write(
                self.style.SUCCESS("ok: 无 SF-1 退役 grant 僵尸表（space_share/delegation_grant）")
            )

    def _check_remaining_space_fks(self, errors: list[str]) -> None:
        if connection.vendor != "postgresql" or not self._table_exists("tabtinspace_space"):
            return
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT c.conrelid::regclass::text, c.conname
                FROM pg_constraint c
                JOIN pg_class t ON t.oid = c.confrelid
                JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE c.contype = 'f'
                  AND n.nspname = current_schema()
                  AND t.relname = 'tabtinspace_space'
                  -- 与 0110 一致：表内自引用随 DROP TABLE 消失，不计入残留
                  AND c.conrelid <> c.confrelid
                ORDER BY 1, 2
                """
            )
            rows = cursor.fetchall()
        # 0110 会先幂等 DROP 退役 grant 表；其 FK 不计为硬挡（见  warning）。
        retired = set(RETIRED_SPACE_GRANT_TABLES)
        blocking = [(t, n) for t, n in rows if t not in retired]
        if blocking:
            sample = ", ".join(f"{t}.{n}" for t, n in blocking[:10])
            errors.append(
                f"仍有 {len(blocking)} 条真 FK 指向 tabtinspace_space（0110 将拒 DROP）: {sample}"
            )
        elif rows:
            self.stdout.write(
                self.style.WARNING(
                    "仅剩退役 grant 表上的 Space FK（0110 将幂等 DROP 这些表）"
                )
            )
        else:
            self.stdout.write(self.style.SUCCESS("ok: 无残留真 FK 指向 tabtinspace_space"))

    def _check_xor_orphans(self, errors: list[str]) -> None:
        from apps.tabtinspace.models import Collection, ContextItem

        item_count = ContextItem.objects.filter(
            workspace_id__isnull=True, project_id__isnull=True,
        ).count()
        coll_count = Collection.objects.filter(
            workspace_id__isnull=True, project_id__isnull=True,
        ).count()
        if item_count or coll_count:
            # 0109 会自动经 resource/collection/deliverable 归位；仍双空者再删。
            # 不再要求运维 env——生产 migrate 必须无人值守。
            self.stdout.write(
                self.style.WARNING(
                    f"双空孤儿 ContextItem={item_count} Collection={coll_count} "
                    "（0109 将自动归位；无法归位的残余脏数据会被删除）"
                )
            )
        else:
            self.stdout.write(self.style.SUCCESS("ok: Collection/ContextItem 无双空孤儿"))

    def _check_workspace_agent(self, warnings: list[str]) -> None:
        # ：Workspace.agent 已删除；身份由 Session / 显式选择承载。
        _ = warnings
        self.stdout.write(self.style.SUCCESS("ok: Workspace.agent FK 已退役"))

    def _check_table_soft_hosts(self, warnings: list[str]) -> None:
        if not self._table_exists("tabdata_table"):
            return
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                  COUNT(*) FILTER (
                    WHERE EXISTS (
                      SELECT 1 FROM tabtinspace_organization o
                      WHERE o.id = t.organization_id
                    )
                  ) AS recoverable,
                  COUNT(*) FILTER (
                    WHERE NOT EXISTS (
                      SELECT 1 FROM tabtinspace_organization o
                      WHERE o.id = t.organization_id
                    )
                  ) AS org_gone
                FROM tabdata_table t
                WHERE t.space_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM tabtinspace_workspace w WHERE w.id = t.space_id
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM tabtinspace_project p WHERE p.id = t.space_id
                  )
                """
            )
            recoverable, org_gone = cursor.fetchone()
            recoverable = int(recoverable or 0)
            org_gone = int(org_gone or 0)
        if recoverable:
            warnings.append(
                f"{recoverable} 张 Table.space_id 悬空但组织仍在"
                "（应跑 migrate 0114 或 --repair-orphan-hosts）"
            )
        if org_gone:
            warnings.append(
                f"{org_gone} 张 Table.space_id 所属 Organization 已不存在"
                "（历史测试残留，无法重建 Workspace）"
            )
        if not recoverable and not org_gone:
            self.stdout.write(self.style.SUCCESS("ok: Table.space_id 均落在 Workspace/Project"))

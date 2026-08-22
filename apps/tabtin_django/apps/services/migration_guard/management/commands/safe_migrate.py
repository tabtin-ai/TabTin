"""safe_migrate —— 跨库一站式迁移命令。

用途：替代手动执行两次 ``migrate``，防止漏掉 ``--database=postgresql``。

用法：

    python manage.py safe_migrate                # 迁移全部库至最新
    python manage.py safe_migrate tabdata        # 只迁移指定 app（自动走它的正确数据库）
    python manage.py safe_migrate --plan         # 查看将要执行的计划
    python manage.py safe_migrate --no-input     # 非交互
    python manage.py safe_migrate --fake-initial # 适用于首次部署已有库的情形

流程：

1. 把 ``_TABTIN_SAFE_MIGRATE_INVOKED=1`` 注入进程 env，让本仓库覆写的 migrate
   wrapper（``apps/services/migration_guard/.../commands/migrate.py``）放行
   不再拦截。
2. 每个库 migrate **之前**跑 ``reconcile_split_migration_history``：
   若库里已 apply 旧单体 ``0107``/``0108`` 但缺拆分后的 ``0107a/b``、``0108a/b``，
   且 schema 已是旧单体终态，则补记 fake applied，避免
   ``InconsistentMigrationHistory`` 挡住入口。
3. 按固定顺序 ``default → postgresql`` 逐库跑 ``call_command("migrate", ...)``。
   任一库失败立刻终止，**不会继续跑后续库**——但 default 库已落账的 applied
   记录是 Django 设计行为，不会自动回滚（需要修完失败原因后重跑 safe_migrate
   自动跳过已 applied 的部分）。
4. 跑完所有库后，调 ``check_migration_integrity --strict`` 跑后自检。如果两
   库 history 仍不一致（典型场景：跑了 default 但 PG 因 router/权限/data
   migration 失败没 apply 真实记录），抛 ``CommandError``。

历史教训：yolo PR3 的 ``0049_rename_yolo_mode_to_allow_yolo_mode``（数据迁移）
在 default 库写了影子 applied 记录，但 PG 库根本没真跑过 forward 函数——
2 个 Agent 的 ``security.yolo_mode`` 字段从未改名为 ``allow_yolo_mode``。原因
是当时的 ``safe_migrate`` 没有跑后自检，且没拦住直接 ``python manage.py
migrate`` 的入口。本次重构同时增强这两条防线。
"""

from __future__ import annotations

import os

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.conf import settings
from django.db import connections

from apps.services.migration_guard.split_migration_history import (
    reconcile_split_migration_history,
)


# 明确顺序：default 先于 postgresql，和 scripts/backend/django-setup.sh 保持一致。
_PREFERRED_ORDER = ["default", "postgresql"]

# 环境变量名要跟 migrate wrapper 里的常量一致——后者放行依据。
_SAFE_MIGRATE_ENV = "_TABTIN_SAFE_MIGRATE_INVOKED"


class Command(BaseCommand):
    help = "对所有已配置数据库分别执行 migrate（先 default 后 postgresql）+ 跑后跨库一致性自检。"
    requires_system_checks = []

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "app_label",
            nargs="?",
            default=None,
            help="可选：仅迁移指定 app。",
        )
        parser.add_argument(
            "migration_name",
            nargs="?",
            default=None,
            help="可选：迁移到指定 migration（支持 zero 回滚）。",
        )
        parser.add_argument("--no-input", "--noinput", dest="no_input", action="store_true")
        parser.add_argument("--fake", action="store_true")
        parser.add_argument("--fake-initial", action="store_true")
        parser.add_argument(
            "--plan",
            action="store_true",
            help="只显示将执行的 migration 计划，不实际应用。",
        )
        parser.add_argument(
            "--run-syncdb",
            action="store_true",
            help="对没有 migration 的 app 创建表（原 migrate 同名参数）。",
        )
        parser.add_argument(
            "--skip-self-check",
            action="store_true",
            help=(
                "跳过跑后 check_migration_integrity 自检。"
                "仅在自检本身故障时应急回退用，正常流程不要加。"
            ),
        )

    def handle(self, *args, app_label=None, migration_name=None, **options) -> None:
        configured = list(
            getattr(settings, "TABTIN_MIGRATION_DATABASE_ALIASES", None)
            or connections.databases.keys()
        )
        ordered = [db for db in _PREFERRED_ORDER if db in configured]
        ordered += [db for db in configured if db not in ordered]

        self.stdout.write(
            self.style.NOTICE(
                f"safe_migrate 将按顺序迁移以下数据库：{ordered}"
            )
        )

        migrate_args: list[str] = []
        if app_label:
            migrate_args.append(app_label)
            if migration_name:
                migrate_args.append(migration_name)

        is_plan = bool(options.get("plan", False))
        skip_self_check = bool(options.get("skip_self_check", False))

        migrate_kwargs = {
            "interactive": not options.get("no_input", False),
            "fake": options.get("fake", False),
            "fake_initial": options.get("fake_initial", False),
            "plan": is_plan,
            "run_syncdb": options.get("run_syncdb", False),
        }

        completed: list[str] = []
        failure: tuple[str, BaseException] | None = None
        env_was_set = os.environ.get(_SAFE_MIGRATE_ENV)
        os.environ[_SAFE_MIGRATE_ENV] = "1"
        try:
            if not is_plan:
                self.stdout.write(
                    self.style.NOTICE(
                        "\n━━━ 迁移前发布包自检（artifact preflight）━━━"
                    )
                )
                call_command("check_migration_integrity", artifact_preflight=True)
            for db in ordered:
                header = f"\n━━━ migrate database={db} ━━━"
                self.stdout.write(self.style.MIGRATE_HEADING(header))
                try:
                    faked = reconcile_split_migration_history(database=db)
                    if faked:
                        self.stdout.write(
                            self.style.WARNING(
                                f"#6333 split-history: database={db} 补记 "
                                f"{', '.join(faked)}（旧单体已落账，避开 "
                                f"InconsistentMigrationHistory）"
                            )
                        )
                    call_command(
                        "migrate", *migrate_args, database=db, **migrate_kwargs
                    )
                except (Exception, SystemExit) as exc:  # noqa: BLE001
                    failure = (db, exc)
                    break
                completed.append(db)
        finally:
            if env_was_set is None:
                os.environ.pop(_SAFE_MIGRATE_ENV, None)
            else:
                os.environ[_SAFE_MIGRATE_ENV] = env_was_set

        if failure is not None:
            failed_db, exc = failure
            untouched = [
                db for db in ordered if db != failed_db and db not in completed
            ]
            self.stdout.write(
                self.style.ERROR(
                    f"\n❌ database={failed_db} 迁移失败：{type(exc).__name__}: {exc}"
                )
            )
            self.stdout.write(
                self.style.ERROR(
                    f"\n本次跨库迁移**未完成**：\n"
                    f"  - 已成功：{completed or ['(无)']}\n"
                    f"  - 失败于：{failed_db}\n"
                    f"  - 未触发：{untouched or ['(无)']}\n\n"
                    f"⚠️  失败前已落账的 default 库 django_migrations 记录不会自动回滚（Django 设计行为）。\n"
                    f"修复路径（按风险从低到高）：\n"
                    f"  1. 修复失败原因后重跑 `safe_migrate`——已 applied 的会自动跳过；\n"
                    f"  2. 跑 `bash scripts/migrate-check.sh --schema --include-legacy` 看实际状态后，\n"
                    f"     再决定是 fake 记录还是 ``--allow-unsafe`` 单库直跑。"
                )
            )
            raise CommandError(f"safe_migrate aborted at database={failed_db}")

        if is_plan or skip_self_check:
            reason = "plan 模式" if is_plan else "--skip-self-check"
            self.stdout.write(
                self.style.SUCCESS(
                    f"\n✅ safe_migrate 完成（跳过自检：{reason}）"
                )
            )
            return

        self.stdout.write(
            self.style.NOTICE(
                "\n━━━ 跑后跨库一致性自检（check_migration_integrity --strict）━━━"
            )
        )
        try:
            call_command("check_migration_integrity", strict=True, schema=True)
        except CommandError:
            self.stdout.write(
                self.style.ERROR(
                    "\n❌ 自检发现两库 history 仍不一致——"
                    "请先跑 `bash scripts/migrate-check.sh --schema --include-legacy` 排查。"
                )
            )
            raise

        self.stdout.write(
            self.style.SUCCESS("\n✅ safe_migrate 已对所有数据库完成 migrate + 跑后自检")
        )

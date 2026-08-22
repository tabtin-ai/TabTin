"""
rename_app_labels — 部署前运行的 app_label 迁移命令

在更改 AppConfig.label 后、运行 migrate 前执行。
更新 django_migrations 和 django_content_type 表中的 app_label。

用法:
    python manage.py rename_app_labels
    python manage.py rename_app_labels --dry-run

必须在 `python manage.py migrate` 之前运行。

== 双库一致性（波次 3b 2026-05-25 增强）==

TabTin 采用双库（MySQL default + PostgreSQL）跨库 migration 一致性策略
（详见 .cursor/rules/backend-django.mdc 双库架构段）。每条 migration 必须在两个库
的 django_migrations 表都有 applied 记录，否则 migrate-check --strict 失败。

故本命令对 ``django_migrations`` 必须**双库**更新；``django_content_type`` 由
DefaultDatabaseRouter._dual_db_labels 路由 → 在两个库都有影子表，也双库更新。
"""

from django.core.management.base import BaseCommand
from django.db import connections


# 旧 app_label → 新 app_label
LABEL_MAP = {
    "ppt": "tabslide",
    "design": "tabdesign",
    "tabdoc": "tabdoc",
    "aitable": "tabdata",
    # 波次 3b（2026-05-25）：Tracker 模块改名 scheduler → tracker。
    # 2026-05-28：ScheduledJob 子系统整体下线（migration 0033），原 /api/scheduler/*
    # 全部归位 —— dry-run 落在 /api/tracker/events/{id}/dry-run，
    # events 目录落在 /api/registry/events，namespace 整体下线。
    "scheduler": "tracker",
}


# 波次 3b：PeriodicTask.task 字段路径替换（修 review P0-1：函数名也改了，不能只改前缀）
# 2026-05-28 收编：ScheduledJob 子系统任务全部下线，仅保留 Tracker 域任务的迁移映射。
TASK_RENAME_MAP = {
    "apps.scheduler.tasks.execute_goal": "apps.tracker.tasks.execute_tracker",
    "apps.scheduler.tasks.scan_due_goals": "apps.tracker.tasks.scan_due_trackers",
    "apps.scheduler.tasks.recover_stuck_goal_runs": "apps.tracker.tasks.recover_stuck_tracker_runs",
    "apps.scheduler.tasks.goal_health_check": "apps.tracker.tasks.tracker_health_check",
}

# 波次 3b：django_celery_beat_periodictask.name 字段也跟着 BEAT_SCHEDULE 改名。
# - scan-due-goals → scan-due-trackers
# - recover-stuck-goal-runs → recover-stuck-tracker-runs
# - goal-health-check → tracker-health-check
PERIODIC_TASK_NAME_MAP = {
    "scan-due-goals": "scan-due-trackers",
    "recover-stuck-goal-runs": "recover-stuck-tracker-runs",
    "goal-health-check": "tracker-health-check",
}

# 已删的 BEAT 任务（不再需要的 PeriodicTask 行直接清理）
# - scan-agenda-reminders：波次 1 下线
# - scan-due-scheduler-jobs / recover-stuck-scheduler-jobs：2026-05-28 ScheduledJob 子系统下线
PERIODIC_TASK_NAMES_TO_DELETE = {
    "scan-agenda-reminders",
    "scan-due-scheduler-jobs",
    "recover-stuck-scheduler-jobs",
}


class Command(BaseCommand):
    help = "更新 django_migrations / django_content_type / PeriodicTask 中的 app_label（app 重命名时使用）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="仅打印将要执行的 SQL，不实际修改",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]

        # ── django_migrations 双库 ──
        self._update_migrations("postgresql", dry_run)
        self._update_migrations("default", dry_run)

        # ── django_content_type 双库（dual_db 影子表）──
        self._update_content_types("postgresql", dry_run)
        self._update_content_types("default", dry_run)

        # ── PeriodicTask（default 库）──
        self._update_periodic_tasks("default", dry_run)

        if dry_run:
            self.stdout.write(self.style.WARNING("\nDRY RUN 完成，未修改任何数据"))
        else:
            self.stdout.write(self.style.SUCCESS("\napp_label 迁移完成"))

    def _update_migrations(self, db_alias: str, dry_run: bool):
        """更新 django_migrations.app 列"""
        self.stdout.write(f"\n── 更新 django_migrations ({db_alias}) ──")
        conn = connections[db_alias]
        with conn.cursor() as cursor:
            for old, new in LABEL_MAP.items():
                cursor.execute(
                    "SELECT COUNT(*) FROM django_migrations WHERE app = %s", [old]
                )
                count = cursor.fetchone()[0]
                if count == 0:
                    cursor.execute(
                        "SELECT COUNT(*) FROM django_migrations WHERE app = %s", [new]
                    )
                    new_count = cursor.fetchone()[0]
                    if new_count > 0:
                        self.stdout.write(f"  ✓ {old} → {new}: 已完成（{new_count} 条记录）")
                    else:
                        self.stdout.write(f"  - {old}: 无记录，跳过")
                    continue

                if dry_run:
                    self.stdout.write(
                        f"  [DRY] UPDATE django_migrations SET app='{new}' WHERE app='{old}' ({count} rows)"
                    )
                else:
                    cursor.execute(
                        "UPDATE django_migrations SET app = %s WHERE app = %s",
                        [new, old],
                    )
                    self.stdout.write(f"  ✓ {old} → {new}: {count} 条记录已更新")

    def _update_content_types(self, db_alias: str, dry_run: bool):
        """更新 django_content_type.app_label 列"""
        self.stdout.write(f"\n── 更新 django_content_type ({db_alias}) ──")
        try:
            conn = connections[db_alias]
            with conn.cursor() as cursor:
                for old, new in LABEL_MAP.items():
                    cursor.execute(
                        "SELECT COUNT(*) FROM django_content_type WHERE app_label = %s",
                        [old],
                    )
                    count = cursor.fetchone()[0]
                    if count == 0:
                        cursor.execute(
                            "SELECT COUNT(*) FROM django_content_type WHERE app_label = %s",
                            [new],
                        )
                        new_count = cursor.fetchone()[0]
                        if new_count > 0:
                            self.stdout.write(
                                f"  ✓ {old} → {new}: 已完成（{new_count} 条记录）"
                            )
                        else:
                            self.stdout.write(f"  - {old}: 无记录，跳过")
                        continue

                    if dry_run:
                        self.stdout.write(
                            f"  [DRY] UPDATE django_content_type SET app_label='{new}' "
                            f"WHERE app_label='{old}' ({count} rows)"
                        )
                    else:
                        cursor.execute(
                            "UPDATE django_content_type SET app_label = %s WHERE app_label = %s",
                            [new, old],
                        )
                        self.stdout.write(f"  ✓ {old} → {new}: {count} 条记录已更新")
        except Exception as e:
            self.stdout.write(self.style.WARNING(f"  跳过 content_type 更新: {e}"))

    def _update_periodic_tasks(self, db_alias: str, dry_run: bool):
        """更新 django_celery_beat_periodictask.task（路径）和 .name（schedule 名）。

        波次 3b 关键修补（review P0-1）：task 不能只改前缀,函数名也变了。
        例如 ``apps.scheduler.tasks.execute_goal`` → ``apps.tracker.tasks.execute_tracker``。
        """
        self.stdout.write(f"\n── 更新 PeriodicTask ({db_alias}) ──")
        try:
            conn = connections[db_alias]
            with conn.cursor() as cursor:
                # 1) 改 task 字段
                for old_task, new_task in TASK_RENAME_MAP.items():
                    cursor.execute(
                        "SELECT COUNT(*) FROM django_celery_beat_periodictask WHERE task = %s",
                        [old_task],
                    )
                    count = cursor.fetchone()[0]
                    if count == 0:
                        continue
                    if dry_run:
                        self.stdout.write(
                            f"  [DRY] UPDATE PeriodicTask SET task='{new_task}' "
                            f"WHERE task='{old_task}' ({count} rows)"
                        )
                    else:
                        cursor.execute(
                            "UPDATE django_celery_beat_periodictask SET task = %s WHERE task = %s",
                            [new_task, old_task],
                        )
                        self.stdout.write(f"  ✓ task '{old_task}' → '{new_task}': {count} 条")

                # 2) 改 name 字段（BEAT entry 名）
                for old_name, new_name in PERIODIC_TASK_NAME_MAP.items():
                    cursor.execute(
                        "SELECT COUNT(*) FROM django_celery_beat_periodictask WHERE name = %s",
                        [old_name],
                    )
                    count = cursor.fetchone()[0]
                    if count == 0:
                        continue
                    if dry_run:
                        self.stdout.write(
                            f"  [DRY] UPDATE PeriodicTask SET name='{new_name}' "
                            f"WHERE name='{old_name}' ({count} rows)"
                        )
                    else:
                        cursor.execute(
                            "UPDATE django_celery_beat_periodictask SET name = %s WHERE name = %s",
                            [new_name, old_name],
                        )
                        self.stdout.write(f"  ✓ name '{old_name}' → '{new_name}': {count} 条")

                # 3) 删除已废弃任务
                for dead_name in PERIODIC_TASK_NAMES_TO_DELETE:
                    cursor.execute(
                        "SELECT COUNT(*) FROM django_celery_beat_periodictask WHERE name = %s",
                        [dead_name],
                    )
                    count = cursor.fetchone()[0]
                    if count == 0:
                        continue
                    if dry_run:
                        self.stdout.write(
                            f"  [DRY] DELETE FROM PeriodicTask WHERE name='{dead_name}' ({count} rows)"
                        )
                    else:
                        cursor.execute(
                            "DELETE FROM django_celery_beat_periodictask WHERE name = %s",
                            [dead_name],
                        )
                        self.stdout.write(f"  ✓ 删除已废弃 task '{dead_name}': {count} 条")
        except Exception as e:
            self.stdout.write(self.style.WARNING(f"  跳过 PeriodicTask 更新: {e}"))

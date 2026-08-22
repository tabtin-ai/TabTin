"""
TabDoc 迁移后验收命令

用途：
1. 校验 postgresql 上是否已应用关键迁移 0006
2. 校验 tabdoc_version 表的关键结构（version 字段、docver_doc_ver_idx 索引）
3. 校验 default(MySQL) 是否误记了 tabdoc 迁移
4. 输出版本数据统计（总数 / version 为空数）

用法：
    python manage.py tabdoc_verify_migration
    python manage.py tabdoc_verify_migration --strict
    python manage.py tabdoc_verify_migration --database=postgresql
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db import connections
from django.db.migrations.recorder import MigrationRecorder


TARGET_APP_LABEL = "tabdoc"
TARGET_MIGRATION = "0006_documentversion_version_field"
TARGET_TABLE = "tabdoc_version"
TARGET_COLUMN = "version"
TARGET_INDEX = "docver_doc_ver_idx"


class Command(BaseCommand):
    help = "验收 TabDoc 迁移状态（重点检查 postgresql 上 0006 与关键 schema）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--database",
            default="postgresql",
            help="目标数据库别名（默认 postgresql）",
        )
        parser.add_argument(
            "--strict",
            action="store_true",
            help="严格模式：存在告警也返回非 0",
        )

    def handle(self, *args, **options):
        db_alias: str = options["database"]
        strict: bool = bool(options["strict"])

        if db_alias not in connections.databases:
            raise CommandError(f"数据库别名不存在: {db_alias}")
        if "default" not in connections.databases:
            raise CommandError("缺少 default 数据库配置")

        issues: list[str] = []
        warnings: list[str] = []

        self.stdout.write(f"[TabDoc] 开始验收，目标数据库: {db_alias}")

        target_applied = self._is_migration_applied(
            db_alias,
            TARGET_APP_LABEL,
            TARGET_MIGRATION,
        )
        if target_applied:
            self.stdout.write(self.style.SUCCESS(f"  ✓ {db_alias} 已应用 {TARGET_MIGRATION}"))
        else:
            issues.append(f"{db_alias} 未应用迁移 {TARGET_MIGRATION}")

        default_applied = self._is_migration_applied(
            "default",
            TARGET_APP_LABEL,
            TARGET_MIGRATION,
        )
        if default_applied:
            issues.append(
                "default 检测到 tabdoc 迁移记录，可能曾误迁移到 MySQL；"
                "请核查 django_migrations 并确保仅在 postgresql 上应用。"
            )
        else:
            self.stdout.write(self.style.SUCCESS("  ✓ default 未误记 tabdoc 迁移"))

        table_exists = self._table_exists(db_alias, TARGET_TABLE)
        if not table_exists:
            issues.append(f"{db_alias} 缺少表 {TARGET_TABLE}")
        else:
            self.stdout.write(self.style.SUCCESS(f"  ✓ 表存在: {TARGET_TABLE}"))

            if self._column_exists(db_alias, TARGET_TABLE, TARGET_COLUMN):
                self.stdout.write(self.style.SUCCESS(f"  ✓ 字段存在: {TARGET_TABLE}.{TARGET_COLUMN}"))
            else:
                issues.append(f"{db_alias} 缺少字段 {TARGET_TABLE}.{TARGET_COLUMN}")

            if self._constraint_exists(db_alias, TARGET_TABLE, TARGET_INDEX):
                self.stdout.write(self.style.SUCCESS(f"  ✓ 索引存在: {TARGET_INDEX}"))
            else:
                issues.append(f"{db_alias} 缺少索引 {TARGET_INDEX}")

            total_versions, null_versions = self._fetch_version_stats(db_alias)
            self.stdout.write(
                f"  · 版本统计: total={total_versions}, null_version={null_versions}"
            )
            if total_versions > 0 and null_versions > 0:
                warnings.append(
                    "发现历史版本 version 为空。新写入不受影响，但建议评估是否需要离线补齐。"
                )

        for warning in warnings:
            self.stdout.write(self.style.WARNING(f"[WARN] {warning}"))
        for issue in issues:
            self.stdout.write(self.style.ERROR(f"[ERROR] {issue}"))

        if issues:
            raise CommandError(f"TabDoc 迁移验收失败（{len(issues)} 个问题）")
        if strict and warnings:
            raise CommandError(f"TabDoc 迁移验收存在告警（strict 模式，{len(warnings)} 条）")

        self.stdout.write(self.style.SUCCESS("[TabDoc] 迁移验收通过"))

    def _is_migration_applied(self, db_alias: str, app_label: str, migration_name: str) -> bool:
        recorder = MigrationRecorder(connections[db_alias])
        return recorder.migration_qs.filter(
            app=app_label,
            name=migration_name,
        ).exists()

    def _table_exists(self, db_alias: str, table_name: str) -> bool:
        connection = connections[db_alias]
        with connection.cursor() as cursor:
            table_names = connection.introspection.table_names(cursor)
        return table_name in set(table_names)

    def _column_exists(self, db_alias: str, table_name: str, column_name: str) -> bool:
        connection = connections[db_alias]
        with connection.cursor() as cursor:
            columns = connection.introspection.get_table_description(cursor, table_name)
        return column_name in {col.name for col in columns}

    def _constraint_exists(self, db_alias: str, table_name: str, constraint_name: str) -> bool:
        connection = connections[db_alias]
        with connection.cursor() as cursor:
            constraints = connection.introspection.get_constraints(cursor, table_name)
        return constraint_name in constraints

    def _fetch_version_stats(self, db_alias: str) -> tuple[int, int]:
        connection = connections[db_alias]
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT
                    COUNT(*) AS total_count,
                    SUM(CASE WHEN {TARGET_COLUMN} IS NULL THEN 1 ELSE 0 END) AS null_count
                FROM {TARGET_TABLE}
                """
            )
            row = cursor.fetchone()
        total = int(row[0] or 0) if row else 0
        nulls = int(row[1] or 0) if row else 0
        return total, nulls

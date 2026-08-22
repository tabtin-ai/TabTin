"""
审计 FileStatistics 表的使用状态，为物理清理做准备。

检查：
  1. 表中有多少行数据
  2. 最早/最晚记录日期
  3. 代码中是否有活跃引用（已在 PRD 确认仅模型定义和注释引用）
  4. 输出清理建议

用法:
    python manage.py audit_file_statistics
    python manage.py audit_file_statistics --drop-preview
"""
from django.core.management.base import BaseCommand
from django.db import connection


class Command(BaseCommand):
    help = "审计 FileStatistics 表状态，输出清理建议"

    def add_arguments(self, parser):
        parser.add_argument(
            "--drop-preview",
            action="store_true",
            help="生成 DROP TABLE 的 SQL（不执行）",
        )

    def handle(self, *args, **options):
        table_name = "services_oss_file_statistics"

        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) FROM information_schema.tables "
                "WHERE table_schema = DATABASE() AND table_name = %s",
                [table_name],
            )
            exists = cursor.fetchone()[0] > 0

        if not exists:
            self.stdout.write(f"表 {table_name} 不存在，无需清理。")
            return

        with connection.cursor() as cursor:
            cursor.execute(f"SELECT COUNT(*) FROM `{table_name}`")
            row_count = cursor.fetchone()[0]

            cursor.execute(f"SELECT MIN(date), MAX(date) FROM `{table_name}`")
            min_date, max_date = cursor.fetchone()

        self.stdout.write(f"\n=== FileStatistics 审计报告 ===")
        self.stdout.write(f"表名: {table_name}")
        self.stdout.write(f"行数: {row_count}")
        self.stdout.write(f"日期范围: {min_date} ~ {max_date}")
        self.stdout.write(f"模型状态: 已标记废弃（docstring）")
        self.stdout.write(f"代码引用: 仅模型定义 + lifecycle cleanup 注释（确认无活跃消费方）")

        if row_count == 0:
            self.stdout.write("\n建议: 表为空，可安全 DROP。")
        else:
            self.stdout.write(f"\n建议: 表有 {row_count} 行历史数据。")
            self.stdout.write("  - 如无数据仓库或 BI 系统直连此表，可安全 DROP")
            self.stdout.write("  - 如需保留数据，建议先 mysqldump 备份后再 DROP")

        if options["drop_preview"]:
            self.stdout.write(f"\n--- DROP 预览 SQL（未执行）---")
            self.stdout.write(f"DROP TABLE IF EXISTS `{table_name}`;")
            self.stdout.write(f"-- 同时删除 django_migrations 中对应记录:")
            self.stdout.write(f"-- DELETE FROM django_migrations WHERE app='oss' AND name LIKE '%filestatistics%';")

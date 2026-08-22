"""
修复 3 张 billing 表的 collation 不一致问题。

这 3 张表在 2026-03-19 创建时跟了 MySQL server 默认的 utf8mb4_0900_ai_ci，
而数据库和其余 109 张表均为 utf8mb4_unicode_ci。
虽然目前尚未有跨表 JOIN 报错，但 workteam_id 等 CharField 一旦
与其他表做 JOIN/子查询就会触发同样的 "Illegal mix of collations"（1267）。

跨库可移植性：CONVERT TO CHARACTER SET ... COLLATE 是 MySQL 专属语法，
collation 不一致也是 MySQL 特有问题。PostgreSQL/SQLite 无此概念，故按 vendor
守卫：single_pg / SQLite 下整体 no-op，避免 `migrate` 在此处直接报错。
"""

from django.db import migrations


_TABLES = (
    "services_billing_admin_audit_log",
    "services_billing_anomaly_alert",
    "services_billing_reconciliation_report",
)


def _convert_collation(apps, schema_editor):
    if schema_editor.connection.vendor != "mysql":
        return
    for table in _TABLES:
        schema_editor.execute(
            f"ALTER TABLE {table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )


def _revert_collation(apps, schema_editor):
    if schema_editor.connection.vendor != "mysql":
        return
    for table in _TABLES:
        schema_editor.execute(
            f"ALTER TABLE {table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
        )


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0023_alter_memberllmbudgetpolicy_target_role"),
    ]

    operations = [
        migrations.RunPython(_convert_collation, _revert_collation),
    ]

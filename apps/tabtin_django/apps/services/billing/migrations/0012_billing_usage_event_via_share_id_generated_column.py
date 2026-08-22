"""
为 BillingUsageEvent 的 metadata->'$.via_share_id' 添加 Generated Column + 索引，
加速按 via_share_id 的查询。

历史上这里写死了 MySQL 语法（JSON_UNQUOTE(JSON_EXTRACT(...))、`DROP INDEX ... ON table`），
在双库（billing 落 MySQL）下没问题。但 single_pg 单库模式下 billing 表落 PostgreSQL，
MySQL 的 JSON 函数与 DROP INDEX 语法在 PG 上不存在，会直接报错。
故改成按 connection.vendor 分支：MySQL 保留原生成列；PostgreSQL/SQLite 用 `->>` 抽取。
"""

from django.db import migrations


def _add_via_share_column(apps, schema_editor):
    if schema_editor.connection.vendor == "mysql":
        schema_editor.execute(
            "ALTER TABLE services_billing_usage_event "
            "ADD COLUMN via_share_id VARCHAR(36) "
            "GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.via_share_id'))) STORED"
        )
    else:
        # PostgreSQL / SQLite：metadata 为 JSON(B)，用 ->> 抽取标量文本。
        schema_editor.execute(
            "ALTER TABLE services_billing_usage_event "
            "ADD COLUMN via_share_id varchar(36) "
            "GENERATED ALWAYS AS ((metadata ->> 'via_share_id')) STORED"
        )


def _drop_via_share_column(apps, schema_editor):
    schema_editor.execute(
        "ALTER TABLE services_billing_usage_event DROP COLUMN via_share_id"
    )


def _add_via_share_index(apps, schema_editor):
    schema_editor.execute(
        "CREATE INDEX idx_billing_via_share "
        "ON services_billing_usage_event(via_share_id)"
    )


def _drop_via_share_index(apps, schema_editor):
    if schema_editor.connection.vendor == "mysql":
        schema_editor.execute(
            "DROP INDEX idx_billing_via_share ON services_billing_usage_event"
        )
    else:
        schema_editor.execute("DROP INDEX idx_billing_via_share")


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0011_rename_workspace_service_policy_to_workteam"),
    ]

    operations = [
        migrations.RunPython(_add_via_share_column, _drop_via_share_column),
        migrations.RunPython(_add_via_share_index, _drop_via_share_index),
    ]

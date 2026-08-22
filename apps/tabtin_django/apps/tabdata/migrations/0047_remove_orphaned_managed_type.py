"""移除临时部署遗留、当前模型已不再声明的 managed_type 列。"""

from django.db import migrations


def remove_orphaned_managed_type(apps, schema_editor):
    table_name = "tabdata_table"
    with schema_editor.connection.cursor() as cursor:
        columns = {
            column.name
            for column in schema_editor.connection.introspection.get_table_description(
                cursor, table_name
            )
        }

    if "managed_type" in columns:
        quoted_table = schema_editor.quote_name(table_name)
        quoted_column = schema_editor.quote_name("managed_type")
        schema_editor.execute(
            f"ALTER TABLE {quoted_table} DROP COLUMN {quoted_column}"
        )


class Migration(migrations.Migration):
    # 测试环境曾执行但未进入仓库的临时迁移；供发布前 artifact 门禁审计。
    reconciles = [("tabdata", "0047_table_managed_type")]

    dependencies = [
        ("tabdata", "0046_merge_0045_link_and_token_3266"),
    ]

    operations = [
        migrations.RunPython(
            remove_orphaned_managed_type,
            reverse_code=migrations.RunPython.noop,
        ),
    ]

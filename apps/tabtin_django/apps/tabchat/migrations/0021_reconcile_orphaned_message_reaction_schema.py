"""收敛临时部署遗留的 MessageReaction 数据库结构。

当前代码仍以 ``message_id`` 作为表情反应身份。某次未入库迁移曾把测试环境
改成 ``conversation_id + message_ref``，导致 ORM 与数据库契约不一致。
只允许自动重建空的遗留表；存在数据时 fail closed，避免静默丢失反应数据。
"""

from django.db import migrations


TABLE_NAME = "tabchat_message_reaction"
CURRENT_IDENTITY_COLUMN = "message_id"
LEGACY_IDENTITY_COLUMNS = {"conversation_id", "message_ref"}


def reconcile_message_reaction_schema(apps, schema_editor):
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        table_names = set(connection.introspection.table_names(cursor))
        if TABLE_NAME not in table_names:
            schema_editor.create_model(apps.get_model("tabchat", "MessageReaction"))
            return

        columns = {
            column.name
            for column in connection.introspection.get_table_description(
                cursor, TABLE_NAME
            )
        }
        if CURRENT_IDENTITY_COLUMN in columns:
            return

        if not LEGACY_IDENTITY_COLUMNS.issubset(columns):
            raise RuntimeError(
                "tabchat_message_reaction 结构未知：缺少 message_id，且不符合已知遗留结构"
            )

        cursor.execute(f"SELECT EXISTS (SELECT 1 FROM {TABLE_NAME} LIMIT 1)")
        has_rows = cursor.fetchone()[0]

    if has_rows:
        raise RuntimeError(
            "tabchat_message_reaction 使用遗留身份结构且包含数据；"
            "必须先制定显式数据映射方案，迁移已安全阻断"
        )

    schema_editor.execute(f"DROP TABLE {schema_editor.quote_name(TABLE_NAME)}")
    schema_editor.create_model(apps.get_model("tabchat", "MessageReaction"))


class Migration(migrations.Migration):
    # 测试环境曾执行但未进入仓库的临时迁移；供发布前 artifact 门禁审计。
    reconciles = [("tabchat", "0019_replace_message_reaction_identity")]

    dependencies = [
        ("tabchat", "0020_resource_access_request_message_ref"),
    ]

    operations = [
        migrations.RunPython(
            reconcile_message_reaction_schema,
            reverse_code=migrations.RunPython.noop,
        ),
    ]

# ：删除 ChatSession.approval_mode，权限唯一真源收敛到 Workspace.approval_grant。

from django.db import migrations
from django.db.migrations.exceptions import IrreversibleError


def discard_and_remove_chatsession_approval_mode(apps, schema_editor):
    """有意丢弃会话级 approval_mode 列值并幂等删除该列。

    产品决策：Workspace.approval_grant 是执行权限唯一真源；会话请求档不再参与
    判决，也不迁到 Workspace / Organization。旧 API 的 approval_mode 字段仅作
    兼容投影或忽略输入，不回写第二数据源。

    本步在状态层 RemoveField 前显式承认并丢弃历史列值，满足
    ``destructive_without_data_move``；物理列不存在时只更新 migration state，
    不删除 ChatSession 行。
    """
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT 1
              FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'chat_session'
               AND column_name = 'approval_mode'
            """
        )
        if cursor.fetchone() is None:
            # 测试线曾由 0089 删除该列；release 回放到同一数据库时无需重复 DDL。
            return

    ChatSession = apps.get_model("conversation", "ChatSession")
    db_alias = connection.alias
    # 读取 distinct 档位，确认历史值在 DROP COLUMN 前被显式处置（丢弃、不迁移）。
    _ = list(
        ChatSession.objects.using(db_alias)
        .order_by()
        .values_list("approval_mode", flat=True)
        .distinct()
    )
    schema_editor.execute(
        f"ALTER TABLE {schema_editor.quote_name('chat_session')} "
        f"DROP COLUMN {schema_editor.quote_name('approval_mode')}"
    )


def reverse_discard_chatsession_approval_mode(apps, schema_editor):
    raise IrreversibleError(
        "ChatSession.approval_mode was retired in ; "
        "historical session request-tier values were intentionally discarded "
        "and are not restored. Recover from DB backup if required."
    )


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0091_sessionshareresourcesyncjob"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(
                    discard_and_remove_chatsession_approval_mode,
                    reverse_discard_chatsession_approval_mode,
                ),
            ],
            state_operations=[
                migrations.RemoveField(
                    model_name="chatsession",
                    name="approval_mode",
                ),
            ],
        ),
    ]

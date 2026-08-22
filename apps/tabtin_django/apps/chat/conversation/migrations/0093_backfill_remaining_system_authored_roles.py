from django.db import migrations
from django.db.models import Q


def normalize_remaining_system_authored_roles(apps, schema_editor):
    ChatMessage = apps.get_model("conversation", "ChatMessage")
    alias = schema_editor.connection.alias
    system_authored = (
        Q(message_kind="external_archive_context")
        | Q(message_kind="llm", metadata__triggered_by="parent_midflight")
    )
    (
        ChatMessage.objects.using(alias)
        .filter(role="user")
        .filter(system_authored)
        .update(role="system")
    )


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0092_backfill_system_authored_message_roles"),
    ]

    operations = [
        migrations.RunPython(
            normalize_remaining_system_authored_roles,
            # 与 0092 同口径：角色回填是事实纠正，不做反向数据污染；灾备回退
            # 依赖迁移前数据库备份。
            reverse_code=migrations.RunPython.noop,
        ),
    ]

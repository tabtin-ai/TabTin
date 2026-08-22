from django.db import migrations
from django.db.models import Q


SYSTEM_AUTHORED_MESSAGE_KINDS = (
    "environment_context",
    "agent_profile_context",
    "system_prompt_context",
    "compaction_summary",
    "hitl_interaction",
)


def normalize_system_authored_roles(apps, schema_editor):
    ChatMessage = apps.get_model("conversation", "ChatMessage")
    alias = schema_editor.connection.alias
    system_authored = (
        Q(message_kind__in=SYSTEM_AUTHORED_MESSAGE_KINDS)
        | Q(message_kind="llm", metadata__source="skill_invoke")
        | Q(message_kind="llm", metadata__triggered_by="push-notification")
    )
    (
        ChatMessage.objects.using(alias)
        .filter(role="user")
        .filter(system_authored)
        .update(role="system")
    )


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0091_sessionshareresourcesyncjob"),
    ]

    operations = [
        migrations.RunPython(
            normalize_system_authored_roles,
            # 作者角色是事实纠正；回滚 migration history 时不应把已纠正的数据
            # 重新伪装为真人 user。需要恢复旧数据只能使用迁移前数据库备份。
            reverse_code=migrations.RunPython.noop,
        ),
    ]

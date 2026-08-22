from django.db import migrations
from django.db.models import Q


MEMORY_MEMO_TYPES = ("about_you", "insight", "task_summary", "diary")


def backfill_agent_id(apps, schema_editor):
    import logging

    logger = logging.getLogger(__name__)
    alias = schema_editor.connection.alias
    Space = apps.get_model("tabtinspace", "Space")
    Memo = apps.get_model("tabmemo", "Memo")

    total_updated = 0
    total_skipped = 0
    spaces = (
        Space.objects.using(alias)
        .filter(type="workspace", agent__isnull=False)
        .values_list("id", "agent_id", "agent__owner_user_id")
    )
    for space_id, agent_id, agent_owner_user_id in spaces.iterator(chunk_size=500):
        queryset = Memo.objects.using(alias).filter(
            space_id=space_id,
            agent_id__isnull=True,
            source="agent",
            memo_type__in=MEMORY_MEMO_TYPES,
        )
        if agent_owner_user_id:
            skipped = (
                queryset.filter(owner_id__isnull=False)
                .exclude(owner_id=agent_owner_user_id)
                .count()
            )
            total_skipped += skipped
            queryset = queryset.filter(
                Q(owner_id__isnull=True) | Q(owner_id=agent_owner_user_id)
            )
        total_updated += queryset.update(agent_id=agent_id)
    logger.info(
        "[MemoAgentBackfill] done: backfilled=%d skipped_owner_mismatch=%d",
        total_updated,
        total_skipped,
    )


class Migration(migrations.Migration):
    dependencies = [
        ("tabmemo", "0023_memo_agent_id_diary"),
        ("tabtinspace", "0098_strip_agent_approval_config"),
    ]

    operations = [
        migrations.RunPython(backfill_agent_id, migrations.RunPython.noop),
    ]

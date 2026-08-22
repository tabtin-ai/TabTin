from django.db import migrations


MEMORY_TYPES = ("about_you", "insight", "task_summary", "diary")
BATCH_SIZE = 500


def migrate_agent_memories(apps, schema_editor):
    alias = schema_editor.connection.alias
    Agent = apps.get_model("agent", "Agent")
    AgentMemory = apps.get_model("agent_memory", "AgentMemory")
    Memo = apps.get_model("tabmemo", "Memo")

    source = Memo.objects.using(alias).filter(
        source="agent",
        memo_type__in=MEMORY_TYPES,
        agent_id__isnull=False,
    )
    valid_agent_ids = set(
        Agent.objects.using(alias)
        .filter(id__in=source.values_list("agent_id", flat=True).distinct())
        .values_list("id", flat=True)
    )
    source = source.filter(agent_id__in=valid_agent_ids).order_by("id")

    pending = []
    for memo in source.iterator(chunk_size=BATCH_SIZE):
        pending.append(
            AgentMemory(
                id=memo.id,
                agent_id=memo.agent_id,
                organization_id=memo.organization_id,
                owner_id=memo.owner_id or memo.created_by_id,
                content_json=memo.content_json or {},
                content_plaintext=memo.content_plaintext or "",
                content_markdown=memo.content_markdown or "",
                memo_type=memo.memo_type,
                title="",
                importance=memo.importance,
                access_count=memo.access_count or 0,
                tags=memo.tags or [],
                ai_tags=memo.ai_tags or [],
                source_url=memo.source_url or "",
                status="active" if memo.status == "active" else "archived",
                forgotten_at=None,
                created_at=memo.created_at,
                updated_at=memo.updated_at,
            )
        )
        if len(pending) == BATCH_SIZE:
            AgentMemory.objects.using(alias).bulk_create(pending)
            pending.clear()

    if pending:
        AgentMemory.objects.using(alias).bulk_create(pending)


def reverse_agent_memories(apps, schema_editor):
    alias = schema_editor.connection.alias
    AgentMemory = apps.get_model("agent_memory", "AgentMemory")
    Memo = apps.get_model("tabmemo", "Memo")
    source_ids = Memo.objects.using(alias).filter(
        source="agent",
        memo_type__in=MEMORY_TYPES,
    ).values_list("id", flat=True)
    AgentMemory.objects.using(alias).filter(id__in=source_ids).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("agent_memory", "0001_initial"),
        ("tabmemo", "0024_backfill_memo_agent_id"),
    ]

    operations = [
        migrations.RunPython(migrate_agent_memories, reverse_agent_memories),
    ]

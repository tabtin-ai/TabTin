from django.db import migrations


ROLE_LEVELS = {"viewer": 1, "participant": 1, "editor": 2, "admin": 3, "owner": 4}


def split_human_agent_rows(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    Agent = apps.get_model("tabtinspace", "Agent")
    SpaceMembership = apps.get_model("tabtinspace", "SpaceMembership")
    Tracker = apps.get_model("tracker", "Tracker")

    human_agent_ids = list(
        Agent.objects.using(db_alias)
        .exclude(type="bot")
        .values_list("id", flat=True)
    )
    if not human_agent_ids:
        return

    memberships = (
        SpaceMembership.objects.using(db_alias)
        .filter(agent_id__in=human_agent_ids)
        .select_related("agent")
        .order_by("joined_at", "id")
    )
    for membership in memberships.iterator():
        agent_user_id = getattr(membership.agent, "user_id", None)
        if not agent_user_id:
            membership.delete()
            continue
        existing_user_row = (
            SpaceMembership.objects.using(db_alias)
            .filter(space_id=membership.space_id, user_id=agent_user_id)
            .exclude(id=membership.id)
            .first()
        )
        if existing_user_row is not None:
            update_fields = []
            if ROLE_LEVELS.get(membership.role, 0) > ROLE_LEVELS.get(existing_user_row.role, 0):
                existing_user_row.role = membership.role
                update_fields.append("role")
            if membership.is_active and not existing_user_row.is_active:
                existing_user_row.is_active = True
                update_fields.append("is_active")
            if update_fields:
                existing_user_row.save(update_fields=update_fields)
            membership.delete()
            continue
        membership.user_id = agent_user_id
        membership.agent_id = None
        membership.save(update_fields=["user_id", "agent_id"])

    Tracker.objects.using(db_alias).filter(agent_id__in=human_agent_ids).update(agent_id=None)
    Agent.objects.using(db_alias).filter(id__in=human_agent_ids).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0095a_agent_purification"),
        ("tracker", "0039_backfill_cron_timezone"),
        ("conversation", "0061_engineruntimeconfig_cleanup_llm_snapshot_retention_days_and_more"),
        ("tabmemo", "0023_memo_agent_id_diary"),
        ("skills", "0012_skill_import_source_url"),
    ]

    operations = [
        migrations.RunPython(split_human_agent_rows, migrations.RunPython.noop),
    ]

from django.db import migrations


LEGACY_DEFAULT_SPACE_NAME = "默认 Space"
LEGACY_DEFAULT_SPACE_DESCRIPTION = "自动创建的默认 Space"
DEFAULT_AGENT_NAME = "默认 Agent"
DEFAULT_AGENT_SPACE_DESCRIPTION = "自动创建的默认 Agent Space"


def restore_default_agent_onboarding_name(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    Agent = apps.get_model("tabtinspace", "Agent")
    Space = apps.get_model("tabtinspace", "Space")

    default_spaces = Space.objects.using(db_alias).filter(
        type="bot",
        is_default=True,
        name=LEGACY_DEFAULT_SPACE_NAME,
        agent_id__isnull=False,
    )

    for space in default_spaces.iterator():
        Agent.objects.using(db_alias).filter(
            id=space.agent_id,
            type="bot",
            name=LEGACY_DEFAULT_SPACE_NAME,
        ).update(name=DEFAULT_AGENT_NAME)

        has_name_conflict = Space.objects.using(db_alias).filter(
            workteam_id=space.workteam_id,
            name=DEFAULT_AGENT_NAME,
        ).exclude(id=space.id).exists()
        if has_name_conflict:
            continue

        update_fields = {"name": DEFAULT_AGENT_NAME}
        if space.description in ("", LEGACY_DEFAULT_SPACE_DESCRIPTION):
            update_fields["description"] = DEFAULT_AGENT_SPACE_DESCRIPTION

        Space.objects.using(db_alias).filter(id=space.id).update(**update_fields)


def reverse_default_agent_onboarding_name(apps, schema_editor):
    return None


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0069_merge_20260623_1752"),
    ]

    operations = [
        migrations.RunPython(
            restore_default_agent_onboarding_name,
            reverse_default_agent_onboarding_name,
        ),
    ]

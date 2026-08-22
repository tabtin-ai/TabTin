from django.db import migrations


LEGACY_DEFAULT_SPACE_NAME = "默认 " + "Agent"
DEFAULT_SPACE_NAME = "默认 Space"
DEFAULT_SPACE_DESCRIPTION = "自动创建的默认 Space"


def rename_default_agent_spaces(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    Agent = apps.get_model("tabtinspace", "Agent")
    Space = apps.get_model("tabtinspace", "Space")

    Agent.objects.using(db_alias).filter(
        type="bot",
        name=LEGACY_DEFAULT_SPACE_NAME,
    ).update(name=DEFAULT_SPACE_NAME)

    Space.objects.using(db_alias).filter(
        type="bot",
        name=LEGACY_DEFAULT_SPACE_NAME,
    ).update(
        name=DEFAULT_SPACE_NAME,
        description=DEFAULT_SPACE_DESCRIPTION,
    )


def reverse_default_agent_spaces(apps, schema_editor):
    # Space-first 命名是产品口径收敛，回滚迁移时也不恢复旧展示文案。
    return None


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0066_retire_space_share_delegation"),
    ]

    operations = [
        migrations.RunPython(rename_default_agent_spaces, reverse_default_agent_spaces),
    ]

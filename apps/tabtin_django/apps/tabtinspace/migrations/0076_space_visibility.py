from django.db import migrations, models


def backfill_space_visibility(apps, schema_editor):
    Space = apps.get_model("tabtinspace", "Space")
    SpaceMembership = apps.get_model("tabtinspace", "SpaceMembership")
    Agent = apps.get_model("tabtinspace", "Agent")

    bot_agent_ids = set(
        Agent.objects.filter(type="bot").values_list("id", flat=True)
    )

    for space in Space.objects.all().iterator():
        if space.agent_id and space.agent_id in bot_agent_ids:
            continue
        has_non_owner = SpaceMembership.objects.filter(
            space_id=space.id,
            is_active=True,
        ).exclude(role="owner").exists()
        if has_non_owner and space.visibility != "shared":
            Space.objects.filter(id=space.id).update(visibility="shared")


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0075_space_type_workspace"),
    ]

    operations = [
        migrations.AddField(
            model_name="space",
            name="visibility",
            field=models.CharField(
                choices=[("private", "仅创建者"), ("shared", "已共享")],
                default="private",
                help_text="private=仅 owner 可见；shared=已授权成员可见。",
                max_length=20,
                verbose_name="可见范围",
            ),
        ),
        migrations.RunPython(backfill_space_visibility, migrations.RunPython.noop),
    ]

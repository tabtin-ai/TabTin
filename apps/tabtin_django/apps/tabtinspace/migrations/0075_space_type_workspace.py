from django.db import migrations, models
from django.db.models import Q


def forward_workspace_type(apps, schema_editor):
    Space = apps.get_model("tabtinspace", "Space")
    Agent = apps.get_model("tabtinspace", "Agent")

    Space.objects.filter(type="bot").update(type="workspace")
    Space.objects.filter(name="默认 Agent").update(name="默认 Space")
    Agent.objects.filter(name="默认 Agent", type="bot").update(name="默认 Space 执行身份")

    for space in Space.objects.filter(working_dir__endswith="默认 Agent"):
        updates = {}
        for field in ("working_dir", "normalized_working_dir"):
            value = getattr(space, field, "") or ""
            if value.endswith("/默认 Agent"):
                updates[field] = value[: -len("默认 Agent")] + "默认 Space"
            elif value.endswith("\\默认 Agent"):
                updates[field] = value[: -len("默认 Agent")] + "默认 Space"
        if updates:
            Space.objects.filter(pk=space.pk).update(**updates)


def backward_workspace_type(apps, schema_editor):
    Space = apps.get_model("tabtinspace", "Space")
    Space.objects.filter(type="workspace").update(type="bot")


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("tabtinspace", "0074_remove_space_ctx_one_active_bot_space_per_agent_and_more"),
    ]

    operations = [
        migrations.RunPython(forward_workspace_type, backward_workspace_type),
        migrations.AlterField(
            model_name="space",
            name="type",
            field=models.CharField(
                choices=[("workspace", "Workspace")],
                default="workspace",
                max_length=20,
                verbose_name="Space 类型",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="space",
            name="ctx_space_device_dir_unique",
        ),
        migrations.AddConstraint(
            model_name="space",
            constraint=models.UniqueConstraint(
                condition=(
                    Q(type="workspace", is_archived=False, trashed_at__isnull=True)
                    & ~Q(("normalized_working_dir", ""))
                ),
                fields=("workteam", "control_device", "normalized_working_dir"),
                name="ctx_space_device_dir_unique",
            ),
        ),
    ]

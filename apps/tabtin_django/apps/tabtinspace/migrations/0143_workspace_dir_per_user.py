from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0142_workspace_home_per_user_9839"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="workspace",
            name="ctx_ws_device_dir_unique",
        ),
        migrations.AddConstraint(
            model_name="workspace",
            constraint=models.UniqueConstraint(
                fields=(
                    "organization",
                    "created_by",
                    "device",
                    "normalized_working_dir",
                ),
                condition=(
                    models.Q(("created_by__isnull", False))
                    & ~models.Q(("normalized_working_dir", ""))
                ),
                name="ctx_ws_device_dir_unique",
            ),
        ),
    ]

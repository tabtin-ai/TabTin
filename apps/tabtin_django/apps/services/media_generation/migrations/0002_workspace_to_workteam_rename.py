"""workspace → workteam 重命名迁移（media_generation app）"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("media_generation", "0001_initial"),
    ]

    operations = [
        migrations.RenameField(
            model_name="mediaprovider",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="mediatask",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

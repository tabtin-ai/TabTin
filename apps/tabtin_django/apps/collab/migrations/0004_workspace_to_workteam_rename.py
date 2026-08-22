"""
workspace_id → workteam_id 重命名迁移（collab app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("collab", "0003_alter_spacecheckpoint_space_id"),
    ]

    operations = [
        migrations.RenameField(
            model_name="spacecheckpoint",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="versionhistory",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

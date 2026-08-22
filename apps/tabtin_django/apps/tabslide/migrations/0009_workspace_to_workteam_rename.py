"""
workspace_id → workteam_id 重命名迁移（tabslide app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabslide", "0008_add_ws_proj_status_idx"),
    ]

    operations = [
        migrations.RenameField(
            model_name="slidehistory",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="slideproject",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

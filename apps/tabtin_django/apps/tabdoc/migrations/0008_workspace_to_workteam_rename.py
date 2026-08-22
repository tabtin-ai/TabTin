"""
workspace_id → workteam_id 重命名迁移（tabdoc app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0007_add_is_private_to_document"),
    ]

    operations = [
        migrations.RenameField(
            model_name="dochistory",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="document",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="documentversion",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

"""
workspace_id → workteam_id 重命名迁移（tabcode app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabcode", "0005_alter_codeproject_space_id"),
    ]

    operations = [
        migrations.RenameField(
            model_name="codeproject",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

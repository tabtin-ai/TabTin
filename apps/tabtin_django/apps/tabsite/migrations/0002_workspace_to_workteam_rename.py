"""
workspace_id → workteam_id 重命名迁移（tabsite app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabsite", "0001_initial"),
    ]

    operations = [
        migrations.RenameField(
            model_name="site",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

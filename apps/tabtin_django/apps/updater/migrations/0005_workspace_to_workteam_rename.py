"""
workspace → workteam 重命名迁移（updater app，MySQL 数据库）

涵盖：
- RenameField: UpdateLog.workspace_id → workteam_id
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("updater", "0004_release_asset_fields"),
    ]

    operations = [
        migrations.RenameField(
            model_name="updatelog",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

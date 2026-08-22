"""
workspace → workteam 重命名迁移（membership app，MySQL 数据库）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("membership", "0006_membershiptier_tier_level"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="WorkspaceMembership",
            new_name="WorkteamMembership",
        ),
        migrations.RenameField(
            model_name="workteammembership",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

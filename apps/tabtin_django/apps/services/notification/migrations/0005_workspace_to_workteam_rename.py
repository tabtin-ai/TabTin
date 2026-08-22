"""workspace → workteam 重命名迁移（notification app）"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("notification", "0004_alter_notification_space_id"),
    ]

    operations = [
        migrations.RenameField(
            model_name="notification",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

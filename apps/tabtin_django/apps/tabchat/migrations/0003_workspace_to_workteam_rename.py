"""
workspace_id → workteam_id 重命名迁移（tabchat app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabchat", "0002_conversation_space_id"),
    ]

    operations = [
        migrations.RenameField(
            model_name="conversation",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

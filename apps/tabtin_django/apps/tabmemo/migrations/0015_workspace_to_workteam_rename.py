"""
workspace_id → workteam_id 重命名迁移（tabmemo app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabmemo", "0014_add_content_plaintext_trgm_gin"),
    ]

    operations = [
        migrations.RenameField(
            model_name="memo",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="memoagentgrant",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="memocollection",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

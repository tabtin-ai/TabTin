"""
workspace_id → workteam_id 重命名迁移（rag app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("rag", "0015_merge_20260318_1146"),
    ]

    operations = [
        migrations.RenameField(
            model_name="codechunkembedding",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="documentembedding",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

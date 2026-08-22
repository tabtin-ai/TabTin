"""
workspace_id → workteam_id 重命名迁移（tins app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tins", "0005_rename_tins_instan_agent_s_63b06b_idx_tins_instan_space_i_4aaf52_idx_and_more"),
    ]

    operations = [
        migrations.RenameField(
            model_name="tin",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="tininstance",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

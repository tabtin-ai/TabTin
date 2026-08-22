"""workspace → workteam 重命名迁移（scheduler app）"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0011_rename_goal_agent_s_f55a97_idx_goal_space_i_30c3d7_idx_and_more"),
        ("tabtinspace", "0016_merge_20260319_0948"),
    ]

    operations = [
        migrations.RenameField(
            model_name="scheduledjob",
            old_name="workspace",
            new_name="workteam",
        ),
        migrations.RenameField(
            model_name="goal",
            old_name="workspace",
            new_name="workteam",
        ),
    ]

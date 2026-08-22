#  终态 · Drop Tracker.space FK（真删除，禁止 softref）
#
# 事实源已是 ``Tracker.workspace``（0040 回填）。本迁移 RemoveField space，
# 索引改挂 workspace。不做 UUIDField softref。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tracker', '0041_agent_fk_to_agent_app'),
        ('tabtinspace', '0108b_personal_shell_schema_cutover_3266'),
    ]

    operations = [
        migrations.RemoveIndex(
            model_name='tracker',
            name='tracker_space_i_21e1e4_idx',
        ),
        migrations.RemoveField(
            model_name='tracker',
            name='space',
        ),
        migrations.AddIndex(
            model_name='tracker',
            index=models.Index(
                fields=['workspace'],
                name='tracker_workspace_idx',
            ),
        ),
    ]

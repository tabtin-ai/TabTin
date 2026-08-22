"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('tracker', '0036_alter_trackerrun_status'),
        ('tabtinspace', '0089_rename_workteam_to_organization'),
    ]

    operations = [
        migrations.RenameField(model_name='tracker', old_name='workteam', new_name='organization'),
    ]

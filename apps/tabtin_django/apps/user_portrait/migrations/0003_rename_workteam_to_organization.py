"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('user_portrait', '0002_alter_userportrait_user'),
    ]

    operations = [
        migrations.RemoveConstraint(model_name='userportrait', name='up_user_workteam_unique'),
        migrations.RenameField(model_name='userportrait', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameIndex(model_name='userportrait', old_name='up_workteam_idx', new_name='up_organization_idx'),
        migrations.AddConstraint(model_name='userportrait', constraint=models.UniqueConstraint(fields=['user', 'organization_id'], name='up_user_organization_unique')),
    ]

"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('agent_engine', '0016_drop_subagent_template_inherit_mode'),
    ]

    operations = [
        migrations.RenameField(model_name='executiontrace', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='executionrun', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='subtaskrun', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='pendinginteraction', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='permissionaudit', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='resourceopenevent', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='cliauditevent', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameIndex(model_name='pendinginteraction', old_name='idx_pi_workteam_status_time', new_name='idx_pi_organization_st_time'),
        migrations.RenameIndex(model_name='permissionaudit', old_name='idx_permaudit_workteam_time', new_name='idx_permaudit_organization_ts'),
        migrations.RenameIndex(model_name='resourceopenevent', old_name='idx_aeroe_workteam_ts', new_name='idx_aeroe_organization_ts'),
    ]

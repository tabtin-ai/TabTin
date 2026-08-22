"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations


def _update_enum_values(apps, schema_editor, forward=True):
    """存量枚举值 'workteam' <-> 'organization'（prelaunch 一次到位，见 RENAME-SPEC §0.2）。"""
    old, new = ("workteam", "organization") if forward else ("organization", "workteam")
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "UPDATE tabdata_share SET share_type = %s WHERE share_type = %s", [new, old]
        )


def _forward_enum_values(apps, schema_editor):
    _update_enum_values(apps, schema_editor, forward=True)


def _reverse_enum_values(apps, schema_editor):
    _update_enum_values(apps, schema_editor, forward=False)

class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0042_alter_tableadminactionlog_action_type'),
    ]

    operations = [
        migrations.RenameField(model_name='table', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='attachmentupload', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='attachmentreference', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='tableshare', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='tablenamedversion', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='tablesnapshot', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='dataconnector', old_name='workteam_id', new_name='organization_id'),
        # CheckpointRollbackSaga 在 0030 已 DeleteModel、迁移状态中不存在（模型代码为幽灵遗留），
        # 不能对其 RenameField；models_saga.py 的字段名改动无需迁移操作。
        migrations.RenameField(model_name='tablewebhook', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='apicalllog', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='apiusagesummary', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='computedoutbox', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='computedoutboxdlq', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameIndex(model_name='computedoutbox', old_name='idx_cob_workteam_status', new_name='idx_cob_organization_status'),
        migrations.RenameIndex(model_name='computedoutboxdlq', old_name='idx_cdlq_workteam_failed', new_name='idx_cdlq_organization_failed'),
        migrations.RunPython(_forward_enum_values, _reverse_enum_values),
    ]

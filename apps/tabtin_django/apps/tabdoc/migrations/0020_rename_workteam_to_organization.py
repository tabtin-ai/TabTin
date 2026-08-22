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
            "UPDATE tabdoc_share SET share_type = %s WHERE share_type = %s", [new, old]
        )


def _forward_enum_values(apps, schema_editor):
    _update_enum_values(apps, schema_editor, forward=True)


def _reverse_enum_values(apps, schema_editor):
    _update_enum_values(apps, schema_editor, forward=False)

class Migration(migrations.Migration):

    dependencies = [
        ('tabdoc', '0019_alter_documentadminactionlog_action_type'),
    ]

    operations = [
        migrations.RenameField(model_name='document', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='dochistory', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='documentversion', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='documentshare', old_name='workteam_id', new_name='organization_id'),
        migrations.RunPython(_forward_enum_values, _reverse_enum_values),
    ]

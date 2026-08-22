"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('extensions', '0005_remove_extensionconnection_ext_conn_unique_with_as_and_more'),
    ]

    operations = [
        migrations.RenameField(model_name='extensionconnection', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='extensioneventlog', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='notificationrule', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='extensionwebhooksubscription', old_name='workteam_id', new_name='organization_id'),
    ]

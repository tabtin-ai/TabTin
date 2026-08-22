"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('wallet', '0015_remove_wallettransaction_users_walle_wallet__71a572_idx'),
    ]

    operations = [
        migrations.RenameModel(old_name='WorkteamWallet', new_name='OrganizationWallet'),
        migrations.RenameField(model_name='organizationwallet', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='wallettransaction', old_name='workteam_wallet', new_name='organization_wallet'),
        migrations.RenameField(model_name='wallettransaction', old_name='workteam_id', new_name='organization_id'),
        migrations.AlterModelTable(name='organizationwallet', table='users_wallet_organization_wallet'),
    ]

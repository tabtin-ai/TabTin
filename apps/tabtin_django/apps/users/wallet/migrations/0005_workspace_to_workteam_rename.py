"""
workspace → workteam 重命名迁移（wallet app，MySQL 数据库）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0004_alter_userwallet_credits_frozen_and_more"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="WorkspaceWallet",
            new_name="WorkteamWallet",
        ),
        migrations.RenameField(
            model_name="workteamwallet",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="wallettransaction",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

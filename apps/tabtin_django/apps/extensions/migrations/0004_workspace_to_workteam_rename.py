"""
workspace_id → workteam_id 重命名迁移（extensions app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("extensions", "0003_alter_extensionconnection_space_id_and_more"),
    ]

    operations = [
        migrations.RenameField(
            model_name="extensionconnection",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="extensioneventlog",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="extensionwebhooksubscription",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="notificationrule",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

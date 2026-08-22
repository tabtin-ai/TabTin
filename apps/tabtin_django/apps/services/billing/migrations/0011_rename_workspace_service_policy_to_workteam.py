"""
WorkspaceServicePolicy → WorkteamServicePolicy 重命名。

- RenameModel: WorkspaceServicePolicy → WorkteamServicePolicy
- RenameField: workspace_id → workteam_id
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0010_alter_billingbudgetpolicy_options_and_more"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="WorkspaceServicePolicy",
            new_name="WorkteamServicePolicy",
        ),
        migrations.RenameField(
            model_name="workteamservicepolicy",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

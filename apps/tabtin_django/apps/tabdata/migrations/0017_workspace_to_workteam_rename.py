"""
workspace_id → workteam_id 重命名迁移（tabdata app）
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabdata", "0016_normalize_field_type_aliases"),
    ]

    operations = [
        migrations.RenameField(
            model_name="attachmentreference",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="attachmentupload",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="table",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="tablenamedversion",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="tablesnapshot",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="apiusagesummary",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="apicalllog",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="dataconnector",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

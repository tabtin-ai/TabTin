"""workspace → workteam 重命名迁移（oss app）"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("oss", "0006_filerecord_services_os_upload__2b2f23_idx"),
    ]

    operations = [
        migrations.RenameField(
            model_name="filerecord",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="uploadtask",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="ossadminactionlog",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="ossadminactionlog",
            old_name="workspace_ids",
            new_name="workteam_ids",
        ),
        migrations.RenameField(
            model_name="ossadminactionlog",
            old_name="workspace_ids_text",
            new_name="workteam_ids_text",
        ),
    ]

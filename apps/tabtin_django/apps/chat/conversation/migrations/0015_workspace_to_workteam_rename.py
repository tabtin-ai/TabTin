"""workspace → workteam 重命名迁移（conversation app）"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0014_add_memory_settle_indexes"),
    ]

    operations = [
        migrations.RenameField(
            model_name="chatsession",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

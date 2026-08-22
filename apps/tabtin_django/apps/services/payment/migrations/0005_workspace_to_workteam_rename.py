"""workspace → workteam 重命名迁移（payment app）"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("payment", "0004_add_refunded_status"),
    ]

    operations = [
        migrations.RenameField(
            model_name="paymentorder",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]

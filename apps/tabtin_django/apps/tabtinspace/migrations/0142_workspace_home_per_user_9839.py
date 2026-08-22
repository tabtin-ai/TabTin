from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0141_organization_member_identity_snapshot"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="workspace",
            name="ctx_ws_org_device_home_unique",
        ),
        migrations.AddConstraint(
            model_name="workspace",
            constraint=models.UniqueConstraint(
                fields=("organization", "device", "created_by"),
                condition=models.Q(
                    ("created_by__isnull", False),
                    ("kind", "home"),
                ),
                name="ctx_ws_org_dev_user_home_uniq",
            ),
        ),
    ]

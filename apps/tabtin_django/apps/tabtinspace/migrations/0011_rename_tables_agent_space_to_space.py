"""Rename database tables from tabtinspace_agent_space_* to tabtinspace_space_*."""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0010_device_role_and_agent_control_device"),
    ]

    operations = [
        migrations.AlterModelTable(
            name="space",
            table="tabtinspace_space",
        ),
        migrations.AlterModelTable(
            name="spacemembership",
            table="tabtinspace_space_membership",
        ),
        migrations.AlterModelTable(
            name="spaceshare",
            table="tabtinspace_space_share",
        ),
        migrations.AlterModelTable(
            name="spaceappsettings",
            table="tabtinspace_space_app_settings",
        ),
        migrations.AlterModelTable(
            name="spacepermission",
            table="tabtinspace_space_permission",
        ),
    ]

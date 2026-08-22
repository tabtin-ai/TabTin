"""
Add 'marketplace' to WorkteamAppInstall.app_source choices.

Supports the Open App Platform: marketplace apps (installScope=workteam)
can now be installed per-workteam by admins.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0026_bot_space_requires_agent'),
    ]

    operations = [
        migrations.AlterField(
            model_name='workteamappinstall',
            name='app_source',
            field=models.CharField(
                choices=[('core', '核心应用'), ('marketplace', '应用市场')],
                default='core',
                max_length=16,
                verbose_name='应用来源',
            ),
        ),
    ]

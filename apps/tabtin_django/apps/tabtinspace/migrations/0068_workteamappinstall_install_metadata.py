from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0067_rename_default_agent_spaces'),
    ]

    operations = [
        migrations.AddField(
            model_name='workteamappinstall',
            name='install_metadata',
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text='保留官方 Plugin Release、upstream revision、adapter 等安装时快照。',
                verbose_name='安装元数据',
            ),
        ),
    ]

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0012_rename_tabdata_token_space_user_idx_tabdata_api_space_i_e3e530_idx_and_more'),
    ]

    operations = [
        migrations.RenameField(
            model_name='tableapitoken',
            old_name='agent_space_ids',
            new_name='space_ids',
        ),
        migrations.AlterField(
            model_name='tableapitoken',
            name='space_ids',
            field=models.JSONField(
                blank=True,
                null=True,
                verbose_name='限定 Space',
                help_text='null 表示用户所有可访问 Space',
            ),
        ),
    ]

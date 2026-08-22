# DE-30: ChannelAccount.config 从 JSONField 改为 EncryptedJSONField（Fernet 加密存储）

from django.db import migrations
import apps.extensions.fields


class Migration(migrations.Migration):

    dependencies = [
        ('channel_gateway', '0003_alter_channelbinding_space_id'),
    ]

    operations = [
        migrations.AlterField(
            model_name='channelaccount',
            name='config',
            field=apps.extensions.fields.EncryptedJSONField(default=dict, verbose_name='账号配置'),
        ),
    ]

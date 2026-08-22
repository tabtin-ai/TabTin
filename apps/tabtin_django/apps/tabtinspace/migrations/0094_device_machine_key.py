# Generated manually for  hardware-anchored device identity

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0093_organization_tombstone_fields_3832'),
    ]

    operations = [
        migrations.AddField(
            model_name='device',
            name='machine_key',
            field=models.CharField(
                blank=True,
                db_index=True,
                default='',
                help_text='Electron: sha256(machineId + profile)[:32]；空字符串表示未上报',
                max_length=64,
                verbose_name='机器锚定密钥',
            ),
        ),
        migrations.AddIndex(
            model_name='device',
            index=models.Index(
                fields=['user', 'machine_key', 'device_type'],
                name='ctx_device_user_mkey_type_idx',
            ),
        ),
    ]

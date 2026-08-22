from django.db import migrations, models


def deactivate_legacy_tencent_tokens(apps, schema_editor):
    DevicePushRegistration = apps.get_model('notification', 'DevicePushRegistration')
    DevicePushRegistration.objects.using(schema_editor.connection.alias).filter(
        provider='tencent_push'
    ).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [
        ('notification', '0013_notification_dedupe_key'),
    ]

    operations = [
        migrations.AddField(
            model_name='devicepushregistration',
            name='environment',
            field=models.CharField(
                choices=[('sandbox', 'Sandbox'), ('production', 'Production')],
                default='production',
                max_length=16,
                verbose_name='APNs 环境',
            ),
        ),
        migrations.RunPython(deactivate_legacy_tencent_tokens, migrations.RunPython.noop),
        migrations.AlterField(
            model_name='devicepushregistration',
            name='provider',
            field=models.CharField(
                choices=[('apns', 'Apple Push Notification service')],
                default='apns',
                max_length=32,
                verbose_name='推送服务商',
            ),
        ),
        migrations.AlterField(
            model_name='devicepushregistration',
            name='registration_id',
            field=models.CharField(max_length=255, verbose_name='APNs device token'),
        ),
        migrations.AlterField(
            model_name='devicepushregistration',
            name='platform',
            field=models.CharField(
                choices=[('ios', 'iOS')],
                max_length=16,
                verbose_name='平台',
            ),
        ),
    ]

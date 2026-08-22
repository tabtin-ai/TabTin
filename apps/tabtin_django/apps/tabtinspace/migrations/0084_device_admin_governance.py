from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0083_workteam_control_policy'),
    ]

    operations = [
        migrations.AddField(
            model_name='device',
            name='app_version',
            field=models.CharField(blank=True, db_index=True, default='', max_length=64, verbose_name='客户端版本'),
        ),
        migrations.AddField(
            model_name='device',
            name='blocked_at',
            field=models.DateTimeField(blank=True, null=True, verbose_name='封禁时间'),
        ),
        migrations.AddField(
            model_name='device',
            name='blocked_by_admin_account_id',
            field=models.CharField(blank=True, default='', max_length=36, verbose_name='封禁后台账号 ID'),
        ),
        migrations.AddField(
            model_name='device',
            name='blocked_reason',
            field=models.TextField(blank=True, default='', verbose_name='封禁原因'),
        ),
        migrations.AddField(
            model_name='device',
            name='control_status',
            field=models.CharField(choices=[('active', '可用'), ('blocked', '已封禁'), ('revoked', '已吊销')], db_index=True, default='active', max_length=20, verbose_name='管控状态'),
        ),
        migrations.AddField(
            model_name='device',
            name='ip_address',
            field=models.GenericIPAddressField(blank=True, null=True, verbose_name='最近 IP 地址'),
        ),
        migrations.AddField(
            model_name='device',
            name='metadata_json',
            field=models.JSONField(default=dict, verbose_name='治理元数据'),
        ),
        migrations.AddIndex(
            model_name='device',
            index=models.Index(fields=['user', 'control_status'], name='ctx_device_user_ctrl_idx'),
        ),
        migrations.AddIndex(
            model_name='device',
            index=models.Index(fields=['fingerprint', 'control_status'], name='ctx_device_fp_ctrl_idx'),
        ),
    ]

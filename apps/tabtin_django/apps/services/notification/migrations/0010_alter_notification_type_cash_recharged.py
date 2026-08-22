# Generated manually for  cash_recharged inbox notification

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('notification', '0009_alter_notification_type'),
    ]

    operations = [
        migrations.AlterField(
            model_name='notification',
            name='type',
            field=models.CharField(
                choices=[
                    ('invite_received', '收到邀请'),
                    ('invite_accepted', '邀请被接受'),
                    ('member_added', '被添加为成员'),
                    ('member_removed', '被移除'),
                    ('role_changed', '角色变更'),
                    ('ownership_transfer', '所有权转让'),
                    ('resource_shared', '资源被共享'),
                    ('quota_warning', '配额预警'),
                    ('balance_low', '余额不足预警'),
                    ('cash_recharged', '现金钱包充值到账'),
                    ('trash_expiry_warning', '回收站过期预警'),
                    ('system', '系统通知'),
                    ('extension_event', 'Extension 事件通知'),
                ],
                max_length=50,
                verbose_name='通知类型',
            ),
        ),
    ]

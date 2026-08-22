from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0087_sessionshare_status_pending'),
    ]

    operations = [
        migrations.AddField(
            model_name='sessionshare',
            name='card_refresh_status',
            field=models.CharField(
                choices=[('confirmed', '已确认'), ('unconfirmed', '待重试')],
                db_index=True,
                default='confirmed',
                help_text='unconfirmed 表示授权事实已提交，但腾讯卡片投影仍需后台重试。',
                max_length=16,
                verbose_name='IM 卡片刷新状态',
            ),
        ),
    ]

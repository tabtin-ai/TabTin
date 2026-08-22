"""为 ChatSession 增加 fork_copy_status 字段（ 大 fork 异步复制进度）。"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0052_chatmessage_reply_to'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatsession',
            name='fork_copy_status',
            field=models.CharField(
                blank=True,
                choices=[
                    ('pending', '复制中'),
                    ('complete', '已完成'),
                    ('failed', '复制失败'),
                ],
                help_text='大 fork 异步复制进度；null 表示同步 fork 或非 fork 会话',
                max_length=16,
                null=True,
                verbose_name='Fork 消息复制状态',
            ),
        ),
    ]

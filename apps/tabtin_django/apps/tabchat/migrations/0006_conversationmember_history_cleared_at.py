from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabchat', '0005_remove_conversationmember_tabchat_member_conv_user_uniq_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='conversationmember',
            name='history_cleared_at',
            field=models.DateTimeField(
                blank=True,
                help_text='该成员清空聊天记录的时间点；只过滤自己的历史可见性，不影响他人',
                null=True,
            ),
        ),
    ]

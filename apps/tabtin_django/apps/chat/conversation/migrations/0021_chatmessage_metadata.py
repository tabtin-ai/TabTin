"""
Add metadata JSONField to ChatMessage for storing per-message billing info
(credits_consumed, input_tokens, output_tokens).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0020_add_fork_fields_to_chat_session'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatmessage',
            name='metadata',
            field=models.JSONField(
                blank=True,
                default=None,
                help_text='存储 credits_consumed / input_tokens / output_tokens 等附加信息',
                null=True,
                verbose_name='消息元数据',
            ),
        ),
    ]

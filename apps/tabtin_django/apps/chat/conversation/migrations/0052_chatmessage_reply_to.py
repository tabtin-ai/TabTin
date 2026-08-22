#  引用回复：ChatMessage 新增 reply_to（self-FK, SET_NULL）+ reply_to_preview 快照

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0051_alter_chatmessage_message_kind'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatmessage',
            name='reply_to',
            field=models.ForeignKey(
                blank=True,
                help_text='本消息「引用回复」指向的被引用 ChatMessage；被引用消息删除时置 NULL',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='replies',
                to='conversation.chatmessage',
                verbose_name='引用的消息',
            ),
        ),
        migrations.AddField(
            model_name='chatmessage',
            name='reply_to_preview',
            field=models.JSONField(
                blank=True,
                default=None,
                help_text='被引用消息的展示快照 { role, author, text }，供气泡引用条渲染；'
                          '与被引用消息同源，被引用消息删除后仍可显示',
                null=True,
                verbose_name='被引用消息快照',
            ),
        ),
    ]

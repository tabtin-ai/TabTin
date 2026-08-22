"""
ChatMessage 增加 client_event_id 字段 + (session, client_event_id) 条件唯一约束。

M2.5 持久化策略基础：relay_events 上行的 user/assistant 消息通过此字段
做幂等 upsert，客户端断线重连时可安全重发，Django 侧去重。

约束为 conditional unique（client_event_id IS NOT NULL），不影响历史
存量数据（client_event_id 为 NULL 的旧消息不参与唯一校验）。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0024_add_fulltext_index_chat_message_content'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatmessage',
            name='client_event_id',
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text='relay_events 上行的幂等去重键，由客户端 RelayBuffer 生成',
                null=True,
                verbose_name='客户端事件 ID',
            ),
        ),
        migrations.AddConstraint(
            model_name='chatmessage',
            constraint=models.UniqueConstraint(
                condition=models.Q(('client_event_id__isnull', False)),
                fields=('session', 'client_event_id'),
                name='uq_session_client_event_id',
            ),
        ),
    ]

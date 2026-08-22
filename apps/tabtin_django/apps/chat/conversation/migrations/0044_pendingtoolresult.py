from django.db import migrations, models


class Migration(migrations.Migration):
    """tool_result 暂存表——根治工具结果与 assistant 消息落库乱序/竞态导致的永久丢失。

    详见 apps.chat.conversation.models.PendingToolResult docstring 与
    apps/services/common/ws/handlers/relay_message_writer.py 的两道 drain 防线。
    """

    dependencies = [
        ('conversation', '0043_remove_chatmessage_external_task_id'),
    ]

    operations = [
        migrations.CreateModel(
            name='PendingToolResult',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('session_id', models.CharField(
                    db_index=True, max_length=64, verbose_name='会话 ID',
                    help_text='ChatSession.id（UUID 字符串软引用，不建 FK——临时数据避免级联约束）',
                )),
                ('agent_run_id', models.CharField(
                    blank=True, default='', db_index=True, max_length=64, verbose_name='Agent Run ID',
                    help_text='合成 user message 的 run_id（= 对应 assistant ChatMessage.agent_run_id），'
                              '与 tool_use_id 组合在同一 run 内唯一定位 tool_use',
                )),
                ('tool_use_id', models.CharField(
                    max_length=128, verbose_name='tool_use ID',
                    help_text='对应 tool_use block 的 id（daemon per-run counter，如 run_terminal_command:25）',
                )),
                ('block_json', models.JSONField(
                    verbose_name='tool_result block',
                    help_text='完整的 Anthropic tool_result ContentBlock dict '
                              '（{type, tool_use_id, content, is_error?}），合并时整体 append 进目标消息',
                )),
                ('is_error', models.BooleanField(
                    default=False, verbose_name='是否错误结果',
                    help_text='冗余 block_json.is_error，便于不解 JSON 直接统计/排障',
                )),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='更新时间')),
            ],
            options={
                'verbose_name': '待合并工具结果',
                'verbose_name_plural': '待合并工具结果',
                'db_table': 'chat_pending_tool_result',
                'ordering': ['created_at'],
            },
        ),
        migrations.AddIndex(
            model_name='pendingtoolresult',
            index=models.Index(fields=['session_id', 'agent_run_id'], name='pending_tr_sess_run_idx'),
        ),
        migrations.AddConstraint(
            model_name='pendingtoolresult',
            constraint=models.UniqueConstraint(
                fields=['session_id', 'agent_run_id', 'tool_use_id'],
                name='uq_pending_tool_result',
            ),
        ),
    ]

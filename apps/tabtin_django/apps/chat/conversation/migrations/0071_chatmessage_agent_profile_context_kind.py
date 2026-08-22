from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0070_chatcontext_current_project_backfill"),
    ]

    operations = [
        migrations.AlterField(
            model_name="chatmessage",
            name="message_kind",
            field=models.CharField(
                choices=[
                    ("llm", "LLM Output"),
                    ("tool_artifact", "Tool Artifact"),
                    ("error_envelope", "Error Envelope"),
                    ("environment_context", "Environment Context"),
                    ("agent_profile_context", "Agent Profile Context"),
                    ("compaction_summary", "Compaction Summary"),
                    ("hitl_interaction", "HITL Interaction"),
                ],
                default="llm",
                help_text=(
                    "ChatMessage 语义类型——区分 LLM 输出 / 工具产物气泡 / 错误文案。"
                    "替换原来用 model_id 字面量 + synthetic 隐式判别的协议层 hack。"
                    "daemon 主循环 push 的 role=user + 含 tool_result block 的合成消息走合并路径，"
                    "不会作为独立 ChatMessage 落表（在 reassembler 层合并到对应 LLM 消息）。"
                    ""
                ),
                max_length=24,
                verbose_name="消息语义类型",
            ),
        ),
        migrations.RunSQL(
            sql=migrations.RunSQL.noop,
            reverse_sql="""
                UPDATE chat_message
                SET message_kind = 'environment_context'
                WHERE message_kind = 'agent_profile_context'
            """,
        ),
    ]

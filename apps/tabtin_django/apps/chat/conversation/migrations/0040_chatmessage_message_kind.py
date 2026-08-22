"""
add ChatMessage.message_kind

本次重构把 daemon 端 message_start 的"这条消息是不是 LLM 真实输出"判别
从隐式（model_id 字面量 'tabtin-tool-runtime' + synthetic 字段双重 hack）
改成显式 `message_kind` 字段（三档 enum：llm / tool_artifact / error_envelope）。
五端按字段 switch，遗漏即编译/运行期 fail-loud，杜绝今天 dogfood 触发的
"mini-message 一刀切跳过落库" silent regress（5 天富内容历史全部丢失）。

== 老数据情况 ==
- migration 之前所有 ChatMessage 都是 LLM 主消息——mini-message 因为 Django
  reassembler bug 一刀切跳过落库，已永久丢失（用户拍板不 backfill）
- AddField DB default='llm' + Django model default='llm' 双重保险，老数据
  自动覆盖
- 新数据由 reassembler `_create_chat_message_from_reassembler_state` 透传
  state_dict['message_kind']（W1a 已在 `_serialize` 输出此字段）

== 生产 DDL 注意 ==
- 本 migration 在 dev / 当前预上线规模下瞬时完成
- 若未来 chat_message 行数 > 10M 且 MySQL < 8.0.12，需要用
  pt-online-schema-change 替代直接 migrate

== 回滚警告 ==
⚠️ AddField 反向 = DROP COLUMN，会丢失所有 W2+ 期间写入的 message_kind 数据。
- W1b 单独 migrate forward → revert 反向是安全的（无数据丢失）
- W2+ 任一 wave 已上线后，禁止单独回滚本 migration——只能全量回滚 W4→W3→W2→W1→W0
- 全量回滚时 tool_artifact / error_envelope 类型的 ChatMessage 会被 UI 当
  LLM 主气泡渲染（视觉降级；数据本身仍在 content_blocks_json 里）

== 顺手收掉的 metadata help_text 漂移 ==
本次 makemigrations 自动 detect 到 `ChatMessage.metadata.help_text` 与上次
migration 0031 时记录的文本有差异（仓库历史上某次改 help_text 漏跑
makemigrations 留下的纯 docstring 漂移）。AlterField 仅修 help_text =
DB schema no-op（不动 column 类型 / 约束），但顺手收掉避免下次 makemigrations
仍 detect 到这条 noise diff 污染未来 PR review。
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0039_chatsession_title_generation_status"),
    ]

    operations = [
        migrations.AddField(
            model_name="chatmessage",
            name="message_kind",
            field=models.CharField(
                choices=[
                    ("llm", "LLM Output"),
                    ("tool_artifact", "Tool Artifact"),
                    ("error_envelope", "Error Envelope"),
                ],
                default="llm",
                help_text="ChatMessage 语义类型——区分 LLM 输出 / 工具产物气泡 / 错误文案。替换原来用 model_id 字面量 + synthetic 隐式判别的协议层 hack。daemon 主循环 push 的 role=user + 含 tool_result block 的合成消息走合并路径，不会作为独立 ChatMessage 落表（在 reassembler 层合并到对应 LLM 消息）。",
                max_length=24,
                verbose_name="消息语义类型",
            ),
        ),
        migrations.AlterField(
            model_name="chatmessage",
            name="metadata",
            field=models.JSONField(
                blank=True,
                default=None,
                help_text="存储 credits_consumed / source / 旧 agent_type / intent 等附加信息；W3 后老字段并入此处兜底（结构化字段优先用顶层 stop_reason / usage_json / error_info_json / subagent_run_id）",
                null=True,
                verbose_name="消息元数据",
            ),
        ),
    ]

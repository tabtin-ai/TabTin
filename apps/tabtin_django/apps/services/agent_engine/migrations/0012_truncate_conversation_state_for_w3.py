"""W3 §3.3.7 配套：TRUNCATE PG agent_engine_conversation_states。

== 背景 ==

Migration `conversation/0038` 把 chat_message 表清空 + drop 老字段（v1/v2
blocks_json / content / attachments_json 等）+ add Anthropic 风新字段
（content_blocks_json 等）。

ConversationState.messages_json 是引擎的 LLM context 快照，与 chat_message
强耦合：v1/v2 时代两边都是"OpenAI 风扁平 message 数组"形态；W3 起
chat_message 改 Anthropic ContentBlock[]，messages_json 也必须改 Anthropic
形态（且写入前要 strip tabtin_* 块——见 v3 §3.3.2 + apps/services/agent_engine/
services/blocks_to_llm_context.py）。

如果 chat_message TRUNCATE 但 conversation_state 保留：
- 老 conversation_state.messages_json 是 v1 形态
- 下次 LLM 调用时拿到"上下文有 N 条历史消息"但 chat_message 表 0 条
- 用户看到的对话历史和 LLM 看到的对话上下文**完全错位**

所以两个表必须**同步 TRUNCATE**——这是 W3 上线日的硬切策略。

== 跨库 alias ==

agent_engine_conversation_states 在 PG (postgresql alias)；本 migration 在
agent_engine app 下，DefaultDatabaseRouter `_pg_app_labels` 包含 agent_engine →
自动路由到 PG。

== 不可逆 ==

数据物理删除——reverse 是 noop（无法恢复），只能让 schema state 回退。

== 与 conversation/0038 的关系 ==

两个 migration 都跑 TRUNCATE 各自表。Django migrate 命令会按
`safe_migrate.py` 的双库顺序跑（先 default 再 postgresql 或反之，由
DependencyResolver 决定），两表 TRUNCATE 时序不重要——上线日保证
"两个 migration 都跑完再让用户登入"即可。
"""

from django.db import migrations


def _truncate_conversation_state(apps, schema_editor):
    """TRUNCATE PG agent_engine_conversation_states + reset version。

    PG TRUNCATE 不需要 RESTART IDENTITY（本表用 BigIntegerField 默认 0
    作为 version，没用 sequence/serial）。
    """
    if schema_editor.connection.alias != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute("TRUNCATE TABLE agent_engine_conversation_states")


def _no_truncate_reverse(apps, schema_editor):
    """反向 noop：TRUNCATE 不可逆。"""
    return


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0011_drop_pg_stale_modules"),
    ]

    operations = [
        migrations.RunPython(_truncate_conversation_state, reverse_code=_no_truncate_reverse),
    ]

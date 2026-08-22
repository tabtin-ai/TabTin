"""v0.1 宪法 §5.1（2026-05-07 收尾）：``ChatSession.space`` FK → UUIDField 软引用。

== 背景 ==

conversation.ChatSession 在 MySQL，tabtinspace.Space 在 PG。0006 把
``space = ForeignKey('tabtinspace.Space', db_constraint=False, ...)`` 落地，
``TabtinspaceRouter.allow_relation`` 放行 ORM 字段引用——但 Space 删除路径会爆：

    Space.delete()
      → Django Collector 用 'postgresql' alias 反向查 ChatSession（``space.chat_sessions``）
      → PG 上没有 chat_session 表（在 MySQL）
      → ProgrammingError: relation "chat_session" does not exist

fts 集成测试 ``apps/fts/tests/integration/test_end_to_end_sync.py:579-589`` 已
用裸 SQL DELETE 绕过证实存在该问题，注释明确写：

    "清理：直接 SQL DELETE 避开 Django collector 跨库 cascade
    （Space.chat_sessions 在 MySQL，db_constraint=False；ORM .delete() 会尝试
    在 PG 上 SET NULL chat_session.space_id 但表不在 PG）"

== 修复 ==

FK → UUIDField 软引用，反向 FK 描述符（Space.chat_sessions）消失，Collector
不再触发跨库查询。原 ``on_delete=SET_NULL`` 语义改由
``apps/chat/conversation/signals.py:cleanup_chat_sessions_on_space_delete``
在 Space ``pre_delete`` 主动 ``UPDATE space_id=NULL`` 维护。

== 索引名兼容 ==

旧 implicit FK index（chat_session 表上 space_id column 自动 index）DB 物理上
还在；state 里的三个命名 index ``chat_sess_space_updated_idx`` /
``idx_session_memory_settle`` / ``idx_session_quick_settle`` 字段引用从 ``space``
改成 ``space_id``——索引名保持不变，DB 物理无需 ALTER。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0035_drop_legacy_mysql_services_llm_shadow"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                # 旧 indexes 引用 'space' 字段，先 RemoveIndex 再 RemoveField
                migrations.RemoveIndex(
                    model_name="chatsession",
                    name="chat_sess_space_updated_idx",
                ),
                migrations.RemoveIndex(
                    model_name="chatsession",
                    name="idx_session_memory_settle",
                ),
                migrations.RemoveIndex(
                    model_name="chatsession",
                    name="idx_session_quick_settle",
                ),
                migrations.RemoveField(
                    model_name="chatsession",
                    name="space",
                ),
                migrations.AddField(
                    model_name="chatsession",
                    name="space_id",
                    field=models.UUIDField(
                        blank=True,
                        db_index=True,
                        null=True,
                        verbose_name="所属智能体空间 ID",
                        help_text=(
                            "软引用 tabtinspace.Space.id（v0.1 §5.1）；用 ``session.space`` "
                            "property 链式访问。"
                        ),
                    ),
                ),
                # 重新 AddIndex（同名，引用新字段）
                migrations.AddIndex(
                    model_name="chatsession",
                    index=models.Index(
                        fields=["space_id", "-updated_at"],
                        name="chat_sess_space_updated_idx",
                    ),
                ),
                migrations.AddIndex(
                    model_name="chatsession",
                    index=models.Index(
                        fields=["space_id", "memory_settled", "-updated_at"],
                        name="idx_session_memory_settle",
                    ),
                ),
                migrations.AddIndex(
                    model_name="chatsession",
                    index=models.Index(
                        fields=["space_id", "memory_quick_settled", "-updated_at"],
                        name="idx_session_quick_settle",
                    ),
                ),
            ],
            database_operations=[],
        ),
    ]

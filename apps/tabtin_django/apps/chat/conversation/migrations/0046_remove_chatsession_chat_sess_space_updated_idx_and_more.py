"""M3b（单库治理）：ChatSession.space 从跨库 UUIDField 软引用恢复为同库物理 FK。

数据安全：SeparateDatabaseAndState——``space_id`` 列与 uuid 数据原样保留，
DB 侧只新增 FK 约束（列类型已匹配 tabtinspace_space.id）。3 个含 space 的复合索引
（chat_sess_space_updated_idx / idx_session_memory_settle / idx_session_quick_settle）
物理上已建在同一 space_id 列、同名，仅在 state 里把字段引用从 space_id 改到 space FK，
DB 无需重建——故索引的 Remove/Add 只放 state、不放 database_operations。

on_delete=SET_NULL 对齐原软引用语义（删 Space 不连带删对话，仅解绑）；
vendor 守卫到 PostgreSQL（dual 下 conversation/tabtinspace 异库无法建跨库约束）。
"""

from django.db import migrations, models
import django.db.models.deletion


_CONSTRAINT = "chat_session_space_id_fk_tabtinspace_space"

# space 相关复合索引在 PG 上的物理建立（CREATE INDEX IF NOT EXISTS）。
# chat_sess_space_updated_idx 历史上在 0006 仅声明在 state、物理由 0037 创建；
# 而 0037 在单库治理 M1 中被守卫为 PostgreSQL no-op（原是 MySQL 专属对齐），
# 导致它在 PG 上从未真正建出。本批次接管 space 索引 state，顺带在 PG 上补齐物理索引，
# 消除 state/物理漂移。idx_session_memory_settle / quick_settle 已由 0014 canonical
# AddIndex 建出，IF NOT EXISTS 幂等跳过。
_SPACE_INDEXES = [
    ('chat_sess_space_updated_idx', '("space_id", "updated_at" DESC)'),
    ('idx_session_memory_settle', '("space_id", "memory_settled", "updated_at" DESC)'),
    ('idx_session_quick_settle', '("space_id", "memory_quick_settled", "updated_at" DESC)'),
]


def add_space_fk(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute("SELECT 1 FROM pg_constraint WHERE conname = %s", [_CONSTRAINT])
        if not cursor.fetchone():
            cursor.execute(
                f'ALTER TABLE "chat_session" ADD CONSTRAINT "{_CONSTRAINT}" '
                f'FOREIGN KEY ("space_id") REFERENCES "tabtinspace_space" ("id") '
                f"ON DELETE SET NULL"
            )
        for name, cols in _SPACE_INDEXES:
            cursor.execute(
                f'CREATE INDEX IF NOT EXISTS "{name}" ON "chat_session" {cols}'
            )


def drop_space_fk(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(f'ALTER TABLE "chat_session" DROP CONSTRAINT IF EXISTS "{_CONSTRAINT}"')


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0059_alter_agent_user_alter_collection_created_by_and_more'),
        ('conversation', '0045_chat_llm_model_physical_fk'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveIndex(model_name='chatsession', name='chat_sess_space_updated_idx'),
                migrations.RemoveIndex(model_name='chatsession', name='idx_session_memory_settle'),
                migrations.RemoveIndex(model_name='chatsession', name='idx_session_quick_settle'),
                migrations.RemoveField(model_name='chatsession', name='space_id'),
                migrations.AddField(
                    model_name='chatsession',
                    name='space',
                    field=models.ForeignKey(
                        blank=True, db_column='space_id', db_index=False,
                        help_text='所属 Agent 工作区（tabtinspace.Space）', null=True,
                        on_delete=django.db.models.deletion.SET_NULL, related_name='+',
                        to='tabtinspace.space', verbose_name='所属智能体空间',
                    ),
                ),
                migrations.AddIndex(
                    model_name='chatsession',
                    index=models.Index(fields=['space', '-updated_at'], name='chat_sess_space_updated_idx'),
                ),
                migrations.AddIndex(
                    model_name='chatsession',
                    index=models.Index(fields=['space', 'memory_settled', '-updated_at'], name='idx_session_memory_settle'),
                ),
                migrations.AddIndex(
                    model_name='chatsession',
                    index=models.Index(fields=['space', 'memory_quick_settled', '-updated_at'], name='idx_session_quick_settle'),
                ),
            ],
            database_operations=[
                migrations.RunPython(add_space_fk, drop_space_fk),
            ],
        ),
    ]

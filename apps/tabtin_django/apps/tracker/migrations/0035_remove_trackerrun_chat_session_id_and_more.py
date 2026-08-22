"""M3b（单库治理）：TrackerRun.chat_session 从跨库 UUIDField 软引用恢复为同库物理 FK。

数据安全：SeparateDatabaseAndState——``chat_session_id`` 列与 uuid 数据原样保留，
DB 侧只新增 FK 约束（列类型已匹配 chat_session.id）。列上的既有索引（来自原
db_index=True）物理保留并继续服务热查询，仅在 state 里把字段引用从 chat_session_id
改到 chat_session FK——故无索引 Remove/Add 的物理操作。

on_delete=SET_NULL 对齐原软引用语义（删 ChatSession 时 Run 运行历史不连带删、置空）；
vendor 守卫到 PostgreSQL（dual 下 tracker/conversation 异库无法建跨库约束）。
"""

from django.db import migrations, models
import django.db.models.deletion


_CONSTRAINT = "tracker_run_chat_session_id_fk_chat_session"


def add_chat_session_fk(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute("SELECT 1 FROM pg_constraint WHERE conname = %s", [_CONSTRAINT])
        if cursor.fetchone():
            return
        cursor.execute(
            f'ALTER TABLE "tracker_run" ADD CONSTRAINT "{_CONSTRAINT}" '
            f'FOREIGN KEY ("chat_session_id") REFERENCES "chat_session" ("id") '
            f"ON DELETE SET NULL"
        )


def drop_chat_session_fk(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(f'ALTER TABLE "tracker_run" DROP CONSTRAINT IF EXISTS "{_CONSTRAINT}"')


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0046_remove_chatsession_chat_sess_space_updated_idx_and_more'),
        ('tracker', '0034_alter_tracker_created_by'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveField(model_name='trackerrun', name='chat_session_id'),
                migrations.AddField(
                    model_name='trackerrun',
                    name='chat_session',
                    field=models.ForeignKey(
                        blank=True, db_column='chat_session_id',
                        help_text='本次 Run 的 react 循环 transcript 所在 ChatSession（charter v1.8 §6.7）。',
                        null=True, on_delete=django.db.models.deletion.SET_NULL,
                        related_name='+', to='conversation.chatsession', verbose_name='关联 ChatSession',
                    ),
                ),
            ],
            database_operations=[
                migrations.RunPython(add_chat_session_fk, drop_chat_session_fk),
            ],
        ),
    ]

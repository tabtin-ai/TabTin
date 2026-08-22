"""M3b（单库治理）：ChatSession.current_model/default_model + ChatMessage.model
从跨库 UUIDField 软引用恢复为同库物理 ForeignKey。

数据安全：用 SeparateDatabaseAndState，**不** drop/add 列——
``current_model_id`` / ``default_model_id`` / ``model_id`` 列与其 uuid 数据原样保留，
DB 侧只新增 FK 约束（列类型 uuid 已与 services_llm_model.id 匹配，无需改列）。
若用 makemigrations 自动生成会是 RemoveField + AddField（DROP COLUMN + ADD COLUMN），
在有数据的库上会丢列——故此处手写。

vendor 守卫：FK 指向 services_llm_model，仅在 single_pg（conversation 与 llm 同库 PG）
下成立；dual 下 conversation 在 MySQL、services_llm_model 在 PG，跨库无法建约束，
RunPython 按 vendor 跳过（与本分支既有 single-PG-only 迁移口径一致）。

on_delete=SET_NULL 对齐原软引用语义（LLMModel 极少删，删了置空、保留会话/消息）。
"""

from django.db import migrations, models
import django.db.models.deletion


_FKS = [
    # (table, column, constraint_name)
    ("chat_session", "current_model_id", "chat_session_current_model_id_fk_llm_model"),
    ("chat_session", "default_model_id", "chat_session_default_model_id_fk_llm_model"),
    ("chat_message", "model_id", "chat_message_model_id_fk_llm_model"),
]
_REF_TABLE = "services_llm_model"


def add_llm_fks(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        for table, column, cname in _FKS:
            cursor.execute(
                "SELECT 1 FROM pg_constraint WHERE conname = %s", [cname]
            )
            if cursor.fetchone():
                continue
            cursor.execute(
                f'ALTER TABLE "{table}" ADD CONSTRAINT "{cname}" '
                f'FOREIGN KEY ("{column}") REFERENCES "{_REF_TABLE}" ("id") '
                f"ON DELETE SET NULL"
            )


def drop_llm_fks(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        for table, _column, cname in _FKS:
            cursor.execute(f'ALTER TABLE "{table}" DROP CONSTRAINT IF EXISTS "{cname}"')


def _fk(verbose_name, help_text, db_column):
    return models.ForeignKey(
        "llm.LLMModel",
        on_delete=django.db.models.deletion.SET_NULL,
        null=True,
        blank=True,
        db_column=db_column,
        db_index=False,
        related_name="+",
        verbose_name=verbose_name,
        help_text=help_text,
    )


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0044_pendingtoolresult"),
        ("llm", "0001_initial"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            # 仅改 Django state：旧 UUIDField → 新 FK 字段；索引重挂到 FK 字段名（同列同名，DB 无操作）。
            state_operations=[
                migrations.RemoveIndex(model_name="chatmessage", name="chat_msg_model_id_idx"),
                migrations.RemoveIndex(model_name="chatsession", name="chat_sess_curr_model_idx"),
                migrations.RemoveField(model_name="chatmessage", name="model_id"),
                migrations.RemoveField(model_name="chatsession", name="current_model_id"),
                migrations.RemoveField(model_name="chatsession", name="default_model_id"),
                migrations.AddField(
                    model_name="chatmessage",
                    name="model",
                    field=_fk("使用的模型", "生成此消息的 LLM 模型（llm.LLMModel）", "model_id"),
                ),
                migrations.AddField(
                    model_name="chatsession",
                    name="current_model",
                    field=_fk("当前使用的模型", "当前 LLM 模型（llm.LLMModel）", "current_model_id"),
                ),
                migrations.AddField(
                    model_name="chatsession",
                    name="default_model",
                    field=_fk("会话默认模型", "会话创建时的初始 LLM 模型（llm.LLMModel）", "default_model_id"),
                ),
                migrations.AddIndex(
                    model_name="chatmessage",
                    index=models.Index(fields=["model"], name="chat_msg_model_id_idx"),
                ),
                migrations.AddIndex(
                    model_name="chatsession",
                    index=models.Index(fields=["current_model"], name="chat_sess_curr_model_idx"),
                ),
            ],
            # 实际 DB：列与索引已存在且不变，仅新增 3 个 FK 物理约束（vendor 守卫 + 幂等）。
            database_operations=[
                migrations.RunPython(add_llm_fks, drop_llm_fks),
            ],
        ),
    ]

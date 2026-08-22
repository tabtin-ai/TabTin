from django.db import migrations


class Migration(migrations.Migration):
    """彻底移除 turn_seq 列与其全部索引。

    turn_seq 实验已废弃,模型与写入代码均不再设置该字段,但数据库残留的
    `turn_seq NOT NULL`(无默认)列导致每条 ChatMessage 插入违反 NOT NULL 约束、
    新会话整条对话无法落库。这里幂等地删除列与两个索引(显式 chat_msg_sess_turn_idx
    与 db_index 自动索引 chat_message_turn_seq_faff7ac9),并用 state_operations
    同步 Django 模型状态。RunSQL 用 IF EXISTS,使全新库与本机漂移库都能安全收敛。
    """

    dependencies = [
        ('conversation', '0048_chatmessage_turn_seq'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=(
                        "DROP INDEX IF EXISTS chat_msg_sess_turn_idx;"
                        "DROP INDEX IF EXISTS chat_message_turn_seq_faff7ac9;"
                        "ALTER TABLE chat_message DROP COLUMN IF EXISTS turn_seq;"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
            ],
            state_operations=[
                migrations.RemoveIndex(
                    model_name='chatmessage',
                    name='chat_msg_sess_turn_idx',
                ),
                migrations.RemoveField(
                    model_name='chatmessage',
                    name='turn_seq',
                ),
            ],
        ),
    ]

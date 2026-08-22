"""v0.1 宪法收尾续：删除 MySQL 上 chat_session / chat_message → services_llm_model
的物理 FK 约束。

== 背景 ==
0031 给三个 FK 字段加了 ``db_constraint=False`` 的 ORM 元数据——但 Django 处理
``AlterField`` 切换 ``db_constraint`` 时**不会自动 DROP 已存在的物理 FK 约束**
（这是 Django 的已知特性：``db_constraint=False`` 只控制后续 schema 生成，对
存量约束 noop）。

结果：
- ORM state：FK 没有 db_constraint
- MySQL 物理：CONSTRAINT 仍然存在
  （chat_session_current_model_id_xxxx_fk_services_llm_model_id 等三个）

而 services_llm 已迁 PG，MySQL 上 ``services_llm_model`` 表为空（其实是个被
DefaultDatabaseRouter._dual_db_labels 排除掉的空 shadow）。任何对
``chat_session.current_model_id`` 的 INSERT 都会被 FK 约束拒绝：

    IntegrityError (1452, 'Cannot add or update a child row: a foreign key
    constraint fails (`chat_session`, CONSTRAINT
    `chat_session_default_model_id_xxxx_fk_services_llm_model_id` ...)')

0033 把 FK→UUIDField 后，POST /api/chat/sessions 不再被 LlmRouter.allow_relation
拒绝，但会被 MySQL FK 物理约束拒绝——同一个症状不同环节，必须把约束也清掉。

== 实现 ==
RunPython 跑 INFORMATION_SCHEMA 查询 + 动态 DROP，幂等：
- existing FK 模式 ``%fk_services_llm_model_id`` 匹配（约束名后缀来自 Django 自动
  命名 ``<table>_<column>_<hash>_fk_<ref_table>_<ref_column>``）
- 检测到就 DROP；fresh DB（已无该约束）SELECT 0 行 → 啥都不做
- alias 守护：仅 MySQL（default）起效；PG 上 router 拒绝 conversation app 的迁移

reverse_code 不重建约束——v0.1 后跨库 FK 不应再存在；如需回滚到 0031 之前请整体
回滚 chat 模块。
"""

from django.db import migrations


def drop_legacy_llm_fks(apps, schema_editor):
    # 仅 MySQL：清理 MySQL 上残留的物理 FK 约束（DATABASE()/反引号语法专属 MySQL）。
    # single_pg 下 default alias 实为 PostgreSQL，按 vendor 守卫，PG 上 no-op
    # （fresh PG 走 db_constraint=False 软引用，本就无这些物理约束可清）。
    if schema_editor.connection.vendor != 'mysql':
        return

    targets = [
        ('chat_session', '%_fk_services_llm_model_id'),
        ('chat_message', '%_fk_services_llm_model_id'),
    ]

    with schema_editor.connection.cursor() as cursor:
        constraints = []
        for table, like_pattern in targets:
            cursor.execute(
                """
                SELECT CONSTRAINT_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
                WHERE CONSTRAINT_SCHEMA = DATABASE()
                  AND TABLE_NAME = %s
                  AND CONSTRAINT_TYPE = 'FOREIGN KEY'
                  AND CONSTRAINT_NAME LIKE %s
                """,
                [table, like_pattern],
            )
            for (constraint_name,) in cursor.fetchall():
                constraints.append((table, constraint_name))

        for table, constraint_name in constraints:
            cursor.execute(
                f'ALTER TABLE `{table}` DROP FOREIGN KEY `{constraint_name}`'
            )


def noop_reverse(apps, schema_editor):
    return


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0033_chat_session_message_model_to_uuid'),
    ]

    operations = [
        migrations.RunPython(drop_legacy_llm_fks, noop_reverse),
    ]

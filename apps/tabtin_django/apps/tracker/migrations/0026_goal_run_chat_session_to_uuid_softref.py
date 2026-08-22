"""v0.1 宪法 §5.1（2026-05-07 收尾）：``GoalRun.chat_session`` FK → UUIDField 软引用。

== 背景 ==

scheduler 在 PostgreSQL，conversation.ChatSession 在 MySQL。0020 把
``chat_session = ForeignKey('conversation.ChatSession', db_constraint=False, ...)``
落地，``SchedulerRouter.allow_relation`` 放行 ORM 字段引用——读路径 OK，但删除
路径会爆：

    ChatSession.delete()
      → Django Collector 用 'default' (MySQL) alias 反向查 GoalRun
      → MySQL 上没有 goal_run 表（在 PG）
      → ProgrammingError: Table 'tabtin_local.goal_run' doesn't exist

修复方式：FK → UUIDField 软引用，反向 FK 描述符消失，Collector 不再跨库查；
原 ``on_delete=SET_NULL`` 语义改由 ``apps/scheduler/signals.py`` 在 ChatSession
``pre_delete`` 主动 ``UPDATE chat_session_id=NULL`` 维护。

== 实现 ==

``SeparateDatabaseAndState`` 模式，DB 层零变更：
- column 名 ``chat_session_id`` 不变（FK 自动生成的 ``_id`` 后缀跟新 UUIDField column 完全一致）
- 数据零迁移
- 物理 FK 约束本来就没有（``db_constraint=False`` + 跨库——MySQL 上没 PG 的
  conversation.chat_session 表，原本就建不出 FK）

== 索引处理 ==

0020 创建 FK 时用 ``db_index=True``（FK 默认带 implicit index），新 UUIDField
显式 ``db_index=True`` 会让 Django 自动生成同名（hash 相同的 column → 相同 index name）
或新名（差异时）。``SeparateDatabaseAndState`` 不动 DB 物理索引，state 跟 DB 名字
若不一致，``db_check_fk_alignment`` 会作为 stale_table 提示——可在后续 cleanup
migration 单独处理（参照 0033 同款 state-DB 漂移说明）。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0025_drop_skill_field_goals"),
        # conversation 0035 是 v0.1 §5.1 收尾终章，确保 LLM shadow 也清理完才推进
        ("conversation", "0035_drop_legacy_mysql_services_llm_shadow"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveField(
                    model_name="goalrun",
                    name="chat_session",
                ),
                migrations.AddField(
                    model_name="goalrun",
                    name="chat_session_id",
                    field=models.UUIDField(
                        blank=True,
                        db_index=True,
                        null=True,
                        verbose_name="关联 ChatSession ID",
                        help_text=(
                            "本次 Run 的 react 循环 transcript 所在 ChatSession（charter v1.8 §6.7）。"
                            "跨库软引用 conversation.ChatSession.id（v0.1 §5.1）；用 ``goal_run.chat_session``"
                            "property 链式访问，列表场景调 attach helper 批量预加载避免 N+1。"
                        ),
                    ),
                ),
            ],
            database_operations=[],
        ),
    ]

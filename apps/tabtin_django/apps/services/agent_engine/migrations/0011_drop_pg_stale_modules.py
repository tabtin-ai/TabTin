"""DROP PG 上 4 个已删除模块的 stale leftover 表 + FK：
  group_chat / tabdesign / tabfunction / app_connect

== 背景 ==

这些模块从 ORM 删除时只走 RemoveField/RemoveModel state 操作，但 DB 上的表 + FK
没有走 DROP TABLE——Django ``RemoveModel`` 的实际 schema 行为依赖
``SeparateDatabaseAndState`` 用法，部分历史 migration 漏 DROP。

体检（``manage.py db_check_fk_alignment``）确认：
- 这 4 个模块在整个代码库 grep 零引用
- 14 条 FK + 13 张 stale 表全部不会被任何 ORM/raw SQL 触发
- 留着只是占元数据 + 心智负担

== 实现 ==

``drop_pg_tables_cascade`` helper 调一次：PG ``DROP TABLE IF EXISTS ... CASCADE``
自动级联清理 FK 约束，不需要先单独 DROP FK（PG 语义跟 MySQL 不同）。

reverse_code 不重建——这些模块已正式下线。
"""

from django.db import migrations

from apps.services.common.migration_helpers import drop_pg_tables_cascade


# 已删除模块的 stale 表（按依赖顺序：子表先 DROP，但 PG CASCADE 模式下顺序无关）
_STALE_TABLES_PG = [
    # ── group_chat（已被 tabchat 取代） ──
    "group_chat_vote",
    "group_chat_message",
    "group_chat_member",
    "group_chat_room",
    # ── tabdesign（旧实现，已删除） ──
    "tabdesign_history",
    "tabdesign_file",
    "tabdesign_project",
    # ── tabfunction（云函数模块，v3.x 删除） ──
    "tabfunction_invocation",
    "tabfunction_secret",
    "tabfunction_trigger",
    "tabfunction_version",
    "tabfunction_cloud_function",
    # ── app_connect（v3.1 删除：Connect 模型作废，PRD-v3.1-方向锚） ──
    "app_connect_audit",
    "app_connect_connect",
]


def drop_pg_stale_tables(apps, schema_editor):
    drop_pg_tables_cascade(schema_editor, tables=_STALE_TABLES_PG)


def noop_reverse(apps, schema_editor):
    return


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0010_alter_cliauditevent_inner_binary"),
    ]

    operations = [
        migrations.RunPython(drop_pg_stale_tables, noop_reverse),
    ]

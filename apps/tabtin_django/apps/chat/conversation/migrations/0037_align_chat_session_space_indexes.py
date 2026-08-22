"""v0.1 §5.1 收尾迭代（2026-05-07）：对齐 ``chat_session`` 表上 ``space_id``
相关索引到 0036 ORM state 期望，处理升级路径 vs fresh DB 的物理 index 漂移。

== 背景 ==

0036 用 ``SeparateDatabaseAndState`` 把 ``ChatSession.space`` FK → ``space_id``
UUIDField，state 改字段、DB 物理不动。理论上 column 名 ``space_id`` 一致，
原 FK implicit index 和命名 index 都该保留。

实际盘 dev 库发现两类漂移：

1. **缺失命名 index**（升级路径残留）：``chat_sess_space_updated_idx`` 在 0006
   state 段声明（也是 SeparateDatabaseAndState，``database_operations=[]``），
   DB 物理上从未真正建过。0036 又一次 RemoveIndex/AddIndex state 操作，物理
   index 仍是 missing。fresh setup 走 ``setup-script`` 从 ORM state 建表会有
   这个 index——升级路径上没有。**这是数据正确性 risk**：
   ``ChatSession.objects.filter(space_id=X).order_by('-updated_at')`` 查询走
   全表扫描而非索引。

2. **多余的 implicit FK index**（升级路径残留）：``chat_session_agent_space_id_d2664d2c``
   是历史 ``agent_space`` FK 时代 Django auto-generated，0006 字段 rename 到
   ``space``、0036 改成 ``space_id`` UUIDField，物理 index 一直没清。Schema
   noise 但无功能影响。

== 修复策略 ==

**保守对齐**：只 CREATE IF NOT EXISTS 缺失的命名 index（数据正确性），不主动
DROP 旧 implicit index（避免误删生产环境定制 index）。旧 implicit index 由
``db_check_fk_alignment`` 体检的 ``reverse_drift`` 类检查发现，让运维手动决定。

升级 + fresh DB 都跑这个 migration 都安全：fresh DB 上 index 已存在 → IF NOT
EXISTS 跳过；升级 DB 上 index 不存在 → 建上。

== 跨库 alias ==

``chat_session`` 表在 ``default`` (MySQL)。本 migration 只在 default alias 跑，
其他 alias noop（DefaultDatabaseRouter ``allow_migrate`` 已经卡了，但 helper
内部再 alias guard 一层更稳）。
"""

from django.db import migrations


# 0036 state 期望的 3 个命名 index 配置
_TARGET_INDEXES = [
    {
        "name": "chat_sess_space_updated_idx",
        "columns": ["space_id", "updated_at"],   # 注意 desc 用 column 顺序表示，MySQL 索引列方向不参与名字
        "directions": ["ASC", "DESC"],
    },
    {
        "name": "idx_session_memory_settle",
        "columns": ["space_id", "memory_settled", "updated_at"],
        "directions": ["ASC", "ASC", "DESC"],
    },
    {
        "name": "idx_session_quick_settle",
        "columns": ["space_id", "memory_quick_settled", "updated_at"],
        "directions": ["ASC", "ASC", "DESC"],
    },
]


def _align_indexes(apps, schema_editor):
    """幂等创建缺失的命名 index。已存在 → noop；不存在 → CREATE。"""
    # 仅 MySQL：对齐 MySQL 物理 index 漂移（INFORMATION_SCHEMA.STATISTICS/反引号专属 MySQL）。
    # single_pg 下 default alias 实为 PostgreSQL，按 vendor 守卫，PG 上 no-op
    # （fresh PG 的 index 由 ORM state 正确建出，无漂移需对齐）。
    if schema_editor.connection.vendor != "mysql":
        return  # chat_session 表在 MySQL，PG/SQLite 跳过

    table = "chat_session"
    with schema_editor.connection.cursor() as cursor:
        for spec in _TARGET_INDEXES:
            cursor.execute(
                """
                SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = %s
                  AND INDEX_NAME = %s
                LIMIT 1
                """,
                [table, spec["name"]],
            )
            if cursor.fetchone():
                continue  # 已存在，幂等跳过

            cols_clause = ", ".join(
                f"`{col}` {direction}"
                for col, direction in zip(spec["columns"], spec["directions"])
            )
            cursor.execute(
                f"CREATE INDEX `{spec['name']}` ON `{table}` ({cols_clause})"
            )


def _reverse_align(apps, schema_editor):
    """反向：DROP 这次新建的 index（幂等）。

    ⚠️ 反向不会恢复"原本 DB 上有这些 index"的状态——只是 cleanup 我们这次的产物。
    回滚到 0036 之前的 state 应当走 0036 reverse + 这次的反向。
    """
    if schema_editor.connection.vendor != "mysql":
        return

    table = "chat_session"
    with schema_editor.connection.cursor() as cursor:
        for spec in _TARGET_INDEXES:
            cursor.execute(
                """
                SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = %s
                  AND INDEX_NAME = %s
                LIMIT 1
                """,
                [table, spec["name"]],
            )
            if not cursor.fetchone():
                continue
            cursor.execute(f"ALTER TABLE `{table}` DROP INDEX `{spec['name']}`")


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0036_chat_session_space_to_uuid_softref"),
    ]

    operations = [
        migrations.RunPython(_align_indexes, reverse_code=_reverse_align),
    ]

"""跨 app 共用的 DDL migration 工具（v0.1 宪法 §5.1 治理配套）。

== 设计原则 ==

1. **语义匹配，不依赖 Django 命名约定**

   所有 FK 查询走 ``REFERENCED_TABLE_NAME / REFERENCED_COLUMN_NAME`` 语义匹配，
   不用 ``LIKE '%_fk_xxx_id'`` 那种依赖 Django 4.x 自动命名格式的 pattern。
   Django 5/6 若调整 ``BaseDatabaseSchemaEditor._create_index_name``，老 LIKE
   pattern 就会静默漏 DROP；语义匹配跨大版本稳定。

   反例参照：``apps/chat/conversation/migrations/0034_drop_legacy_llm_model_fk_constraints.py``
   原版用 LIKE pattern，本模块的 ``drop_mysql_fks_by_referenced_table`` 是改进版。

2. **alias 守护**

   每个函数明确接受 ``target_db_alias`` 决定在哪个 connection 上跑。alias 不
   匹配直接 noop——让上层 migration 在两库都引用本 helper 时也能正确分发，
   不需要每次手写 ``if schema_editor.connection.alias != 'default': return``。

3. **幂等**

   全部检查存量后再操作：FK 已 DROP 跑两次也不报错；表已 DROP 用 ``IF EXISTS``。
   migration 重跑或 ``--fake`` 后再 unfake 都安全。
"""

from __future__ import annotations

from typing import Iterable


# ════════════════════════════════════════════════════════════════════════════
#  MySQL helpers (default 库)
# ════════════════════════════════════════════════════════════════════════════


def drop_mysql_fks_by_referenced_table(
    schema_editor,
    *,
    target_db_alias: str = "default",
    table_constraint_pairs: Iterable[tuple[str, str]],
    referenced_column: str = "id",
) -> None:
    """按 ``(local_table, referenced_table)`` 语义匹配 DROP MySQL FK 约束。

    Args:
        table_constraint_pairs: ``[(本表名, 引用表名), ...]``——按"哪张表上 FK 指向哪张表"
            语义匹配。
        referenced_column: 引用列名，默认 ``id``。

    Example::

        drop_mysql_fks_by_referenced_table(
            schema_editor,
            table_constraint_pairs=[
                ('chat_session', 'services_llm_model'),
                ('chat_message', 'services_llm_model'),
            ],
        )
    """
    # MySQL 专属物理 schema 维护（DATABASE()/反引号/DROP FK）。single_pg 下 default
    # alias 实为 PostgreSQL，故按 vendor 守卫；PG/SQLite 上整体 no-op，避免 MySQL SQL 报错。
    if schema_editor.connection.vendor != "mysql":
        return
    if schema_editor.connection.alias != target_db_alias:
        return

    with schema_editor.connection.cursor() as cursor:
        for local_table, ref_table in table_constraint_pairs:
            cursor.execute(
                """
                SELECT CONSTRAINT_NAME
                FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                WHERE CONSTRAINT_SCHEMA = DATABASE()
                  AND TABLE_NAME = %s
                  AND REFERENCED_TABLE_NAME = %s
                  AND REFERENCED_COLUMN_NAME = %s
                """,
                [local_table, ref_table, referenced_column],
            )
            for (constraint_name,) in cursor.fetchall():
                cursor.execute(
                    f"ALTER TABLE `{local_table}` DROP FOREIGN KEY `{constraint_name}`"
                )


def drop_mysql_tables(
    schema_editor,
    *,
    target_db_alias: str = "default",
    tables: Iterable[str],
) -> None:
    """按列表顺序 ``DROP TABLE IF EXISTS``。

    调用方需保证：调用前已 DROP 所有指向这些表的 FK 约束（否则 MySQL 会拒绝），
    或直接 SET FOREIGN_KEY_CHECKS=0 包一层（不推荐）。
    """
    # MySQL 专属物理 schema 维护（反引号 DROP TABLE）。single_pg 下 default alias 实为
    # PostgreSQL，故按 vendor 守卫；PG/SQLite 上整体 no-op，避免 MySQL SQL 报错。
    if schema_editor.connection.vendor != "mysql":
        return
    if schema_editor.connection.alias != target_db_alias:
        return

    with schema_editor.connection.cursor() as cursor:
        for table in tables:
            cursor.execute(f"DROP TABLE IF EXISTS `{table}`")


def add_mysql_fk_idempotent(
    schema_editor,
    *,
    target_db_alias: str = "default",
    local_table: str,
    column: str,
    referenced_table: str,
    referenced_column: str = "id",
    on_delete: str = "CASCADE",
    constraint_name: str | None = None,
    integrity_check: bool = True,
) -> None:
    """幂等 ADD FK：已存在则 noop，否则前置悬空记录扫描后 ADD CONSTRAINT。

    Args:
        on_delete: ``CASCADE`` / ``SET NULL`` / ``RESTRICT`` 等 MySQL 标准动作
        constraint_name: 显式约束名；缺省走 Django 风格 ``<table>_<col>_fk_<ref>_<rcol>``
        integrity_check: True 时先查悬空记录数 >0 抛错（建议生产开启）；False 跳过
            （历史脏数据已知场景）

    Raises:
        RuntimeError: ``integrity_check=True`` 且发现悬空记录时
    """
    # MySQL 专属物理 schema 维护（DATABASE()/反引号/ADD FK）。single_pg 下 default alias
    # 实为 PostgreSQL，故按 vendor 守卫；PG/SQLite 上整体 no-op，避免 MySQL SQL 报错。
    if schema_editor.connection.vendor != "mysql":
        return
    if schema_editor.connection.alias != target_db_alias:
        return

    with schema_editor.connection.cursor() as cursor:
        # 已存在 → noop
        cursor.execute(
            """
            SELECT 1 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = %s
              AND COLUMN_NAME = %s
              AND REFERENCED_TABLE_NAME = %s
              AND REFERENCED_COLUMN_NAME = %s
            LIMIT 1
            """,
            [local_table, column, referenced_table, referenced_column],
        )
        if cursor.fetchone():
            return

        if integrity_check:
            cursor.execute(
                f"""
                SELECT COUNT(*) FROM `{local_table}` l
                LEFT JOIN `{referenced_table}` r ON r.`{referenced_column}` = l.`{column}`
                WHERE l.`{column}` IS NOT NULL AND r.`{referenced_column}` IS NULL
                """
            )
            (orphan,) = cursor.fetchone()
            if orphan:
                raise RuntimeError(
                    f"{local_table}.{column} 有 {orphan} 条悬空记录，建 FK 前请先清理"
                )

        cname = constraint_name or (
            f"{local_table}_{column}_fk_{referenced_table}_{referenced_column}"
        )
        cursor.execute(
            f"""
            ALTER TABLE `{local_table}`
            ADD CONSTRAINT `{cname}`
            FOREIGN KEY (`{column}`) REFERENCES `{referenced_table}` (`{referenced_column}`)
            ON DELETE {on_delete}
            """
        )


# ════════════════════════════════════════════════════════════════════════════
#  PostgreSQL helpers
# ════════════════════════════════════════════════════════════════════════════


def drop_pg_tables_cascade(
    schema_editor,
    *,
    target_db_alias: str = "postgresql",
    tables: Iterable[str],
) -> None:
    """``DROP TABLE IF EXISTS ... CASCADE``——PG 自动级联清理 FK。

    PG 的 CASCADE 语义跟 MySQL 不同：会自动 DROP 该表上所有 FK 约束（不只是
    DELETE 时的级联），所以不需要先单独 DROP FK。
    """
    if schema_editor.connection.alias != target_db_alias:
        return

    with schema_editor.connection.cursor() as cursor:
        for table in tables:
            cursor.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')


def drop_pg_fks_by_referenced_table(
    schema_editor,
    *,
    target_db_alias: str = "postgresql",
    table_constraint_pairs: Iterable[tuple[str, str]],
    referenced_column: str = "id",
) -> None:
    """按 ``(local_table, referenced_table)`` 语义匹配 DROP PG FK 约束。

    跟 MySQL 版对偶。PG 上 FK 约束名走 ``information_schema.table_constraints``
    + ``constraint_column_usage`` JOIN 查询（PG 没有 KEY_COLUMN_USAGE 的
    REFERENCED_TABLE_NAME 列，必须 JOIN）。

    Args:
        table_constraint_pairs: ``[(本表名, 引用表名), ...]``
        referenced_column: 引用列名，默认 ``id``。

    Example::

        drop_pg_fks_by_referenced_table(
            schema_editor,
            table_constraint_pairs=[
                ('chat_session', 'tabtinspace_space'),
            ],
        )
    """
    if schema_editor.connection.alias != target_db_alias:
        return

    with schema_editor.connection.cursor() as cursor:
        for local_table, ref_table in table_constraint_pairs:
            cursor.execute(
                """
                SELECT tc.constraint_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.constraint_column_usage ccu
                    ON ccu.constraint_name = tc.constraint_name
                   AND ccu.table_schema = tc.table_schema
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND tc.table_schema = 'public'
                  AND tc.table_name = %s
                  AND ccu.table_name = %s
                  AND ccu.column_name = %s
                """,
                [local_table, ref_table, referenced_column],
            )
            for (constraint_name,) in cursor.fetchall():
                cursor.execute(
                    f'ALTER TABLE "{local_table}" DROP CONSTRAINT "{constraint_name}"'
                )


def add_pg_fk_idempotent(
    schema_editor,
    *,
    target_db_alias: str = "postgresql",
    local_table: str,
    column: str,
    referenced_table: str,
    referenced_column: str = "id",
    on_delete: str = "CASCADE",
    constraint_name: str | None = None,
    integrity_check: bool = True,
) -> None:
    """幂等 ADD FK on PG：已存在则 noop，否则前置悬空记录扫描后 ADD CONSTRAINT。

    跟 MySQL 版对偶。区别：
    - PG 不支持 ``ON DELETE RESTRICT`` 默认行为之外的方言混用，需要显式声明
    - PG 约束名长度上限 ``63``——长 table_name + column 拼出的默认名可能超限，
      建议显式传 ``constraint_name``

    Raises:
        RuntimeError: ``integrity_check=True`` 且发现悬空记录时
    """
    if schema_editor.connection.alias != target_db_alias:
        return

    cname = constraint_name or (
        f"{local_table}_{column}_fk_{referenced_table}_{referenced_column}"
    )
    if len(cname) > 63:
        raise ValueError(
            f"PG constraint name {cname!r} 超过 63 字符上限，"
            f"请显式传入更短的 constraint_name"
        )

    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT 1 FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = 'public'
              AND tc.table_name = %s
              AND kcu.column_name = %s
            LIMIT 1
            """,
            [local_table, column],
        )
        if cursor.fetchone():
            return

        if integrity_check:
            cursor.execute(
                f'''
                SELECT COUNT(*) FROM "{local_table}" l
                LEFT JOIN "{referenced_table}" r ON r."{referenced_column}" = l."{column}"
                WHERE l."{column}" IS NOT NULL AND r."{referenced_column}" IS NULL
                '''
            )
            (orphan,) = cursor.fetchone()
            if orphan:
                raise RuntimeError(
                    f"{local_table}.{column} 有 {orphan} 条悬空记录（PG），"
                    f"建 FK 前请先清理"
                )

        cursor.execute(
            f'''
            ALTER TABLE "{local_table}"
            ADD CONSTRAINT "{cname}"
            FOREIGN KEY ("{column}") REFERENCES "{referenced_table}" ("{referenced_column}")
            ON DELETE {on_delete}
            '''
        )


# ════════════════════════════════════════════════════════════════════════════
#  跨库通用 helpers（不限 alias）
# ════════════════════════════════════════════════════════════════════════════


def rename_index_idempotent(
    schema_editor,
    *,
    target_db_alias: str,
    old_name: str,
    new_name: str,
) -> None:
    """幂等 RENAME INDEX：旧名存在 → rename；新名已存在 → noop（已 rename 过）。

    Django ``migrations.RenameIndex`` 在 ``SeparateDatabaseAndState`` state 段
    可用，但 ``database_operations`` 段需要走 raw SQL——本 helper 提供 MySQL/PG
    通用 dialect。

    适用场景：``0036_chat_session_space_to_uuid_softref`` 这种通过 SeparateDatabaseAndState
    改 state 字段名后，DB 物理 index 名残留旧 hash 后缀（``..._space_id_xxx_idx``
    指向 column ``space_id``，state 改成 ``space_id`` UUIDField 后名字一致但
    auto-generated suffix 可能漂移），需要补 cleanup migration 对齐。

    Args:
        target_db_alias: ``'default'`` (MySQL) 或 ``'postgresql'``，决定 SQL 方言。
    """
    if schema_editor.connection.alias != target_db_alias:
        return

    if target_db_alias == "default":
        # MySQL：检查 INFORMATION_SCHEMA.STATISTICS
        check_sql = """
            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = %s
            LIMIT 1
        """
        rename_sql_template = "ALTER TABLE `{table}` RENAME INDEX `{old}` TO `{new}`"
        # MySQL 需要 table 名才能 rename index——查 STATISTICS 取 TABLE_NAME
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(check_sql, [new_name])
            if cursor.fetchone():
                return  # 新名已存在，噪音 rename 过
            cursor.execute(check_sql, [old_name])
            row = cursor.fetchone()
            if not row:
                return  # 旧名也不在，可能是 fresh DB（state 段已建新名）
            # 还得拿 table name
            cursor.execute(
                """
                SELECT TABLE_NAME FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = %s
                LIMIT 1
                """,
                [old_name],
            )
            (table,) = cursor.fetchone()
            cursor.execute(rename_sql_template.format(
                table=table, old=old_name, new=new_name,
            ))
    elif target_db_alias == "postgresql":
        # PG：直接 ALTER INDEX，不需要 table 名
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = %s
                LIMIT 1
                """,
                [new_name],
            )
            if cursor.fetchone():
                return
            cursor.execute(
                """
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = %s
                LIMIT 1
                """,
                [old_name],
            )
            if not cursor.fetchone():
                return
            cursor.execute(f'ALTER INDEX "{old_name}" RENAME TO "{new_name}"')
    else:
        raise ValueError(
            f"rename_index_idempotent: unsupported alias {target_db_alias!r}"
        )


def drop_index_if_exists(
    schema_editor,
    *,
    target_db_alias: str,
    index_name: str,
) -> None:
    """幂等 DROP INDEX：找不到 → noop。

    用于 cleanup migration 清掉历史 implicit FK index 残留（升级路径下 Django auto
    生成的 ``<table>_<col>_<hash>_fk`` 这种名字，state 改字段后变成孤儿 index）。
    """
    if schema_editor.connection.alias != target_db_alias:
        return

    if target_db_alias == "default":
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT TABLE_NAME FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = %s
                LIMIT 1
                """,
                [index_name],
            )
            row = cursor.fetchone()
            if not row:
                return
            (table,) = row
            cursor.execute(f"ALTER TABLE `{table}` DROP INDEX `{index_name}`")
    elif target_db_alias == "postgresql":
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(f'DROP INDEX IF EXISTS "{index_name}"')
    else:
        raise ValueError(
            f"drop_index_if_exists: unsupported alias {target_db_alias!r}"
        )

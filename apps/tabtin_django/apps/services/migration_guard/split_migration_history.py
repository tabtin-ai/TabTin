"""#6333：拆 migration 文件后，为「已 apply 旧单体」的库补齐 django_migrations 半账。

背景
----
 把已在部分环境落账的单体 ``0107`` / ``0108`` 拆成
``0107→0107a→0107b``、``0108→0108a→0108b``，并把 ``0108`` 的依赖改成
``0107b``。Test 等库在拆文件前已 apply 旧单体名，拆完后 Django 报：

    InconsistentMigrationHistory: 0108 is applied before its dependency 0107b

同类还有 ``tabtinspace.0105→0105a``（0106 依赖改挂）、``agent.0004→0004a→0004b``。

``migrate --fake`` 也无法先跑——一致性检查在入口就会拒。本模块在
``safe_migrate`` 调 Django migrate **之前**，按 schema 探针确认旧单体效果
已落地后，用 ``MigrationRecorder.record_applied`` 补记缺失的拆分节点。

只处理「拆文件名已在磁盘、锚点已 applied、schema 已是终态」的半账；
不会对全新库或半跑中的新链误 fake。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Iterable

from django.db import connections
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.recorder import MigrationRecorder

logger = logging.getLogger(__name__)

TABTINSPACE = "tabtinspace"
AGENT = "agent"

MIGRATION_0105 = "0105_project_fk_cutover_3266"
MIGRATION_0105A = "0105a_project_fk_cutover_backfill_3266"
MIGRATION_0106_CONTEXT = "0106_contextitem_project_backfill_xor_3266"
MIGRATION_0107 = "0107_personal_workspace_fk_3266"
MIGRATION_0107A = "0107a_personal_workspace_fk_backfill_3266"
MIGRATION_0107B = "0107b_personal_workspace_fk_indexes_3266"
MIGRATION_0108 = "0108_personal_shell_fk_workspace_3266"
MIGRATION_0108A = "0108a_personal_shell_fk_backfill_3266"
MIGRATION_0108B = "0108b_personal_shell_schema_cutover_3266"

MIGRATION_AGENT_0004 = "0004_agent_is_default"
MIGRATION_AGENT_0004A = "0004a_agent_is_default_backfill"
MIGRATION_AGENT_0004B = "0004b_agent_one_active_default_constraint"
MIGRATION_AGENT_0005 = "0005_rename_default_agent_to_xiaotin"

# 兼容旧测试 / 调用方：历史默认 app
APP = TABTINSPACE

INDEX_0107B_MARKER = "ctx_item_workspace_type_idx"
INDEX_AGENT_0004B_MARKER = "agent_one_active_default_per_owner"
TABLE_CONTEXT_ITEM = "tabtinspace_context_item"
TABLE_SPACE_APP_SETTINGS = "tabtinspace_space_app_settings"
TABLE_SPACE = "tabtinspace_space"
TABLE_WORKSPACE = "tabtinspace_workspace"
COLUMN_WORKSPACE_ID = "workspace_id"
COLUMN_SPACE_ID = "space_id"


def _table_columns(connection, table: str) -> set[str]:
    with connection.cursor() as cursor:
        description = connection.introspection.get_table_description(cursor, table)
    return {getattr(col, "name", None) or col[0] for col in description}


def _table_exists(connection, table: str) -> bool:
    return table in set(connection.introspection.table_names())


def _index_exists(connection, index_name: str) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'i'
              AND c.relname = %s
              AND n.nspname = current_schema()
            LIMIT 1
            """,
            [index_name],
        )
        return cursor.fetchone() is not None


def schema_looks_like_post_0105a(connection) -> bool:
    """0105a 消解 team_space 壳后的终态。"""
    if _table_exists(connection, TABLE_WORKSPACE) and not _table_exists(
        connection, TABLE_SPACE,
    ):
        return True
    if not _table_exists(connection, TABLE_SPACE):
        return False
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT 1 FROM {TABLE_SPACE} WHERE type = %s LIMIT 1",
            ["team_space"],
        )
        return cursor.fetchone() is None


def schema_looks_like_post_0107_monolith(connection) -> bool:
    """旧单体 0107 已含 AddField + 回填 + 0107b 复合索引。"""
    if not _table_exists(connection, TABLE_CONTEXT_ITEM):
        return False
    columns = _table_columns(connection, TABLE_CONTEXT_ITEM)
    if COLUMN_WORKSPACE_ID not in columns:
        return False
    return _index_exists(connection, INDEX_0107B_MARKER)


def schema_looks_like_post_0108_monolith(connection) -> bool:
    """旧单体 0108 已含 cutover：壳表挂 workspace，且 space 列已 Drop。"""
    if not _table_exists(connection, TABLE_SPACE_APP_SETTINGS):
        return False
    columns = _table_columns(connection, TABLE_SPACE_APP_SETTINGS)
    return COLUMN_WORKSPACE_ID in columns and COLUMN_SPACE_ID not in columns


def schema_looks_like_post_agent_0004b(connection) -> bool:
    """0004b 的部分唯一约束/索引已在库中。"""
    return _index_exists(connection, INDEX_AGENT_0004B_MARKER)


@dataclass(frozen=True)
class _SplitRule:
    """锚点已 applied + schema 探针通过 → 补记 siblings。"""

    app: str
    name: str
    anchor: str
    siblings: tuple[str, ...]
    schema_ok: Callable


_RULES: tuple[_SplitRule, ...] = (
    _SplitRule(
        app=TABTINSPACE,
        name="0105-split",
        anchor=MIGRATION_0105,
        siblings=(MIGRATION_0105A,),
        schema_ok=schema_looks_like_post_0105a,
    ),
    _SplitRule(
        app=TABTINSPACE,
        name="0107-split",
        anchor=MIGRATION_0107,
        siblings=(MIGRATION_0107A, MIGRATION_0107B),
        schema_ok=schema_looks_like_post_0107_monolith,
    ),
    _SplitRule(
        app=TABTINSPACE,
        name="0108-split",
        anchor=MIGRATION_0108,
        siblings=(MIGRATION_0108A, MIGRATION_0108B),
        schema_ok=schema_looks_like_post_0108_monolith,
    ),
    _SplitRule(
        app=AGENT,
        name="agent-0004-split",
        anchor=MIGRATION_AGENT_0004,
        siblings=(MIGRATION_AGENT_0004A, MIGRATION_AGENT_0004B),
        schema_ok=schema_looks_like_post_agent_0004b,
    ),
)


def _applied_names(recorder: MigrationRecorder, app: str) -> set[str]:
    return {name for applied_app, name in recorder.applied_migrations() if applied_app == app}


def _on_disk(loader: MigrationLoader, app: str, name: str) -> bool:
    return (app, name) in loader.disk_migrations


def plan_fake_split_migrations(
    connection,
    *,
    loader: MigrationLoader | None = None,
    recorder: MigrationRecorder | None = None,
) -> list[tuple[str, str]]:
    """返回应按序 fake 的 ``(app, migration_name)`` 列表。"""
    loader = loader or MigrationLoader(connection, ignore_no_migrations=True)
    recorder = recorder or MigrationRecorder(connection)

    split_markers = (
        (TABTINSPACE, MIGRATION_0105A),
        (TABTINSPACE, MIGRATION_0107B),
        (TABTINSPACE, MIGRATION_0108B),
        (AGENT, MIGRATION_AGENT_0004B),
    )
    if not any(_on_disk(loader, app, name) for app, name in split_markers):
        return []

    planned: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    applied_by_app: dict[str, set[str]] = {}

    def _applied(app: str) -> set[str]:
        if app not in applied_by_app:
            applied_by_app[app] = _applied_names(recorder, app)
        return applied_by_app[app]

    def _queue(app: str, names: Iterable[str]) -> None:
        applied = _applied(app)
        for name in names:
            key = (app, name)
            if key in seen or name in applied:
                continue
            if not _on_disk(loader, app, name):
                continue
            planned.append(key)
            seen.add(key)

    space_applied = _applied(TABTINSPACE)
    # 0106 已落账但缺 0105a
    if MIGRATION_0106_CONTEXT in space_applied and MIGRATION_0105A not in space_applied:
        if schema_looks_like_post_0105a(connection):
            _queue(TABTINSPACE, (MIGRATION_0105A,))

    # 0108 已落账但缺 0107b
    if MIGRATION_0108 in space_applied and MIGRATION_0107B not in space_applied:
        if schema_looks_like_post_0107_monolith(connection) or schema_looks_like_post_0108_monolith(
            connection
        ):
            _queue(TABTINSPACE, (MIGRATION_0107A, MIGRATION_0107B))

    agent_applied = _applied(AGENT)
    # 0005 已落账但缺 0004b（及可能缺 0004a）
    if MIGRATION_AGENT_0005 in agent_applied and MIGRATION_AGENT_0004B not in agent_applied:
        if schema_looks_like_post_agent_0004b(connection):
            _queue(AGENT, (MIGRATION_AGENT_0004A, MIGRATION_AGENT_0004B))

    for rule in _RULES:
        applied = _applied(rule.app)
        if rule.anchor not in applied:
            continue
        missing = [name for name in rule.siblings if name not in applied]
        if not missing:
            continue
        if not any(_on_disk(loader, rule.app, name) for name in missing):
            continue
        if not rule.schema_ok(connection):
            logger.warning(
                "#6333 split-history: skip %s — anchor %s.%s applied but schema "
                "does not look like old monolith end-state",
                rule.name,
                rule.app,
                rule.anchor,
            )
            continue
        _queue(rule.app, rule.siblings)

    return planned


def reconcile_split_migration_history(database: str = "default") -> list[str]:
    """对指定库补记拆分半账；返回实际新写入的 ``app.name`` 列表。"""
    connection = connections[database]
    vendor = getattr(connection, "vendor", None)
    if vendor and vendor != "postgresql":
        return []

    loader = MigrationLoader(connection, ignore_no_migrations=True)
    recorder = MigrationRecorder(connection)
    to_fake = plan_fake_split_migrations(
        connection, loader=loader, recorder=recorder,
    )
    if not to_fake:
        return []

    recorded: list[str] = []
    for app, name in to_fake:
        recorder.record_applied(app, name)
        recorded.append(f"{app}.{name}")
        logger.warning(
            "#6333 split-history: faked %s.%s on database=%s "
            "(old monolith already applied; unblocks InconsistentMigrationHistory)",
            app,
            name,
            database,
        )
    return recorded

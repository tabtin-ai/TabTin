"""v0.1 宪法 §5.1 收尾终章：彻底 DROP MySQL 上 ``services_llm_*`` 整套 stale shadow。

== 背景 ==

v0.1 把 ``services_llm`` app 整体迁 PostgreSQL（``LlmRouter.db_for_read='postgresql'``
强制），但 MySQL（default）库上 v0.1 之前留下的 stale 资源没清理：

- **10 张 stale 表 + 11 条 FK 约束**——其中 5 张表的 ORM 已删（capability_drift /
  provider_probe_log / request / usage_statistics / vision_request），另外 5 张
  ORM 还在但路由强制走 PG（model / provider / provider_key / scene_binding /
  usage_fact）
- **1 条 orphan FK**：``services_llm_usage_fact.llm_request_id`` ORM 字段已删但
  DB 上 FK 还在（体检脚本 ``manage.py db_check_fk_alignment`` 可定位为唯一 ERROR）

ORM 路由把这堆 MySQL 表/约束完全隔离了，**正常业务路径触发不到**——但留着是
炸药：

1. 任何 raw SQL 误用 ``connections['default']`` 写 ``services_llm_*`` → FK 拒绝
2. 调试时把 ``'llm'`` 从 ``DefaultDatabaseRouter._pg_app_labels`` 摘下来 → 默认
   走 MySQL → FK 拒绝（复刻 0034 同款事故）
3. fresh DB 重建（新员工本地 setup / 测试环境重置）→ 整套 stale schema 又会被
   建出来加固

== 实现 ==

RunPython 三阶段，全用 ``apps.services.common.migration_helpers`` 的语义匹配
helper（不依赖 Django 命名约定，幂等）：

1. **兜底重 DROP** ``chat_session / chat_message → services_llm_model`` FK——
   0034 用 LIKE pattern 匹配，本阶段用 ``REFERENCED_TABLE_NAME`` 语义匹配再扫
   一次。fresh DB / 0034 已生效都 noop；Django 升级若改命名规则导致 0034 漏 DROP
   也能在这里兜底。

2. **DROP 全部跨表 FK**（11 条）——按"哪张表上的 FK 指向哪张表"语义匹配。

3. **DROP TABLE IF EXISTS**（10 张 stale 表）——按依赖顺序倒序删，先删被引用方
   持有 FK 的子表。

reverse_code 不重建——v0.1 后 services_llm 不应再回 MySQL；如需整体回滚请手动
restore 备份。
"""

from django.db import migrations

from apps.services.common.migration_helpers import (
    drop_mysql_fks_by_referenced_table,
    drop_mysql_tables,
)


# ════════════════════════════════════════════════════════════════════════════
# 0034 兜底：语义匹配再扫一次 chat_session/chat_message → services_llm_model
# ════════════════════════════════════════════════════════════════════════════

_BACKFILL_0034_PAIRS = [
    ("chat_session", "services_llm_model"),
    ("chat_message", "services_llm_model"),
]


# ════════════════════════════════════════════════════════════════════════════
# 全部跨表 FK
# ════════════════════════════════════════════════════════════════════════════
#
# 注意顺序：先 DROP "ORM 仍存在的 5 张表"上的 FK，再 DROP "已删 stale 表"上的
# FK——后者跑完才能 DROP TABLE，否则被引用方持有 FK 时 MySQL 会拒绝。

_LEGACY_FK_PAIRS = [
    # ── A 类：ORM 仍存在但已迁 PG 的 5 张表上的 FK ──
    ("services_llm_model", "services_llm_provider"),
    ("services_llm_provider_key", "services_llm_provider"),
    ("services_llm_scene_binding", "services_llm_model"),
    ("services_llm_usage_fact", "services_llm_provider"),
    ("services_llm_usage_fact", "services_llm_model"),
    # ── B 类：ORM 字段已删但 FK 残留（体检 ERROR）──
    ("services_llm_usage_fact", "services_llm_request"),
    # ── C 类：5 张 stale 表上指向其他 stale 表的 FK ──
    ("services_llm_capability_drift", "services_llm_model"),
    ("services_llm_provider_probe_log", "services_llm_provider"),
    ("services_llm_request", "services_llm_model"),
    ("services_llm_usage_statistics", "services_llm_model"),
    ("services_llm_vision_request", "services_llm_request"),
]


# ════════════════════════════════════════════════════════════════════════════
# 待 DROP 的整套 services_llm_* 表
# ════════════════════════════════════════════════════════════════════════════
#
# **全部 DROP**——llm 不在 ``_dual_db_labels`` 双库白名单，没理由保留 MySQL shadow。
# 顺序：依赖在前的子表先删，被引用方后删。
#
# - 5 张 ORM 已删的 stale 表
# - 5 张 ORM 仍存在但路由走 PG 的 shadow 表

_LEGACY_SHADOW_TABLES = [
    # ── stale 表（ORM 已删，按依赖关系子→父） ──
    "services_llm_capability_drift",
    "services_llm_provider_probe_log",
    "services_llm_usage_statistics",
    "services_llm_vision_request",
    "services_llm_request",
    # ── 完全 stale 表（ORM 无任何 model 声明，无 FK；安全直 DROP）──
    "services_llm_model_cache",
    "services_llm_usage_budget_policy",
    # ── ORM 仍存在但路由走 PG 的 shadow 表（按 FK 依赖：scene_binding/usage_fact/provider_key 都引用 model 或 provider）──
    "services_llm_scene_binding",
    "services_llm_usage_fact",
    "services_llm_provider_key",
    "services_llm_admin_audit_log",
    # ── 最后两张被引用的核心表 ──
    "services_llm_model",
    "services_llm_provider",
]


def drop_legacy_mysql_services_llm_shadow(apps, schema_editor):
    # 仅 MySQL：清理 MySQL 上 services_llm_* stale shadow 表/约束（MySQL 专属）。
    # single_pg 下 default alias 实为 PostgreSQL，按 vendor 守卫（且所调 helper 亦已 vendor 守卫）。
    if schema_editor.connection.vendor != "mysql":
        return

    # Phase 1: 0034 语义匹配兜底（fresh DB / 已生效 都 noop）
    drop_mysql_fks_by_referenced_table(
        schema_editor,
        table_constraint_pairs=_BACKFILL_0034_PAIRS,
    )

    # Phase 2: DROP 全部 services_llm_* 跨表 FK
    drop_mysql_fks_by_referenced_table(
        schema_editor,
        table_constraint_pairs=_LEGACY_FK_PAIRS,
    )

    # Phase 3: DROP TABLE IF EXISTS
    drop_mysql_tables(schema_editor, tables=_LEGACY_SHADOW_TABLES)


def noop_reverse(apps, schema_editor):
    return


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0034_drop_legacy_llm_model_fk_constraints"),
    ]

    operations = [
        migrations.RunPython(drop_legacy_mysql_services_llm_shadow, noop_reverse),
    ]

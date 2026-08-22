"""跨库 FK 物理约束 + 软引用治理体检 — 防 0034 / §5.1 同款回归。

== 检查项 ==

1. **drift（漂移）**：ORM 字段标记 ``db_constraint=False`` 但 DB 上仍有 FK 约束
   → ERROR。这是 Django ``AlterField`` 已知缺陷的产物，必须清掉物理约束（参照
   ``apps/chat/conversation/migrations/0034_drop_legacy_llm_model_fk_constraints.py``）。

2. **orphan_fk**：DB 上有 FK 约束但 ORM 字段已删除 → ERROR。属于历史脏数据。

3. **stale_table**：DB 上有表但 ORM 整模型已删除 → WARNING。提示有死表可清理。
   M2M auto through 中间表已被纳入 ``_collect_orm_fks`` / ``_collect_orm_tables``，
   不会再误报 ``Group.permissions`` / ``User.groups`` 这类内置 M2M。

4. **reverse_drift**：ORM 字段 ``db_constraint=True`` + 同库 FK，但 DB 上没建
   → WARNING。可能是 ``setup-script`` 历史漏跑。

5. **cross_db_with_constraint**：ORM 字段是跨库 FK 但 ``db_constraint=True``
   → ERROR。跨库 FK 必须 ``db_constraint=False``，否则一定会被 router 拒绝。

6. **softref_no_cascade**：``SoftRefRegistry`` 里 ``on_orphan_action='report_only'``
   且没有显式 ``no_cascade_needed=True`` 标记的 softref → WARNING。提示开发者
   "是漏注册 ``install_softref_cascade(...)`` 了吗？"——主动声明 metadata 引用
   不需要 cascade 的，加 ``no_cascade_needed=True, no_cascade_reason='...'`` 静默。

== 用法 ==

::

    python manage.py check_fk_alignment           # 仅打印诊断
    python manage.py check_fk_alignment --strict  # 有 ERROR 时退出码非 0（CI 模式）

把它接入 ``bash scripts/backend/restart.sh`` 或 CI pipeline 后，``db_constraint=False``
的 ORM 改造会自动校验是否同步 DROP 了物理约束——v0.1 0034 类问题再也不会上线。
"""

from __future__ import annotations

from typing import Any

from django.apps import apps as django_apps
from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import connections, router
from django.db.models import ForeignKey, ManyToManyField, OneToOneField


# ════════════════════════════════════════════════════════════════════════════
#  DB → FK 信息抽取
# ════════════════════════════════════════════════════════════════════════════


_MYSQL_FK_SQL = """
SELECT
    TABLE_NAME,
    COLUMN_NAME,
    CONSTRAINT_NAME,
    REFERENCED_TABLE_NAME,
    REFERENCED_COLUMN_NAME
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND REFERENCED_TABLE_NAME IS NOT NULL
"""


_PG_FK_SQL = """
SELECT
    tc.table_name,
    kcu.column_name,
    tc.constraint_name,
    ccu.table_name,
    ccu.column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
"""


_FK_SQL_BY_VENDOR = {
    "mysql": _MYSQL_FK_SQL,
    "postgresql": _PG_FK_SQL,
}


def _db_aliases_to_check() -> list[str]:
    """返回当前架构下承载关系数据、需要体检的 DB alias 列表。

    单库（single-PG）下 ``default`` 与 ``postgresql`` 是同一物理库的镜像 alias，
    只查一次（``default``）即可——否则同一批物理 FK 会被读两遍，且读到的 alias 与
    router 的 ``local_db``（单库恒为 ``default``）对不上，导致 reverse_drift 全量误报。
    优先取 ``TABTIN_MIGRATION_DATABASE_ALIASES``（与 ``check_migration_integrity`` 对齐），
    缺省时回退到所有已配置连接。
    """
    aliases = list(getattr(settings, "TABTIN_MIGRATION_DATABASE_ALIASES", None) or [])
    return aliases or list(connections.databases.keys())


def _collect_db_fks() -> list[tuple[str, str, str, str, str, str]]:
    """从当前架构的关系库收集所有物理 FK，返回 ``[(alias, table, col, cname, rtab, rcol), ...]``。

    按 ``connection.vendor`` 选 SQL（MySQL/PG 专属 SQL 必须用 vendor 守卫，不能跑错库——
    见 ``.cursor/rules/backend-django.mdc``），不再硬编码 ``default→MySQL``：单库下
    ``default`` 已是 PostgreSQL，硬跑 MySQL 的 ``REFERENCED_TABLE_NAME`` 会整库读不到 FK。
    """
    rows: list[tuple[str, str, str, str, str, str]] = []
    for alias in _db_aliases_to_check():
        connection = connections[alias]
        sql = _FK_SQL_BY_VENDOR.get(connection.vendor)
        if sql is None:
            print(
                f"[check_fk_alignment] WARN: skip alias={alias!r}: "
                f"unsupported vendor {connection.vendor!r}"
            )
            continue
        try:
            with connection.cursor() as cursor:
                cursor.execute(sql)
                for table, col, cname, rtab, rcol in cursor.fetchall():
                    rows.append((alias, table, col, cname, rtab, rcol))
        except Exception as exc:  # noqa: BLE001
            # alias 不存在 / 连接不通——发警告但不阻塞其他 alias 检查
            print(f"[check_fk_alignment] WARN: skip alias={alias!r}: {exc}")
    return rows


def _record_fk(orm_fks, *, model, field, source_label):
    """把单个 FK 记入 orm_fks 索引（统一 model 和 through model 的入口）。"""
    local_db = router.db_for_read(model) or "default"
    target_db = router.db_for_read(field.related_model) or "default"
    orm_fks[(model._meta.db_table, field.column)] = {
        "db_constraint": field.db_constraint,
        "local_db": local_db,
        "target_db": target_db,
        "is_cross_db": local_db != target_db,
        "app": model._meta.app_label,
        "model": model.__name__,
        "field": field.name,
        "source": source_label,  # "field" | "m2m_through:<owner>.<m2m_name>"
    }


def _collect_orm_fks() -> dict[tuple[str, str], dict[str, Any]]:
    """收集 ORM 声明的所有 FK，返回 ``{(table, column): {db_constraint, ...}}``。

    包含两类 FK 来源：

    1. **直接字段**：model 上声明的 ``ForeignKey`` / ``OneToOneField``。
    2. **M2M auto through**：``ManyToManyField`` 自动生成的 through model 上的两个
       FK（指向 owner / target）。Django 自动 through 不出现在 ``get_models()`` 里，
       不递归扫的话所有 M2M 中间表 FK 都会被误报成 ``stale_table``——参照
       ``Group.permissions`` / ``User.groups`` 这类内置 M2M。

    显式 through model（``through=MyExplicitThrough``）已经是普通 model，会被
    ``get_models()`` 扫到；这里用 ``through._meta.auto_created`` 区分跳过避免重复。
    """
    orm_fks: dict[tuple[str, str], dict[str, Any]] = {}
    for model in django_apps.get_models():
        for field in model._meta.get_fields():
            if isinstance(field, (ForeignKey, OneToOneField)):
                if not getattr(field, "concrete", False):
                    continue
                _record_fk(orm_fks, model=model, field=field, source_label="field")
                continue

            if isinstance(field, ManyToManyField):
                through = field.remote_field.through
                if through is None or not through._meta.auto_created:
                    continue
                source = f"m2m_through:{model.__name__}.{field.name}"
                for through_field in through._meta.get_fields():
                    if not isinstance(through_field, (ForeignKey, OneToOneField)):
                        continue
                    if not getattr(through_field, "concrete", False):
                        continue
                    _record_fk(
                        orm_fks, model=through, field=through_field,
                        source_label=source,
                    )
    return orm_fks


def _collect_orm_tables() -> set[str]:
    """收集所有 ORM 声明的 db_table（含 M2M auto through 中间表）。

    跟 ``_collect_orm_fks`` 同源——M2M 中间表也是合法 ORM 表，不计入会让
    stale_table 把整张 M2M join 表错报成"ORM 已删"。
    """
    tables: set[str] = set()
    for model in django_apps.get_models():
        tables.add(model._meta.db_table)
        for field in model._meta.get_fields():
            if isinstance(field, ManyToManyField):
                through = field.remote_field.through
                if through is not None and through._meta.auto_created:
                    tables.add(through._meta.db_table)
    return tables


# ════════════════════════════════════════════════════════════════════════════
#  Diagnostics
# ════════════════════════════════════════════════════════════════════════════


def _diagnose(orm_fks, orm_tables, db_fks):
    """返回 ``(errors, warnings)`` 两个列表。"""
    errors: list[str] = []
    warnings: list[str] = []

    db_fk_keys: set[tuple[str, str, str]] = set()
    for alias, table, col, cname, rtab, rcol in db_fks:
        db_fk_keys.add((alias, table, col))
        orm = orm_fks.get((table, col))

        if orm is None:
            if table not in orm_tables:
                warnings.append(
                    f"[stale_table] {alias}.{table}: 整张表的 ORM 已删，含 stale FK "
                    f"{cname} ({col} → {rtab}.{rcol})"
                )
            else:
                errors.append(
                    f"[orphan_fk] {alias}.{table}.{col}: ORM 字段已删但 DB 仍有 FK "
                    f"{cname} → {rtab}.{rcol}"
                )
            continue

        if not orm["db_constraint"]:
            errors.append(
                f"[drift] {alias}.{table}.{col}: ORM db_constraint=False 但 DB 仍有 "
                f"FK {cname} → {rtab}.{rcol} ({orm['app']}.{orm['model']}.{orm['field']})"
            )

    # 反向：ORM 同库 FK 期望约束但 DB 上没建
    for (table, col), orm in orm_fks.items():
        if orm["is_cross_db"]:
            if orm["db_constraint"]:
                errors.append(
                    f"[cross_db_with_constraint] {orm['local_db']}.{table}.{col}: "
                    f"跨库 FK 必须 db_constraint=False（{orm['app']}.{orm['model']}.{orm['field']} → "
                    f"{orm['target_db']}）"
                )
            continue

        if not orm["db_constraint"]:
            continue
        local_db = orm["local_db"]
        if (local_db, table, col) not in db_fk_keys:
            warnings.append(
                f"[reverse_drift] {local_db}.{table}.{col}: ORM 期望 FK 但 DB 没建 "
                f"({orm['app']}.{orm['model']}.{orm['field']})"
            )

    return errors, warnings


# ════════════════════════════════════════════════════════════════════════════
#  SoftRef cascade 体检
# ════════════════════════════════════════════════════════════════════════════


def _diagnose_softrefs() -> list[str]:
    """检查 SoftRefRegistry 注册的所有 softref 是否都有 cascade 配置。

    判定：
    - ``on_orphan_action != 'report_only'`` → OK，已注册 install_softref_cascade
    - ``on_orphan_action == 'report_only'`` AND ``no_cascade_needed=True`` → OK，
      显式声明 metadata 引用不需要 cascade
    - ``on_orphan_action == 'report_only'`` AND NOT ``no_cascade_needed`` → WARNING，
      可能漏注册 cascade signal

    返回 WARNING 字符串列表（本检查不产生 ERROR——是否需要 cascade 是产品决策，
    体检只能提示不能强制）。
    """
    warnings: list[str] = []
    try:
        from apps.services.common.cross_db_softref import SoftRefRegistry
    except Exception as exc:  # noqa: BLE001
        return [f"[softref_no_cascade] cross_db_softref module unavailable: {exc!r}"]

    for spec in SoftRefRegistry.all_specs():
        if spec.on_orphan_action != "report_only":
            continue
        if spec.no_cascade_needed:
            continue
        warnings.append(
            f"[softref_no_cascade] {spec.holder_app}.{spec.holder_model}.{spec.attr_name} "
            f"→ {spec.target_model}: 没注册 install_softref_cascade(...)；"
            f"target 删除时 holder 会留悬空 ID（reconcile_softrefs 兜底）。"
            f" 若是有意（metadata 引用），加 no_cascade_needed=True + no_cascade_reason=... 静默。"
        )
    return warnings


# ════════════════════════════════════════════════════════════════════════════
#  Command
# ════════════════════════════════════════════════════════════════════════════


class Command(BaseCommand):
    help = (
        "体检 ORM db_constraint 与 DB 物理 FK 的一致性，防 v0.1 0034 类回归。"
        " --strict 有 ERROR 退出码非 0（CI 模式）。"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--strict",
            action="store_true",
            help="有 ERROR 时退出码非 0（CI 卡 PR 模式）",
        )
        parser.add_argument(
            "--include-warnings",
            action="store_true",
            help="--strict 模式下，把 WARNING 也视作 fail（默认只 fail on ERROR）",
        )

    def handle(self, *args, strict: bool = False, include_warnings: bool = False, **opts):
        orm_fks = _collect_orm_fks()
        orm_tables = _collect_orm_tables()
        db_fks = _collect_db_fks()

        errors, warnings = _diagnose(orm_fks, orm_tables, db_fks)
        # 软引用体检追加（只产生 WARNING，不影响 ERROR 计数）
        warnings.extend(_diagnose_softrefs())

        for w in warnings:
            self.stdout.write(self.style.WARNING(w))
        for e in errors:
            self.stdout.write(self.style.ERROR(e))

        summary = (
            f"\n体检完成：{len(orm_fks)} 个 ORM FK / "
            f"{len(db_fks)} 条 DB FK / "
            f"{len(errors)} 个 ERROR / {len(warnings)} 个 WARNING"
        )
        if errors:
            self.stdout.write(self.style.ERROR(summary))
        elif warnings:
            self.stdout.write(self.style.WARNING(summary))
        else:
            self.stdout.write(self.style.SUCCESS(summary + " ✓"))

        if strict:
            should_fail = bool(errors) or (include_warnings and bool(warnings))
            if should_fail:
                raise SystemExit(1)

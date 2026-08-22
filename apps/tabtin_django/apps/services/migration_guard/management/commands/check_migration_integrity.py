"""check_migration_integrity —— 跨库 migration history / schema 一致性自检。

核心假设（由 Django 4.2 的 ``MigrationLoader.check_consistent_history`` 决定）：

    每个已配置数据库的 ``django_migrations`` 表必须持有**所有当前活跃 app**
    的完整 applied 记录，即便该 app 的 DDL 不在该库执行——这些"影子"
    记录是 Django 内部跨 app 依赖图验证的必需数据。

本命令的判定标准（从严到宽）：

    1. **活跃 history 缺失（阻断）**：app 仍在 INSTALLED_APPS、磁盘上有
       migration 文件，但任一数据库没有 applied 记录。它同时覆盖"只跑了
       单侧 migrate"和"两库都还没跑新 migration"。
    2. **重复记录（阻断）**：同一 (db, app, name) 在 ``django_migrations``
       表出现 > 1 条。
    3. **多 leaf 节点（阻断）**：同一 app 的 migration graph 上有 >1 个
       leaf，意味着两个分支各自基于同一个父节点新增 migration 没合流。
       Django 在这种情况下虽然能跑（两个 leaf 都 apply），但容易出现
       "字典序在前的先跑、后到的没跑"的不一致历史，且会让编号语义混乱。
       典型表现：``0041_xxx_a.py`` / ``0041_xxx_b.py`` 同时存在且都
       depends on ``0040``。
    4. **当前 schema 漂移（可选阻断）**：加 ``--schema`` 时，按当前 router
       决策检查目标库是否存在模型表与字段。
    5. **发布包外迁移（阻断）**：活跃 app 在数据库中已有 applied 记录，
       但发布包既无对应 migration 文件、也没有 squash ``replaces`` 声明。
    6. **历史残留（不阻断）**：已删除 app，或被 squash 明确替代的旧
       migration 仍在 django_migrations 表里。
"""

from __future__ import annotations

from collections import Counter, defaultdict

from django.apps import apps as _django_apps
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connections
from django.db import router as db_router
from django.db.migrations.loader import MigrationLoader


class Command(BaseCommand):
    help = "检查两库 django_migrations 表完整性、重复记录、可选 schema 漂移"
    requires_system_checks = []

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--strict",
            action="store_true",
            help="发现活跃缺失、重复记录或 schema 漂移时 exit 1，供 CI 使用",
        )
        parser.add_argument(
            "--artifact-preflight",
            action="store_true",
            help=(
                "迁移前发布包门禁：仅对数据库已执行、但发布包无法解释的 migration "
                "以及重复记录/多 leaf exit 1；允许发布包内 migration 尚未执行"
            ),
        )
        parser.add_argument(
            "--include-legacy",
            action="store_true",
            help="显示已删除 app / squash 残留的详情（默认只显示数量）",
        )
        parser.add_argument(
            "--schema",
            action="store_true",
            help="额外核对当前模型在目标库的物理表/字段是否存在",
        )
        parser.add_argument(
            "--cleanup-legacy",
            action="store_true",
            help="直接从 django_migrations 删除历史残留（操作前会打印清单）",
        )

    def handle(
        self,
        *args,
        strict: bool = False,
        artifact_preflight: bool = False,
        include_legacy: bool = False,
        schema: bool = False,
        cleanup_legacy: bool = False,
        **options,
    ) -> None:
        per_db_rows: dict[str, list[tuple[int | None, str, str]]] = {}
        db_aliases = list(
            getattr(settings, "TABTIN_MIGRATION_DATABASE_ALIASES", None)
            or connections.databases.keys()
        )
        for db_alias in db_aliases:
            conn = connections[db_alias]
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT id, app, name FROM django_migrations")
                    per_db_rows[db_alias] = list(cur.fetchall())
            except Exception as exc:
                self.stdout.write(
                    self.style.WARNING(
                        f"[skip] 数据库 {db_alias} 不可用或缺少 django_migrations 表: {exc}"
                    )
                )

        db_list = sorted(per_db_rows.keys())
        if not db_aliases:
            raise CommandError("没有可用于加载 migration graph 的数据库配置")
        single_db_mode = len(db_list) < 2
        active_app_labels = {ac.label for ac in _django_apps.get_app_configs()}
        loader = MigrationLoader(
            connections[db_list[0] if db_list else db_aliases[0]],
            ignore_no_migrations=True,
        )
        active_on_disk = {
            (app, name)
            for (app, name) in loader.disk_migrations.keys()
            if app in active_app_labels
        }
        replaced_migrations = {
            tuple(replaced)
            for migration in loader.disk_migrations.values()
            for replaced in (getattr(migration, "replaces", None) or [])
        }
        reconciled_migrations = {
            tuple(reconciled)
            for migration in loader.disk_migrations.values()
            for reconciled in (getattr(migration, "reconciles", None) or [])
        }

        per_db_counter: dict[str, Counter] = {
            db: Counter((app, name) for _rid, app, name in rows)
            for db, rows in per_db_rows.items()
        }
        migration_targets: dict[tuple[str, str], set[str]] = {
            (app, name): self._migration_target_dbs(
                app,
                loader.disk_migrations[(app, name)],
                db_list,
            )
            for app, name in active_on_disk
        }

        active_missing: dict[str, dict[str, list[str]]] = defaultdict(
            lambda: defaultdict(list)
        )
        missing_everywhere: dict[str, list[str]] = defaultdict(list)
        for app, name in sorted(active_on_disk):
            missing_dbs = [
                db for db in db_list if per_db_counter[db].get((app, name), 0) == 0
            ]
            if not missing_dbs:
                continue
            for db in missing_dbs:
                active_missing[db][app].append(name)
            if len(missing_dbs) == len(db_list):
                missing_everywhere[app].append(name)
        has_active_gap = any(active_missing.values())

        duplicates: dict[str, dict[tuple[str, str], int]] = defaultdict(dict)
        for db, counter in per_db_counter.items():
            for key, count in counter.items():
                if count > 1:
                    duplicates[db][key] = count
        has_duplicates = any(duplicates.values())

        multi_leaf: dict[str, list[str]] = {}
        for app_label in sorted(active_app_labels):
            try:
                leaves = loader.graph.leaf_nodes(app_label)
            except Exception:
                continue
            if len(leaves) > 1:
                multi_leaf[app_label] = sorted(name for _app, name in leaves)
        has_multi_leaf = bool(multi_leaf)

        unpublished_applied: dict[str, dict[str, list[str]]] = defaultdict(
            lambda: defaultdict(list)
        )
        legacy: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        for db, counter in per_db_counter.items():
            for (app, name), _count in counter.items():
                if (app, name) in active_on_disk:
                    continue
                if (
                    app in active_app_labels
                    and (app, name) not in replaced_migrations
                    and (app, name) not in reconciled_migrations
                ):
                    unpublished_applied[db][app].append(name)
                    continue
                legacy[db][app].append(name)
        has_unpublished_applied = any(unpublished_applied.values())
        legacy_total: dict[str, int] = {
            db: sum(len(v) for v in legacy.get(db, {}).values()) for db in per_db_rows
        }

        if db_list:
            self.stdout.write("数据库状态概览：")
            for db in db_list:
                total = len(per_db_rows[db])
                active_count = sum(
                    c for k, c in per_db_counter[db].items() if k in active_on_disk
                )
                legacy_count = legacy_total.get(db, 0)
                self.stdout.write(
                    f"  - {db}: 总 {total} 条 | 活跃 {active_count} 条 | 历史残留 {legacy_count} 条"
                )
        else:
            self.stdout.write(
                self.style.WARNING(
                    "数据库尚未初始化或不可用；跳过 history/schema 状态检查，"
                    "仅执行发布包 migration graph 预检。"
                )
            )

        if has_active_gap:
            self.stdout.write(
                self.style.ERROR(
                    "\n❌ 活跃 app 的 migration history 缺失 / 跨库不一致："
                )
            )
            if missing_everywhere:
                total = sum(len(v) for v in missing_everywhere.values())
                self.stdout.write(f"\n  完全未记录（所有数据库都缺）{total} 条：")
                for app, names in sorted(missing_everywhere.items()):
                    self.stdout.write(f"    - {app}: {self._format_name_sample(names)}")
            for db in db_list:
                gap = active_missing.get(db, {})
                if not gap:
                    continue
                total = sum(len(v) for v in gap.values())
                self.stdout.write(f"\n  database={db} 缺失 {total} 条记录：")
                for app, names in sorted(gap.items()):
                    by_kind: dict[str, list[str]] = defaultdict(list)
                    for name in sorted(names):
                        by_kind[
                            self._missing_kind(
                                db,
                                migration_targets.get((app, name), set()),
                            )
                        ].append(name)
                    for kind, kind_names in sorted(by_kind.items()):
                        self.stdout.write(
                            f"    - {app} [{kind}]: {self._format_name_sample(kind_names)}"
                        )
            self.stdout.write(
                self.style.WARNING(
                    "\n下一步：先结合 --schema 核对目标库真实 DDL；"
                    "schema 已存在但 history 缺失时考虑 fake 记录，"
                    "schema 缺失时再执行 safe_migrate。"
                )
            )
        elif db_list:
            if single_db_mode:
                self.stdout.write(
                    self.style.SUCCESS("\n✅ 活跃 app 的 migration history 在单库中完整")
                )
            else:
                self.stdout.write(
                    self.style.SUCCESS("\n✅ 活跃 app 的 migration history 跨库完全一致")
                )

        if has_multi_leaf:
            self.stdout.write(
                self.style.ERROR(
                    "\n❌ 发现同一 app 的 migration graph 有多个 leaf（双胎/未合流）："
                )
            )
            for app_label, leaves in sorted(multi_leaf.items()):
                self.stdout.write(f"\n  - {app_label}: {len(leaves)} 个 leaf")
                for name in leaves:
                    self.stdout.write(f"      · {name}")
            self.stdout.write(
                self.style.WARNING(
                    "\n修复：把后到的那个 migration 重命名为下一编号，"
                    "并把它的 dependencies 改为指向另一个 leaf；或运行 "
                    "`python manage.py makemigrations --merge` 生成合流节点。"
                    "切勿留两个同前缀 leaf 直接 merge 进主分支。"
                )
            )

        if has_duplicates:
            self.stdout.write(
                self.style.ERROR("\n❌ 发现 django_migrations 表有重复记录：")
            )
            for db in db_list:
                if not duplicates.get(db):
                    continue
                self.stdout.write(f"\n  database={db}：")
                for (app, name), count in sorted(duplicates[db].items()):
                    self.stdout.write(f"    - {app}.{name}: {count} 行")
            self.stdout.write(
                self.style.WARNING(
                    "\n修复：保留最早的 id，其余删除：\n"
                    "  DELETE FROM django_migrations WHERE id NOT IN (\n"
                    "    SELECT min_id FROM (\n"
                    "      SELECT MIN(id) AS min_id FROM django_migrations GROUP BY app, name\n"
                    "    ) t\n"
                    "  );"
                )
            )

        if has_unpublished_applied:
            self.stdout.write(
                self.style.ERROR(
                    "\n❌ 活跃 app 存在发布包外 migration 记录："
                )
            )
            for db in db_list:
                gap = unpublished_applied.get(db, {})
                if not gap:
                    continue
                self.stdout.write(f"\n  database={db}：")
                for app, names in sorted(gap.items()):
                    self.stdout.write(
                        f"    - {app}: {self._format_name_sample(names)}"
                    )
            self.stdout.write(
                self.style.WARNING(
                    "\n该数据库曾执行当前发布包无法复现的迁移。"
                    "禁止继续发布；请补回原迁移或提供显式补偿迁移并核对真实 DDL。"
                )
            )

        has_legacy = any(legacy_total.values())
        if has_legacy and include_legacy:
            self.stdout.write("\n— 历史残留详情（不阻断 CI）—")
            for db in db_list:
                gap = legacy.get(db, {})
                if not gap:
                    continue
                self.stdout.write(f"\n  database={db} 共 {legacy_total[db]} 条：")
                for app, names in sorted(gap.items()):
                    reason = (
                        "app 已删除"
                        if app not in active_app_labels
                        else "migration 文件已删除"
                    )
                    self.stdout.write(f"    - {app} ({reason}): {len(names)} 条")
        elif has_legacy and not include_legacy:
            counts = ", ".join(f"{db}={legacy_total[db]}" for db in db_list)
            self.stdout.write(
                self.style.NOTICE(
                    f"\n提示：历史残留 {counts}（不阻断），--include-legacy 查看详情。"
                )
            )

        schema_issues = []
        if schema and db_list:
            schema_issues = self._check_current_model_schema(db_list)
            if schema_issues:
                self.stdout.write(
                    self.style.ERROR("\n❌ 当前模型 schema 与目标数据库不一致：")
                )
                for issue in schema_issues[:80]:
                    self.stdout.write(f"  - {issue}")
                if len(schema_issues) > 80:
                    self.stdout.write(f"  …共 {len(schema_issues)} 项")
            else:
                self.stdout.write(
                    self.style.SUCCESS("\n✅ 当前模型 schema 快照未发现缺表/缺字段")
                )

        router_warnings = self._router_audit_warnings(db_list) if db_list else []
        if router_warnings:
            self.stdout.write(
                self.style.WARNING("\n⚠️  Router 配置审计提示（不阻断）：")
            )
            for warning in router_warnings:
                self.stdout.write(f"  - {warning}")

        if cleanup_legacy and has_legacy:
            self._cleanup_legacy(legacy, per_db_rows)

        artifact_failure = has_duplicates or has_multi_leaf or has_unpublished_applied
        if artifact_preflight and artifact_failure:
            raise CommandError("migration 发布包预检失败")

        if strict and (
            has_active_gap
            or has_duplicates
            or has_multi_leaf
            or has_unpublished_applied
            or schema_issues
        ):
            raise CommandError("migration 一致性检查失败")

    def _migration_target_dbs(
        self,
        app_label: str,
        migration,
        db_list: list[str],
    ) -> set[str]:
        targets: set[str] = set()
        for operation in getattr(migration, "operations", []):
            targets.update(self._operation_target_dbs(app_label, operation, db_list))
        return targets

    def _operation_target_dbs(
        self,
        app_label: str,
        operation,
        db_list: list[str],
    ) -> set[str]:
        database_operations = getattr(operation, "database_operations", None)
        if database_operations:
            targets: set[str] = set()
            for nested in database_operations:
                targets.update(self._operation_target_dbs(app_label, nested, db_list))
            return targets

        hints = dict(getattr(operation, "hints", {}) or {})
        hinted_db = hints.get("target_db")
        model_name = self._operation_model_name(operation)
        targets: set[str] = set()
        for db in db_list:
            if hinted_db and db != hinted_db:
                continue
            try:
                if model_name:
                    allowed = db_router.allow_migrate(
                        db,
                        app_label,
                        model_name=model_name,
                        **hints,
                    )
                elif hinted_db:
                    allowed = db == hinted_db
                else:
                    allowed = db_router.allow_migrate(db, app_label, **hints)
            except Exception:
                allowed = None
            if allowed:
                targets.add(db)
        return targets

    def _operation_model_name(self, operation) -> str | None:
        for attr in ("model_name", "name", "old_name"):
            value = getattr(operation, attr, None)
            if value:
                return str(value).lower()
        return None

    def _missing_kind(self, db: str, targets: set[str]) -> str:
        if db in targets:
            return "目标库记录缺失"
        if targets:
            return f"影子记录缺失；DDL目标={','.join(sorted(targets))}"
        return "history-only 记录缺失"

    def _format_name_sample(self, names: list[str]) -> str:
        sorted_names = sorted(names)
        sample = ", ".join(sorted_names[:3])
        more = f"…共 {len(sorted_names)} 条" if len(sorted_names) > 3 else ""
        return f"{sample}{more}"

    def _check_current_model_schema(self, db_list: list[str]) -> list[str]:
        issues: list[str] = []
        table_cache: dict[str, set[str]] = {}
        try:
            models = list(_django_apps.get_models(include_auto_created=False))
        except Exception as exc:
            return [f"无法读取 Django app registry: {exc}"]

        for model in models:
            if getattr(model._meta, "proxy", False) or not getattr(
                model._meta, "managed", True
            ):
                continue
            label = model._meta.app_label
            model_name = model._meta.model_name
            target_dbs = []
            for db in db_list:
                try:
                    if db_router.allow_migrate(
                        db,
                        label,
                        model_name=model_name,
                        model=model,
                    ):
                        target_dbs.append(db)
                except Exception as exc:
                    issues.append(f"{label}.{model_name}: router 判断 {db} 失败: {exc}")

            for db in target_dbs:
                conn = connections[db]
                try:
                    if db not in table_cache:
                        table_cache[db] = set(conn.introspection.table_names())
                    table = model._meta.db_table
                    role = self._schema_db_role(db, model)
                    if table not in table_cache[db]:
                        issues.append(
                            f"{db}.{table}: 缺{role}表（{label}.{model_name}）"
                        )
                        continue
                    with conn.cursor() as cur:
                        description = conn.introspection.get_table_description(
                            cur, table
                        )
                    existing_columns = {col.name for col in description}
                    missing_columns = [
                        field.column
                        for field in model._meta.fields
                        if field.column and field.column not in existing_columns
                    ]
                    if missing_columns:
                        issues.append(
                            f"{db}.{table}: 缺{role}字段 {', '.join(missing_columns)}"
                        )
                    model_columns = {
                        field.column for field in model._meta.fields if field.column
                    }
                    extra_required_columns = [
                        column.name
                        for column in description
                        if column.name not in model_columns
                        and getattr(column, "null_ok", True) is False
                        and getattr(column, "default", None) is None
                    ]
                    if extra_required_columns:
                        issues.append(
                            f"{db}.{table}: 存在模型未声明的 NOT NULL 无默认字段 "
                            f"{', '.join(extra_required_columns)}；ORM INSERT 将失败"
                        )
                except Exception as exc:
                    issues.append(f"{db}.{label}.{model_name}: schema 检查失败: {exc}")
        return issues

    def _schema_db_role(self, db: str, model) -> str:
        try:
            read_db = db_router.db_for_read(model)
            write_db = db_router.db_for_write(model)
        except Exception:
            return ""
        if db in {read_db, write_db}:
            return "目标"
        return "影子"

    def _router_audit_warnings(self, db_list: list[str]) -> list[str]:
        warnings: list[str] = []
        if "postgresql" not in db_list:
            return warnings

        try:
            models = list(_django_apps.get_models(include_auto_created=False))
        except Exception:
            return warnings

        app_targets: dict[str, set[tuple[str, ...]]] = defaultdict(set)
        active_labels = {ac.label for ac in _django_apps.get_app_configs()}
        for model in models:
            targets = []
            for db in db_list:
                try:
                    if db_router.allow_migrate(
                        db,
                        model._meta.app_label,
                        model_name=model._meta.model_name,
                        model=model,
                    ):
                        targets.append(db)
                except Exception:
                    pass
            app_targets[model._meta.app_label].add(tuple(sorted(targets)))

        actual_pg_only = {
            label
            for label, targets in app_targets.items()
            if targets and all(target == ("postgresql",) for target in targets)
        }

        try:
            from apps.services.common.db_router import DefaultDatabaseRouter
        except Exception:
            return warnings

        configured_pg = set(DefaultDatabaseRouter._pg_app_labels)
        missing_in_config = sorted(actual_pg_only - configured_pg)
        stale_in_config = sorted(configured_pg - active_labels)

        if missing_in_config:
            warnings.append(
                "实际 router 判定为 PG-only，但 DefaultDatabaseRouter._pg_app_labels 未登记："
                + ", ".join(missing_in_config)
            )
        if stale_in_config:
            warnings.append(
                "DefaultDatabaseRouter._pg_app_labels 中存在非活跃 app："
                + ", ".join(stale_in_config)
            )
        return warnings

    def _cleanup_legacy(
        self,
        legacy: dict[str, dict[str, list[str]]],
        per_db_rows: dict[str, list[tuple[int | None, str, str]]],
    ) -> None:
        self.stdout.write("\n开始清理历史残留…")
        for db, gap in legacy.items():
            ids_to_delete = []
            legacy_pairs = {(app, name) for app, names in gap.items() for name in names}
            for rid, app, name in per_db_rows[db]:
                if rid is not None and (app, name) in legacy_pairs:
                    ids_to_delete.append(rid)
            if not ids_to_delete:
                continue
            placeholders = ",".join(["%s"] * len(ids_to_delete))
            sql = f"DELETE FROM django_migrations WHERE id IN ({placeholders})"
            with connections[db].cursor() as cur:
                cur.execute(sql, ids_to_delete)
                self.stdout.write(
                    self.style.SUCCESS(f"  [{db}] 删除 {cur.rowcount} 条历史残留")
                )

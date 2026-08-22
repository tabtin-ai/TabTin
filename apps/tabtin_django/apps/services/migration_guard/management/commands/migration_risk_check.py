"""静态扫描新增/既有 migration 的高风险操作顺序。

不直接禁止合入，但默认以非零退出提醒；``--require-scenario-tests``
模式下，命中高风险规则时必须能在仓库里找到对应的
``PostgresMigrationScenarioTestCase`` 子类文件。
"""

from __future__ import annotations

import importlib
import re
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import migrations


class Command(BaseCommand):
    help = "扫描 migration 操作顺序中的高风险组合"

    def add_arguments(self, parser):
        parser.add_argument(
            "paths",
            nargs="*",
            help="migration 文件或目录；默认扫描 apps/tabtin_django 下全部 migrations/",
        )
        parser.add_argument(
            "--strict",
            action="store_true",
            help="命中任一高风险规则时 exit 1（默认也是；加 --warn-only 可降级）",
        )
        parser.add_argument(
            "--warn-only",
            action="store_true",
            help="只打印告警，不失败",
        )
        parser.add_argument(
            "--require-scenario-tests",
            action="store_true",
            help="命中高风险规则时，要求同 app 存在 *migration*_pg.py 场景测试",
        )

    def handle(self, *args, **options):
        roots = options["paths"] or ["apps"]
        files = self._collect_migration_files(roots)
        if not files:
            self.stdout.write("没有可扫描的 migration 文件")
            return

        findings: list[dict] = []
        for path in files:
            findings.extend(self._scan_file(path))

        if not findings:
            self.stdout.write(self.style.SUCCESS(f"扫描 {len(files)} 个 migration：无高风险命中"))
            return

        for item in findings:
            self.stdout.write(
                self.style.WARNING(
                    f"[risk:{item['rule']}] {item['path']} :: {item['message']}"
                )
            )

        if options["require_scenario_tests"]:
            missing = []
            for item in findings:
                if not self._has_scenario_test(item["path"]):
                    missing.append(item["path"])
            if missing:
                uniq = sorted(set(missing))
                msg = (
                    "以下高风险 migration 缺少 PostgreSQL 场景测试"
                    "（*migration*_pg.py / PostgresMigrationScenarioTestCase）：\n"
                    + "\n".join(f"  - {p}" for p in uniq)
                )
                if options["warn_only"]:
                    self.stdout.write(self.style.WARNING(msg))
                else:
                    raise CommandError(msg)
            else:
                self.stdout.write(
                    self.style.SUCCESS(
                        "高风险 migration 均有 PostgreSQL 场景测试覆盖"
                    )
                )
                return

        if options["warn_only"]:
            return
        # 默认（及 --strict）命中即失败，逼开发机先看见。
        raise CommandError(f"migration-risk-check 命中 {len(findings)} 条高风险规则")

    def _collect_migration_files(self, roots: list[str]) -> list[Path]:
        files: list[Path] = []
        for raw in roots:
            path = Path(raw)
            if not path.exists():
                # 相对 Django 工程根再试一次
                alt = Path.cwd() / raw
                path = alt if alt.exists() else path
            if path.is_file() and self._is_migration_file(path):
                files.append(path.resolve())
                continue
            if path.is_dir():
                for candidate in path.rglob("*.py"):
                    if self._is_migration_file(candidate):
                        files.append(candidate.resolve())
        return sorted(set(files))

    @staticmethod
    def _is_migration_file(path: Path) -> bool:
        if path.name == "__init__.py":
            return False
        parts = path.parts
        return "migrations" in parts and path.suffix == ".py"

    def _scan_file(self, path: Path) -> list[dict]:
        try:
            module = self._import_migration_module(path)
            migration_cls = getattr(module, "Migration", None)
            if migration_cls is None:
                return []
            operations = list(getattr(migration_cls, "operations", []) or [])
        except Exception as exc:  # noqa: BLE001
            return [
                {
                    "rule": "import_failed",
                    "path": str(path),
                    "message": f"无法 import migration：{exc}",
                }
            ]

        findings: list[dict] = []
        findings.extend(self._rule_null_write_before_nullable(path, operations))
        findings.extend(self._rule_not_null_before_backfill(path, operations))
        findings.extend(self._rule_type_change_without_cleanup(path, operations))
        findings.extend(self._rule_destructive_without_data_move(path, operations))
        findings.extend(
            self._rule_data_op_then_schema_ddl(path, migration_cls, operations)
        )
        return findings

    # PG deferred FK：同事务数据步后紧跟下列 DDL 易 pending trigger events。
    # 不含 AlterField：回填后收紧 null=False 是推荐分阶段模式，另有
    # not_null_without_prior_data_op 覆盖。已设 atomic=False 的旧迁移放行。
    _SCHEMA_DDL_AFTER_DATA = (
        migrations.AddIndex,
        migrations.AddConstraint,
        migrations.RemoveConstraint,
        migrations.RemoveIndex,
        migrations.AlterUniqueTogether,
        migrations.AlterIndexTogether,
        migrations.RemoveField,
    )

    def _import_migration_module(self, path: Path):
        """把 .../apps/<...>/migrations/00xx_foo.py 转成可 import 的模块路径。"""
        text = path.read_text(encoding="utf-8")
        # 优先走 Django app 模块路径
        parts = path.parts
        try:
            apps_idx = parts.index("apps")
            mod_parts = parts[apps_idx:]
            mod_name = ".".join(mod_parts)[:-3]  # strip .py
            return importlib.import_module(mod_name)
        except (ValueError, ImportError):
            # fallback：exec 模块（仅用于拿 Migration.operations）
            ns: dict = {"__file__": str(path)}
            exec(compile(text, str(path), "exec"), ns)  # noqa: S102
            return type("M", (), ns)

    def _rule_null_write_before_nullable(self, path: Path, operations: list) -> list[dict]:
        """#3832 模式：RunSQL 写入 NULL 早于把字段改成 nullable。"""
        findings = []
        nullable_indexes: dict[str, int] = {}
        for index, op in enumerate(operations):
            if isinstance(op, migrations.AlterField) and getattr(op.field, "null", False):
                key = f"{op.model_name}.{op.name}".lower()
                nullable_indexes.setdefault(key, index)

        for index, op in enumerate(operations):
            if not isinstance(op, migrations.RunSQL):
                continue
            sql = op.sql if isinstance(op.sql, str) else ""
            if not sql or "NULL" not in sql.upper():
                continue
            assigned = self._columns_assigned_null(sql)
            if not assigned:
                # 泛化：有 UPDATE ... NULL 但解析不出列名时，仍告警若后面才出现 nullable AlterField
                later_nullable = [
                    (key, idx) for key, idx in nullable_indexes.items() if idx > index
                ]
                if later_nullable:
                    findings.append(
                        {
                            "rule": "null_write_before_nullable",
                            "path": str(path),
                            "message": (
                                f"operations[{index}] RunSQL 含 NULL 写入，但 nullable "
                                f"AlterField 在更后面（{[k for k,_ in later_nullable[:3]]}）。"
                                "应先 AlterField(null=True) 再清理。"
                            ),
                        }
                    )
                continue
            for column in assigned:
                matches = [
                    (key, idx)
                    for key, idx in nullable_indexes.items()
                    if key.endswith(f".{column}") and idx > index
                ]
                if matches:
                    findings.append(
                        {
                            "rule": "null_write_before_nullable",
                            "path": str(path),
                            "message": (
                                f"operations[{index}] 对 `{column}` 写入 NULL，"
                                f"但 nullable AlterField 在 index={matches[0][1]}。"
                                "应先解除 NOT NULL。"
                            ),
                        }
                    )
        return findings

    def _rule_not_null_before_backfill(self, path: Path, operations: list) -> list[dict]:
        findings = []
        for index, op in enumerate(operations):
            if not isinstance(op, migrations.AlterField):
                continue
            field = op.field
            if getattr(field, "null", True):
                continue
            # 新增 NOT NULL / 收紧 null=False，前面应有数据回填
            prior = operations[:index]
            has_data_op = any(
                isinstance(prev, (migrations.RunSQL, migrations.RunPython))
                for prev in prior
            )
            if not has_data_op and index > 0:
                findings.append(
                    {
                        "rule": "not_null_without_prior_data_op",
                        "path": str(path),
                        "message": (
                            f"operations[{index}] AlterField `{op.model_name}.{op.name}` "
                            "为 NOT NULL，且前面没有 RunSQL/RunPython 回填。"
                        ),
                    }
                )
        return findings

    def _rule_type_change_without_cleanup(self, path: Path, operations: list) -> list[dict]:
        findings = []
        for index, op in enumerate(operations):
            if not isinstance(op, migrations.AlterField):
                continue
            field = op.field
            # varchar→UUID / FK 化常见风险
            field_type = type(field).__name__
            if field_type not in {"UUIDField", "ForeignKey", "OneToOneField"}:
                continue
            prior = operations[:index]
            has_cleanup = any(
                isinstance(prev, (migrations.RunSQL, migrations.RunPython))
                for prev in prior
            )
            if not has_cleanup:
                findings.append(
                    {
                        "rule": "type_change_without_cleanup",
                        "path": str(path),
                        "message": (
                            f"operations[{index}] `{op.model_name}.{op.name}` 改为 "
                            f"{field_type}，前面没有清理非法值的 RunSQL/RunPython。"
                        ),
                    }
                )
        return findings

    def _rule_destructive_without_data_move(self, path: Path, operations: list) -> list[dict]:
        findings = []
        for index, op in enumerate(operations):
            if not isinstance(op, (migrations.RemoveField, migrations.DeleteModel)):
                continue
            prior = operations[:index]
            has_move = any(
                isinstance(prev, (migrations.RunSQL, migrations.RunPython))
                for prev in prior
            )
            if not has_move:
                label = (
                    f"RemoveField {op.model_name}.{op.name}"
                    if isinstance(op, migrations.RemoveField)
                    else f"DeleteModel {op.name}"
                )
                findings.append(
                    {
                        "rule": "destructive_without_data_move",
                        "path": str(path),
                        "message": (
                            f"operations[{index}] {label} 前没有数据迁移 RunSQL/RunPython。"
                        ),
                    }
                )
        return findings

    def _rule_data_op_then_schema_ddl(
        self, path: Path, migration_cls: type, operations: list
    ) -> list[dict]:
        """#6333：同 migration 内数据步与会推迟刷出的 schema DDL 混排。

        两类都会在默认 atomic 下撞 PG pending trigger events：
        1. RunPython/RunSQL 之后还有 AddIndex/AddConstraint/RemoveField 等；
        2. AddField（尤其 ForeignKey，索引进 deferred_sql）之后还有 RunPython——
           Django 在 schema_editor.__exit__ 才 CREATE INDEX，晚于回填 UPDATE。

        已设 ``atomic = False`` 的历史迁移放行；新代码应拆文件。
        """
        if getattr(migration_cls, "atomic", True) is False:
            return []

        findings: list[dict] = []

        add_field_indexes = [
            index
            for index, op in enumerate(operations)
            if isinstance(op, migrations.AddField)
        ]
        data_indexes = [
            index
            for index, op in enumerate(operations)
            if isinstance(op, (migrations.RunPython, migrations.RunSQL))
        ]

        if add_field_indexes and data_indexes:
            first_add = add_field_indexes[0]
            first_data_after_add = next(
                (i for i in data_indexes if i > first_add), None
            )
            if first_data_after_add is not None:
                findings.append(
                    {
                        "rule": "data_op_then_schema_ddl",
                        "path": str(path),
                        "message": (
                            f"operations[{first_add}] AddField 之后还有 "
                            f"operations[{first_data_after_add}] RunPython/RunSQL。"
                            "ForeignKey AddField 的 CREATE INDEX 在 schema_editor.__exit__ "
                            "才执行，会晚于回填并撞 pending trigger events。"
                            "应拆成：①只 AddField ②只回填 ③显式复合索引/DDL。"
                        ),
                    }
                )

        if data_indexes:
            first_data = data_indexes[0]
            for index, op in enumerate(operations):
                if index <= first_data:
                    continue
                if not isinstance(op, self._SCHEMA_DDL_AFTER_DATA):
                    continue
                findings.append(
                    {
                        "rule": "data_op_then_schema_ddl",
                        "path": str(path),
                        "message": (
                            f"operations[{first_data}] RunPython/RunSQL 之后还有 "
                            f"operations[{index}] {type(op).__name__}。"
                            "PostgreSQL 上同事务易报 pending trigger events。"
                            "应拆成：前一份只回填，后一份只做索引/DDL；"
                            "仅当该迁移已 apply 无法改写时才用 atomic=False。"
                        ),
                    }
                )
                break

        return findings

    @staticmethod
    def _columns_assigned_null(sql: str) -> set[str]:
        found = set()
        for match in re.finditer(
            r"SET\s+([a-zA-Z_][\w]*)\s*=\s*NULL",
            sql,
            flags=re.IGNORECASE,
        ):
            found.add(match.group(1).lower())
        return found

    @staticmethod
    def _has_scenario_test(migration_path: str) -> bool:
        path = Path(migration_path)
        # .../app/migrations/0039_foo.py → 在邻近 tests/ 找 *_pg.py 且源码含 PostgresMigrationScenarioTestCase
        app_root = path.parents[1]  # migrations/ -> app
        tests_dirs = [app_root / "tests", app_root / "test"]
        needle = "PostgresMigrationScenarioTestCase"
        migration_stem = path.stem  # 0039_organization_fk_convergence_3832
        number = migration_stem.split("_", 1)[0]
        for tests_dir in tests_dirs:
            if not tests_dir.is_dir():
                continue
            for candidate in tests_dir.rglob("*migration*_pg.py"):
                text = candidate.read_text(encoding="utf-8")
                if needle not in text:
                    continue
                if number in candidate.name or migration_stem in text or number in text:
                    return True
            # 宽松：同 app 任意场景测试基类也算覆盖（多 migration 共用一个文件）
            for candidate in tests_dir.rglob("*_pg.py"):
                text = candidate.read_text(encoding="utf-8")
                if needle in text and (number in text or path.stem in text):
                    return True
        return False

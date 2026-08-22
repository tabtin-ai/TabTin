"""扫描所有跨库软引用，找出指向已删除 target 的悬空 ID + 按声明动作清理。

== 为什么需要 ==

cascade signal 在 ``transaction.on_commit`` 钩子里跑，**异常仅 warning 不 raise**
（不该阻塞已 COMMIT 的 target 删除）。理论上极少失败，但实际场景：

- 对端库瞬时不通 → on_commit 异常吞掉 → holder 留悬空 ID
- holder 模型还没 import → ``apps.get_model`` 抛 ``LookupError`` → 吞掉
- DB connection 挂 → 整段 cascade 没跑 → 全局悬空

孤儿 ID 不影响 holder 表本身工作（业务侧描述符 fallback fetch 返回 None），
但长期沉淀会让审计 / 报表偏差。本命令是兜底机制。

== 设计 ==

基于 ``SoftRefRegistry`` 自动遍历——不需要每加一个 softref 就改命令。

工作流：

1. 列举：``SoftRefRegistry.all_specs()`` 拿全表
2. 过滤：``--holder=app.Model`` / ``--id-attr=foo_id`` 限定单条 spec
3. 扫描每条 spec：
   a. 在 holder 库拿所有 distinct id_attr 值（exclude NULL）
   b. 在 target 库拿存在的 id 集合
   c. 差集 = 悬空 ID 列表
4. 报告 / 修复（按 ``--fix``）：
   - ``set_null``：``UPDATE holder SET id_attr=NULL WHERE id_attr IN (...)``
   - ``soft_delete``：``UPDATE holder SET is_deleted=True WHERE id_attr IN (...)``
   - ``cascade``：``DELETE FROM holder WHERE id_attr IN (...)``
   - ``report_only``：仅打印（无副作用 cascade，不能/不该自动清）

== 用法 ==

::

    # 全量 dry-run（默认）
    python manage.py reconcile_softrefs

    # 单条 spec 全量 dry-run
    python manage.py reconcile_softrefs --holder=tabdata.AttachmentUpload --id-attr=upload_task_id

    # 全量实际修复
    python manage.py reconcile_softrefs --fix

    # JSON 输出（接 monitoring）
    python manage.py reconcile_softrefs --json

== 安全 ==

- 默认 ``--dry-run``——只查不改
- ``--fix`` 必须显式开启
- ``report_only`` action 永远只报告（防误清未注册 cascade 的 softref）
- 单批最多删 ``--batch-size`` 条（默认 1000），避免长事务
- 每批 commit 后 ``logger.info`` 进度，可中断恢复

未来接 Celery beat 周期跑前必须先**人工 dry-run 两周**确认悬空规模
合理（参照 v0.1 §5.1 收尾决策）。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from django.apps import apps as django_apps
from django.core.management.base import BaseCommand, CommandError
from django.db import router as db_router
from django.utils import timezone

from apps.services.common.cross_db_softref import SoftRefRegistry, SoftRefSpec


logger = logging.getLogger(__name__)


@dataclass
class ReconcileResult:
    spec_key: str           # "tabdata.AttachmentUpload.upload_task_id"
    target_model: str
    on_orphan_action: str
    total_referenced: int   # holder 表里 id_attr NOT NULL 的 distinct 总数
    target_existing: int    # target 库实际存在的数量
    orphan_count: int       # 悬空 ID 数量
    orphan_sample: list[str]
    fixed: int = 0          # 实际清理的 holder 行数
    skipped_reason: str | None = None  # 为什么没修复（report_only / dry_run / 其他）


class Command(BaseCommand):
    help = (
        "扫描所有 SoftRefRegistry 注册的跨库软引用，找出悬空 ID 并按声明动作清理。"
        " 默认 dry-run；--fix 才实际修复。"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--holder",
            help="限定 holder 模型（格式 ``app_label.ModelName``，如 ``tabdata.AttachmentUpload``）",
        )
        parser.add_argument(
            "--id-attr",
            dest="id_attr",
            help="限定 id_attr 字段名（须配合 --holder 一起用）",
        )
        parser.add_argument(
            "--fix",
            action="store_true",
            help="实际执行清理（默认 dry-run，只报告不改）",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=1000,
            help="单批清理最多记录数，避免长事务（默认 1000）",
        )
        parser.add_argument(
            "--json",
            dest="as_json",
            action="store_true",
            help="结果输出 JSON 而非人读文本（接 monitoring / CI）",
        )

    def handle(
        self,
        *args,
        holder: str | None = None,
        id_attr: str | None = None,
        fix: bool = False,
        batch_size: int = 1000,
        as_json: bool = False,
        **opts,
    ):
        specs = SoftRefRegistry.all_specs()
        if not specs:
            self.stderr.write(
                "SoftRefRegistry 为空——确认 model 已 import（描述符通过 "
                "class_prepared signal 注册，需要至少一次 model class 创建）。"
            )
            return

        if holder:
            if "." not in holder:
                raise CommandError(
                    "--holder 格式必须是 'app_label.ModelName'，如 "
                    "'tabdata.AttachmentUpload'"
                )
            holder_app, holder_model = holder.split(".", 1)
            specs = [
                s for s in specs
                if s.holder_app == holder_app and s.holder_model == holder_model
            ]
            if id_attr:
                specs = [s for s in specs if s.id_attr == id_attr]
            if not specs:
                raise CommandError(
                    f"找不到匹配的 softref：holder={holder!r} id_attr={id_attr!r}"
                )

        results: list[ReconcileResult] = []
        for spec in specs:
            try:
                results.append(
                    self._reconcile_one(spec, fix=fix, batch_size=batch_size)
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("[reconcile_softrefs] failed on spec %s", spec.key)
                results.append(ReconcileResult(
                    spec_key=f"{spec.holder_app}.{spec.holder_model}.{spec.id_attr}",
                    target_model=spec.target_model,
                    on_orphan_action=spec.on_orphan_action,
                    total_referenced=-1,
                    target_existing=-1,
                    orphan_count=-1,
                    orphan_sample=[],
                    skipped_reason=f"exception: {exc!r}",
                ))

        if as_json:
            self.stdout.write(json.dumps(
                [r.__dict__ for r in results],
                indent=2, default=str, ensure_ascii=False,
            ))
        else:
            self._print_human(results, fix=fix)

    # ────────────────────────────────────────────────────────────────────
    #  Per-spec reconcile
    # ────────────────────────────────────────────────────────────────────

    def _reconcile_one(
        self, spec: SoftRefSpec, *, fix: bool, batch_size: int,
    ) -> ReconcileResult:
        spec_key = f"{spec.holder_app}.{spec.holder_model}.{spec.id_attr}"

        holder_cls = django_apps.get_model(spec.holder_app, spec.holder_model)
        target_cls = self._resolve_target(spec.target_model)
        holder_db = db_router.db_for_read(holder_cls) or "default"
        target_db = db_router.db_for_read(target_cls) or "default"

        # 1) 拿所有 holder 引用的 distinct id 值
        base_qs = holder_cls.objects.using(holder_db).exclude(**{spec.id_attr: None})
        # 软删过滤：如果 holder 有 is_deleted 字段且 spec 是 soft_delete cascade，
        # 跳过已软删的（不重复软删）
        if spec.on_orphan_action == "soft_delete":
            extra_filter = dict(spec.soft_delete_extra_filter or ())
            if extra_filter:
                base_qs = base_qs.filter(**extra_filter)

        ref_ids_raw = base_qs.values_list(spec.id_attr, flat=True).distinct()
        ref_id_strs = {str(i) for i in ref_ids_raw if i is not None}

        if not ref_id_strs:
            return ReconcileResult(
                spec_key=spec_key,
                target_model=spec.target_model,
                on_orphan_action=spec.on_orphan_action,
                total_referenced=0,
                target_existing=0,
                orphan_count=0,
                orphan_sample=[],
                skipped_reason="no_references",
            )

        # 2) 在 target 库验证哪些 id 仍存在
        existing_ids = set(
            str(i) for i in target_cls.objects.using(target_db)
            .filter(id__in=ref_id_strs).values_list("id", flat=True)
        )
        orphan_ids = sorted(ref_id_strs - existing_ids)

        result = ReconcileResult(
            spec_key=spec_key,
            target_model=spec.target_model,
            on_orphan_action=spec.on_orphan_action,
            total_referenced=len(ref_id_strs),
            target_existing=len(existing_ids),
            orphan_count=len(orphan_ids),
            orphan_sample=orphan_ids[:10],
        )

        if not orphan_ids:
            return result

        if not fix:
            result.skipped_reason = "dry_run"
            return result

        if spec.on_orphan_action == "report_only":
            result.skipped_reason = (
                "report_only —— softref 没注册 cascade signal，不能自动清理；"
                "需手动判断 holder 数据如何处理"
            )
            return result

        # 3) 实际修复（按 action 分支，分批处理）
        result.fixed = self._apply_fix(
            spec=spec,
            holder_cls=holder_cls,
            holder_db=holder_db,
            orphan_ids=orphan_ids,
            batch_size=batch_size,
        )
        return result

    def _apply_fix(
        self, *,
        spec: SoftRefSpec,
        holder_cls,
        holder_db: str,
        orphan_ids: list[str],
        batch_size: int,
    ) -> int:
        """按 action 分批修复，返回总影响行数（按 holder 行计）。"""
        total_fixed = 0
        action = spec.on_orphan_action

        for i in range(0, len(orphan_ids), batch_size):
            batch = orphan_ids[i : i + batch_size]
            qs = holder_cls.objects.using(holder_db).filter(
                **{f"{spec.id_attr}__in": batch}
            )

            if action == "set_null":
                affected = qs.update(**{spec.id_attr: None})
            elif action == "soft_delete":
                set_fields = dict(spec.soft_delete_set_fields or ())
                if not set_fields:
                    set_fields = {"is_deleted": True, "deleted_at": timezone.now}
                resolved = {
                    k: (v() if callable(v) else v) for k, v in set_fields.items()
                }
                affected = qs.update(**resolved)
            elif action == "cascade":
                affected, _ = qs.delete()
            else:
                # 其他 action 不应该走到这里——_reconcile_one 已经过滤
                affected = 0

            total_fixed += affected
            logger.info(
                "[reconcile_softrefs] %s action=%s batch=%d/%d affected=%d",
                spec.key, action,
                i // batch_size + 1,
                (len(orphan_ids) + batch_size - 1) // batch_size,
                affected,
            )

        return total_fixed

    @staticmethod
    def _resolve_target(target_model: str):
        if "." not in target_model:
            raise CommandError(
                f"spec.target_model 格式错误：{target_model!r}（应为 'app.Model'）"
            )
        app_label, model_name = target_model.split(".", 1)
        return django_apps.get_model(app_label, model_name)

    # ────────────────────────────────────────────────────────────────────
    #  Output
    # ────────────────────────────────────────────────────────────────────

    def _print_human(self, results: list[ReconcileResult], *, fix: bool) -> None:
        mode = "FIX" if fix else "DRY-RUN"
        self.stdout.write(self.style.SUCCESS(
            f"\n=== reconcile_softrefs ({mode}) ===\n"
        ))

        total_orphan = 0
        total_fixed = 0
        any_problem = False

        for r in results:
            head = (
                f"• {r.spec_key} → {r.target_model} "
                f"[action={r.on_orphan_action}]"
            )
            self.stdout.write(head)

            if r.total_referenced < 0:
                self.stdout.write(self.style.ERROR(f"    ✗ {r.skipped_reason}"))
                any_problem = True
                continue

            line = (
                f"    referenced={r.total_referenced} "
                f"existing={r.target_existing} "
                f"orphan={r.orphan_count}"
            )
            if r.orphan_count > 0:
                self.stdout.write(self.style.WARNING(line))
                total_orphan += r.orphan_count
                if r.orphan_sample:
                    self.stdout.write(
                        f"    sample: {', '.join(r.orphan_sample[:5])}"
                        + ("..." if r.orphan_count > 5 else "")
                    )
                if r.fixed:
                    self.stdout.write(self.style.SUCCESS(
                        f"    ✓ fixed {r.fixed} holder row(s)"
                    ))
                    total_fixed += r.fixed
                elif r.skipped_reason:
                    self.stdout.write(f"    skipped: {r.skipped_reason}")
                any_problem = True
            else:
                self.stdout.write(self.style.SUCCESS(line + " ✓"))

        summary = (
            f"\nSummary: {len(results)} spec(s) checked / "
            f"{total_orphan} orphan ID(s) total / {total_fixed} fixed"
        )
        if not any_problem:
            self.stdout.write(self.style.SUCCESS(summary + " ✓ all clean"))
        else:
            self.stdout.write(self.style.WARNING(summary))
            if not fix and total_orphan:
                self.stdout.write(
                    "\nRun with --fix to actually clean up "
                    "(report_only specs always skipped)."
                )

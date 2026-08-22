"""
清理 django_celery_beat.PeriodicTask 中的 orchestration 历史遗留记录。

【历史背景】
- Wave 9（2026-04）将 orchestration 下的 Celery task 模块全部搬迁到
  `apps/services/agent_engine/`
- Wave 11（2026-04-17）**彻底删除** `apps.orchestration` Django app 及其目录
- Wave 12（2026-04-17）将历史上以 `orchestration-*` 命名的 schedule key
  归一为无前缀风格（与 agent_engine 下其他 15 条 schedule key 一致）。
  代码层当前仅涉及 `orchestration-check-monitor-heartbeats` →
  `check-monitor-heartbeats` 这 1 条；过渡阶段曾短暂使用 `agent-engine-*`
  前缀，现已一并作为 legacy 处理（见 `apps/maintenance/legacy_schedules.py`
  的 `LEGACY_SCHEDULE_KEY_PREFIXES`）。

【为什么仍需保留本命令】
项目启用了 DatabaseScheduler
（`CELERY_BEAT_SCHEDULER = 'django_celery_beat.schedulers:DatabaseScheduler'`），
历史部署可能把旧路径或旧 schedule key 写入了 `django_celery_beat_periodictask`
表。Wave 11/12 后这些 DB 记录仍会存在：
  - 旧 task 路径（如 `apps.orchestration.middleware.trace.flush_pending_trace_publishes`）
    会因模块找不到而运行失败。
  - 旧 schedule key（如 `orchestration-check-monitor-heartbeats`）在代码中
    不再出现，`setup_periodic_tasks` 不会更新它，但 Beat 仍会按旧配置调度，
    造成同一任务被新旧两个 key 重复调度。
本命令刻意保留 `orchestration` 一词，因为它处理的就是"orchestration 遗留产物"
这一历史问题。

本命令提供两组互不干扰的检查：
  1. **task 路径** 以 `apps.orchestration.` 开头（Wave 11 修复对象）
     - `--fix`：替换为 `apps.services.agent_engine.`
     - `--disable`：仅置 `enabled=False`
  2. **schedule key (name 字段)** 以 `orchestration-` 开头（Wave 12 修复对象）
     - `--purge-legacy-keys`：先列出，配合 `--confirm` 后真正删除

注意：
    - 仅匹配完整模块路径前缀 `apps.orchestration.` 与完整 key 前缀
      `orchestration-`。`@shared_task(name="orchestration.xxx")` 这类
      显式任务名（如 `orchestration.sweep_stale_runs`）是产品级标识符，
      不会被误伤（它们进入的是 PeriodicTask.task 字段，且包含点号，
      不会被 `orchestration-` 前缀匹配）。
    - `setup_periodic_tasks` 在 Worker 启动时对当前代码中定义的
      schedule 做 update_or_create（按 name 匹配）。name 不再出现的
      旧记录会残留，这正是本命令需要处理的对象。

用法:
    python manage.py check_orchestration_beat_tasks
        仅报告两类记录
    python manage.py check_orchestration_beat_tasks --fix
        替换旧 task 路径为新路径
    python manage.py check_orchestration_beat_tasks --disable
        仅禁用旧 task 路径记录
    python manage.py check_orchestration_beat_tasks --purge-legacy-keys
        列出 orchestration-* 开头的 schedule key 记录（只读）
    python manage.py check_orchestration_beat_tasks --purge-legacy-keys --confirm
        真正删除这些 schedule key 记录
    python manage.py check_orchestration_beat_tasks --strict
        两类记录任一存在则退出码 1（CI 用）
"""

from __future__ import annotations

import logging

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.maintenance.legacy_schedules import (
    LEGACY_SCHEDULE_KEY_PREFIXES,
    TASK_PATH_MIGRATIONS,
    resolve_new_task_path,
)

audit_logger = logging.getLogger("apps.maintenance.beat_legacy_cleanup")

# 单一前缀来源：W11 task 路径迁移目前仅一对。W12 schedule key 前缀有两条
# （`orchestration-` 与过渡态的 `agent-engine-`），遍历 LEGACY_SCHEDULE_KEY_PREFIXES
# 以确保与 celery.py 的 `_soft_disable_legacy_duplicates` 覆盖面完全一致。
# 未来新增时只在 apps.maintenance.legacy_schedules 追加，本命令自动同步。
TASK_PATH_OLD_PREFIX, TASK_PATH_NEW_PREFIX = next(iter(TASK_PATH_MIGRATIONS.items()))


def _legacy_schedule_key_filter():
    """构造覆盖所有 legacy schedule key 前缀的 ORM Q 对象。"""
    from functools import reduce
    from operator import or_ as _or

    from django.db.models import Q

    return reduce(
        _or,
        (Q(name__startswith=p) for p in LEGACY_SCHEDULE_KEY_PREFIXES),
    )


def _legacy_schedule_key_examples() -> str:
    """前缀展示，给 help/报告文本使用。"""
    return " / ".join(f"'{p}*'" for p in LEGACY_SCHEDULE_KEY_PREFIXES)


class Command(BaseCommand):
    help = (
        "清理 django_celery_beat.PeriodicTask 的两类 orchestration 历史遗留：\n"
        "  [类1] task 字段 'apps.orchestration.*'  →  用 --fix 或 --disable\n"
        "  [类2] name  字段 'orchestration-*'      →  用 --purge-legacy-keys [--confirm]\n"
        "两类互不干扰，可单独或组合执行；--strict 用于 CI / 部署前 gate。\n"
        "不带参即只读报告（默认干运行）。"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--fix",
            action="store_true",
            help="[类1] 将 task 字段从 'apps.orchestration.' 替换为 "
                 "'apps.services.agent_engine.'（事务原子提交）",
        )
        parser.add_argument(
            "--disable",
            action="store_true",
            help="[类1] 仅将匹配到的 task 路径记录置 enabled=False（保守选项，不改路径）",
        )
        parser.add_argument(
            "--purge-legacy-keys",
            action="store_true",
            help="[类2][默认 dry-run] 列出 name 以 'orchestration-' 开头的 schedule "
                 "key 记录；加 --confirm 才真正 DELETE。"
                 "⚠ 注意：匹配条件仅为 name__startswith='orchestration-'，"
                 "任何自定义/调试用的 PeriodicTask 若命名以此前缀开头也会被一并删除，"
                 "勿在生产库将该前缀用于非迁移用途",
        )
        parser.add_argument(
            "--confirm",
            action="store_true",
            help="配合 --purge-legacy-keys 使用，确认执行删除操作",
        )
        parser.add_argument(
            "--strict",
            action="store_true",
            help="两类记录任一存在则退出码 1（用于 CI / 部署前检查）",
        )

    def handle(self, *args, **options):
        if options["fix"] and options["disable"]:
            self.stderr.write(
                self.style.ERROR("--fix 与 --disable 互斥，请只指定一个。")
            )
            raise SystemExit(2)

        if options["confirm"] and not options["purge_legacy_keys"]:
            self.stderr.write(
                self.style.ERROR("--confirm 必须配合 --purge-legacy-keys 使用。")
            )
            raise SystemExit(2)

        try:
            from django_celery_beat.models import PeriodicTask
        except ImportError:
            self.stdout.write(
                self.style.WARNING(
                    "django_celery_beat 未安装，跳过检查（环境可能是纯测试 settings）。"
                )
            )
            return

        legacy_path_tasks, legacy_key_tasks = self._query_legacy(PeriodicTask)

        self._report_legacy_path_tasks(legacy_path_tasks)

        if options["fix"]:
            self._apply_fix(legacy_path_tasks)
        elif options["disable"]:
            self._apply_disable(legacy_path_tasks)

        self._report_legacy_key_tasks(legacy_key_tasks)

        if options["purge_legacy_keys"]:
            self._apply_purge_legacy_keys(legacy_key_tasks, options["confirm"])

        if options["strict"]:
            # 修复类操作（--fix/--disable/--purge-legacy-keys --confirm）可能已清理 DB；
            # 重新查询最终状态，只在仍有**活跃**残留时返回非零（--disable 后 enabled=False
            # 的记录不会被 Beat 调度，视为已清理，不阻断 gate）。
            # 这样 CI 可以用 `--fix --strict` / `--disable --strict` /
            # `--purge-legacy-keys --confirm --strict` 做"修复并 gate"的单步操作。
            final_path_tasks, final_key_tasks = self._query_legacy(
                PeriodicTask, active_only=True,
            )
            if final_path_tasks or final_key_tasks:
                self.stdout.write("")
                self.stdout.write(
                    self.style.ERROR(
                        f"--strict 判定失败：仍存在 "
                        f"{len(final_path_tasks)} 条旧 task 路径 + "
                        f"{len(final_key_tasks)} 条旧 schedule key 记录。"
                    )
                )
                # CI 场景下新人开发常因缺背景不知道下一步跑什么；把对应修复命令直接打出来
                self.stdout.write("")
                self.stdout.write(self.style.MIGRATE_HEADING("  修复建议："))
                if final_path_tasks:
                    self.stdout.write(
                        "    - 迁移旧 task 路径："
                        "python manage.py check_orchestration_beat_tasks --fix --strict"
                    )
                    self.stdout.write(
                        "      （或保守禁用："
                        "python manage.py check_orchestration_beat_tasks --disable --strict）"
                    )
                if final_key_tasks:
                    self.stdout.write(
                        "    - 删除旧 schedule key："
                        "python manage.py check_orchestration_beat_tasks "
                        "--purge-legacy-keys --confirm --strict"
                    )
                raise SystemExit(1)

    def _query_legacy(self, PeriodicTask, *, active_only: bool = False):
        """查询两类 legacy 记录。

        active_only=True 时仅返回 enabled=True 记录，供 --strict 最终判定使用：
        --disable 操作已把记录置 enabled=False，这些记录不会被 Beat 调度，
        视为已清理，不应再阻断 strict gate。
        """
        from django.db import DatabaseError, ProgrammingError

        try:
            path_qs = PeriodicTask.objects.filter(task__startswith=TASK_PATH_OLD_PREFIX)
            key_qs = PeriodicTask.objects.filter(_legacy_schedule_key_filter())
            if active_only:
                path_qs = path_qs.filter(enabled=True)
                key_qs = key_qs.filter(enabled=True)
            legacy_path_tasks = list(path_qs.order_by("id"))
            legacy_key_tasks = list(key_qs.order_by("id"))
        except (DatabaseError, ProgrammingError) as exc:
            self.stderr.write(
                self.style.ERROR(
                    f"查询 PeriodicTask 失败（DB 可能未 migrate 或未配置）: "
                    f"{type(exc).__name__}: {exc}"
                )
            )
            raise SystemExit(2) from exc
        return legacy_path_tasks, legacy_key_tasks

    def _report_legacy_group(
        self,
        *,
        section: str,
        heading: str,
        empty_msg: str,
        found_msg: str,
        hint: str,
        tasks,
    ):
        """统一的遗留记录报告输出（路径类/key 类共用）。

        参数：
            section: 分节标号（如 "[1/2]"），None 表示不写空行分隔
            heading: 段落标题（MIGRATE_HEADING 样式）
            empty_msg: 无记录时的成功提示
            found_msg: 发现记录时的警告头（含 %d 占位待格式化）
            hint: 结尾的操作提示（NOTICE 样式）
            tasks: 匹配到的 PeriodicTask 列表
        """
        count = len(tasks)
        if section != "[1/2]":
            self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING(f"{section} {heading}"))
        if count == 0:
            self.stdout.write(self.style.SUCCESS(f"  ✓ {empty_msg}"))
            return
        self.stdout.write(self.style.WARNING(f"  {found_msg % count}"))
        for task in tasks:
            flag = "enabled" if task.enabled else "disabled"
            self.stdout.write(
                f"    - [{task.id}] name='{task.name}' task='{task.task}' ({flag})"
            )
        self.stdout.write(self.style.NOTICE(f"  {hint}"))

    def _report_legacy_path_tasks(self, tasks):
        self._report_legacy_group(
            section="[1/2]",
            heading=f"检查 task 字段以 '{TASK_PATH_OLD_PREFIX}' 开头的记录",
            empty_msg=f"没有发现 {TASK_PATH_OLD_PREFIX}* 开头的 PeriodicTask 记录。",
            found_msg=f"发现 %d 条 task 字段以 '{TASK_PATH_OLD_PREFIX}' 开头的记录：",
            hint="提示：使用 --fix 替换为新路径，或 --disable 仅禁用。",
            tasks=tasks,
        )

    def _report_legacy_key_tasks(self, tasks):
        prefixes_display = _legacy_schedule_key_examples()
        self._report_legacy_group(
            section="[2/2]",
            heading=f"检查 name 字段以 {prefixes_display} 开头的记录",
            empty_msg=f"没有发现 {prefixes_display} 开头的 schedule key 记录。",
            found_msg=(
                f"发现 %d 条 schedule key 以 {prefixes_display} 开头的记录："
            ),
            hint="提示：使用 --purge-legacy-keys 列出，再加 --confirm 执行删除。",
            tasks=tasks,
        )

    def _apply_fix(self, old_tasks):
        if not old_tasks:
            return
        self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING("执行 --fix，更新 task 字段："))
        updated = 0
        # 批量 rename 必须原子提交：要么全部完成，要么全部回滚。
        # 若中途异常导致部分记录已改而部分未改，django_celery_beat 的
        # DatabaseScheduler 会同时调度新/旧路径，触发重复执行与模块找不到错误。
        # 进入本分支的 old_tasks 已被 _query_legacy 按 TASK_PATH_MIGRATIONS 所有旧前缀过滤，
        # resolve_new_task_path 命中必返回新路径；若返回 None 说明查询条件与迁移表错位，
        # 抛 RuntimeError 触发事务回滚。
        try:
            with transaction.atomic():
                for task in old_tasks:
                    new_task = resolve_new_task_path(task.task)
                    if new_task is None:
                        raise RuntimeError(
                            f"记录 id={task.id} task='{task.task}' 未匹配任何 "
                            f"TASK_PATH_MIGRATIONS 前缀，疑似查询条件与迁移表错位"
                        )
                    task.task = new_task
                    task.save(update_fields=["task"])
                    updated += 1
                    self.stdout.write(
                        self.style.SUCCESS(
                            f"  ✓ [{task.id}] {task.name} → {new_task}"
                        )
                    )
        except Exception as exc:
            self.stderr.write(
                self.style.ERROR(
                    f"  ✗ --fix 执行失败已回滚：{type(exc).__name__}: {exc}"
                )
            )
            raise
        self.stdout.write(
            self.style.SUCCESS(f"  已更新 {updated}/{len(old_tasks)} 条记录。")
        )

    def _apply_disable(self, old_tasks):
        if not old_tasks:
            return
        self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING("执行 --disable，禁用记录："))
        ids = [t.id for t in old_tasks]
        from django_celery_beat.models import PeriodicTask

        updated = PeriodicTask.objects.filter(id__in=ids).update(enabled=False)
        self.stdout.write(self.style.SUCCESS(f"  ✓ 已将 {updated} 条记录 enabled=False"))

    def _apply_purge_legacy_keys(self, legacy_key_tasks, confirm: bool):
        if not legacy_key_tasks:
            return
        self.stdout.write("")
        self.stdout.write(
            self.style.MIGRATE_HEADING("执行 --purge-legacy-keys：")
        )
        if not confirm:
            # 醒目横幅防止 SRE 疲劳 debug 时粘贴命令看错模式
            self.stdout.write(self.style.WARNING(
                "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            ))
            self.stdout.write(self.style.WARNING(
                "   DRY RUN  —  未指定 --confirm，不会修改数据库"
            ))
            self.stdout.write(self.style.WARNING(
                "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            ))
            self.stdout.write(
                self.style.WARNING(
                    f"  ⚠ 确认前请核对：--confirm 后会删除**所有** {len(legacy_key_tasks)} 条 "
                    f"name 以 {_legacy_schedule_key_examples()} 开头的 PeriodicTask，"
                    f"包括任何自定义/调试用途的记录。"
                )
            )
            self.stdout.write(
                self.style.NOTICE(
                    "  建议先把当前列表导出作为回滚依据："
                )
            )
            self.stdout.write(
                "    python manage.py check_orchestration_beat_tasks "
                "--purge-legacy-keys > /tmp/legacy-beat-backup-$(date +%Y%m%d-%H%M%S).txt"
            )
            self.stdout.write(
                self.style.NOTICE(
                    "  加 --confirm 后将执行删除。级联行为说明：django_celery_beat 的 "
                    "PeriodicTask.interval/crontab 外键定义在 PeriodicTask 侧且使用 "
                    "on_delete=CASCADE（语义为'Interval/Crontab 被删时级联删 PeriodicTask'）。"
                    "反方向（删 PeriodicTask）**不会**触及 Interval/Crontab 表，对应的 "
                    "Interval/Crontab 行保留（通常被其他 PeriodicTask 复用，如被 _sync_schedule_to_db 复用）。"
                )
            )
            return

        ids = [t.id for t in legacy_key_tasks]
        from django_celery_beat.models import PeriodicTask

        # 审计日志：删除前按 (id, name, task, enabled) 记录每一条，
        # 便于事后追溯"谁在什么时候删了什么"。日志 logger name 固定为
        # `apps.maintenance.beat_legacy_cleanup`，与 Django LOGGING 标准链路一致。
        for t in legacy_key_tasks:
            audit_logger.info(
                "purge_legacy_key: id=%s name=%s task=%s enabled=%s",
                t.id, t.name, t.task, t.enabled,
            )

        # delete() 返回 (total_objs_deleted, {"app_label.ModelClass": count, ...})。
        # 注意 Django 在 per_model dict 里使用**类名**（首字母大写），不是 model_name。
        # 我们只关心 PeriodicTask 的真实删除条数，避免与级联对象总数混淆。
        deleted_total, deleted_per_model = PeriodicTask.objects.filter(id__in=ids).delete()
        audit_logger.info(
            "purge_legacy_keys_summary: deleted=%s per_model=%s ids=%s",
            deleted_total, deleted_per_model, ids,
        )
        periodic_task_label = f"{PeriodicTask._meta.app_label}.{PeriodicTask.__name__}"
        periodic_deleted = deleted_per_model.get(periodic_task_label, 0)

        self.stdout.write(
            self.style.SUCCESS(
                f"  ✓ 已删除 {periodic_deleted} 条 {_legacy_schedule_key_examples()} "
                f"PeriodicTask 记录"
                + (
                    f"（含级联对象共 {deleted_total} 个，"
                    f"按模型: {deleted_per_model}）"
                    if deleted_total != periodic_deleted
                    else ""
                )
                + "。"
            )
        )

        # 复核：再查一次，给 SRE 一个明确的 after 视图。
        remaining = PeriodicTask.objects.filter(_legacy_schedule_key_filter()).count()
        prefixes_display = _legacy_schedule_key_examples()
        if remaining == 0:
            self.stdout.write(
                self.style.SUCCESS(
                    f"  ✓ 复核：DB 中已无 {prefixes_display} 开头的 PeriodicTask。"
                )
            )
        else:
            self.stdout.write(
                self.style.ERROR(
                    f"  ✗ 复核异常：仍有 {remaining} 条 {prefixes_display} 记录未被删除，"
                    f"请人工确认。"
                )
            )

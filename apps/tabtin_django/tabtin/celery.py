"""
Celery configuration for tabtin project.
"""

import importlib
import logging
import os
import sys
from celery import Celery
from django.apps import apps as django_apps

# ⚠️ 修复 macOS fork() 崩溃问题
# 在 macOS 上，使用 spawn 模式而不是 fork 模式
# 参考: https://github.com/celery/celery/issues/7281
if sys.platform == 'darwin':  # macOS
    from multiprocessing import set_start_method
    try:
        set_start_method('spawn', force=True)
    except RuntimeError:
        pass  # 已经设置过了

# Set the default Django settings module for the 'celery' program.
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')

# R5-03 修复：OTel SDK 启动必须在 Celery worker / beat 进程业务模块 import 前
# Celery worker 也是 fts/agent_engine 的 trace 来源（flush_outbox / FC 调用等）
try:
    from tabtin.otel_init import setup_otel
    setup_otel()
except Exception:  # pragma: no cover - 启动不该被 OTel 拖死
    logging.getLogger(__name__).exception("[Celery] OTel setup failed; continue without trace")

# Sentry 错误监控：SENTRY_DSN 未配置时 no-op；
# CeleryIntegration 让 worker 任务的未捕获异常也自动上报
try:
    from tabtin.sentry import init_sentry
    init_sentry()
except Exception:  # pragma: no cover - 启动不该被 Sentry 拖死
    logging.getLogger(__name__).exception("[Celery] Sentry setup failed; continue without reporting")

app = Celery('tabtin')
logger = logging.getLogger(__name__)

# Register narrow realtime worker lifecycle logs before task modules are loaded.
try:
    import apps.services.common.observability.realtime_celery_lifecycle  # noqa: F401
except Exception:  # pragma: no cover - observability must not block worker boot
    logger.exception("[Celery] realtime lifecycle signal setup failed; continue without it")

# Register first-version Celery runtime Prometheus metrics. The module is
# inert unless CELERY_WORKER_METRICS_ENABLED is enabled on worker pods.
try:
    import apps.services.common.observability.celery_worker_metrics  # noqa: F401
except Exception:  # pragma: no cover - observability must not block worker boot
    logger.exception("[Celery] worker metrics signal setup failed; continue without it")

# Using a string here means the worker doesn't have to serialize
# the configuration object to child processes.
app.config_from_object('django.conf:settings', namespace='CELERY')

# Load task modules from all registered Django apps.
app.autodiscover_tasks()

_SCHEDULE_EXPORTS = (
    {
        "module": "apps.maintenance.tasks",
        "attr": "MAINTENANCE_SCHEDULE",
        "required_apps": ("apps.maintenance",),
    },
    {
        "module": "apps.maintenance.celery_health_tasks",
        "attr": "CELERY_HEALTH_CHECK_SCHEDULE",
        "required_apps": ("apps.maintenance",),
    },
    {
        "module": "apps.rag.tasks",
        "attr": "RAG_BEAT_SCHEDULE",
        "required_apps": ("apps.rag",),
    },
    {
        "module": "apps.users.wallet.tasks",
        "attr": "WALLET_BEAT_SCHEDULE",
        "required_apps": ("apps.users.wallet",),
    },
    {
        "module": "apps.services.payment.tasks",
        "attr": "PAYMENT_BEAT_SCHEDULE",
        "required_apps": ("apps.services.payment",),
    },
    {
        "module": "apps.services.billing.tasks",
        "attr": "BILLING_BEAT_SCHEDULE",
        "required_apps": ("apps.services.billing",),
    },
    # AGT-BEAT: apps.services.agent_engine 的所有 *_BEAT_SCHEDULE 子字典
    # 由 _discover_beat_schedules_auto() 通过 tasks / tasks.cleanup / tasks.memory
    # 自动发现；AGENT_ENGINE_BEAT_SCHEDULE（旧名 ORCHESTRATION_BEAT_SCHEDULE）
    # 只是这些子字典的便利聚合视图，无需显式注册。
    {
        "module": "apps.tracker.tasks",
        "attr": "TRACKER_BEAT_SCHEDULE",
        "required_apps": ("apps.tracker",),
    },
    {
        "module": "apps.users.membership.tasks",
        "attr": "MEMBERSHIP_BEAT_SCHEDULE",
        "required_apps": ("apps.users.membership",),
    },
    {
        "module": "apps.tabdata.tasks.link_integrity_tasks",
        "attr": "LINK_INTEGRITY_BEAT_SCHEDULE",
        "required_apps": ("apps.tabdata",),
    },
    {
        "module": "apps.tabdata.tasks.history_tasks",
        "attr": "TABDATA_HISTORY_BEAT_SCHEDULE",
        "required_apps": ("apps.tabdata",),
    },
    {
        "module": "apps.tabdata.tasks.api_log_tasks",
        "attr": "API_LOG_BEAT_SCHEDULE",
        "required_apps": ("apps.tabdata",),
    },
    {
        "module": "apps.tabdata.tasks.connector_tasks",
        "attr": "CONNECTOR_BEAT_SCHEDULE",
        "required_apps": ("apps.tabdata",),
    },
    {
        "module": "apps.services.common.ws.tasks",
        "attr": "WS_BEAT_SCHEDULE",
        "required_apps": (),
    },
    {
        "module": "apps.services.oss.tasks",
        "attr": "OSS_BEAT_SCHEDULE",
        "required_apps": ("apps.services.oss",),
    },
    {
        "module": "apps.services.docparse.tasks",
        "attr": "DOCPARSE_BEAT_SCHEDULE",
        "required_apps": ("apps.services.docparse",),
    },
    {
        "module": "apps.services.llm.tasks.runtime_tasks",
        "attr": "LLM_RUNTIME_BEAT_SCHEDULE",
        "required_apps": ("apps.services.llm",),
    },
    {
        "module": "apps.tabdoc.tasks",
        "attr": "TABDOC_BEAT_SCHEDULE",
        "required_apps": ("apps.tabdoc",),
    },
    {
        "module": "apps.tabslide.tasks",
        "attr": "TABSLIDE_BEAT_SCHEDULE",
        "required_apps": ("apps.tabslide",),
    },
    {
        "module": "apps.channel_gateway.tasks",
        "attr": "CHANNEL_GATEWAY_BEAT_SCHEDULE",
        "required_apps": ("apps.channel_gateway",),
    },
    {
        "module": "apps.services.media_generation.tasks",
        "attr": "MEDIA_GENERATION_BEAT_SCHEDULE",
        "required_apps": ("apps.services.media_generation",),
    },
    {
        "module": "apps.extensions.tasks",
        "attr": "EXTENSIONS_BEAT_SCHEDULE",
        "required_apps": ("apps.extensions",),
    },
    {
        "module": "apps.tabtinspace.tasks",
        "attr": "TABTINSPACE_BEAT_SCHEDULE",
        "required_apps": ("apps.tabtinspace",),
    },
    {
        "module": "apps.collab.tasks",
        "attr": "COLLAB_BEAT_SCHEDULE",
        "required_apps": ("apps.collab",),
    },
    {
        "module": "apps.chat.conversation.tasks",
        "attr": "CONVERSATION_BEAT_SCHEDULE",
        "required_apps": ("apps.chat.conversation",),
    },
    {
        "module": "apps.client_errors.tasks",
        "attr": "CLIENT_ERRORS_BEAT_SCHEDULE",
        "required_apps": ("apps.client_errors",),
    },
    {
        "module": "apps.tins.tasks",
        "attr": "TINS_BEAT_SCHEDULE",
        "required_apps": ("apps.tins",),
    },
    {
        "module": "apps.services.sms.tasks",
        "attr": "SMS_BEAT_SCHEDULE",
        "required_apps": ("apps.services.sms",),
    },
    {
        "module": "apps.tabsite.tasks",
        "attr": "TABSITE_BEAT_SCHEDULE",
        "required_apps": ("apps.tabsite",),
    },
    # 注：apps.services.common.observability.trace.TRACE_PUBLISH_BEAT_SCHEDULE
    # 由下方 _discover_beat_schedules_auto() 扫描 `middleware.trace` 后缀时自动发现
    # （通过 re-export stub），W10 后 agent_engine 已是 INSTALLED_APPS 成员，无需显式登记。
)

# 自动扫描这些子模块中的 `*_BEAT_SCHEDULE` dict（ImportError 表示未实现该子包，跳过）
_BEAT_DISCOVERY_MODULE_SUFFIXES = (
    "tasks",
    "tasks.cleanup",
    "tasks.memory",
    "middleware.trace",
)


def _is_app_installed(app_name: str) -> bool:
    return bool(app_name) and django_apps.is_installed(app_name)


def _load_schedule_export(module_path: str, attr_name: str, required_apps: tuple[str, ...]) -> dict:
    if required_apps and not all(_is_app_installed(app_name) for app_name in required_apps):
        logger.debug(
            "Skip beat schedule export %s.%s because required apps are not installed: %s",
            module_path,
            attr_name,
            ",".join(required_apps),
        )
        return {}

    module = importlib.import_module(module_path)
    schedule = getattr(module, attr_name, {})
    if not isinstance(schedule, dict):
        logger.warning("Beat schedule export %s.%s is not a dict", module_path, attr_name)
        return {}
    return schedule


def _discover_beat_schedules_auto() -> dict:
    """遍历已安装 Django app 的约定子模块，合并所有 `*_BEAT_SCHEDULE` dict。

    仅捕获 ImportError / ModuleNotFoundError（模块不存在）；其它异常仍会抛出以便暴露真实错误。
    """
    merged: dict = {}
    for app_config in sorted(django_apps.get_app_configs(), key=lambda c: c.name):
        base = app_config.name
        for suffix in _BEAT_DISCOVERY_MODULE_SUFFIXES:
            module_path = f"{base}.{suffix}"
            try:
                module = importlib.import_module(module_path)
            except ImportError:
                continue
            for attr_name in dir(module):
                if not attr_name.endswith("_BEAT_SCHEDULE"):
                    continue
                val = getattr(module, attr_name, None)
                if isinstance(val, dict):
                    merged.update(val)
    return merged


# 配置定期任务
# 延迟导入避免循环依赖，并按已安装 app 装配 schedule，避免最小测试 settings 被无关模块污染。
def get_beat_schedule():
    schedule_dict = _discover_beat_schedules_auto()
    logger.info(
        "Celery beat schedule auto-discovery: merged %d periodic entries (before explicit exports)",
        len(schedule_dict),
    )
    for spec in _SCHEDULE_EXPORTS:
        schedule_dict.update(
            _load_schedule_export(
                module_path=spec["module"],
                attr_name=spec["attr"],
                required_apps=spec["required_apps"],
            )
        )
    # FTS producer 必须以运行时 SEARCH_ENGINE_ENABLED 为准：
    # flag=false 时绝不把 fts-* 写进 schedule（避免只关 worker 仍往 search_indexing 灌任务）。
    try:
        from apps.fts.tasks import FTS_BEAT_PRODUCER_NAMES, get_fts_beat_schedule

        for name in FTS_BEAT_PRODUCER_NAMES:
            schedule_dict.pop(name, None)
        schedule_dict.update(get_fts_beat_schedule())
    except ImportError:
        pass
    return schedule_dict


def _gate_fts_search_indexing_producers(PeriodicTask) -> None:
    """DatabaseScheduler 残留行：flag 关闭时强制禁用 FTS → search_indexing 生产者。"""
    import logging

    from django.conf import settings
    from django.db import DatabaseError, OperationalError, ProgrammingError

    _logger = logging.getLogger("celery.setup")
    try:
        from apps.fts.tasks import FTS_BEAT_GATE_DESCRIPTION, FTS_BEAT_PRODUCER_NAMES
        from django_celery_beat.models import PeriodicTasks
    except ImportError:
        return

    try:
        if getattr(settings, "SEARCH_ENGINE_ENABLED", False):
            # 仅恢复本 gate 曾禁用的行，避免覆盖运维其它手动暂停
            restored = PeriodicTask.objects.filter(
                name__in=FTS_BEAT_PRODUCER_NAMES,
                description__startswith="[fts-gate]",
            ).update(enabled=True, description="")
            if restored:
                PeriodicTasks.update_changed()
                _logger.info("[fts-gate] re-enabled %d FTS beat producers", restored)
            return

        updated = PeriodicTask.objects.filter(
            name__in=FTS_BEAT_PRODUCER_NAMES,
            enabled=True,
        ).update(enabled=False, description=FTS_BEAT_GATE_DESCRIPTION)
        # 已是 disabled 但无 marker 的也打上标记，便于审计
        PeriodicTask.objects.filter(
            name__in=FTS_BEAT_PRODUCER_NAMES,
            enabled=False,
        ).exclude(description__startswith="[fts-gate]").update(
            description=FTS_BEAT_GATE_DESCRIPTION,
        )
        if updated:
            PeriodicTasks.update_changed()
            _logger.warning(
                "[fts-gate] disabled %d FTS beat producers (SEARCH_ENGINE_ENABLED=false)",
                updated,
            )
    except (DatabaseError, ProgrammingError, OperationalError) as exc:
        _logger.warning("[fts-gate] failed to gate FTS producers: %s", exc)

@app.on_after_finalize.connect
def setup_periodic_tasks(sender, **kwargs):
    """将代码中定义的定期任务同步到 DatabaseScheduler（幂等）。"""
    schedule_dict = get_beat_schedule()

    try:
        from django_celery_beat.models import (
            CrontabSchedule,
            IntervalSchedule,
            PeriodicTask,
            PeriodicTasks,
        )
    except Exception:
        sender.conf.beat_schedule = schedule_dict
        return

    try:
        _sync_schedule_to_db(schedule_dict, PeriodicTask, IntervalSchedule, CrontabSchedule)
        _soft_disable_retired_periodic_tasks(PeriodicTask, PeriodicTasks)
        _soft_disable_legacy_duplicates(schedule_dict, PeriodicTask)
        _gate_fts_search_indexing_producers(PeriodicTask)
    except Exception:
        import logging
        from django.conf import settings
        _logger = logging.getLogger("celery.setup")
        _logger.error(
            "Failed to sync beat schedule to DB (table may not exist yet). "
            "Beat will NOT pick up new/changed schedule entries until this is resolved. "
            "Worker will continue normally.",
            exc_info=getattr(settings, 'DEBUG', False),
        )


# legacy 前缀来源统一放在 apps.maintenance.legacy_schedules，
# `_soft_disable_legacy_duplicates` 与 `check_orchestration_beat_tasks` 共享一份。
# 新增历史前缀迁移时只改那边，两处自动同步。


_RETIRED_PERIODIC_TASK_NAMES = frozenset({
    "apps.services.agent_engine.tasks.cleanup.chat_message_reconciliation."
    "reconcile_chat_messages_from_trace",
    "apps.services.billing.task_billing.reconcile_member_usage_counters",
    "apps.services.billing.tasks._generate_invoice_batch",
    "apps.services.billing.tasks._settle_organization_batch",
    "apps.services.billing.tasks.auto_collect_open_invoices",
    "apps.services.billing.tasks.auto_collect_single_invoice",
    "apps.services.billing.tasks.auto_retry_failed_invoices_after_recharge",
    "apps.services.billing.tasks.check_dispute_sla_overdue",
    "apps.services.billing.tasks.cleanup_billing_history",
    "apps.services.billing.tasks.cleanup_old_member_usage_counters",
    "apps.services.billing.tasks.collect_daily_storage_charges",
    "apps.services.billing.tasks.compensate_refund_entitlement_sync",
    "apps.services.billing.tasks.detect_billing_anomalies",
    "apps.services.billing.tasks.generate_last_month_invoices",
    "apps.services.billing.tasks.hourly_aggregate_charge",
    "apps.services.billing.tasks.reconcile_daily_billing",
    "apps.services.billing.tasks.reconcile_member_usage_counters",
    "apps.services.billing.tasks.reconcile_new_organization_provider_credits_async",
    "apps.services.billing.tasks.reconcile_storage_snapshots",
    "apps.services.billing.tasks.release_stale_frozen_credits",
    "apps.services.billing.tasks.retry_charge_failed_events",
    "apps.services.billing.tasks.retry_hourly_failed_aggregate_events",
    "apps.services.billing.tasks.retry_internal_refund",
    "apps.services.billing.tasks.retry_storage_billing_compensation",
    "apps.services.billing.tasks.retry_workteam_lifecycle_cleanups",
    "apps.services.billing.tasks.scan_refund_inconsistencies",
    "apps.services.billing.tasks.settle_previous_day_usage_for_all_organizations",
    "apps.services.billing.tasks.snapshot_storage_end_of_day",
    "apps.services.billing.tasks.verify_monthly_invoices_completeness",
    "apps.services.payment.tasks.compensate_unpaid_benefits",
    "apps.services.payment.tasks.reconcile_paying_orders",
    "tabdata.outbox_recover_stale_leases",
    "tabdata.outbox_worker_run_sweep",
    "tabtinspace.cleanup_old_workteam_activity",
    "tabtinspace.compensate_missing_default_workteam",
    "tabtinspace.expire_stale_grants",
    "tabtinspace.repurge_stuck_deleting_workteams",
    "tabtinspace.reset_monthly_suspended_shares",
    "apps.tracker.tasks.scan_due_trackers",
    "apps.tracker.tasks.recover_stuck_tracker_runs",
    "apps.tracker.tasks.redispatch_waiting_tracker_runs",
    "apps.tracker.tasks.tracker_health_check",
})
"""已下线但可能仍残留在 DatabaseScheduler 中的任务名。"""


def _soft_disable_retired_periodic_tasks(PeriodicTask, PeriodicTasks) -> None:
    """软禁用已明确下线的数据库定时任务，并通知 Beat 重载。"""
    import logging

    from django.db import (
        DatabaseError,
        OperationalError,
        ProgrammingError,
        transaction,
    )
    from django.db.models import Q

    _logger = logging.getLogger("celery.setup")
    try:
        with transaction.atomic():
            updated = PeriodicTask.objects.filter(
                Q(task__in=_RETIRED_PERIODIC_TASK_NAMES)
                | Q(
                    name__in=(
                        "scan-due-trackers",
                        "recover-stuck-tracker-runs",
                        "redispatch-waiting-tracker-runs",
                        "tracker-health-check",
                    )
                ),
                enabled=True,
            ).update(enabled=False)
            if not updated:
                return
            PeriodicTasks.update_changed()
        _logger.warning(
            "[beat-retired] 自动软禁用 %d 条已下线 PeriodicTask",
            updated,
        )
    except (DatabaseError, OperationalError, ProgrammingError) as exc:
        _logger.warning("[beat-retired] 软禁用已下线 PeriodicTask 失败: %s", exc)


_SOFT_DISABLE_DESCRIPTION_MARK = (
    "[beat-legacy] Wave 12 软禁用：新 key 已激活，避免双倍调度。"
    "要彻底删除请执行 "
    "`python manage.py check_orchestration_beat_tasks --purge-legacy-keys --confirm`。"
)
"""写入 PeriodicTask.description 的说明文案。

django_celery_beat Admin 列表里 SRE 看到 disabled 记录时，鼠标悬停/点进去
就能看到这条说明，不必跑命令也能自助搞清来龙去脉。首轮被软禁用的记录里
已写入该 marker 的不再重复日志，保证重启幂等不刷屏。
"""


def _soft_disable_legacy_duplicates(schedule_dict, PeriodicTask):
    """Worker 启动时自动软禁用被替代的 legacy schedule key（不删除、可审计）。

    防双倍调度机制：
      - Wave 12 归一后，历史 key（如 `orchestration-check-monitor-heartbeats` 或
        过渡阶段使用的 `agent-engine-check-monitor-heartbeats`）在 DB 里仍
        `enabled=True`，新 key（`check-monitor-heartbeats`）由
        `_sync_schedule_to_db` 写入后也 enabled，Beat 会对同一 task 路径**调度两次**。
      - 本函数只对"task 字段与当前代码中已定义的 schedule 相同、但 name 仍是 legacy
        前缀"的记录置 `enabled=False`，并写入 description marker 便于 SRE 在 Admin
        界面看到来龙去脉。保留记录本身便于审计；完全清理仍需走
        `python manage.py check_orchestration_beat_tasks --purge-legacy-keys --confirm`。
      - 若运维自建了 `orchestration-*` 前缀但 task 字段不在新 schedule 中的任务，
        本函数不会触碰（task 不匹配）。

    并发保护：生产环境多 Worker（或 macOS spawn 模式下多 pool child）同时启动时，
    通过 Redis advisory lock（`celery:soft_disable_legacy_lock`，与
    ``_recover_stuck_jobs_on_startup`` 同一套路）保证全集群只跑一次、日志不刷屏。
    Redis 不可用时降级：本节点跳过，等其他节点或下轮重启再做；实际的 update 仍幂等
    （``enabled=True`` 过滤 + description marker 去重），不会造成数据破损。

    SRE 手工恢复提示：若需临时恢复 legacy 记录调试，需同时改 task 字段使其不再
    落入当前 schedule 的 task 集合；否则下次 Worker 重启会重新软禁用。
    """
    import logging
    _logger = logging.getLogger("celery.setup")

    try:
        from apps.maintenance.legacy_schedules import LEGACY_SCHEDULE_KEY_PREFIXES
    except ImportError:
        _logger.warning("[beat-legacy] 无法导入 legacy_schedules 常量，跳过")
        return

    try:
        from django.core.cache import cache
        if not cache.add("celery:soft_disable_legacy_lock", 1, timeout=300):
            _logger.debug("[beat-legacy] 已有其他进程持锁，跳过")
            return
    except Exception:
        _logger.debug("[beat-legacy] 缓存不可用，允许本地执行（update 仍幂等）")

    task_names_in_code = {
        _resolve_task_name(entry, key) for key, entry in schedule_dict.items()
        if entry.get("schedule") is not None
    }
    if not task_names_in_code:
        return

    from django.db import DatabaseError, ProgrammingError, OperationalError
    try:
        qs = PeriodicTask.objects.filter(
            task__in=task_names_in_code,
            enabled=True,
        )
        from functools import reduce
        from operator import or_ as _or
        from django.db.models import Q
        prefix_q = reduce(
            _or,
            (Q(name__startswith=p) for p in LEGACY_SCHEDULE_KEY_PREFIXES),
        )
        candidates = list(
            qs.filter(prefix_q).only("id", "name", "task", "description")
        )
    except (DatabaseError, ProgrammingError, OperationalError) as exc:
        _logger.warning("[beat-legacy] 查询 legacy duplicates 失败: %s", exc)
        return

    if not candidates:
        return

    disabled_ids: list[int] = []
    fresh_names: list[str] = []
    for obj in candidates:
        if obj.name in schedule_dict:
            continue
        disabled_ids.append(obj.id)
        # description 在 PeriodicTask 模型里定义为 TextField(blank=True, default="")，
        # 但测试 mock 场景下可能是任意对象，显式 str() 兜底避免 TypeError 于 `in` 操作。
        existing_desc = str(getattr(obj, "description", "") or "")
        if _SOFT_DISABLE_DESCRIPTION_MARK not in existing_desc:
            fresh_names.append(obj.name)

    if not disabled_ids:
        return

    # 首次被软禁用的记录汇总成一条 WARNING，避免一次性禁用 N 条（历史迁移场景）
    # 时日志刷屏。已经有 description marker 的记录只做 enabled 兜底，不产生新日志。
    if fresh_names:
        preview = ", ".join(fresh_names[:5])
        tail = f"...(+{len(fresh_names) - 5} more)" if len(fresh_names) > 5 else ""
        _logger.warning(
            "[beat-legacy] 自动软禁用 %d 条 legacy schedule key: %s%s。"
            "完全删除请执行 "
            "`python manage.py check_orchestration_beat_tasks --purge-legacy-keys --confirm`。",
            len(fresh_names), preview, tail,
        )

    try:
        updated = PeriodicTask.objects.filter(id__in=disabled_ids).update(
            enabled=False,
            description=_SOFT_DISABLE_DESCRIPTION_MARK,
        )
    except (DatabaseError, ProgrammingError, OperationalError) as exc:
        _logger.warning("[beat-legacy] 软禁用 update 失败: %s", exc)
        return

    if updated:
        _logger.info(
            "[beat-legacy] 软禁用完成 %d 条（含 %d 条首次标记）",
            updated, len(fresh_names),
        )


def _resolve_task_name(entry: dict, key: str) -> str:
    """与 ``_sync_schedule_to_db`` 的 ``defaults['task']`` 保持一致的兜底语义。

    schedule dict 缺省 ``task`` 字段时回退到 key，两处必须同步否则 ``task__in``
    匹配集合不一致。抽出 helper 是为了让变更集中到一个位置。
    """
    return entry.get("task", key)


def _sync_schedule_to_db(schedule_dict, PeriodicTask, IntervalSchedule, CrontabSchedule):
    """将 schedule_dict 同步到 DatabaseScheduler，拆分出来以便统一容错。"""
    import json

    for task_name, entry in schedule_dict.items():
        sched = entry.get('schedule')
        if sched is None:
            continue
        from datetime import timedelta
        from celery.schedules import crontab as crontab_cls, schedule as interval_cls
        db_schedule_kwargs: dict = {}
        if isinstance(sched, crontab_cls):
            cron = CrontabSchedule.objects.filter(
                minute=sched._orig_minute,
                hour=sched._orig_hour,
                day_of_week=sched._orig_day_of_week,
                day_of_month=sched._orig_day_of_month,
                month_of_year=sched._orig_month_of_year,
            ).first()
            if not cron:
                cron = CrontabSchedule.objects.create(
                    minute=sched._orig_minute,
                    hour=sched._orig_hour,
                    day_of_week=sched._orig_day_of_week,
                    day_of_month=sched._orig_day_of_month,
                    month_of_year=sched._orig_month_of_year,
                )
            db_schedule_kwargs['crontab'] = cron
            db_schedule_kwargs['interval'] = None
        else:
            if isinstance(sched, (int, float)):
                total_seconds = float(sched)
            elif isinstance(sched, timedelta):
                total_seconds = sched.total_seconds()
            elif hasattr(sched, 'run_every'):
                total_seconds = sched.run_every.total_seconds()
            else:
                continue
            total_seconds = max(total_seconds, 1)
            if total_seconds >= 86400:
                period, every = IntervalSchedule.DAYS, int(total_seconds / 86400)
            elif total_seconds >= 3600:
                period, every = IntervalSchedule.HOURS, int(total_seconds / 3600)
            elif total_seconds >= 60:
                period, every = IntervalSchedule.MINUTES, int(total_seconds / 60)
            else:
                period, every = IntervalSchedule.SECONDS, int(total_seconds)
            ival = IntervalSchedule.objects.filter(every=every, period=period).first()
            if not ival:
                ival = IntervalSchedule.objects.create(every=every, period=period)
            db_schedule_kwargs['interval'] = ival
            db_schedule_kwargs['crontab'] = None

        # 保留运维手动设置的 enabled 状态；仅在首次创建时默认启用。
        # 若无条件写 True，每次 Worker 重启都会撤销运维手动禁用（紧急暂停失效）。
        existing = PeriodicTask.objects.filter(name=task_name).only('enabled').first()
        entry_options = entry.get('options', {})
        entry_expires = entry_options.get('expires')
        defaults = {
            'task': _resolve_task_name(entry, task_name),
            'args': json.dumps(entry.get('args', [])),
            'kwargs': json.dumps(entry.get('kwargs', {})),
            'queue': entry_options.get('queue', ''),
            'enabled': existing.enabled if existing is not None else True,
            **db_schedule_kwargs,
        }
        if entry_expires is not None:
            defaults['expire_seconds'] = int(entry_expires) if isinstance(entry_expires, (int, float)) else None
        PeriodicTask.objects.update_or_create(name=task_name, defaults=defaults)

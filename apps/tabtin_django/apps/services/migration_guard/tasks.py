"""Migration Guard 周期任务（v0.1 §5.1 收尾迭代 Phase 1，2026-05-07）。

== 当前阶段：dry-run only ==

`reconcile_softrefs_task` 当前**只跑 dry-run**——仅 SELECT 检测悬空 ID + log
统计，**不执行任何 UPDATE/DELETE**。目的：

1. **收集真实悬空数据 2 周**：现在 dev 库 orphan=0，生产规模未知；不确定调度
   频率（每周？每天？）、不确定要不要开 `--fix`，都需要数据支撑
2. **零生产破坏风险**：dry-run 失败的最坏情况是 log 一条 ERROR——绝无可能
   误删/误改任何数据
3. **观察 cascade signal 健康度**：如果 `orphan_count > 0` 高频出现，说明
   cascade signal 在丢失事件——需要先排查根因，而不是依赖兜底清理

== 升级到 Phase 2（开 --fix）的判定条件 ==

观察 ≥ 2 周 log 后，根据 `TELEMETRY:` 行的 `orphan_total` 趋势决定：

- **总是 0** → cascade signal 完全可靠 → **不开 --fix**，task 改成只发告警
- **偶发悬空（< 0.1% 引用率，孤立事件）** → 可开 --fix，但保持周跑
- **频繁悬空（持续 > 0.1%）** → **不开 --fix**，先去修 cascade signal 根因

⚠️ 不要凭"感觉差不多了"就改成 `--fix=True`。一定要看 log 数据。

== 调度时段 ==

每周一 03:00 跑一次：
- 避开 OSS `reconcile_file_usages_task` 的周一 02:30
- 避开 OSS `cleanup_orphan_files` 的每天 04:00
- 选周一是因为周末业务量低、悬空数据更新慢，趋势观察最干净

== 分布式锁 ==

Redis 锁 `lock:reconcile_softrefs` TTL 1800s，跟 task time_limit 一致——多
worker 部署时只一个会真跑，其他 silent skip。
"""

from __future__ import annotations

import logging
import re
from io import StringIO

from celery import shared_task
from celery.schedules import crontab
from django.core.cache import cache as django_cache
from django.core.management import call_command


logger = logging.getLogger(__name__)


_LOCK_KEY = "lock:reconcile_softrefs"
_LOCK_TIMEOUT = 1800
_MAX_OUTPUT_LEN = 8000

# 从 reconcile_softrefs 人读输出抓 "Summary" 行做轻量 telemetry 解析。
# 例：``Summary: 8 spec(s) checked / 0 orphan ID(s) total / 0 fixed ✓ all clean``
_SUMMARY_PATTERN = re.compile(
    r"Summary:\s*(\d+)\s*spec.*?/\s*(\d+)\s*orphan\s*ID.*?/\s*(\d+)\s*fixed",
    re.IGNORECASE,
)


@shared_task(time_limit=1800, soft_time_limit=1740)
def reconcile_softrefs_task():
    """周期跑 ``reconcile_softrefs`` dry-run，log 悬空规模做 telemetry 收集。

    返回 dict 描述本次执行结果（Celery 自动 serialize 进 result backend）。
    出现异常仅 log error，不 raise——避免拖垮 beat 调度。
    """
    lock_acquired = django_cache.add(_LOCK_KEY, "1", timeout=_LOCK_TIMEOUT)
    if not lock_acquired:
        logger.info(
            "reconcile_softrefs_task 分布式锁未获取，跳过本次执行（其他 worker 正在跑）"
        )
        return {"skipped": True, "reason": "lock_not_acquired"}

    out = StringIO()
    try:
        logger.info("reconcile_softrefs_task 开始执行 (dry-run mode)")

        # ⚠️ Phase 1：永远不传 fix=True；要升级到 Phase 2 必须先看 2 周 log
        # 数据再改这里——直接改 fix=True 没数据支撑就是赌。
        call_command("reconcile_softrefs", stdout=out)

        output = out.getvalue()
        truncated = (
            output[:_MAX_OUTPUT_LEN] + f"\n... (截断，总长 {len(output)} 字符)"
            if len(output) > _MAX_OUTPUT_LEN
            else output
        )

        # 解析 telemetry 字段——后期接 monitoring 直接 grep "TELEMETRY:" 行
        match = _SUMMARY_PATTERN.search(output)
        if match:
            specs_count = int(match.group(1))
            orphan_total = int(match.group(2))
            telemetry = (
                f"TELEMETRY: reconcile_softrefs specs={specs_count} "
                f"orphan_total={orphan_total} fixed=0 mode=dry_run"
            )
            if orphan_total > 0:
                logger.warning(telemetry)
            else:
                logger.info(telemetry)
        else:
            logger.warning(
                "reconcile_softrefs_task 输出未匹配到 Summary 行；"
                "可能命令实现已变更或解析 pattern 过期"
            )
            telemetry = "TELEMETRY: reconcile_softrefs parse_failed"

        logger.info("reconcile_softrefs_task 完成:\n%s", truncated)
        return {
            "success": True,
            "telemetry": telemetry,
            "output": truncated,
        }

    except Exception as exc:  # noqa: BLE001
        logger.error("reconcile_softrefs_task 异常: %s", exc, exc_info=True)
        return {"success": False, "error": str(exc)}

    finally:
        django_cache.delete(_LOCK_KEY)


# ════════════════════════════════════════════════════════════════════════════
#  Beat schedule —— 由 celery.py:_discover_beat_schedules_auto() 自动扫描合并
# ════════════════════════════════════════════════════════════════════════════
#
# 不需要在 tabtin/celery.py:_SCHEDULE_EXPORTS 显式登记——本模块路径
# ``apps.services.migration_guard.tasks`` 命中自动发现的 (app_name + ".tasks")
# 后缀规则。新增 task 直接加到下方 dict 即可。

MIGRATION_GUARD_BEAT_SCHEDULE = {
    "migration-guard-reconcile-softrefs": {
        "task": "apps.services.migration_guard.tasks.reconcile_softrefs_task",
        # 周一 03:00：避开 OSS reconcile_file_usages（周一 02:30）和
        # OSS cleanup_orphan_files（每天 04:00）。
        "schedule": crontab(hour=3, minute=0, day_of_week="monday"),
        "options": {"queue": "default"},
    },
}

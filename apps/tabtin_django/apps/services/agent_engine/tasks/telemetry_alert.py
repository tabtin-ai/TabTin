"""
Telemetry Alert Tasks — resource_open 埋点维度的主动告警（W8 L87 收敛）。

业务背景（W7 独立验证 P2-2 + W8 L87）：
    ``scripts/telemetry/resource_open_sample.py`` 已实现 ``query_manifest_opens_alert``
    检查 PRD §6 标准 1 "可见率 ≥ 80%" 的隐性反例 —— 当 D3 三种 trigger
    (chat_markdown / rich_resource_card / open_in_space_tool) 的 system_fallback
    占比 > 50% 时意味着 manifest opens 注册全部失效，所有 Agent 产物落到系统应用。
    但那是 query 函数，**PM 不主动跑就永远看不到** ——
    这违反 PRD §6 "标准 2 异常 deny / 静默失败 = 0" 的精神（fail-closed 应有主动通路）。

本 task 主动跑（Celery Beat 每小时一次），命中阈值时 Sentry + logger.critical 主动告警，
PM 不需要手跑脚本，运维 / Sentry 配置好 alert rule 即可 P1 推送。

设计取向（与 ``apps/services/common/manifest_opens.py:_emit_fallback_alert`` 同款）：
  - 双管齐下：命名 logger ``resource_open.manifest_opens_alert`` (CRITICAL) + sentry_sdk
  - 时间窗口 1 小时 = 与 beat 频率对齐（窗口大于频率会重复告警，窗口小于频率会漏）
  - 数据点 < 50 时不告警 —— 避免低流量误报（产品上线初期 / 用户少时全凭运气）
  - 默认阈值 0.50（system_fallback / 总 D3 trigger）—— 与 ``query_manifest_opens_alert``
    一致，运维侧可通过 Django settings ``RESOURCE_OPEN_ALERT_THRESHOLD`` 调整

复用 ``query_manifest_opens_alert`` ：避免双轨实现，逻辑变更只改一处；导入路径
经 ``importlib`` 反射 ``scripts/telemetry/resource_open_sample.py`` —— 该脚本在
``ROOT_DIR / "scripts" / "telemetry"`` 不在 Python package path，直接 file import
是最简洁的方案（不引入 PYTHONPATH 配置 / 不在 ``apps/`` 下复制一份）。
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys
from pathlib import Path

from celery import shared_task
from django.conf import settings

logger = logging.getLogger(__name__)

# 专属告警 logger —— ELK / Sentry 可按 logger name grouping + alert
_alert_logger = logging.getLogger("resource_open.manifest_opens_alert")


def _load_sample_module():
    """反射加载 scripts/telemetry/resource_open_sample.py。

    脚本在 ``scripts/`` 不在 Python package path，但暴露的 query 函数复用价值高
    （beat 这边 + PM CLI 那边走同款逻辑）。用 importlib.util.spec_from_file_location
    动态加载——无需把脚本搬进 apps/ 内或维护 sys.path 入侵。
    """
    from apps.services.repo_root import get_repo_root

    project_root = get_repo_root()
    script_path = project_root / "scripts" / "telemetry" / "resource_open_sample.py"
    if not script_path.exists():
        logger.error("[telemetry_alert] 抽样脚本不存在: %s", script_path)
        return None
    spec = importlib.util.spec_from_file_location(
        "tabtin_resource_open_sample", str(script_path)
    )
    if spec is None or spec.loader is None:
        logger.error("[telemetry_alert] 抽样脚本加载失败: %s", script_path)
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(spec.name, module)
    spec.loader.exec_module(module)
    return module


@shared_task(bind=True, ignore_result=True, time_limit=120, soft_time_limit=100)
def check_resource_open_manifest_opens_alert(self):
    """检查 resource_open 埋点的 manifest_opens fail-closed 告警条件。

    业务流程：
      1. 反射加载 ``scripts/telemetry/resource_open_sample.py``（与 PM CLI 同款逻辑）
      2. 跑 ``query_manifest_opens_alert(days=1)`` —— 1 天窗口与每小时跑频率对齐
      3. 若 ``alert=True`` 且总样本 ≥ 50 → logger.critical + sentry_sdk.capture_message

    返回 dict 供 Celery 状态查询 / 测试断言。

    PRD §6 标准 1 验收支撑：本 task 是 query_manifest_opens_alert 的主动告警通路。
    """
    try:
        sample_module = _load_sample_module()
        if sample_module is None:
            return {"success": False, "reason": "sample_script_load_failed"}

        # Django setup 在 Celery worker 上下文里已 ready，sample_module.setup_django()
        # 重复调用安全（django.setup 内部幂等）—— 但跳过避免重复 logger 配置
        result = sample_module.query_manifest_opens_alert(days=1)

        threshold = float(
            os.environ.get("RESOURCE_OPEN_ALERT_THRESHOLD")
            or getattr(settings, "RESOURCE_OPEN_ALERT_THRESHOLD", 0.50)
        )

        total = result.get("total_in_d3_triggers", 0)
        system_fallback_count = result.get("system_fallback_count", 0)
        system_fallback_rate = float(result.get("system_fallback_rate", 0.0))

        # 数据点 < 50 不告警 —— 低流量场景全凭运气，会误报
        if total < 50:
            logger.info(
                "[telemetry_alert] 样本不足 (total=%d < 50)，跳过 manifest_opens_alert",
                total,
            )
            return {
                "success": True,
                "alerted": False,
                "reason": "insufficient_sample",
                "result": result,
            }

        if system_fallback_rate <= threshold:
            return {
                "success": True,
                "alerted": False,
                "reason": "under_threshold",
                "result": result,
            }

        # 命中告警阈值 —— 双管齐下
        msg = (
            f"resource_open manifest_opens_alert: D3 trigger 中 system_fallback 占比 "
            f"{system_fallback_rate:.2%} > {threshold:.2%} "
            f"(total={total}, system_fallback={system_fallback_count})"
        )
        try:
            _alert_logger.critical(
                "[manifest_opens_alert] %s", msg,
                extra={
                    "metric": "resource_open.manifest_opens_alert",
                    "system_fallback_rate": system_fallback_rate,
                    "system_fallback_count": system_fallback_count,
                    "total_in_d3_triggers": total,
                    "threshold": threshold,
                },
            )
        except Exception:
            # 告警 logger 自身故障：吞
            pass

        try:
            import sentry_sdk
            sentry_sdk.capture_message(
                msg,
                level="error",
                extras={
                    "metric": "resource_open.manifest_opens_alert",
                    "system_fallback_rate": system_fallback_rate,
                    "system_fallback_count": system_fallback_count,
                    "total_in_d3_triggers": total,
                    "threshold": threshold,
                    "hint": result.get("hint"),
                },
            )
        except Exception:
            # sentry_sdk 未安装 / 未初始化 → 静默吞
            pass

        return {
            "success": True,
            "alerted": True,
            "system_fallback_rate": system_fallback_rate,
            "result": result,
        }

    except Exception as exc:
        logger.error(
            "[telemetry_alert] check_resource_open_manifest_opens_alert failed: %s",
            exc, exc_info=True,
        )
        return {"success": False, "error": str(exc)}


TELEMETRY_ALERT_BEAT_SCHEDULE = {
    "check-resource-open-manifest-opens-alert": {
        "task": "apps.services.agent_engine.tasks.telemetry_alert.check_resource_open_manifest_opens_alert",
        # 每 1 小时一次 = 3600s。频率说明：
        #   - 频率过高 (< 30min) 会浪费 Celery worker + 重复 PG 查询
        #   - 频率过低 (> 6h) 会让 P1 故障晚 6 小时才推送
        # 1 小时是 PM 在 14 天验收期内能容忍的最大延迟
        "schedule": 3600.0,
        "options": {"queue": "default"},
    },
}

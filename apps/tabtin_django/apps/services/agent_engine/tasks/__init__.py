"""
Agent Engine 异步任务

提供：
- cleanup: Context/Trace 清理任务
- memory: 记忆系统异步任务（capture / task_summary / access_count）

Beat Schedule 注册机制（AGT-BEAT 改造）：
  各子模块独立定义自己的 *_BEAT_SCHEDULE 字典，
  celery.py 的 _discover_beat_schedules_auto() 自动扫描聚合。
  AGENT_ENGINE_BEAT_SCHEDULE 是 cleanup + memory 的聚合便利视图。
"""
import logging as _logging
import warnings as _warnings

from .cleanup import (
    cleanup_expired_agent_traces,
    repair_abandoned_pg_states,
    recover_fallback_states,
    recover_msg_fallback_states,
    check_monitor_heartbeats,
    TRACE_BEAT_SCHEDULE,
    CONVERSATION_STATE_BEAT_SCHEDULE,
    ABANDONED_PG_REPAIR_BEAT_SCHEDULE,
    STATE_FALLBACK_RECOVERY_BEAT_SCHEDULE,
    MSG_FALLBACK_RECOVERY_BEAT_SCHEDULE,
    MONITOR_BEAT_SCHEDULE,
    CLEANUP_BEAT_SCHEDULE,
)
from .cleanup.conversation_state import cleanup_stale_conversation_states  # noqa: F401

from .memory import (
    COMPACTION_BEAT_SCHEDULE,
    DAILY_DIARY_BEAT_SCHEDULE,
    IMPORTANCE_BEAT_SCHEDULE,
    IDLE_SETTLEMENT_BEAT_SCHEDULE,
    MEMORY_BEAT_SCHEDULE,
)
from .memory.capture import extract_memories_task  # noqa: F401
from .memory.capture import advance_memory_index_task  # noqa: F401
from .memory.task_summary import generate_task_summary_task  # noqa: F401
from .memory.access_count import increment_access_count_task  # noqa: F401
from .memory.compaction import compact_memories_task  # noqa: F401
from .memory.importance_adjust import adjust_memory_importance_task  # noqa: F401
from .memory.idle_settlement import settle_idle_session_task  # noqa: F401
from .memory.idle_settlement import dispatch_idle_settlement  # noqa: F401
from .memory.daily_diary import dispatch_daily_diary  # noqa: F401
from .memory.daily_diary import distill_daily_diary_task  # noqa: F401

# W8 L87：resource_open 埋点 manifest_opens fail-closed 主动告警 beat task
from .telemetry_alert import (
    check_resource_open_manifest_opens_alert,  # noqa: F401
    TELEMETRY_ALERT_BEAT_SCHEDULE,
)
from .queue_recovery import recover_chat_queue  # noqa: F401
from .run_host_lease import (  # noqa: F401
    RUN_HOST_LEASE_BEAT_SCHEDULE,
    sweep_expired_run_host_leases,
)

AGENT_ENGINE_BEAT_SCHEDULE = {
    **CLEANUP_BEAT_SCHEDULE,
    **MEMORY_BEAT_SCHEDULE,
    **TELEMETRY_ALERT_BEAT_SCHEDULE,
    **RUN_HOST_LEASE_BEAT_SCHEDULE,
}

_alias_logger = _logging.getLogger(__name__)
_alias_warned: set[str] = set()


def _reset_alias_deprecation_cache() -> None:
    _alias_warned.clear()


def __getattr__(name):
    if name == "ORCHESTRATION_BEAT_SCHEDULE":
        if name not in _alias_warned:
            _alias_warned.add(name)
            message = (
                "[agent_engine] Deprecated module attribute "
                "'apps.services.agent_engine.tasks.ORCHESTRATION_BEAT_SCHEDULE' "
                "detected; please rename to 'AGENT_ENGINE_BEAT_SCHEDULE'. "
                "Legacy alias will be removed in Wave 13 (2026-06)."
            )
            _alias_logger.warning(message)
            _warnings.warn(message, DeprecationWarning, stacklevel=2)
        return AGENT_ENGINE_BEAT_SCHEDULE
    # M5: subagent tasks removed — provide helpful error
    if name in ("run_subagent_inline", "run_subagent_background_inline", "dispatch_subagent_task"):
        raise AttributeError(
            f"'{name}' has been removed in M5 (Django builtin execution cleanup). "
            f"Subagent tasks now run on client devices."
        )
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    # cleanup tasks
    "cleanup_expired_agent_traces",
    "repair_abandoned_pg_states",
    "recover_fallback_states",
    "recover_msg_fallback_states",
    "cleanup_stale_conversation_states",
    "check_monitor_heartbeats",
    # memory tasks
    "extract_memories_task",
    "advance_memory_index_task",
    "generate_task_summary_task",
    "increment_access_count_task",
    "compact_memories_task",
    "adjust_memory_importance_task",
    "settle_idle_session_task",
    "dispatch_idle_settlement",
    "dispatch_daily_diary",
    "distill_daily_diary_task",
    # telemetry alert
    "check_resource_open_manifest_opens_alert",
    "recover_chat_queue",
    "sweep_expired_run_host_leases",
    "RUN_HOST_LEASE_BEAT_SCHEDULE",
    "TELEMETRY_ALERT_BEAT_SCHEDULE",
    # schedules
    "TRACE_BEAT_SCHEDULE",
    "CONVERSATION_STATE_BEAT_SCHEDULE",
    "ABANDONED_PG_REPAIR_BEAT_SCHEDULE",
    "STATE_FALLBACK_RECOVERY_BEAT_SCHEDULE",
    "MSG_FALLBACK_RECOVERY_BEAT_SCHEDULE",
    "MONITOR_BEAT_SCHEDULE",
    "CLEANUP_BEAT_SCHEDULE",
    "COMPACTION_BEAT_SCHEDULE",
    "DAILY_DIARY_BEAT_SCHEDULE",
    "IMPORTANCE_BEAT_SCHEDULE",
    "IDLE_SETTLEMENT_BEAT_SCHEDULE",
    "MEMORY_BEAT_SCHEDULE",
    "AGENT_ENGINE_BEAT_SCHEDULE",
]

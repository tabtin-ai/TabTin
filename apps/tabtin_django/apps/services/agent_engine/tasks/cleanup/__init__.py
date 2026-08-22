"""
任务清理

- trace: Agent Trace 清理
- conversation_state: ConversationState 定期清理
- abandoned_pg_repair: PG messages_json 残留修复
- state_fallback_recovery: PG 持久化兜底回写
- msg_fallback_recovery: MySQL 消息兜底回写
- monitor: Monitor 心跳超时检测

已删除 chat_message_reconciliation（W3 从 trace 重建 assistant 的灾难恢复兜底）：
6 件套降 transient 后不再写 trace，该 worker 扫不到 message_stop 恒空跑；
assistant 落库唯一权威 = persist_message（+ agent-runtime 本地 transcript 回补），
不再需要服务端从 trace 重建的兜底路径。

W12 决策 3 (2026-04)：删除 6 个 orphan runs cleanup task
（cleanup_expired_subagents / cleanup_expired_agent_runs /
flush_orphaned_announcements / sweep_stale_runs /
gc_stale_execution_runs / check_zombie_threads）。
M5 后 Agent 执行全部落在客户端 runtime，
Django 侧不再写入 SubtaskRun / ExecutionRun，
相关 Celery task 不再需要。
"""

from .trace import cleanup_expired_agent_traces, TRACE_BEAT_SCHEDULE
from .conversation_state import cleanup_stale_conversation_states, CONVERSATION_STATE_BEAT_SCHEDULE
from .abandoned_pg_repair import repair_abandoned_pg_states, ABANDONED_PG_REPAIR_BEAT_SCHEDULE
from .state_fallback_recovery import recover_fallback_states, STATE_FALLBACK_RECOVERY_BEAT_SCHEDULE
from .msg_fallback_recovery import recover_msg_fallback_states, MSG_FALLBACK_RECOVERY_BEAT_SCHEDULE
from .monitor import check_monitor_heartbeats, MONITOR_BEAT_SCHEDULE

CLEANUP_BEAT_SCHEDULE = {
    **TRACE_BEAT_SCHEDULE,
    **CONVERSATION_STATE_BEAT_SCHEDULE,
    **ABANDONED_PG_REPAIR_BEAT_SCHEDULE,
    **STATE_FALLBACK_RECOVERY_BEAT_SCHEDULE,
    **MSG_FALLBACK_RECOVERY_BEAT_SCHEDULE,
    **MONITOR_BEAT_SCHEDULE,
}

__all__ = [
    "cleanup_expired_agent_traces",
    "cleanup_stale_conversation_states",
    "repair_abandoned_pg_states",
    "recover_fallback_states",
    "recover_msg_fallback_states",
    "check_monitor_heartbeats",
    "TRACE_BEAT_SCHEDULE",
    "CONVERSATION_STATE_BEAT_SCHEDULE",
    "ABANDONED_PG_REPAIR_BEAT_SCHEDULE",
    "STATE_FALLBACK_RECOVERY_BEAT_SCHEDULE",
    "MSG_FALLBACK_RECOVERY_BEAT_SCHEDULE",
    "MONITOR_BEAT_SCHEDULE",
    "CLEANUP_BEAT_SCHEDULE",
]

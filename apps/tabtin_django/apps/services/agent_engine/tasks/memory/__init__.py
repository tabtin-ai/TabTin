"""
记忆系统异步任务

- capture: 记忆提取
- task_summary: 任务摘要生成
- access_count: 访问计数
- compaction: 记忆合并/压缩
- importance_adjust: 重要性动态调整 + embedding 补偿清扫
- idle_settlement: 空闲结算
- daily_diary: 每日 Agent 日记蒸馏
"""

from .compaction import COMPACTION_BEAT_SCHEDULE
from .daily_diary import DAILY_DIARY_BEAT_SCHEDULE
from .importance_adjust import IMPORTANCE_BEAT_SCHEDULE
from .idle_settlement import IDLE_SETTLEMENT_BEAT_SCHEDULE

MEMORY_BEAT_SCHEDULE = {
    **COMPACTION_BEAT_SCHEDULE,
    **DAILY_DIARY_BEAT_SCHEDULE,
    **IMPORTANCE_BEAT_SCHEDULE,
    **IDLE_SETTLEMENT_BEAT_SCHEDULE,
}

__all__ = [
    "COMPACTION_BEAT_SCHEDULE",
    "DAILY_DIARY_BEAT_SCHEDULE",
    "IMPORTANCE_BEAT_SCHEDULE",
    "IDLE_SETTLEMENT_BEAT_SCHEDULE",
    "MEMORY_BEAT_SCHEDULE",
]

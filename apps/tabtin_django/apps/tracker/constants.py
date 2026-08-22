"""Tracker 常量与枚举。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Tuple


@dataclass(frozen=True)
class ChoiceGroup:
    """简化 Django choices 的包装器。"""

    choices: Tuple[Tuple[str, str], ...]

    def as_choices(self) -> Tuple[Tuple[str, str], ...]:
        return self.choices

    def values(self) -> Iterable[str]:
        return (value for value, _ in self.choices)


# 2026-05-28 收编：SCHEDULER_* 枚举（job_type / schedule_type / session_target /
# wake_mode / job_status / run_status / run_trigger）已随 ScheduledJob 子系统整体
# 下线，并入 Tracker.trigger_type='table_event'。Tracker 的触发/状态枚举见下方
# TRACKER_* 常量。


# ─── Tracker 常量 ────────────────────────────────────────────

TRACKER_TRIGGER_TYPE_CHOICES = ChoiceGroup(
    (
        ("manual", "手动触发"),
        ("cron", "Cron 表达式"),
        ("interval", "固定间隔"),
        ("at", "一次性执行"),
        ("extension_event", "Extension 事件触发"),
        ("table_event", "表格事件触发"),
        ("webhook", "Webhook 入站触发"),
        ("tracker_completed", "上游 Tracker 完成后触发"),
    )
)

TRACKER_STATUS_CHOICES = ChoiceGroup(
    (
        ("draft", "草案"),
        ("active", "已激活"),
        ("paused", "已暂停"),
        ("disabled", "已禁用"),
        # TS-6（软删）：删除 Tracker 不再物理硬删（CASCADE 会连带删 TrackerRun
        # 审计历史，与 models.py TrackerRun「运行历史是审计资产，独立保留」自相
        # 矛盾——TS-15）。改为归档：status=archived 的 Tracker 停止触发、从列表
        # 隐藏，但所有 TrackerRun 与关联 ChatSession 全部保留。
        # 注意：archived 语义是「已删除/已归档」，与 disabled（可恢复的停用）不同。
        ("archived", "已归档"),
    )
)

# Wave 2 (charter v1.8 §6.4)：删除 TRACKER_STEP_* / STEP_RUN_STATUS_CHOICES
# ——多步骤 step 已废弃。

TRACKER_RUN_STATUS_CHOICES = ChoiceGroup(
    (
        ("pending", "等待执行"),
        ("running", "执行中"),
        # waiting_checkpoint 保留为历史 enum 值（DB 中存量记录可能存在），
        # 新写入路径不再使用——charter v1.8 §6.4 已移除 step-level checkpoint。
        ("waiting_checkpoint", "等待检查点（已废弃）"),
        # 离线韧性（2026-07）：触发时绑定设备离线/WS 不可达 → Run 挂起等设备上线，
        # 设备上线事件或看门狗轮询重投为 pending；超过等待窗口标 failed。
        ("waiting_device", "等待设备上线"),
        ("completed", "已完成"),
        ("partial_failed", "部分失败"),
        ("failed", "失败"),
        ("cancelled", "已取消"),
    )
)

# ─── 离线韧性（waiting_device / catch-up）常量 ─────────────────

# Run 挂起等设备上线的最长窗口。超窗由看门狗标 failed（个人设备可能关机数小时，
# 显式等待窗口，取更长默认值）。
WAITING_DEVICE_TIMEOUT_SECONDS = 6 * 3600

# 迟到阈值：调度迟到 ≤ 该值视为正常抖动；
# 超过才算「真错过」，进入 catchup_policy（run_once 补跑标记 / skip 跳过）分流。
MISFIRE_GRACE_SECONDS = 600

# 由本机 agent-host 持钟的触发类型。服务端 Beat 不再对这些类型发令。
HOST_OWNED_TRIGGER_TYPES = ("cron", "interval", "at")

# ─── 瞬态失败自动重试（Tracker 层）─────────────────────────────
#
# run 执行失败且 error_category 属白名单时，延迟重投同一 TrackerRun，
# 耗尽次数才落终态。与 dispatch 投递失败的 Celery retry_policy 正交。
TRANSIENT_ERROR_CATEGORIES = frozenset({
    "rate_limit",
    "device_dropped",  # 中途掉线优先走 waiting_device；若未挂起则仍可重试
    "remote_agent_timeout",
    "result_backend_unavailable",
    "llm_proxy_result_backend_unavailable",
    "llm_proxy_database_unavailable",
})
TRANSIENT_RETRY_MAX_ATTEMPTS = 2
TRANSIENT_RETRY_DELAY_SECONDS = 120
TRANSIENT_RETRY_CONTEXT_KEY = "auto_retry_attempt"
# ：同 Run 跨 attempt 复用 ChatSession 后，卡住恢复必须只认「本次 attempt」
# 之后落库的 assistant 消息，避免把上一轮失败前的阶段性汇报误判为本次完成。
CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY = "_current_attempt_started_at"
# Tracker 对话标题：
# - 旧前缀 ``[Tracker] ``：历史会话识别 / 复用时刷新为新产品文案
# - 现行落库 SSoT：``自动化任务 "…" 的第 N 次记录``（具体任务/执行）
# - 过渡文案：``自动化 "…"``；旧称：``定时任务 "…"``——识别后须刷新为现行文案，
#   否则复用会话时会被当成用户手改标题而不拨正
#   UI 若有 tracker_run 元数据可走 i18n 重算展示，列表无元数据时直接读库内标题。
# ：不做标题前缀孤儿扫描（误伤风险）；堵住新孤儿靠复用 + 同事务回填。
TRACKER_SESSION_TITLE_PREFIX = "[Tracker] "
_TRACKER_RUN_SESSION_TITLE_RE = re.compile(
    r'^(?:自动化任务|自动化|定时任务) ".+" 的第 \d+ 次记录$'
)


def build_tracker_run_session_title(tracker_name: str | None, run_index: int) -> str:
    """执行记录 ChatSession 落库标题（产品中文 SSoT）。"""
    name = (tracker_name or "").strip() or "未命名"
    idx = run_index if isinstance(run_index, int) and run_index > 0 else 1
    return f'自动化任务 "{name}" 的第 {idx} 次记录'


def is_tracker_run_session_title(title: str | None) -> bool:
    """是否为 Tracker 执行记录会话标题（[Tracker] / 现行 / 过渡 / 旧称）。"""
    text = (title or "").strip()
    if not text:
        return False
    if text.startswith(TRACKER_SESSION_TITLE_PREFIX):
        return True
    return _TRACKER_RUN_SESSION_TITLE_RE.match(text) is not None

# ─── 截断长度常量 ─────────────────────────────────────────────

OUTPUT_MAX_LEN = 5000
ERROR_MSG_MAX_LEN = 2000
DISCUSSION_MAX_LEN = 8000
NOTIFICATION_PREVIEW_LEN = 500
INSTRUCTION_PREVIEW_LEN = 200
TOOL_RESULT_PREVIEW_LEN = 200

# ─── Tracker 步骤并发：Redis 分布式信号量 ──────────────────────
# cache key 字符串值 "agenda:step_semaphore" 是稳定的 cache key namespace，
# 改 namespace 会让生产环境正在执行的 Tracker 信号量计数失效（短暂超并发风险）。
# 这里只在 Python 层把常量名改成 TRACKER_*，cache key 值保持不变。
TRACKER_STEP_SEMAPHORE_REDIS_KEY = "agenda:step_semaphore"

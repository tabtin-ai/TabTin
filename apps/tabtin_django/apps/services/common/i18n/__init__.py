"""
用户可见文案和 LLM 系统指令的集中管理。

S2 里程碑：从 ``prompts/system_directives.py`` 迁移至此，
让 agent_execution / 其他外部模块不再依赖 ``prompts/`` 目录。

分两类：
1. LLM 指令（system/user role 消息）— 发给 AI，保留英文
2. 用户可见文案（step titles、错误提示、通知）— 需要国际化
"""

from __future__ import annotations


# ---------------------------------------------------------------------------
# LLM 系统指令（发给 AI，英文）
# ---------------------------------------------------------------------------

APPROACHING_LIMIT = (
    "You are approaching the iteration limit. "
    "On your next response, please wrap up your current task "
    "and provide a summary of what was accomplished and what remains."
)

TOOL_TIMEOUT_WARNING = (
    "WARNING: The following tools timed out recently: {tools}. "
    "Do NOT retry them with the same parameters. "
    "Consider alternative approaches (e.g., background execution with polling, "
    "breaking the task into smaller steps, or skipping the operation)."
)

S5_CONTINUATION = (
    "Output token limit hit. Resume directly from where you stopped — "
    "no apology, no recap of what was done. "
    "Continue the work. If your previous turn was mid-edit or mid-command, "
    "complete it. If the task needs more steps, keep going."
)


# ---------------------------------------------------------------------------
# 用户可见文案（需要国际化）
# ---------------------------------------------------------------------------

def step_title_thinking(iteration: int) -> str:
    """迭代步骤标题。"""
    if iteration == 0:
        return "正在分析..."
    return f"思考中（第 {iteration + 1} 轮）"


def step_title_generating() -> str:
    """生成最终回复的步骤标题。"""
    return "正在生成回复"


def notice_max_iterations(count: int) -> str:
    """达到最大迭代数的通知。"""
    return (
        f"Agent 在本轮对话中执行了 {count} 个操作步骤后自动暂停，"
        "避免过度消耗。你可以发送新消息让 Agent 继续完成任务。"
    )


def notice_cancelled(iteration_count: int) -> str:
    """用户取消的通知。"""
    return f"Agent 在执行第 {iteration_count} 步时被取消。"


def error_generic(error_category: str = "internal") -> str:
    """通用错误消息。"""
    return f"[{error_category}] 处理你的请求时出现了错误，请稍后重试。"


def error_timeout(seconds: int) -> str:
    """Agent 执行超时。"""
    return f"Agent 执行超时（{seconds} 秒），请缩小任务范围后重试。"

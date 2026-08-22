"""
ExecutionProfile — 三种 Agent 执行模式的声明式配置

设计原则：
- 一个引擎（NativeReactLoop），三种人格
- Profile 是声明式配置，描述「这次执行应该怎么表现」
- 驱动 prompt 风格、工具集范围、中间件链、迭代上限、权限策略等行为差异

三种 Profile：
- conversational: 侧边栏对话模式（默认，当前行为）
- task:           任务驱动执行模式（scheduler / skill auto-run / TabAgenda Goal）
- oneshot:        单次生成模式（文档摘要、一键生成等）
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Optional

ProfileName = Literal["conversational", "task", "oneshot"]

PROFILE_CONVERSATIONAL: ProfileName = "conversational"
PROFILE_TASK: ProfileName = "task"
PROFILE_ONESHOT: ProfileName = "oneshot"


@dataclass(frozen=True)
class ExecutionProfile:
    """Agent 执行模式的声明式配置。

    每个字段描述该模式下 NativeReactLoop / ReactAgent / Prompt 应如何表现。
    字段值在 profile 创建后不可变（frozen）。
    """

    name: ProfileName

    # ── 执行控制 ──
    max_iterations: int = 500
    streaming: bool = True
    timeout_seconds: Optional[int] = None

    # ── 消费控制（BIL-17）──
    # 单次 run 的默认消费上限（点券），Agent 配置可覆盖。
    # conversational 的 500 轮 / 1000 credits 与本地 runtime DEFAULT_MAX_TURNS /
    # DEFAULT_MAX_CREDITS_PER_RUN 及设置页执行限制对齐。
    default_max_run_credits: Optional[Decimal] = Decimal("1000")

    # ── 上下文 ──
    conversation_history: bool = True
    context_pruning: bool = True

    # ── 工具 ──
    authorization_preset: Literal["cautious", "collaborative", "full_auto", "server_auto", ""] = ""

    # ── 输出 ──
    output_format: Literal["stream_events", "structured", "content"] = "stream_events"

    # ── Prompt ──
    prompt_style: Literal["interactive", "execution", "generation"] = "interactive"

    # ── 中间件 ──
    enable_doom_loop_guard: bool = True
    enable_context_pressure: bool = True
    enable_todo_middleware: bool = True
    enable_title_generation: bool = True

    # ── 成本控制 ──
    prefer_fast_model: bool = False


# ── 预定义 Profile 实例 ──

CONVERSATIONAL = ExecutionProfile(
    name="conversational",
    max_iterations=500,
    default_max_run_credits=Decimal("1000"),
    streaming=True,
    conversation_history=True,
    context_pruning=True,
    authorization_preset="",
    output_format="stream_events",
    prompt_style="interactive",
    enable_doom_loop_guard=True,
    enable_context_pressure=True,
    enable_todo_middleware=True,
    enable_title_generation=True,
    prefer_fast_model=False,
)

TASK = ExecutionProfile(
    name="task",
    max_iterations=500,
    default_max_run_credits=Decimal("30"),
    streaming=False,
    timeout_seconds=300,
    conversation_history=False,
    context_pruning=False,
    authorization_preset="server_auto",
    output_format="structured",
    prompt_style="execution",
    enable_doom_loop_guard=True,
    enable_context_pressure=False,
    enable_todo_middleware=False,
    enable_title_generation=False,
    prefer_fast_model=False,
)

ONESHOT = ExecutionProfile(
    name="oneshot",
    max_iterations=10,
    default_max_run_credits=Decimal("10"),
    streaming=True,
    conversation_history=False,
    context_pruning=False,
    authorization_preset="server_auto",
    output_format="content",
    prompt_style="generation",
    enable_doom_loop_guard=False,
    enable_context_pressure=False,
    enable_todo_middleware=False,
    enable_title_generation=False,
    prefer_fast_model=True,
)

_PROFILES = {
    "conversational": CONVERSATIONAL,
    "task": TASK,
    "oneshot": ONESHOT,
}


def get_profile(name: str | ProfileName) -> ExecutionProfile:
    """根据名称获取预定义 Profile，未知名称回退 conversational。"""
    return _PROFILES.get(name, CONVERSATIONAL)


__all__ = [
    "ExecutionProfile",
    "ProfileName",
    "PROFILE_CONVERSATIONAL",
    "PROFILE_TASK",
    "PROFILE_ONESHOT",
    "CONVERSATIONAL",
    "TASK",
    "ONESHOT",
    "get_profile",
]

"""
AgentMode — 用户可见的 Agent 交互模式（用户层）

设计正交性：
- ExecutionProfile（conversational/task/oneshot）：控制 Agent **怎么执行**（面向系统/自动化）
- AgentMode（ask/agent/plan/study）：控制 Agent **做什么类型的事**（面向用户交互）
- SubagentTaskType（explore/plan/execute）：控制子 Agent 的**任务角色**（面向系统编排）

AgentMode 与 SubagentTaskType 的 "plan" 区别：
- AgentMode.plan：面向用户的规划讨论，产出行动计划，引导切换到 agent 模式执行
- SubagentTaskType "plan"：面向主 Agent 的架构规划，产出技术方案，供主 Agent 消费

工具过滤：由 BaseTool.available_modes 声明（工具侧自声明），不再由 AgentMode 维护黑白名单。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

AgentModeName = Literal["ask", "agent", "plan", "study", "yolo", "group"]

AGENT_MODE_ASK: AgentModeName = "ask"
AGENT_MODE_AGENT: AgentModeName = "agent"
AGENT_MODE_PLAN: AgentModeName = "plan"
AGENT_MODE_STUDY: AgentModeName = "study"
AGENT_MODE_YOLO: AgentModeName = "yolo"
AGENT_MODE_GROUP: AgentModeName = "group"

ALL_AGENT_MODES: tuple[AgentModeName, ...] = (
    "ask",
    "agent",
    "plan",
    "study",
    "yolo",
    "group",
)


@dataclass(frozen=True)
class AgentMode:
    """Agent 交互模式的声明式配置。

    Attributes:
        name: 模式标识
        label: 显示名称
        authorization_preset: 授权策略（cautious / collaborative）
        max_iterations: 迭代上限覆盖，None 表示使用 profile 默认值
        skip_execution_section: 是否跳过 <execution> prompt section（非 agent 模式替换为模式专属指令）
    """

    name: AgentModeName
    label: str
    authorization_preset: str
    max_iterations: Optional[int]
    skip_execution_section: bool


# ---------------------------------------------------------------------------
# 预设实例
# ---------------------------------------------------------------------------

ASK = AgentMode(
    name="ask",
    label="问答 (Ask)",
    authorization_preset="cautious",
    max_iterations=10,
    skip_execution_section=True,
)

AGENT = AgentMode(
    name="agent",
    label="执行 (Agent)",
    authorization_preset="collaborative",
    max_iterations=None,
    skip_execution_section=False,
)

PLAN = AgentMode(
    name="plan",
    label="规划 (Plan)",
    authorization_preset="cautious",
    max_iterations=15,
    skip_execution_section=True,
)

STUDY = AgentMode(
    name="study",
    label="学习 (Study)",
    authorization_preset="collaborative",
    max_iterations=25,
    skip_execution_section=True,
)

GROUP = AgentMode(
    name="group",
    label="PMO",
    authorization_preset="collaborative",
    max_iterations=50,
    skip_execution_section=True,
)

# PR1 (2026-05-18) — Yolo 模式:
#   - 工具集语义同 agent / group（contract 中复用 `ALL_MODE_POLICY`,kind='all'）。
#   - `authorization_preset='full_auto'`：daemon 路径下激活 sandbox `full_auto` preset,
#     Electron 本地 runtime 由 PR2 judge.ts step3 实施 ask→allow 旁路。
#   - `max_iterations=None`：与 agent 对齐表示无限迭代（不引入新字段,本表沿用 None 语义）。
#   - `skip_execution_section=False`：和 agent 一样进入 <execution> 段,不走受限模式
#     的额外 prompt section。
YOLO = AgentMode(
    name="yolo",
    label="全自动 (Yolo)",
    authorization_preset="full_auto",
    max_iterations=None,
    skip_execution_section=False,
)

_MODES: dict[AgentModeName, AgentMode] = {
    "ask": ASK,
    "agent": AGENT,
    "plan": PLAN,
    "study": STUDY,
    "yolo": YOLO,
    "group": GROUP,
}


def get_agent_mode(name: str | AgentModeName | None) -> AgentMode:
    """根据名称获取预定义 AgentMode，未知名称回退 agent。"""
    if not name:
        return AGENT
    return _MODES.get(name, AGENT)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Subagent 约束矩阵：各 AgentMode 下允许 spawn 的 SubagentTaskType
# ---------------------------------------------------------------------------

AGENT_MODE_SUBAGENT_CONSTRAINTS: dict[AgentModeName, frozenset[str] | None] = {
    "ask":   frozenset({"explore"}),
    "agent": None,
    "plan":  frozenset({"explore", "plan"}),
    "study": frozenset({"explore", "plan"}),
    # PR1 (2026-05-18) — Yolo 与 agent 工具集等价,子 Agent 派单也不受限。
    "yolo":  None,
    "group": None,
}


__all__ = [
    "AgentMode",
    "AgentModeName",
    "AGENT_MODE_ASK",
    "AGENT_MODE_AGENT",
    "AGENT_MODE_PLAN",
    "AGENT_MODE_STUDY",
    "AGENT_MODE_YOLO",
    "AGENT_MODE_GROUP",
    "ALL_AGENT_MODES",
    "ASK",
    "AGENT",
    "PLAN",
    "STUDY",
    "YOLO",
    "GROUP",
    "get_agent_mode",
    "AGENT_MODE_SUBAGENT_CONSTRAINTS",
]

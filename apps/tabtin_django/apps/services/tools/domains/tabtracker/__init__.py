"""tabtracker FC tools 域已下线。

Tracker 模块收敛波次 1（2026-05-20）执行方案 B 决定：
- 移除 ``CreateTrackedTaskTool`` / ``ListTrackedTasksTool`` / ``GetTaskStatusTool`` /
  ``TriggerTaskTool`` / ``PauseTaskTool`` / ``ResumeTaskTool`` 六件 FC 工具。
- Agent 创建 / 操作 Tracker **全部走 CLI**：``run_terminal_command + tabtin tracker ...``
  （charter v1.8 §6.8 + AGENTS.md「CLI-first，不是 FC-first」决策）。
- 保留空 provider 函数避免外部调用方 ImportError；ToolHub 注册侧实际上 W6 后
  已经把 tabtracker 域列入 forbidden（详见 ``test_tool_contract_cleanup.py``），
  这里仅保留软兼容 API 形态。

历史 :file:`tracker_tools.py` 与 :file:`tests/test_intent_corpus.py` 已删除。
"""


def get_all_tools():
    """tabtracker 域空 provider — 波次 1 后无任何 BaseTool 工具。

    保留函数符号以避免外部调用方 ImportError。
    """
    return []


def get_tracker_tools():
    """旧 ``get_tracker_tools`` 符号——保留空实现避免运行时 ImportError。"""
    return []


__all__ = ['get_all_tools', 'get_tracker_tools']

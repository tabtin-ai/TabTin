"""Think Tool Registry — 工具发现与子 Agent 编排域

W10 cleanup: ``task_tool`` was removed together with subagent_tool /
parallel_subagent_tool / resume_subagent_tool — those server-side tools
relied on ``SubagentFactory`` which depended on the now-deleted ``ReactAgent``.
Sub-agent spawning is provided by the client runtime's own ``agent`` tool
(``createAgentTool`` in ``packages/agent-runtime``).

Wave 4.5 (2026-05-10): ``think_tool`` removed — 让 LLM 通过原生 thinking
block 反思，不再外化成独立工具；the registry now only exposes ``tool_search``. The directory
name "think" is preserved for git history / import stability; rename to
e.g. "discovery" can be folded into a future tool-domain restructure.
"""

from typing import List
import logging

from apps.services.tools import BaseTool
from apps.services.tools.domains.think.tool_search_tool import tool_search_tool

logger = logging.getLogger(__name__)

_TOOLS = [tool_search_tool]
_TOOL_MAP = {t.name: t for t in _TOOLS}


def get_all_tools() -> List[BaseTool]:
    return list(_TOOLS)


def get_tool_by_name(tool_name: str) -> BaseTool | None:
    tool = _TOOL_MAP.get(tool_name)
    if not tool:
        logger.warning("[ThinkRegistry] Tool not found: %s", tool_name)
    return tool


def get_tool_info() -> List[dict]:
    return [
        {
            "name": t.name,
            "description": t.description,
            "timeout": t.timeout,
            "requires_permission": t.requires_permission,
            "class_name": t.__class__.__name__,
        }
        for t in _TOOLS
    ]


__all__ = ["get_all_tools", "get_tool_by_name", "get_tool_info"]

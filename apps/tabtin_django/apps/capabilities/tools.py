"""
Capabilities 工具 — 注册到 ToolHub 供 Agent 调用

提供：
- discover_tools: Agent 通过自然语言发现平台上可用的工具
- tabtin.search:  统一搜索引擎 FC 入口（Wave 4，PRD 3.9.B）
"""

import json
import logging
from typing import List, Optional, Type

from pydantic import BaseModel, Field

from apps.services.tools import BaseTool

logger = logging.getLogger(__name__)


# ─── discover_tools ──────────────────────────────────────

class DiscoverToolsInput(BaseModel):
    query: str = Field(description="描述你想要查找的工具能力，如'操作数据库的工具'、'生成图片'")
    top_k: int = Field(default=5, ge=1, le=50, description="返回的最大结果数")
    category: Optional[str] = Field(
        default=None,
        description="可选过滤：app / runtime / service / extension / platform / custom",
    )


class DiscoverToolsTool(BaseTool):
    name: str = "discover_tools"
    description: str = (
        "通过自然语言查找平台上可用的工具。"
        "当你不确定有哪些工具可用、或需要查找特定功能的工具时使用。"
        "返回匹配的工具列表及其说明。"
    )
    args_schema: Type[BaseModel] = DiscoverToolsInput

    def run(self, query: str, top_k: int = 5, category: Optional[str] = None, **kwargs) -> str:
        from apps.capabilities.services.agent_resolve import AgentResolveService

        tools = AgentResolveService.discover_tools(
            query=query, top_k=top_k, category=category,
        )

        if not tools:
            return json.dumps({"message": f"未找到与 '{query}' 匹配的工具", "tools": []})

        related_skills = AgentResolveService.get_related_skills_for_tools(
            [t["name"] for t in tools],
        )

        return json.dumps({
            "tools": tools,
            "related_skills": related_skills,
            "hint": "找到匹配工具后，如有关联的 Skill，建议先读取 Skill 了解最佳实践",
        }, ensure_ascii=False)



def get_capabilities_tools() -> List[BaseTool]:
    # Wave 4 R-FC：tabtin.search 也通过 capabilities provider 注册到 ToolHub，
    # 与 DiscoverToolsTool 同一注册路径（apps/services/tools/domains/registry.py:179）。
    # 本工具直接 import apps.fts.services.search_service.search，零 HTTP 一跳。
    from apps.capabilities.search_tool import SearchTool
    return [DiscoverToolsTool(), SearchTool()]

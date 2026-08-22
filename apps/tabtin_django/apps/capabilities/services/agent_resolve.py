"""
AgentResolveService — Agent 能力解析服务

提供 Agent 运行时使用的能力解析接口，包括：
1. 按上下文解析可用工具集
2. 按自然语言查询发现工具
3. 为工具推荐相关 Skill
"""

import logging
from typing import Any, Dict, List, Optional, Set

from apps.capabilities.constants import CAPABILITIES_DB as DB, MAX_DESCRIPTION_PREVIEW as MAX_DESC_PREVIEW

logger = logging.getLogger(__name__)


class AgentResolveService:
    """Agent 运行时能力解析。"""

    @staticmethod
    def resolve_tools_for_context(
        app_types: Optional[List[str]] = None,
        categories: Optional[List[str]] = None,
        domains: Optional[List[str]] = None,
        include_optional: bool = False,
    ) -> List[Dict[str, Any]]:
        """根据 Agent 当前上下文解析可用的工具列表。

        相比 ToolHub 的硬编码域映射，这里直接查 DB 并支持更灵活的过滤。
        """
        from apps.capabilities.models import RegisteredTool
        from django.db.models import Q

        qs = RegisteredTool.objects.using(DB).filter(status="active")

        if not include_optional:
            qs = qs.filter(optional=False)

        filters = Q()
        if app_types:
            filters |= Q(provider_id__in=app_types)
        if categories:
            filters |= Q(category__in=categories)
        if domains:
            filters |= Q(domain__in=domains)

        if filters:
            qs = qs.filter(filters)

        return [
            {
                "name": t.name,
                "display_name": t.display_name,
                "description": (t.description or "")[:MAX_DESC_PREVIEW],
                "category": t.category,
                "provider_id": t.provider_id,
                "domain": t.domain,
                "execution_target": t.execution_target,
            }
            for t in qs
        ]

    @staticmethod
    def discover_tools(
        query: str,
        top_k: int = 5,
        category: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Agent 通过自然语言发现工具。

        包装 ToolEmbeddingService.search，简化返回格式。
        """
        try:
            from apps.capabilities.services.tool_embedding import ToolEmbeddingService
            results = ToolEmbeddingService.search(
                query=query,
                top_k=top_k,
                category=category,
                similarity_threshold=0.45,
            )
            return [
                {
                    "name": r["tool"]["name"],
                    "description": r["tool"]["description"],
                    "domain": r["tool"]["domain"],
                    "score": round(r["score"], 3),
                }
                for r in results
            ]
        except Exception:
            logger.warning("[AgentResolve] 语义工具发现失败", exc_info=True)
            return []

    @staticmethod
    def get_related_skills_for_tools(tool_names: List[str]) -> List[Dict[str, Any]]:
        """给定一组工具名，返回相关的 Skill。"""
        from apps.capabilities.models import ToolSkillLink

        links = (
            ToolSkillLink.objects.using(DB)
            .filter(tool_name__in=tool_names)
            .values("tool_name", "skill_key", "relation_type")
        )

        skill_map: Dict[str, Dict[str, Any]] = {}
        for link in links:
            sk = link["skill_key"]
            if sk not in skill_map:
                skill_map[sk] = {
                    "skill_key": sk,
                    "related_tools": [],
                    "relation_types": set(),
                }
            skill_map[sk]["related_tools"].append(link["tool_name"])
            skill_map[sk]["relation_types"].add(link["relation_type"])

        results = []
        for skill in skill_map.values():
            skill["relation_types"] = sorted(skill["relation_types"])
            results.append(skill)
        return results

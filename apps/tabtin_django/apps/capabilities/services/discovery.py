"""
DiscoveryService — 统一发现服务

同时搜索工具和 Skill，合并结果并按相关度排序返回。
"""

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class DiscoveryService:
    """统一发现：同时搜索 Tool 和 Skill。"""

    @staticmethod
    def discover(
        query: str,
        top_k: int = 10,
        include_tools: bool = True,
        include_skills: bool = True,
        category: Optional[str] = None,
    ) -> Dict[str, Any]:
        """统一搜索工具和 Skill。

        Returns:
            {
                "query": "...",
                "tools": [{"tool": {...}, "score": 0.85}, ...],
                "skills": [{"skill_key": "...", "score": 0.80}, ...],
                "links": [{"tool_name": "...", "skill_key": "...", ...}, ...],
            }
        """
        result: Dict[str, Any] = {"query": query, "tools": [], "skills": [], "links": []}

        tool_names = set()

        if include_tools:
            result["tools"] = _search_tools(query, top_k, category)
            tool_names = {r["tool"]["name"] for r in result["tools"]}

        if include_skills:
            result["skills"] = _search_skills(query, top_k)

        if tool_names or result["skills"]:
            result["links"] = _find_related_links(
                tool_names,
                {s.get("skill_key", "") for s in result["skills"]},
            )

        return result


def _search_tools(
    query: str, top_k: int, category: Optional[str],
) -> List[Dict[str, Any]]:
    try:
        from apps.capabilities.services.tool_embedding import ToolEmbeddingService
        return ToolEmbeddingService.search(
            query=query, top_k=top_k, category=category,
        )
    except Exception:
        logger.warning("[Discovery] 工具搜索失败", exc_info=True)
        return []


def _search_skills(query: str, top_k: int) -> List[Dict[str, Any]]:
    try:
        from apps.skills.services.embedding_service import SkillEmbeddingService
        return SkillEmbeddingService.search(
            query=query, top_k=top_k,
        )
    except ImportError:
        logger.debug("[Discovery] SkillEmbeddingService 不可用")
        return []
    except Exception:
        logger.warning("[Discovery] Skill 搜索失败", exc_info=True)
        return []


def _find_related_links(
    tool_names: set, skill_keys: set,
) -> List[Dict[str, str]]:
    """查找搜索结果中工具和 Skill 之间的关联。"""
    if not tool_names and not skill_keys:
        return []

    try:
        from apps.capabilities.models import ToolSkillLink
        from django.db.models import Q

        q = Q()
        if tool_names:
            q |= Q(tool_name__in=tool_names)
        if skill_keys:
            q |= Q(skill_key__in=skill_keys)

        from apps.capabilities.constants import CAPABILITIES_DB
        links = ToolSkillLink.objects.using(CAPABILITIES_DB).filter(q)
        return [
            {
                "tool_name": link.tool_name,
                "skill_key": link.skill_key,
                "relation_type": link.relation_type,
            }
            for link in links
        ]
    except Exception:
        logger.warning("[Discovery] 关联查询失败", exc_info=True)
        return []

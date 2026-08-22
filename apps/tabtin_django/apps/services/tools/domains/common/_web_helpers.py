"""
Shared web helpers for common web tools (web_search / web_fetch).

统一走 apps.services.search，避免工具层各自接第三方搜索。
"""

from __future__ import annotations

import logging
from typing import Iterable, Optional

from apps.services.search import SearchService
from apps.services.tools.error_envelope import tool_result_success

logger = logging.getLogger(__name__)


def do_web_search(
    query: str,
    max_results: int = 8,
    *,
    freshness: Optional[str] = None,
    include_summary: Optional[bool] = None,
    include_domains: Iterable[str] | None = None,
    exclude_domains: Iterable[str] | None = None,
    organization_id: str | None = None,
    user_id: str | None = None,
    thread_id: str | None = None,
) -> str:
    if not user_id:
        logger.warning("[web_search] user_id 为空，搜索计费将无法归属到具体用户: ws=%s", organization_id)

    result = SearchService.search(
        query=query,
        count=max_results,
        summary=include_summary,
        freshness=freshness,
        include_domains=include_domains,
        exclude_domains=exclude_domains,
        organization_id=organization_id,
        user_id=user_id,
        thread_id=thread_id,
        biz_type="orchestration.web_search",
    )
    return tool_result_success(SearchService.format_for_llm(result))

"""
公共搜索 API — 供本地 Runtime 等客户端调用。

POST /api/search/web
"""

import logging
from typing import List, Optional

from ninja import Router, Schema
from pydantic import Field

from apps.users.auth.api import jwt_auth
from apps.i18n.response import success_response, error_response_with_status
from apps.services.search.services.invocation_identity import (
    SearchInvocationValidationError,
    resolve_verified_search_invocation,
)

logger = logging.getLogger(__name__)

router = Router(tags=["Search"])


class WebSearchRequest(Schema):
    query: str = Field(description="搜索词")
    count: int = Field(default=8, ge=1, le=50, description="结果数量")
    freshness: Optional[str] = Field(default=None, description="时间过滤")
    summary: Optional[bool] = Field(default=None, description="是否返回 AI 摘要")
    include_domains: Optional[List[str]] = Field(default=None)
    exclude_domains: Optional[List[str]] = Field(default=None)
    biz_type: str = Field(default="search.web", description="计费来源标识")
    agent_run_id: Optional[str] = Field(
        default=None,
        max_length=128,
        description="Agent 执行 Run ID",
    )
    client_tool_invocation_component: Optional[str] = Field(
        default=None,
        max_length=255,
        description="客户端稳定工具调用标识",
    )


class WebSearchResultItem(Schema):
    title: Optional[str] = None
    url: Optional[str] = None
    snippet: Optional[str] = None


class WebSearchResponse(Schema):
    results: List[WebSearchResultItem] = []
    total_count: int = 0
    summary: Optional[str] = None


@router.post("/web", auth=jwt_auth)
def web_search(request, data: WebSearchRequest):
    """联网搜索（含计费守卫）。"""
    from apps.services.search import SearchService, SearchProviderError

    from apps.services.billing.organization_resolver import resolve_organization_id_from_request

    try:
        user = request.auth
        # E1：付费搜索必须能归属到可计费 organization，否则会变成不计费的免费调用。
        # 显式上下文优先，无则回退到用户个人 organization（仍走五层预检 + 扣费）。
        organization_id = resolve_organization_id_from_request(request, fallback_to_personal=True) or None
        verified_invocation = resolve_verified_search_invocation(
            authenticated_user=user,
            organization_id=organization_id,
            agent_run_id=data.agent_run_id,
            client_tool_invocation_component=data.client_tool_invocation_component,
        )
        result = SearchService.search(
            query=data.query,
            count=data.count,
            summary=data.summary,
            freshness=data.freshness,
            include_domains=data.include_domains,
            exclude_domains=data.exclude_domains,
            organization_id=organization_id,
            user_id=str(user.id),
            biz_type=data.biz_type,
            verified_invocation=verified_invocation,
        )
    except SearchInvocationValidationError as exc:
        return error_response_with_status(
            exc.code.upper(),
            message=str(exc),
            status_code=exc.status_code,
        )
    except SearchProviderError as exc:
        code = getattr(exc, "code", "search_error")
        if exc.status_code in {409, 425, 503}:
            return error_response_with_status(
                code.upper(),
                message=str(exc),
                status_code=exc.status_code,
            )
        if "billing" in code or "disabled" in code:
            return error_response_with_status("BILLING_ERROR", message=str(exc), status_code=402)
        return error_response_with_status("SEARCH_ERROR", message=str(exc), status_code=502)
    except Exception as exc:
        logger.exception("[search/web] unexpected error")
        return error_response_with_status(
            "INTERNAL_ERROR", message=f"搜索服务异常: {exc}", status_code=500,
        )

    items = [
        WebSearchResultItem(
            title=page.name,
            url=page.url,
            snippet=page.summary or page.snippet or "",
        )
        for page in (result.web_pages or [])[:data.count]
    ]

    resp = WebSearchResponse(
        results=items,
        total_count=result.total_estimated_matches or len(items),
        summary=getattr(result, "answer_text", None),
    )
    return success_response(data=resp.model_dump(mode="json"))

"""
web_search — Search the web for real-time information.

Runs on the backend using the unified search service.
"""

import logging
from typing import Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import json_tool_error

logger = logging.getLogger(__name__)

_SEARCH_CONFIG_CODES = frozenset({
    "search_provider_api_key_missing",
    "search_provider_inactive",
    "search_provider_unsupported",
})

_SEARCH_BILLING_QUOTA_CODES = frozenset({
    "search_billing_budget_exceeded",
    "search_billing_member_budget",
})



def _classify_search_provider_error(exc: Exception) -> tuple[str, str, str, bool, str | None]:
    from apps.services.search import SearchProviderError

    if not isinstance(exc, SearchProviderError):
        return (
            "The web search request could not be completed.",
            "internal_error",
            "Retry web_search once. If it fails again, ask the user for help instead of repeating it.",
            False,
            None,
        )

    code = (getattr(exc, "code", None) or "search_provider_error").strip()
    if code == "search_query_required":
        return (
            "search_term is required",
            "missing_required_param",
            "Provide the web search query in search_term before calling web_search.",
            False,
            code,
        )

    if code in _SEARCH_CONFIG_CODES:
        return (
            "The search service is not configured.",
            "runtime_misconfig",
            "Tell the user the search provider is unavailable due to server configuration. Do not retry web_search on this path. "
            "If the target site is well known, you may open its domain homepage and navigate via real in-page links; "
            "never guess deeper URL paths. Otherwise ask the user for the exact URL.",
            False,
            code,
        )

    if "billing" in code or code.startswith("search_billing_") or code == "search_service_disabled":
        if code in _SEARCH_BILLING_QUOTA_CODES:
            return (
                "Web search is blocked by billing quota limits.",
                "rate_limited",
                "Wait a moment or ask the user to increase the organization search budget, then retry web_search.",
                False,
                code,
            )
        return (
            "Web search is blocked by billing limits.",
            "permission_denied",
            "Ask the user to check organization billing balance or search access before retrying web_search.",
            False,
            code,
        )

    return (
        "The search provider could not complete the request.",
        "upstream_error",
        "Retry web_search once. If it fails again, tell the user the search service is unavailable and stop retrying this path. "
        "If the target site is well known, you may open its domain homepage and navigate via real in-page links; "
        "never guess deeper URL paths. Otherwise ask the user for the exact URL.",
        True,
        code,
    )


class WebSearchInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None,
        description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None,
        description="组织 ID（自动注入）",
    )
    thread_id: Annotated[Optional[str], InjectedState("thread_id")] = Field(
        default=None,
        description="线程 ID（自动注入）",
    )
    search_term: str = Field(
        description="The search term to look up. Be specific and include relevant keywords.",
    )
    count: int = Field(
        default=8,
        ge=1,
        le=50,
        description="Maximum number of search results to retrieve.",
    )
    freshness: Optional[str] = Field(
        default=None,
        description=(
            "Optional time range filter. "
            "Supports noLimit / oneDay / oneWeek / oneMonth / oneYear / "
            "YYYY-MM-DD / YYYY-MM-DD..YYYY-MM-DD."
        ),
    )
    include_summary: Optional[bool] = Field(
        default=None,
        description="Whether to request provider summaries. Leave empty to use server default.",
    )
    include_domains: Optional[list[str]] = Field(
        default=None,
        description="Optional allowlist of domains to include.",
    )
    exclude_domains: Optional[list[str]] = Field(
        default=None,
        description="Optional blocklist of domains to exclude.",
    )
    explanation: Optional[str] = Field(
        default=None,
        description="Brief explanation of why this search is needed.",
    )


class WebSearchTool(BaseTool):
    category: str = "web"
    name: str = "web_search"
    description: str = (
        "Search the web for real-time information via server-side execution. "
        "Use when you need up-to-date library docs, API references, current events, "
        "or any information that may not be in your training data. "
        "Returns summarized results with source URLs. Include version/year for best results."
    )
    execution_mode: str = "server"
    timeout: int = 30
    cacheable: bool = True
    cache_ttl: int = 300
    args_schema: type[WebSearchInput] = WebSearchInput
    risk_level: str = "safe"
    required_permissions: list[str] = []

    def run(
        self,
        search_term: str,
        count: int = 8,
        freshness: Optional[str] = None,
        include_summary: Optional[bool] = None,
        include_domains: Optional[list[str]] = None,
        exclude_domains: Optional[list[str]] = None,
        explanation: Optional[str] = None,
        user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> str:
        if not search_term or not search_term.strip():
            return json_tool_error(
                "search_term is required",
                error_kind="missing_required_param",
                hint="Provide the web search query in search_term before calling web_search.",
                retryable=False,
            )

        try:
            from apps.services.tools.domains.common._web_helpers import do_web_search
            return do_web_search(
                search_term.strip(),
                max_results=count,
                freshness=freshness,
                include_summary=include_summary,
                include_domains=include_domains,
                exclude_domains=exclude_domains,
                organization_id=organization_id,
                user_id=user_id,
                thread_id=thread_id,
            )
        except Exception as exc:
            logger.warning("[web_search] failed: %s", exc)
            message, error_kind, hint, retryable, upstream_code = _classify_search_provider_error(exc)
            return json_tool_error(
                message,
                error_kind=error_kind,
                hint=hint,
                retryable=retryable,
                upstream_code=upstream_code,
            )


__all__ = ["WebSearchTool"]

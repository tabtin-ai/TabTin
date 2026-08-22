from __future__ import annotations

import re
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import requests

from apps.services.search.services.base import (
    BaseSearchProvider,
    SearchProviderError,
    SearchProviderOutcomeUnknown,
)
from apps.services.search.services.types import (
    SearchImageResult,
    SearchRequest,
    SearchResponse,
    SearchVideoResult,
    SearchWebPageResult,
)

# 千帆文档：content 长度限制 72 个字符（一个汉字占两个字符），超长只取前 72。
_QIANFAN_QUERY_CHAR_BUDGET = 72

_FRESHNESS_TO_RECENCY = {
    "noLimit": "",
    "day": "week",
    "oneDay": "week",
    "week": "week",
    "oneWeek": "week",
    "month": "month",
    "oneMonth": "month",
    "semiyear": "semiyear",
    "year": "year",
    "oneYear": "year",
}


class QianfanSearchProvider(BaseSearchProvider):
    provider_type = "qianfan"

    def search(self, request: SearchRequest) -> SearchResponse:
        endpoint = self._resolve_endpoint(self.config.base_url)
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        # 兼容 AppBuilder 文档示例头；默认仍走 Authorization。
        auth_header = str((self.config.extra_config or {}).get("auth_header") or "").strip()
        if auth_header:
            headers[auth_header] = f"Bearer {self.config.api_key}"

        query = self._truncate_query(request.query)
        top_k = max(1, min(int(request.count or 1), 50))
        payload: dict[str, Any] = {
            "messages": [{"role": "user", "content": query}],
            "search_source": str(
                (self.config.extra_config or {}).get("search_source") or "baidu_search_v2"
            ),
            "resource_type_filter": [{"type": "web", "top_k": top_k}],
        }

        recency = _FRESHNESS_TO_RECENCY.get((request.freshness or "").strip(), "")
        if recency:
            payload["search_recency_filter"] = recency

        search_filter: dict[str, Any] = {}
        sites = self._split_sites(request.include)
        if sites:
            search_filter["match"] = {"site": sites}
        blocked = self._split_sites(request.exclude)
        if blocked:
            search_filter["block_websites"] = blocked
        if search_filter:
            payload["search_filter"] = search_filter

        started = time.monotonic()
        try:
            response = requests.post(
                endpoint,
                json=payload,
                headers=headers,
                timeout=self.config.request_timeout_sec,
            )
        except requests.RequestException as exc:
            raise SearchProviderOutcomeUnknown(
                f"千帆搜索请求失败: {exc}",
                provider_key=self.config.provider_key,
                code="qianfan_request_failed",
            ) from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        data = self._parse_response(response)
        references = data.get("references") or []
        if not isinstance(references, list):
            references = []

        web_pages: list[SearchWebPageResult] = []
        images: list[SearchImageResult] = []
        videos: list[SearchVideoResult] = []

        for item in references:
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "web").strip().lower()
            if item_type == "image":
                image_node = item.get("image") if isinstance(item.get("image"), dict) else {}
                content_url = str(image_node.get("url") or item.get("url") or "")
                if not content_url:
                    continue
                images.append(
                    SearchImageResult(
                        name=str(item.get("title") or item.get("web_anchor") or ""),
                        content_url=content_url,
                        host_page_url=str(item.get("url") or ""),
                        thumbnail_url=content_url,
                        width=self._as_int(image_node.get("width")),
                        height=self._as_int(image_node.get("height")),
                        date_published=str(item.get("date") or ""),
                    )
                )
                continue

            if item_type == "video":
                video_node = item.get("video") if isinstance(item.get("video"), dict) else {}
                content_url = str(video_node.get("url") or "")
                host_page_url = str(item.get("url") or "")
                if not content_url and not host_page_url:
                    continue
                videos.append(
                    SearchVideoResult(
                        name=str(item.get("title") or item.get("web_anchor") or ""),
                        content_url=content_url,
                        host_page_url=host_page_url,
                        thumbnail_url=str(video_node.get("hover_pic") or ""),
                        description=str(item.get("snippet") or item.get("content") or ""),
                        duration=str(video_node.get("duration") or ""),
                        width=self._as_int(video_node.get("width")),
                        height=self._as_int(video_node.get("height")),
                        date_published=str(item.get("date") or ""),
                    )
                )
                continue

            url = str(item.get("url") or "")
            if not url:
                continue
            snippet = str(item.get("snippet") or item.get("content") or "")
            title = str(item.get("title") or item.get("web_anchor") or "")
            site_name = str(item.get("website") or "")
            if not site_name:
                try:
                    site_name = urlparse(url).netloc
                except Exception:
                    site_name = ""
            web_pages.append(
                SearchWebPageResult(
                    name=title,
                    url=url,
                    display_url=url,
                    snippet=snippet,
                    summary=snippet if request.summary else "",
                    site_name=site_name,
                    site_icon=str(item.get("icon") or ""),
                    date_published=str(item.get("date") or ""),
                )
            )

        return SearchResponse(
            provider_key=self.config.provider_key,
            provider_type=self.config.provider_type,
            provider_display_name=self.config.display_name,
            request_id=str(data.get("request_id") or uuid.uuid4().hex),
            query=request.query,
            count=request.count,
            summary_enabled=request.summary,
            freshness=request.freshness,
            total_estimated_matches=len(web_pages),
            web_pages=web_pages,
            images=images,
            videos=videos,
            provider_log_id=str(data.get("request_id") or ""),
            latency_ms=latency_ms,
            raw=data,
        )

    @staticmethod
    def _truncate_query(query: str) -> str:
        text = (query or "").strip()
        if not text:
            return text
        budget = _QIANFAN_QUERY_CHAR_BUDGET
        used = 0
        chars: list[str] = []
        for ch in text:
            cost = 2 if ord(ch) > 127 else 1
            if used + cost > budget:
                break
            chars.append(ch)
            used += cost
        return "".join(chars)

    @staticmethod
    def _split_sites(raw: str) -> list[str]:
        if not raw:
            return []
        parts = re.split(r"[\s,;|]+", raw.strip())
        return [part.strip() for part in parts if part.strip()]

    @staticmethod
    def _as_int(value: Any) -> int:
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _resolve_endpoint(base_url: str) -> str:
        normalized = (base_url or "").rstrip("/")
        if normalized.endswith("/web_search"):
            return normalized
        if normalized.endswith("/ai_search"):
            return f"{normalized}/web_search"
        if normalized.endswith("/v2"):
            return f"{normalized}/ai_search/web_search"
        return f"{normalized}/v2/ai_search/web_search"

    def _parse_response(self, response: requests.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except ValueError as exc:
            error_type = (
                SearchProviderError
                if response.status_code >= 400
                else SearchProviderOutcomeUnknown
            )
            raise error_type(
                "千帆搜索返回了无法解析的响应",
                provider_key=self.config.provider_key,
                status_code=response.status_code,
                code="qianfan_invalid_json",
            ) from exc

        if not isinstance(payload, dict):
            error_type = (
                SearchProviderError
                if response.status_code >= 400
                else SearchProviderOutcomeUnknown
            )
            raise error_type(
                "千帆搜索返回了非对象响应",
                provider_key=self.config.provider_key,
                status_code=response.status_code,
                code="qianfan_invalid_payload",
            )

        error_code = payload.get("code")
        error_message = payload.get("message") or payload.get("msg")
        if response.status_code >= 400 or error_code not in (None, "", 0, "0"):
            message = error_message or response.text[:200] or f"HTTP {response.status_code}"
            raise SearchProviderError(
                f"千帆搜索失败: {message}",
                provider_key=self.config.provider_key,
                status_code=response.status_code,
                code="qianfan_http_error",
                details=payload,
            )
        return payload

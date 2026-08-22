from __future__ import annotations

import time
import uuid
from typing import Any

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


class BochaSearchProvider(BaseSearchProvider):
    provider_type = "bocha"

    def search(self, request: SearchRequest) -> SearchResponse:
        endpoint = self._resolve_endpoint(self.config.base_url)
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        payload: dict[str, Any] = {
            "query": request.query,
            "freshness": request.freshness,
            "summary": request.summary,
            "count": request.count,
        }
        if request.include:
            payload["include"] = request.include
        if request.exclude:
            payload["exclude"] = request.exclude

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
                f"博查搜索请求失败: {exc}",
                provider_key=self.config.provider_key,
                code="bocha_request_failed",
            ) from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        data = self._parse_response(response)
        body = data.get("data") or {}

        web_pages_node = body.get("webPages") or {}
        images_node = body.get("images") or {}
        videos_node = body.get("videos") or {}

        web_pages = [
            SearchWebPageResult(
                name=str(item.get("name") or ""),
                url=str(item.get("url") or ""),
                display_url=str(item.get("displayUrl") or ""),
                snippet=str(item.get("snippet") or ""),
                summary=str(item.get("summary") or ""),
                site_name=str(item.get("siteName") or ""),
                site_icon=str(item.get("siteIcon") or ""),
                date_published=str(item.get("datePublished") or item.get("dateLastCrawled") or ""),
                cached_page_url=str(item.get("cachedPageUrl") or ""),
                language=str(item.get("language") or ""),
            )
            for item in (web_pages_node.get("value") or [])
            if isinstance(item, dict) and item.get("url")
        ]

        images = [
            SearchImageResult(
                name=str(item.get("name") or ""),
                content_url=str(item.get("contentUrl") or ""),
                host_page_url=str(item.get("hostPageUrl") or ""),
                thumbnail_url=str(item.get("thumbnailUrl") or ""),
                width=int(item.get("width") or 0),
                height=int(item.get("height") or 0),
                date_published=str(item.get("datePublished") or ""),
            )
            for item in (images_node.get("value") or [])
            if isinstance(item, dict) and item.get("contentUrl")
        ]

        videos = [
            SearchVideoResult(
                name=str(item.get("name") or ""),
                content_url=str(item.get("contentUrl") or ""),
                host_page_url=str(item.get("hostPageUrl") or ""),
                thumbnail_url=str(item.get("thumbnailUrl") or ""),
                description=str(item.get("description") or ""),
                duration=str(item.get("duration") or ""),
                width=int(item.get("width") or 0),
                height=int(item.get("height") or 0),
                date_published=str(item.get("datePublished") or ""),
            )
            for item in (videos_node.get("value") or [])
            if isinstance(item, dict) and (item.get("contentUrl") or item.get("hostPageUrl"))
        ]

        return SearchResponse(
            provider_key=self.config.provider_key,
            provider_type=self.config.provider_type,
            provider_display_name=self.config.display_name,
            request_id=uuid.uuid4().hex,
            query=request.query,
            count=request.count,
            summary_enabled=request.summary,
            freshness=request.freshness,
            total_estimated_matches=int(web_pages_node.get("totalEstimatedMatches") or 0),
            web_pages=web_pages,
            images=images,
            videos=videos,
            provider_log_id=str(data.get("log_id") or ""),
            latency_ms=latency_ms,
            raw=data,
        )

    @staticmethod
    def _resolve_endpoint(base_url: str) -> str:
        normalized = (base_url or "").rstrip("/")
        if normalized.endswith("/web-search"):
            return normalized
        if normalized.endswith("/v1"):
            return f"{normalized}/web-search"
        return f"{normalized}/v1/web-search"

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
                "博查搜索返回了无法解析的响应",
                provider_key=self.config.provider_key,
                status_code=response.status_code,
                code="bocha_invalid_json",
            ) from exc

        if response.status_code >= 400:
            message = (
                payload.get("message")
                or payload.get("msg")
                or payload.get("error")
                or response.text[:200]
                or f"HTTP {response.status_code}"
            )
            raise SearchProviderError(
                f"博查搜索失败: {message}",
                provider_key=self.config.provider_key,
                status_code=response.status_code,
                code="bocha_http_error",
                details=payload,
            )

        code = payload.get("code")
        if code not in (None, 200, "200"):
            message = payload.get("message") or payload.get("msg") or "未知错误"
            raise SearchProviderError(
                f"博查搜索失败: {message}",
                provider_key=self.config.provider_key,
                status_code=response.status_code,
                code="bocha_business_error",
                details=payload,
            )
        return payload

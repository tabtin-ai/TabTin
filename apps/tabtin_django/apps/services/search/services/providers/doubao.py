from __future__ import annotations

import datetime as dt
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

_DOUBAO_QUERY_MAX_LENGTH = 100
_DOUBAO_CUSTOM_DEFAULT_COUNT = 10
_DOUBAO_CUSTOM_MAX_COUNT = 50
_DEFAULT_MAX_CONTENT_CHARS = 4000

_FRESHNESS_TO_TIME_RANGE = {
    "day": "OneDay",
    "1d": "OneDay",
    "oneday": "OneDay",
    "oneDay": "OneDay",
    "week": "OneWeek",
    "1w": "OneWeek",
    "oneweek": "OneWeek",
    "oneWeek": "OneWeek",
    "month": "OneMonth",
    "1m": "OneMonth",
    "onemonth": "OneMonth",
    "oneMonth": "OneMonth",
    "year": "OneYear",
    "1y": "OneYear",
    "oneyear": "OneYear",
    "oneYear": "OneYear",
}
_NO_TIME_RANGE_VALUES = {"", "nolimit", "noLimit", "none", "all"}
_VALID_INDUSTRIES = {"finance", "game", "gov"}
_NON_RETRYABLE_ERROR_CODES = {
    "10400",
    "10401",
    "10402",
    "10403",
    "10406",
    "10409",
    "10410",
    "10412",
}
_RETRYABLE_ERROR_CODES = {"10500", "700429"}
_RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}


class DoubaoSearchProvider(BaseSearchProvider):
    provider_type = "doubao"

    def search(self, request: SearchRequest) -> SearchResponse:
        endpoint = self._resolve_endpoint(self.config.base_url)
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        payload = self._build_payload(request)

        started = time.monotonic()
        data = self._post_json_with_retry(endpoint, payload, headers)
        elapsed_ms = int((time.monotonic() - started) * 1000)

        result_node = data.get("Result") if isinstance(data.get("Result"), dict) else {}
        web_results = result_node.get("WebResults") or []
        if not isinstance(web_results, list):
            web_results = []

        web_pages: list[SearchWebPageResult] = []
        metadata_rows: list[dict[str, Any]] = []
        for item in web_results:
            if not isinstance(item, dict):
                continue
            page, metadata = self._map_web_page(item, request.summary)
            if page is None:
                continue
            web_pages.append(page)
            metadata_rows.append(metadata)

        request_id = self._request_id(data)
        log_id = str(result_node.get("LogId") or "")
        latency_ms = self._as_int(result_node.get("TimeCost")) or elapsed_ms
        raw = dict(data)
        raw["_tabtin"] = {
            "provider_variant": "custom",
            "origin_query": self._origin_query(result_node),
            "web_results": metadata_rows,
        }

        return SearchResponse(
            provider_key=self.config.provider_key,
            provider_type=self.config.provider_type,
            provider_display_name=self.config.display_name,
            request_id=request_id,
            query=request.query,
            count=self._normalize_count(request.count),
            summary_enabled=request.summary,
            freshness=request.freshness,
            total_estimated_matches=self._as_int(result_node.get("ResultCount")) or len(web_pages),
            web_pages=web_pages,
            images=[],
            videos=[],
            provider_log_id=log_id or request_id,
            latency_ms=latency_ms,
            raw=raw,
        )

    @staticmethod
    def _resolve_endpoint(base_url: str) -> str:
        normalized = (base_url or "").rstrip("/")
        if normalized.endswith("/web_search"):
            return normalized
        if normalized.endswith("/search_api"):
            return f"{normalized}/web_search"
        return f"{normalized}/search_api/web_search"

    def _build_payload(self, request: SearchRequest) -> dict[str, Any]:
        search_type = str((self.config.extra_config or {}).get("search_type") or "web").strip()
        if search_type != "web":
            raise SearchProviderError(
                f"豆包搜索暂不支持 SearchType={search_type}",
                provider_key=self.config.provider_key,
                code="doubao_search_type_unsupported",
            )

        payload: dict[str, Any] = {
            "Query": self._normalize_query(request.query),
            "SearchType": "web",
            "Count": self._normalize_count(request.count),
            "Filter": self._build_filter(request),
            "QueryControl": {
                "QueryRewrite": self._bool_extra("query_rewrite", False),
            },
            "ContentFormats": self._content_format(),
        }

        time_range = self._time_range(request.freshness)
        if time_range:
            payload["TimeRange"] = time_range

        industry = str((self.config.extra_config or {}).get("industry") or "").strip()
        if industry:
            if industry not in _VALID_INDUSTRIES:
                raise SearchProviderError(
                    f"豆包搜索不支持 Industry={industry}",
                    provider_key=self.config.provider_key,
                    code="doubao_industry_unsupported",
                )
            payload["Industry"] = industry

        return payload

    def _build_filter(self, request: SearchRequest) -> dict[str, Any]:
        filter_node: dict[str, Any] = {
            "NeedContent": self._bool_extra("need_content", False),
            "NeedUrl": self._bool_extra("need_url", True),
            "NeedSummary": bool(request.summary),
            "AuthInfoLevel": self._auth_info_level(),
        }

        sites = self._domain_filter(request.include, limit=20)
        if sites:
            filter_node["Sites"] = sites

        blocked = self._domain_filter(request.exclude, limit=5)
        if blocked:
            filter_node["BlockHosts"] = blocked

        return filter_node

    @staticmethod
    def _normalize_query(query: str) -> str:
        text = (query or "").strip()
        if not text:
            raise SearchProviderError("豆包搜索 Query 不能为空", code="doubao_query_required")
        return text[:_DOUBAO_QUERY_MAX_LENGTH]

    @staticmethod
    def _normalize_count(count: int) -> int:
        if not count:
            return _DOUBAO_CUSTOM_DEFAULT_COUNT
        return max(1, min(int(count), _DOUBAO_CUSTOM_MAX_COUNT))

    @staticmethod
    def _time_range(raw: str) -> str:
        value = (raw or "").strip()
        if value in _NO_TIME_RANGE_VALUES or value.lower() in _NO_TIME_RANGE_VALUES:
            return ""
        mapped = _FRESHNESS_TO_TIME_RANGE.get(value) or _FRESHNESS_TO_TIME_RANGE.get(value.lower())
        if mapped:
            return mapped
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}", value):
            start_raw, end_raw = value.split("..", 1)
            try:
                start = dt.date.fromisoformat(start_raw)
                end = dt.date.fromisoformat(end_raw)
            except ValueError as exc:
                raise SearchProviderError(
                    f"豆包搜索 TimeRange 日期格式无效: {value}",
                    code="doubao_time_range_invalid",
                ) from exc
            if start > end:
                raise SearchProviderError(
                    f"豆包搜索 TimeRange 起始日期晚于结束日期: {value}",
                    code="doubao_time_range_invalid",
                )
            return value
        return ""

    @staticmethod
    def _domain_filter(raw: str, *, limit: int) -> str:
        if not raw:
            return ""
        parts = re.split(r"[\s,;|]+", raw.strip())
        domains: list[str] = []
        seen: set[str] = set()
        for part in parts:
            domain = DoubaoSearchProvider._normalize_domain(part)
            if not domain or domain in seen:
                continue
            seen.add(domain)
            domains.append(domain)
            if len(domains) >= limit:
                break
        return "|".join(domains)

    @staticmethod
    def _normalize_domain(value: str) -> str:
        text = (value or "").strip().lower()
        if not text:
            return ""
        parsed = urlparse(text if "://" in text else f"//{text}")
        host = parsed.hostname or text.split("/", 1)[0].split(":", 1)[0]
        return host.strip(".")

    def _auth_info_level(self) -> int:
        if self._bool_extra("authoritative_only", False):
            return 1
        raw = (self.config.extra_config or {}).get("auth_info_level", 0)
        try:
            level = int(raw)
        except (TypeError, ValueError):
            level = 0
        return 1 if level == 1 else 0

    def _content_format(self) -> str:
        value = str((self.config.extra_config or {}).get("content_formats") or "markdown").strip().lower()
        if value not in {"text", "markdown"}:
            return "markdown"
        return value

    def _bool_extra(self, key: str, default: bool) -> bool:
        value = (self.config.extra_config or {}).get(key, default)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    def _int_extra(self, key: str, default: int, *, minimum: int, maximum: int) -> int:
        value = (self.config.extra_config or {}).get(key, default)
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
        return max(minimum, min(parsed, maximum))

    def _post_json_with_retry(
        self,
        endpoint: str,
        payload: dict[str, Any],
        headers: dict[str, str],
    ) -> dict[str, Any]:
        max_retries = self._int_extra("max_retries", 0, minimum=0, maximum=3)
        backoff_sec = self._int_extra("retry_backoff_ms", 200, minimum=0, maximum=5000) / 1000
        attempts = max_retries + 1
        last_error: SearchProviderError | None = None

        for attempt in range(attempts):
            try:
                response = requests.post(
                    endpoint,
                    json=payload,
                    headers=headers,
                    timeout=self.config.request_timeout_sec,
                )
                return self._parse_response(response)
            except SearchProviderError as exc:
                last_error = exc
                retryable = bool((exc.details or {}).get("retryable"))
                if not retryable or attempt >= max_retries:
                    raise
            except (requests.ReadTimeout, requests.ConnectTimeout, requests.ConnectionError) as exc:
                last_error = SearchProviderOutcomeUnknown(
                    f"豆包搜索请求失败: {exc}",
                    provider_key=self.config.provider_key,
                    code="doubao_request_failed",
                    details={"retryable": True},
                )
                if attempt >= max_retries:
                    raise last_error from exc
            except requests.RequestException as exc:
                raise SearchProviderOutcomeUnknown(
                    f"豆包搜索请求失败: {exc}",
                    provider_key=self.config.provider_key,
                    code="doubao_request_failed",
                    details={"retryable": False},
                ) from exc

            if backoff_sec:
                time.sleep(backoff_sec * (2 ** attempt))

        if last_error is not None:
            raise last_error
        raise SearchProviderError(
            "豆包搜索请求失败",
            provider_key=self.config.provider_key,
            code="doubao_request_failed",
        )

    def _parse_response(self, response: requests.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except ValueError as exc:
            if response.status_code >= 400:
                raise self._error(
                    f"豆包搜索失败: {response.text[:200] or f'HTTP {response.status_code}'}",
                    status_code=response.status_code,
                    code="doubao_http_error",
                    details={
                        "retryable": response.status_code in _RETRYABLE_STATUS_CODES,
                    },
                ) from exc
            raise self._error(
                "豆包搜索返回了无法解析的响应",
                status_code=response.status_code,
                code="doubao_invalid_json",
                details={"retryable": False},
                outcome_unknown=True,
            ) from exc

        if not isinstance(payload, dict):
            raise self._error(
                "豆包搜索返回了非对象响应",
                status_code=response.status_code,
                code="doubao_invalid_payload",
                details={"retryable": False},
                outcome_unknown=response.status_code < 400,
            )

        error_code, error_message = self._extract_error(payload)
        if response.status_code >= 400 or error_code:
            upstream_code = str(error_code or response.status_code)
            retryable = self._is_retryable(response.status_code, upstream_code)
            code = "doubao_http_error" if response.status_code >= 400 else "doubao_business_error"
            raise self._error(
                f"豆包搜索失败: {error_message or upstream_code}",
                status_code=response.status_code,
                code=code,
                details={
                    "upstream_error_code": upstream_code,
                    "upstream_error_message": error_message,
                    "request_id": self._request_id(payload),
                    "retryable": retryable,
                },
            )

        return payload

    def _error(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str,
        details: dict[str, Any] | None = None,
        outcome_unknown: bool = False,
    ) -> SearchProviderError:
        error_type = (
            SearchProviderOutcomeUnknown
            if outcome_unknown
            else SearchProviderError
        )
        return error_type(
            message,
            provider_key=self.config.provider_key,
            status_code=status_code,
            code=code,
            details=details or {},
        )

    @staticmethod
    def _extract_error(payload: dict[str, Any]) -> tuple[str, str]:
        metadata = payload.get("ResponseMetadata")
        if isinstance(metadata, dict):
            error = metadata.get("Error")
            if isinstance(error, dict):
                return str(error.get("Code") or ""), str(error.get("Message") or "")
        return str(payload.get("ErrorCode") or ""), str(payload.get("ErrorMsg") or payload.get("ErrorMessage") or "")

    @staticmethod
    def _is_retryable(status_code: int | None, upstream_code: str) -> bool:
        if upstream_code in _NON_RETRYABLE_ERROR_CODES:
            return False
        if upstream_code in _RETRYABLE_ERROR_CODES:
            return True
        return bool(status_code and status_code in _RETRYABLE_STATUS_CODES)

    def _map_web_page(
        self,
        item: dict[str, Any],
        summary_enabled: bool,
    ) -> tuple[SearchWebPageResult | None, dict[str, Any]]:
        url = self._first_text(item, "Url", "URL", "url")
        if not url:
            return None, {}

        snippet = self._first_text(item, "Snippet", "snippet")
        summary = self._first_text(item, "Summary", "summary")
        content = self._first_text(item, "Content", "content")
        truncated_content, content_truncated = self._truncate_content(content)
        if summary_enabled and not summary and not snippet and truncated_content:
            summary = truncated_content

        metadata = {
            "provider_result_id": self._first_text(item, "Id", "id"),
            "rank": self._as_int(item.get("SortId") or item.get("sort_id")),
            "title": self._first_text(item, "Title", "title"),
            "url": url,
            "content_length": len(content),
            "content_truncated": content_truncated,
            "relevance_score": self._as_float(item.get("RankScore") or item.get("rank_score")),
            "authority_label": self._first_text(item, "AuthInfoDes", "auth_info_des"),
            "authority_level": self._as_int(item.get("AuthInfoLevel") or item.get("auth_info_level")),
            "content_format": self._first_text(item, "ContentFormats", "content_formats"),
            "publish_time_raw": self._first_text(item, "PublishTime", "publish_time"),
        }

        return (
            SearchWebPageResult(
                name=metadata["title"],
                url=url,
                display_url=url,
                snippet=snippet,
                summary=summary,
                site_name=self._first_text(item, "SiteName", "site_name"),
                site_icon=self._first_text(item, "LogoUrl", "logo_url"),
                date_published=metadata["publish_time_raw"],
            ),
            metadata,
        )

    def _truncate_content(self, content: str) -> tuple[str, bool]:
        if not content:
            return "", False
        limit = self._int_extra(
            "max_content_chars",
            _DEFAULT_MAX_CONTENT_CHARS,
            minimum=0,
            maximum=20000,
        )
        if not limit or len(content) <= limit:
            return content, False
        return content[:limit].rstrip(), True

    @staticmethod
    def _first_text(source: dict[str, Any], *keys: str) -> str:
        for key in keys:
            value = source.get(key)
            if value is not None:
                return str(value)
        return ""

    @staticmethod
    def _as_int(value: Any) -> int:
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _as_float(value: Any) -> float:
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _request_id(payload: dict[str, Any]) -> str:
        metadata = payload.get("ResponseMetadata")
        if isinstance(metadata, dict):
            request_id = metadata.get("RequestId") or metadata.get("RequestID")
            if request_id:
                return str(request_id)
        return str(payload.get("RequestId") or payload.get("RequestID") or uuid.uuid4().hex)

    @staticmethod
    def _origin_query(result_node: dict[str, Any]) -> str:
        search_context = result_node.get("SearchContext")
        if isinstance(search_context, dict):
            return str(search_context.get("OriginQuery") or "")
        return ""

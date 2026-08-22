from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class SearchRequest:
    query: str
    count: int
    summary: bool
    freshness: str
    include: str = ""
    exclude: str = ""


@dataclass(frozen=True, slots=True)
class SearchRequestFingerprint:
    fingerprint_version: str
    meter_key: str
    query_sha256: str
    request_fingerprint: str


@dataclass(frozen=True, slots=True)
class SearchInvocationContext:
    logical_search_invocation_id: str
    agent_run_id: str
    fingerprint_version: str
    meter_key: str
    query_sha256: str
    request_fingerprint: str


@dataclass(slots=True)
class SearchWebPageResult:
    name: str
    url: str
    display_url: str = ""
    snippet: str = ""
    summary: str = ""
    site_name: str = ""
    site_icon: str = ""
    date_published: str = ""
    cached_page_url: str = ""
    language: str = ""


@dataclass(slots=True)
class SearchImageResult:
    name: str
    content_url: str
    host_page_url: str = ""
    thumbnail_url: str = ""
    width: int = 0
    height: int = 0
    date_published: str = ""


@dataclass(slots=True)
class SearchVideoResult:
    name: str
    content_url: str = ""
    host_page_url: str = ""
    thumbnail_url: str = ""
    description: str = ""
    duration: str = ""
    width: int = 0
    height: int = 0
    date_published: str = ""


@dataclass(slots=True)
class SearchResponse:
    provider_key: str
    provider_type: str
    provider_display_name: str
    request_id: str
    query: str
    count: int
    summary_enabled: bool
    freshness: str
    total_estimated_matches: int = 0
    web_pages: list[SearchWebPageResult] = field(default_factory=list)
    images: list[SearchImageResult] = field(default_factory=list)
    videos: list[SearchVideoResult] = field(default_factory=list)
    provider_log_id: str = ""
    latency_ms: int | None = None
    billing_result: dict[str, Any] | None = None
    invocation_context: SearchInvocationContext | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        # invocation_context 是服务端后续幂等状态机使用的内部上下文；PR0A 不扩展
        # Provider/客户端响应契约，也不向调用方暴露逻辑调用命名空间。
        data.pop("invocation_context", None)
        return data

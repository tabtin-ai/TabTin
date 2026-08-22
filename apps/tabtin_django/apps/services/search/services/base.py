from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from .types import SearchRequest, SearchResponse


class SearchProviderError(Exception):
    def __init__(
        self,
        message: str,
        *,
        provider_key: str = "",
        status_code: int | None = None,
        code: str = "search_provider_error",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.provider_key = provider_key
        self.status_code = status_code
        self.code = code
        self.details = details or {}


class SearchProviderOutcomeUnknown(SearchProviderError):
    """Provider may have executed the request, but no authoritative result arrived."""


@dataclass(slots=True)
class RuntimeSearchProviderConfig:
    provider_type: str
    provider_key: str
    display_name: str
    base_url: str
    api_key: str
    api_key_source: str
    request_timeout_sec: int
    capabilities_config: dict[str, Any] = field(default_factory=dict)
    extra_config: dict[str, Any] = field(default_factory=dict)


class BaseSearchProvider(ABC):
    provider_type: str = ""

    def __init__(self, config: RuntimeSearchProviderConfig) -> None:
        self.config = config

    @abstractmethod
    def search(self, request: SearchRequest) -> SearchResponse:
        raise NotImplementedError

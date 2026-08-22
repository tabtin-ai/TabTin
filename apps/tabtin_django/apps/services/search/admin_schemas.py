import datetime
from decimal import Decimal
from typing import Any, Optional

from ninja import Schema


class SearchProviderSchema(Schema):
    class Config:
        protected_namespaces = ()

    id: str
    provider_type: str
    provider_key: str
    display_name: str
    base_url: str
    api_key_masked: str
    api_key_source: str
    request_timeout_sec: int
    is_active: bool
    priority: int
    is_default: bool
    capabilities_config: dict[str, Any]
    extra_config: dict[str, Any]
    created_at: Optional[datetime.datetime] = None
    updated_at: Optional[datetime.datetime] = None


class SearchProviderListSchema(Schema):
    providers: list[SearchProviderSchema]


class SearchProviderUpsertSchema(Schema):
    provider_type: str = "qianfan"
    provider_key: Optional[str] = None
    display_name: str
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    api_key_env_name: Optional[str] = None
    request_timeout_sec: Optional[int] = None
    is_active: Optional[bool] = None
    priority: Optional[int] = None
    capabilities_config: Optional[dict[str, Any]] = None
    extra_config: Optional[dict[str, Any]] = None


class SearchGlobalConfigSchema(Schema):
    default_provider_key: str
    default_count: int
    default_summary_enabled: bool
    default_freshness: str


class SearchGlobalConfigUpdateSchema(Schema):
    default_provider_key: Optional[str] = None
    default_count: Optional[int] = None
    default_summary_enabled: Optional[bool] = None
    default_freshness: Optional[str] = None


class SearchBillingSummarySchema(Schema):
    total_requests: int
    total_amount: Decimal
    currency: str
    period_start: datetime.date
    period_end: datetime.date


class SearchBillingDailySchema(Schema):
    date: datetime.date
    requests: int
    amount: Decimal


class SearchBillingProviderSchema(Schema):
    provider_key: str
    requests: int
    amount: Decimal


class SearchBillingOverviewSchema(Schema):
    summary: SearchBillingSummarySchema
    daily: list[SearchBillingDailySchema]
    by_provider: list[SearchBillingProviderSchema]

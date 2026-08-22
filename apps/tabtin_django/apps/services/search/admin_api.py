from __future__ import annotations

import logging
from datetime import timedelta
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db.models import Count, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.i18n import _
from apps.services.billing.models import BillingUsageEvent
from apps.users.auth.admin_audit import record_admin_sensitive_action
from apps.users.auth.permissions import AdminPermissionAuth, StaffAuth, SuperuserAuth

from .admin_schemas import (
    SearchBillingDailySchema,
    SearchBillingOverviewSchema,
    SearchBillingProviderSchema,
    SearchBillingSummarySchema,
    SearchGlobalConfigSchema,
    SearchGlobalConfigUpdateSchema,
    SearchProviderListSchema,
    SearchProviderSchema,
    SearchProviderUpsertSchema,
)
from .constants import (
    BOCHA_API_KEY_ENV_NAME,
    BOCHA_SEARCH_BASE_URL,
    DEFAULT_SEARCH_PROVIDER_KEY,
    DEFAULT_SEARCH_PROVIDER_NAME,
    DEFAULT_SEARCH_PROVIDER_TYPE,
    DEFAULT_SEARCH_TIMEOUT_SEC,
    DOUBAO_API_KEY_ENV_NAME,
    DOUBAO_SEARCH_BASE_URL,
    QIANFAN_API_KEY_ENV_NAME,
    QIANFAN_SEARCH_BASE_URL,
    SEARCH_BILLING_METER_KEY,
)
from .models import SearchGlobalConfig, SearchProvider
from .services.runtime import SearchProviderRuntime

router = Router(auth=StaffAuth())
logger = logging.getLogger(__name__)


def _defaults_for_provider_type(provider_type: str) -> tuple[str, str]:
    if provider_type == "bocha":
        return BOCHA_SEARCH_BASE_URL, BOCHA_API_KEY_ENV_NAME
    if provider_type == "doubao":
        return DOUBAO_SEARCH_BASE_URL, DOUBAO_API_KEY_ENV_NAME
    return QIANFAN_SEARCH_BASE_URL, QIANFAN_API_KEY_ENV_NAME


def _default_capabilities_for_provider_type(provider_type: str) -> dict:
    if provider_type == "doubao":
        return {"summary": True, "freshness": True, "image": False}
    return {}


def _default_extra_config_for_provider_type(provider_type: str) -> dict:
    if provider_type == "doubao":
        return {
            "variant": "custom",
            "need_content": False,
            "need_url": True,
            "auth_info_level": 0,
            "query_rewrite": False,
            "content_formats": "markdown",
            "max_content_chars": 4000,
        }
    return {}


def _provider_to_schema(provider: SearchProvider, default_provider_key: str) -> SearchProviderSchema:
    api_key_masked, api_key_source = SearchProviderRuntime.mask_api_key(provider)
    return SearchProviderSchema(
        id=str(provider.id),
        provider_type=provider.provider_type,
        provider_key=provider.provider_key,
        display_name=provider.display_name,
        base_url=provider.base_url,
        api_key_masked=api_key_masked,
        api_key_source=api_key_source,
        request_timeout_sec=provider.request_timeout_sec,
        is_active=provider.is_active,
        priority=provider.priority,
        is_default=provider.provider_key == default_provider_key,
        capabilities_config=provider.capabilities_config or {},
        extra_config=provider.extra_config or {},
        created_at=provider.created_at,
        updated_at=provider.updated_at,
    )

def _fallback_provider_schema(default_provider_key: str) -> SearchProviderSchema:
    return SearchProviderSchema(
        id="fallback-qianfan",
        provider_type=DEFAULT_SEARCH_PROVIDER_TYPE,
        provider_key=DEFAULT_SEARCH_PROVIDER_KEY,
        display_name=DEFAULT_SEARCH_PROVIDER_NAME,
        base_url=QIANFAN_SEARCH_BASE_URL,
        api_key_masked="未配置",
        api_key_source=f"env:{QIANFAN_API_KEY_ENV_NAME}",
        request_timeout_sec=DEFAULT_SEARCH_TIMEOUT_SEC,
        is_active=True,
        priority=100,
        is_default=default_provider_key == DEFAULT_SEARCH_PROVIDER_KEY,
        capabilities_config={"summary": True, "freshness": True, "image": False},
        extra_config={"search_source": "baidu_search_v2"},
        created_at=None,
        updated_at=None,
    )

def _get_global_config() -> SearchGlobalConfig:
    return SearchProviderRuntime.get_global_config()

@router.get("/search/config", auth=StaffAuth(), response=SearchGlobalConfigSchema)
def get_search_config(request):

    config = _get_global_config()
    return SearchGlobalConfigSchema(
        default_provider_key=config.default_provider_key,
        default_count=config.default_count,
        default_summary_enabled=config.default_summary_enabled,
        default_freshness=config.default_freshness,
    )

@router.put("/search/config", auth=SuperuserAuth(), response=SearchGlobalConfigSchema)
def update_search_config(request, payload: SearchGlobalConfigUpdateSchema):
    config = _get_global_config()

    if payload.default_provider_key is not None:
        provider = SearchProvider.objects.filter(provider_key=payload.default_provider_key).first()
        if provider is None:
            raise HttpError(400, _("search.default_provider_not_exist", key=payload.default_provider_key))
        if not provider.is_active:
            raise HttpError(400, _("search.default_provider_disabled", key=payload.default_provider_key))
        config.default_provider_key = payload.default_provider_key
    if payload.default_count is not None:
        if payload.default_count < 1 or payload.default_count > 50:
            raise HttpError(400, "default_count 必须在 1~50 之间")
        config.default_count = payload.default_count
    if payload.default_summary_enabled is not None:
        config.default_summary_enabled = payload.default_summary_enabled
    if payload.default_freshness is not None:
        config.default_freshness = payload.default_freshness.strip() or config.default_freshness

    config.save()
    return SearchGlobalConfigSchema(
        default_provider_key=config.default_provider_key,
        default_count=config.default_count,
        default_summary_enabled=config.default_summary_enabled,
        default_freshness=config.default_freshness,
    )

@router.get("/search/providers", auth=StaffAuth(), response=SearchProviderListSchema)
def list_search_providers(request):

    config = _get_global_config()
    providers = list(SearchProviderRuntime.list_providers())
    if not providers:
        return SearchProviderListSchema(providers=[_fallback_provider_schema(config.default_provider_key)])
    return SearchProviderListSchema(
        providers=[_provider_to_schema(provider, config.default_provider_key) for provider in providers]
    )

@router.post("/search/providers", auth=SuperuserAuth(), response=SearchProviderSchema)
def create_search_provider(request, payload: SearchProviderUpsertSchema):

    valid_types = {choice[0] for choice in SearchProvider.PROVIDER_TYPE_CHOICES}
    provider_type = (payload.provider_type or "").strip() or DEFAULT_SEARCH_PROVIDER_KEY
    if provider_type not in valid_types:
        raise HttpError(400, _("search.unsupported_provider_type", type=provider_type))

    provider_key = (payload.provider_key or provider_type).strip()
    if SearchProvider.objects.filter(provider_key=provider_key).exists():
        raise HttpError(400, f"provider_key 已存在: {provider_key}")

    default_base_url, default_env_name = _defaults_for_provider_type(provider_type)
    provider = SearchProvider.objects.create(
        provider_type=provider_type,
        provider_key=provider_key,
        display_name=payload.display_name.strip(),
        base_url=(payload.base_url or default_base_url).strip(),
        api_key="" if provider_type == "doubao" else (payload.api_key or "").strip(),
        api_key_env_name=default_env_name if provider_type == "doubao" else (payload.api_key_env_name or default_env_name).strip(),
        request_timeout_sec=payload.request_timeout_sec or DEFAULT_SEARCH_TIMEOUT_SEC,
        is_active=True if payload.is_active is None else payload.is_active,
        priority=100 if payload.priority is None else payload.priority,
        capabilities_config=(
            payload.capabilities_config
            if payload.capabilities_config is not None
            else _default_capabilities_for_provider_type(provider_type)
        ),
        extra_config=(
            payload.extra_config
            if payload.extra_config is not None
            else _default_extra_config_for_provider_type(provider_type)
        ),
    )
    config = _get_global_config()
    return _provider_to_schema(provider, config.default_provider_key)

@router.put("/search/providers/{provider_id}", auth=SuperuserAuth(), response=SearchProviderSchema)
def update_search_provider(request, provider_id: str, payload: SearchProviderUpsertSchema):

    try:
        provider = SearchProvider.objects.get(id=provider_id)
    except (SearchProvider.DoesNotExist, ValidationError, ValueError):
        raise HttpError(404, _("search.search_provider_not_found"))

    if payload.provider_type is not None:
        valid_types = {choice[0] for choice in SearchProvider.PROVIDER_TYPE_CHOICES}
        provider_type = payload.provider_type.strip()
        if provider_type not in valid_types:
            raise HttpError(400, _("search.unsupported_provider_type", type=provider_type))
        provider.provider_type = provider_type
        if provider_type == "doubao":
            provider.api_key = ""

    if payload.provider_key is not None:
        next_key = payload.provider_key.strip()
        if next_key and next_key != provider.provider_key:
            if SearchProvider.objects.exclude(id=provider.id).filter(provider_key=next_key).exists():
                raise HttpError(400, f"provider_key 已存在: {next_key}")
            provider.provider_key = next_key

    if payload.display_name is not None:
        provider.display_name = payload.display_name.strip()
    if payload.base_url is not None:
        provider.base_url = payload.base_url.strip()
    if payload.api_key is not None and provider.provider_type != "doubao":
        provider.api_key = payload.api_key.strip()
    elif provider.provider_type == "doubao":
        provider.api_key = ""
    if payload.api_key_env_name is not None:
        _, default_env_name = _defaults_for_provider_type(provider.provider_type)
        provider.api_key_env_name = (
            default_env_name
            if provider.provider_type == "doubao"
            else payload.api_key_env_name.strip() or default_env_name
        )
    if payload.request_timeout_sec is not None:
        provider.request_timeout_sec = payload.request_timeout_sec
    if payload.is_active is not None:
        provider.is_active = payload.is_active
    if payload.priority is not None:
        provider.priority = payload.priority
    if payload.capabilities_config is not None:
        provider.capabilities_config = payload.capabilities_config
    if payload.extra_config is not None:
        provider.extra_config = payload.extra_config

    provider.save()
    config = _get_global_config()
    return _provider_to_schema(provider, config.default_provider_key)

@router.delete("/search/providers/{provider_id}", auth=AdminPermissionAuth("search_provider:delete"))
def delete_search_provider(request, provider_id: str, reason: str = "", ticket_id: str = ""):
    normalized_reason = (reason or "").strip()
    if not normalized_reason:
        raise HttpError(400, "reason 不能为空")

    try:
        provider = SearchProvider.objects.get(id=provider_id)
    except (SearchProvider.DoesNotExist, ValidationError, ValueError):
        raise HttpError(404, _("search.search_provider_not_found"))

    config = _get_global_config()
    if provider.provider_key == config.default_provider_key:
        raise HttpError(400, _("search.default_provider_no_direct_delete"))

    before_json = {
        "provider_id": str(provider.id),
        "provider_key": provider.provider_key,
        "display_name": provider.display_name,
        "status": "active" if provider.is_active else "inactive",
    }
    provider.delete()
    record_admin_sensitive_action(
        request,
        permission_code="search_provider:delete",
        action="search_provider.delete",
        target_type="search_provider",
        target_id=provider_id,
        reason=normalized_reason,
        ticket_id=(ticket_id or "").strip(),
        before_json=before_json,
        after_json={
            "provider_id": provider_id,
            "status": "deleted",
        },
    )
    return {"success": True, "deleted": True}

@router.get("/search/billing/overview", auth=StaffAuth(), response=SearchBillingOverviewSchema)
def get_search_billing_overview(request, days: int = 30, provider_key: str | None = None):

    normalized_days = min(max(days, 1), 365)
    now = timezone.now()
    start = now - timedelta(days=normalized_days)
    qs = BillingUsageEvent.objects.filter(
        meter_key=SEARCH_BILLING_METER_KEY,
        occurred_at__gte=start,
        occurred_at__lt=now,
    )
    if provider_key:
        qs = qs.filter(provider_key=provider_key)

    summary = qs.aggregate(
        total_requests=Count("id"),
        total_amount=Sum("amount"),
    )
    daily_rows = (
        qs.annotate(day=TruncDate("occurred_at"))
        .values("day")
        .annotate(requests=Count("id"), amount=Sum("amount"))
        .order_by("day")
    )
    provider_rows = (
        qs.values("provider_key")
        .annotate(requests=Count("id"), amount=Sum("amount"))
        .order_by("-amount", "-requests", "provider_key")
    )

    return SearchBillingOverviewSchema(
        summary=SearchBillingSummarySchema(
            total_requests=summary.get("total_requests") or 0,
            total_amount=summary.get("total_amount") or Decimal("0"),
            currency="CREDITS",
            period_start=start.date(),
            period_end=now.date(),
        ),
        daily=[
            SearchBillingDailySchema(
                date=row["day"],
                requests=row["requests"] or 0,
                amount=row["amount"] or Decimal("0"),
            )
            for row in daily_rows
        ],
        by_provider=[
            SearchBillingProviderSchema(
                provider_key=str(row["provider_key"] or "unknown"),
                requests=row["requests"] or 0,
                amount=row["amount"] or Decimal("0"),
            )
            for row in provider_rows
        ],
    )

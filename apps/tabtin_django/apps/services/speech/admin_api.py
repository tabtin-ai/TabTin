"""
Speech Admin 管理 API（ASR + TTS）

提供 ASR / TTS 服务的统一管理能力：
  1. 配置管理：查看/更新 ASR / TTS Provider 配置（DB + settings 双来源）
  2. 定价管理：查看/更新 speech.tts.characters 计量项定价
  3. 用量统计：按日/按业务类型维度统计 ASR / TTS 用量

权限：
  - 读接口：is_staff
  - 写接口：is_superuser
"""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from datetime import timedelta

from django.conf import settings as django_settings
from django.core.exceptions import ValidationError
from django.db import DatabaseError, transaction
from django.db.models import Count, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.i18n import _
from apps.services.billing.models import BillingUsageEvent, MeterPricing
from apps.services.llm.models import LLMModel, LLMProvider
from apps.services.speech.asr.factory import VALID_WS_ENDPOINTS
from apps.services.speech.tts.factory import PROVIDER_ALIASES
from apps.users.auth.permissions import StaffAuth, SuperuserAuth

from .admin_schemas import (
    ASRConfigOverviewSchema,
    ASRConfigUpdateSchema,
    ASRPricingListSchema,
    ASRPricingSchema,
    ASRPricingUpdateSchema,
    ASRProviderConfigSchema,
    ASRUsageByBizTypeSchema,
    ASRUsageDailySchema,
    ASRUsageStatsSchema,
    ASRUsageSummarySchema,
    TTSConfigOverviewSchema,
    TTSConfigUpdateSchema,
    TTSPricingListSchema,
    TTSPricingSchema,
    TTSPricingUpdateSchema,
    TTSProviderConfigSchema,
    TTSUsageByBizTypeSchema,
    TTSUsageDailySchema,
    TTSUsageStatsSchema,
    TTSUsageSummarySchema,
)

router = Router(auth=StaffAuth())
logger = logging.getLogger(__name__)

TTS_METER_KEY = "speech.tts.characters"

KNOWN_SPEAKERS = [
    {"id": "zh_female_vv_uranus_bigtts", "name": "女声-甜美（默认 Speech）", "gender": "female"},
    {"id": "zh_male_ruyayichen_saturn_bigtts", "name": "男声-儒雅（默认 TabVideo）", "gender": "male"},
    {"id": "zh_female_shuangkuaisisi_moon_bigtts", "name": "女声-爽快", "gender": "female"},
    {"id": "zh_male_wennuanahu_moon_bigtts", "name": "男声-温暖", "gender": "male"},
    {"id": "zh_female_tianmeixiaoyuan_moon_bigtts", "name": "女声-甜美小圆", "gender": "female"},
    {"id": "zh_male_chunhou_moon_bigtts", "name": "男声-淳厚", "gender": "male"},
]

def _get_valid_speaker_ids() -> frozenset[str]:
    """从 DB 获取所有活跃音色 ID（含 fallback 硬编码列表）"""
    try:
        from apps.services.speech.models import TTSVoice
        db_ids = set(TTSVoice.objects.filter(is_active=True).values_list('voice_type', flat=True))
        return frozenset(db_ids | {s["id"] for s in KNOWN_SPEAKERS})
    except Exception:
        return frozenset(s["id"] for s in KNOWN_SPEAKERS)

_SAFE_CONFIG_KEYS = frozenset({
    "resource_id", "resource_ids", "default_speaker", "sample_rate",
    "format", "encoding", "channel", "bits", "ws_endpoint",
    "model_version",
})

def _mask(value: str, show_prefix: int = 4, show_suffix: int = 4) -> str:
    if not value or len(value) < show_prefix + show_suffix + 3:
        return "***"
    return value[:show_prefix] + "..." + value[-show_suffix:]

def _sanitize_capabilities_config(extra: dict) -> dict:
    """白名单过滤：仅保留已知安全字段，避免新增敏感字段泄露"""
    return {k: v for k, v in extra.items() if k in _SAFE_CONFIG_KEYS}

def _get_operator_id(request) -> str:
    user = request.auth
    return str(user.id) if user else "unknown"

# ── TTS 配置管理 ──

def _load_db_provider_config() -> TTSProviderConfigSchema | None:
    """从 DB (LLMProvider/LLMModel) 加载 TTS 配置（v0.1 schema）"""
    try:
        provider_obj = LLMProvider.objects.filter(
            name="bytedance",
            capability_domains__contains=["tts"],
            routing_enabled=True,
        ).first()
        if not provider_obj:
            return None

        model_obj = LLMModel.objects.filter(
            provider=provider_obj,
            capability_domain="tts",
        ).first()
        if not model_obj:
            return None

        extra = model_obj.capabilities_config or {}
        return TTSProviderConfigSchema(
            source="database",
            provider_name="bytedance",
            display_name=provider_obj.display_name or "ByteDance TTS",
            app_id_masked=_mask(extra.get("app_id", "")),
            access_token_masked=_mask(provider_obj.api_key or ""),
            resource_id=extra.get("resource_id", model_obj.model_name or ""),
            default_speaker=extra.get("default_speaker", ""),
            # v0.1.x：is_active 字段已删；可路由语义 = provider.routing_enabled。
            is_active=bool(provider_obj.routing_enabled),
            provider_id=str(provider_obj.id),
            model_id=str(model_obj.id),
            model_name=model_obj.model_name,
            capabilities_config=_sanitize_capabilities_config(extra),
        )
    except (DatabaseError, AttributeError) as e:
        logger.warning("从 DB 加载 TTS 配置失败: %s", e)
        return None

def _load_settings_config() -> TTSProviderConfigSchema:
    """从 Django settings 加载 TTS 配置"""
    app_id = getattr(django_settings, "BYTEDANCE_TTS_APP_ID", "")
    token = getattr(django_settings, "BYTEDANCE_TTS_ACCESS_TOKEN", "")
    resource_id = getattr(django_settings, "BYTEDANCE_TTS_RESOURCE_ID", "seed-tts-2.0")
    speaker = getattr(django_settings, "BYTEDANCE_TTS_DEFAULT_SPEAKER", "zh_female_vv_uranus_bigtts")

    return TTSProviderConfigSchema(
        source="settings",
        provider_name="bytedance",
        display_name="ByteDance TTS (settings fallback)",
        app_id_masked=_mask(app_id),
        access_token_masked=_mask(token),
        resource_id=resource_id,
        default_speaker=speaker,
        is_active=bool(app_id and token),
    )

@router.get("/speech/tts/config", auth=StaffAuth(), response=TTSConfigOverviewSchema)
def get_tts_config(request):
    """获取 TTS 配置总览"""

    providers: list[TTSProviderConfigSchema] = []

    db_config = _load_db_provider_config()
    if db_config:
        providers.append(db_config)

    providers.append(_load_settings_config())

    return TTSConfigOverviewSchema(
        providers=providers,
        available_speakers=KNOWN_SPEAKERS,
        factory_aliases=PROVIDER_ALIASES,
    )

@router.put("/speech/tts/config/{provider_id}", auth=SuperuserAuth(), response=TTSProviderConfigSchema)
def update_tts_config(request, provider_id: str, payload: TTSConfigUpdateSchema):
    """更新 TTS Provider 配置（仅 DB 来源）"""

    operator_id = _get_operator_id(request)

    try:
        provider = LLMProvider.objects.get(id=provider_id, name="bytedance")
    except (LLMProvider.DoesNotExist, ValueError, ValidationError):
        raise HttpError(404, _("speech.tts_provider_not_found"))

    valid_ids = _get_valid_speaker_ids()
    if payload.default_speaker is not None and payload.default_speaker not in valid_ids:
        raise HttpError(
            400,
            _("speech.invalid_speaker_id", speaker=payload.default_speaker, valid=", ".join(sorted(valid_ids))),
        )

    has_model_fields = any(
        getattr(payload, f) is not None
        for f in ("app_id", "resource_id", "default_speaker")
    )

    with transaction.atomic():
        provider_fields: list[str] = []
        if payload.access_token is not None:
            provider.api_key = payload.access_token
            provider_fields.append("encrypted_api_key")
        # v0.1.x：LLMProvider.is_active 已删（0022），改用 routing_enabled。
        if payload.is_active is not None:
            provider.routing_enabled = payload.is_active
            provider_fields.append("routing_enabled")
        if provider_fields:
            provider.save(update_fields=provider_fields + ["updated_at"])

        # v0.1.x：LLMModel.mode 已删（0022），改用 capability_domain。
        model = LLMModel.objects.filter(
            provider=provider, capability_domain="tts",
        ).first()

        if has_model_fields and not model:
            raise HttpError(
                400,
                _("speech.no_audio_speech_model"),
            )

        model_changed_fields: list[str] = []
        if model and has_model_fields:
            extra = model.capabilities_config or {}
            if payload.app_id is not None:
                extra["app_id"] = payload.app_id
                model_changed_fields.append("app_id")
            if payload.resource_id is not None:
                extra["resource_id"] = payload.resource_id
                model_changed_fields.append("resource_id")
            if payload.default_speaker is not None:
                extra["default_speaker"] = payload.default_speaker
                model_changed_fields.append("default_speaker")
            model.capabilities_config = extra
            model.save(update_fields=["capabilities_config"])

    from ._config_cache import invalidate as _invalidate_speech_cache
    _invalidate_speech_cache()

    logger.info(
        "[SpeechAdmin] 更新 TTS 配置: operator=%s, provider=%s, provider_fields=%s, model_fields=%s",
        operator_id,
        provider_id,
        provider_fields,
        model_changed_fields,
    )

    result = _load_db_provider_config()
    if result:
        return result
    return _load_settings_config()

# ── 通用 Pricing / Usage 辅助函数 ──

def _build_pricing_schema(p: MeterPricing, schema_cls):
    """将 MeterPricing 实例转为对应的 Pricing Schema（TTS / ASR 共用）"""
    return schema_cls(
        id=str(p.id),
        meter_key=p.meter_key,
        scope=p.scope,
        unit_price=p.unit_price,
        unit=p.unit,
        currency=p.currency,
        provider_key=p.provider_key,
        model_name=p.model_name,
        is_active=p.is_active,
        effective_from=p.effective_from,
        effective_to=p.effective_to,
        priority=p.priority,
    )

def _do_update_pricing(
    meter_key: str,
    pricing_id: str,
    payload,
    operator_id: str,
    schema_cls,
    label: str,
):
    """通用 pricing 更新逻辑（TTS / ASR 共用）"""
    try:
        pricing = MeterPricing.objects.get(id=pricing_id, meter_key=meter_key)
    except (MeterPricing.DoesNotExist, ValueError, ValidationError):
        raise HttpError(404, _("speech.pricing_not_found"))

    fields: list[str] = []
    if payload.unit_price is not None:
        try:
            new_price = Decimal(payload.unit_price)
        except (InvalidOperation, ValueError):
            raise HttpError(400, _("speech.invalid_unit_price", price=payload.unit_price))
        if new_price < 0:
            raise HttpError(400, _("speech.unit_price_negative"))
        pricing.unit_price = new_price
        fields.append("unit_price")
    if payload.is_active is not None:
        pricing.is_active = payload.is_active
        fields.append("is_active")

    if fields:
        pricing.save(update_fields=fields)
        logger.info(
            "[SpeechAdmin] 更新 %s 定价: operator=%s, id=%s, fields=%s",
            label,
            operator_id,
            pricing_id,
            fields,
        )

    return _build_pricing_schema(pricing, schema_cls)

def _build_usage_stats(
    meter_key: str,
    days: int,
    *,
    daily_schema_cls,
    summary_schema_cls,
    biz_schema_cls,
    stats_schema_cls,
    quantity_field: str,
):
    """
    通用用量统计（TTS / ASR 共用）。

    quantity_field: schema 中用量字段名，如 "characters"（TTS）或 "seconds"（ASR）。
    summary schema 中对应 "total_{quantity_field}"。
    """
    days = min(max(days, 1), 365)
    now = timezone.now()
    start = now - timedelta(days=days)

    qs = BillingUsageEvent.objects.filter(
        meter_key=meter_key,
        occurred_at__gte=start,
    )

    daily_qs = (
        qs.annotate(day=TruncDate("occurred_at"))
        .values("day")
        .annotate(
            qty=Sum("quantity"),
            amt=Sum("amount"),
            cnt=Count("id"),
        )
        .order_by("day")
    )

    total_qty = Decimal(0)
    total_amount = Decimal(0)
    total_events = 0
    daily = []
    for row in daily_qs:
        qty = row["qty"] or Decimal(0)
        amt = row["amt"] or Decimal(0)
        cnt = row["cnt"] or 0
        total_qty += qty
        total_amount += amt
        total_events += cnt
        daily.append(daily_schema_cls(
            date=row["day"],
            amount=amt,
            event_count=cnt,
            **{quantity_field: qty},
        ))

    summary = summary_schema_cls(
        total_amount=total_amount,
        total_events=total_events,
        currency="CREDITS",
        **{f"total_{quantity_field}": total_qty},
    )

    biz_qs = (
        qs.values("biz_type")
        .annotate(
            qty=Sum("quantity"),
            amt=Sum("amount"),
            cnt=Count("id"),
        )
        .order_by("-qty")
    )
    by_biz_type = [
        biz_schema_cls(
            biz_type=row["biz_type"] or "unknown",
            amount=row["amt"] or Decimal(0),
            event_count=row["cnt"] or 0,
            **{quantity_field: row["qty"] or Decimal(0)},
        )
        for row in biz_qs
    ]

    return stats_schema_cls(
        summary=summary,
        daily=daily,
        by_biz_type=by_biz_type,
        period_start=start.date(),
        period_end=now.date(),
    )

# ── TTS 定价管理 ──

@router.get("/speech/tts/pricing", auth=StaffAuth(), response=TTSPricingListSchema)
def list_tts_pricing(request):
    """获取 TTS 定价列表"""

    qs = MeterPricing.objects.filter(
        meter_key=TTS_METER_KEY,
    ).order_by("-priority", "-effective_from")

    items = [_build_pricing_schema(p, TTSPricingSchema) for p in qs]
    return TTSPricingListSchema(items=items)

@router.put("/speech/tts/pricing/{pricing_id}", auth=SuperuserAuth(), response=TTSPricingSchema)
def update_tts_pricing(request, pricing_id: str, payload: TTSPricingUpdateSchema):
    """更新 TTS 定价"""
    return _do_update_pricing(
        TTS_METER_KEY, pricing_id, payload,
        _get_operator_id(request), TTSPricingSchema, "TTS",
    )

# ── TTS 用量统计 ──

@router.get("/speech/tts/usage", auth=StaffAuth(), response=TTSUsageStatsSchema)
def get_tts_usage(request, days: int = 30):
    """获取 TTS 用量统计"""

    return _build_usage_stats(
        TTS_METER_KEY, days,
        daily_schema_cls=TTSUsageDailySchema,
        summary_schema_cls=TTSUsageSummarySchema,
        biz_schema_cls=TTSUsageByBizTypeSchema,
        stats_schema_cls=TTSUsageStatsSchema,
        quantity_field="characters",
    )

# ── ASR 配置管理 ──

ASR_METER_KEY = "speech.asr.seconds"
ASR_SUPPORTED_MODES = ["flash", "standard", "streaming"]

def _load_db_asr_config() -> ASRProviderConfigSchema | None:
    """从 DB (LLMProvider/LLMModel) 加载 ASR 配置（v0.1 schema）"""
    try:
        provider_obj = LLMProvider.objects.filter(
            name="bytedance",
            capability_domains__overlap=["asr", "tts"],
            routing_enabled=True,
        ).first()
        if not provider_obj:
            return None

        model_obj = LLMModel.objects.filter(
            provider=provider_obj,
            capability_domain="asr",
        ).first()
        if not model_obj:
            return None

        extra = model_obj.capabilities_config or {}
        return ASRProviderConfigSchema(
            source="database",
            provider_name="bytedance",
            display_name=provider_obj.display_name or "ByteDance ASR",
            app_id_masked=_mask(extra.get("app_id", "")),
            access_token_masked=_mask(provider_obj.api_key or ""),
            secret_key_masked=_mask(extra.get("secret_key", "")),
            resource_id=extra.get("resource_id", model_obj.model_name or ""),
            ws_endpoint=extra.get("ws_endpoint", ""),
            # v0.1.x：is_active 字段已删；可路由语义 = provider.routing_enabled。
            is_active=bool(provider_obj.routing_enabled),
            provider_id=str(provider_obj.id),
            model_id=str(model_obj.id),
            model_name=model_obj.model_name,
            capabilities_config=_sanitize_capabilities_config(extra),
        )
    except (DatabaseError, AttributeError) as e:
        logger.warning("从 DB 加载 ASR 配置失败: %s", e)
        return None

def _load_asr_settings_config() -> ASRProviderConfigSchema:
    """从 Django settings 加载 ASR 配置"""
    app_id = getattr(django_settings, "BYTEDANCE_ASR_APP_ID", "")
    token = getattr(django_settings, "BYTEDANCE_ASR_ACCESS_TOKEN", "")
    secret = getattr(django_settings, "BYTEDANCE_ASR_SECRET_KEY", "")
    resource_id = getattr(django_settings, "BYTEDANCE_ASR_RESOURCE_ID", "")

    return ASRProviderConfigSchema(
        source="settings",
        provider_name="bytedance",
        display_name="ByteDance ASR (settings fallback)",
        app_id_masked=_mask(app_id),
        access_token_masked=_mask(token),
        secret_key_masked=_mask(secret),
        resource_id=resource_id,
        is_active=bool(app_id and token),
    )

@router.get("/speech/asr/config", auth=StaffAuth(), response=ASRConfigOverviewSchema)
def get_asr_config(request):
    """获取 ASR 配置总览"""

    providers: list[ASRProviderConfigSchema] = []

    db_config = _load_db_asr_config()
    if db_config:
        providers.append(db_config)

    providers.append(_load_asr_settings_config())

    return ASRConfigOverviewSchema(
        providers=providers,
        supported_modes=ASR_SUPPORTED_MODES,
    )

@router.put("/speech/asr/config/{provider_id}", auth=SuperuserAuth(), response=ASRProviderConfigSchema)
def update_asr_config(request, provider_id: str, payload: ASRConfigUpdateSchema):
    """更新 ASR Provider 配置（仅 DB 来源）"""

    operator_id = _get_operator_id(request)

    try:
        provider = LLMProvider.objects.get(id=provider_id, name="bytedance")
    except (LLMProvider.DoesNotExist, ValueError, ValidationError):
        raise HttpError(404, _("speech.asr_provider_not_found"))

    if payload.ws_endpoint is not None and payload.ws_endpoint not in VALID_WS_ENDPOINTS:
        raise HttpError(
            400,
            _("speech.invalid_ws_endpoint", endpoint=payload.ws_endpoint, valid=sorted(VALID_WS_ENDPOINTS)),
        )

    has_model_fields = any(
        getattr(payload, f) is not None
        for f in ("app_id", "secret_key", "resource_id", "ws_endpoint")
    )

    with transaction.atomic():
        provider_fields: list[str] = []
        if payload.access_token is not None:
            provider.api_key = payload.access_token
            provider_fields.append("encrypted_api_key")
        # v0.1.x：LLMProvider.is_active 已删（0022），改用 routing_enabled。
        if payload.is_active is not None:
            provider.routing_enabled = payload.is_active
            provider_fields.append("routing_enabled")
        if provider_fields:
            provider.save(update_fields=provider_fields + ["updated_at"])

        # v0.1.x：LLMModel.mode 已删（0022），改用 capability_domain。
        model = LLMModel.objects.filter(
            provider=provider, capability_domain="asr",
        ).first()

        if has_model_fields and not model:
            raise HttpError(
                400,
                _("speech.no_audio_transcription_model"),
            )

        model_changed_fields: list[str] = []
        if model and has_model_fields:
            extra = model.capabilities_config or {}
            if payload.app_id is not None:
                extra["app_id"] = payload.app_id
                model_changed_fields.append("app_id")
            if payload.secret_key is not None:
                extra["secret_key"] = payload.secret_key
                model_changed_fields.append("secret_key")
            if payload.resource_id is not None:
                extra["resource_id"] = payload.resource_id
                model_changed_fields.append("resource_id")
            if payload.ws_endpoint is not None:
                extra["ws_endpoint"] = payload.ws_endpoint
                model_changed_fields.append("ws_endpoint")
            model.capabilities_config = extra
            model.save(update_fields=["capabilities_config"])

    from ._config_cache import invalidate as _invalidate_speech_cache
    _invalidate_speech_cache()

    logger.info(
        "[SpeechAdmin] 更新 ASR 配置: operator=%s, provider=%s, provider_fields=%s, model_fields=%s",
        operator_id,
        provider_id,
        provider_fields,
        model_changed_fields,
    )

    result = _load_db_asr_config()
    if result:
        return result
    return _load_asr_settings_config()

# ── ASR 定价管理 ──

@router.get("/speech/asr/pricing", auth=StaffAuth(), response=ASRPricingListSchema)
def list_asr_pricing(request):
    """获取 ASR 定价列表"""

    qs = MeterPricing.objects.filter(
        meter_key=ASR_METER_KEY,
    ).order_by("-priority", "-effective_from")

    items = [_build_pricing_schema(p, ASRPricingSchema) for p in qs]
    return ASRPricingListSchema(items=items)

@router.put("/speech/asr/pricing/{pricing_id}", auth=SuperuserAuth(), response=ASRPricingSchema)
def update_asr_pricing(request, pricing_id: str, payload: ASRPricingUpdateSchema):
    """更新 ASR 定价"""
    return _do_update_pricing(
        ASR_METER_KEY, pricing_id, payload,
        _get_operator_id(request), ASRPricingSchema, "ASR",
    )

# ── ASR 用量统计 ──

@router.get("/speech/asr/usage", auth=StaffAuth(), response=ASRUsageStatsSchema)
def get_asr_usage(request, days: int = 30):
    """获取 ASR 用量统计"""

    return _build_usage_stats(
        ASR_METER_KEY, days,
        daily_schema_cls=ASRUsageDailySchema,
        summary_schema_cls=ASRUsageSummarySchema,
        biz_schema_cls=ASRUsageByBizTypeSchema,
        stats_schema_cls=ASRUsageStatsSchema,
        quantity_field="seconds",
    )

"""Speech Admin 管理接口 Schema（ASR + TTS）"""

import datetime
from decimal import Decimal
from typing import Any, Optional

from ninja import Schema


# ── TTS 配置概览 ──

class TTSProviderConfigSchema(Schema):
    """TTS 服务商配置（合并 DB + settings 来源）"""

    class Config:
        protected_namespaces = ()

    source: str  # "database" | "settings"
    provider_name: str
    display_name: str
    app_id_masked: str
    access_token_masked: str
    resource_id: str
    default_speaker: str
    is_active: bool
    # DB 来源的额外信息
    provider_id: Optional[str] = None
    model_id: Optional[str] = None
    model_name: Optional[str] = None
    capabilities_config: Optional[dict[str, Any]] = None


class TTSConfigOverviewSchema(Schema):
    """TTS 配置总览"""
    providers: list[TTSProviderConfigSchema]
    available_speakers: list[dict[str, str]]
    factory_aliases: dict[str, str]


class TTSConfigUpdateSchema(Schema):
    """更新 TTS 配置（仅 DB 来源）"""
    app_id: Optional[str] = None
    access_token: Optional[str] = None
    resource_id: Optional[str] = None
    default_speaker: Optional[str] = None
    is_active: Optional[bool] = None


# ── 定价管理 ──

class TTSPricingSchema(Schema):
    """TTS 定价"""

    class Config:
        protected_namespaces = ()

    id: str
    meter_key: str
    scope: str
    unit_price: Decimal
    unit: str
    currency: str
    provider_key: str
    model_name: str
    is_active: bool
    effective_from: Optional[datetime.datetime] = None
    effective_to: Optional[datetime.datetime] = None
    priority: int


class TTSPricingUpdateSchema(Schema):
    """更新 TTS 定价"""
    unit_price: Optional[str] = None
    is_active: Optional[bool] = None


class TTSPricingListSchema(Schema):
    items: list[TTSPricingSchema]


# ── 用量统计 ──

class TTSUsageSummarySchema(Schema):
    """TTS 用量汇总"""
    total_characters: Decimal
    total_amount: Decimal
    total_events: int
    currency: str


class TTSUsageDailySchema(Schema):
    """每日用量"""
    date: datetime.date
    characters: Decimal
    amount: Decimal
    event_count: int


class TTSUsageByBizTypeSchema(Schema):
    """按业务类型分组"""
    biz_type: str
    characters: Decimal
    amount: Decimal
    event_count: int


class TTSUsageStatsSchema(Schema):
    """TTS 用量统计响应"""
    summary: TTSUsageSummarySchema
    daily: list[TTSUsageDailySchema]
    by_biz_type: list[TTSUsageByBizTypeSchema]
    period_start: datetime.date
    period_end: datetime.date


# ── ASR 配置概览 ──

class ASRProviderConfigSchema(Schema):
    """ASR 服务商配置（合并 DB + settings 来源）"""

    class Config:
        protected_namespaces = ()

    source: str  # "database" | "settings"
    provider_name: str
    display_name: str
    app_id_masked: str
    access_token_masked: str
    secret_key_masked: str = ""
    resource_id: str
    ws_endpoint: str = ""
    is_active: bool
    provider_id: Optional[str] = None
    model_id: Optional[str] = None
    model_name: Optional[str] = None
    capabilities_config: Optional[dict[str, Any]] = None


class ASRConfigOverviewSchema(Schema):
    """ASR 配置总览"""
    providers: list[ASRProviderConfigSchema]
    supported_modes: list[str]


class ASRConfigUpdateSchema(Schema):
    """更新 ASR 配置（仅 DB 来源）"""
    app_id: Optional[str] = None
    access_token: Optional[str] = None
    secret_key: Optional[str] = None
    resource_id: Optional[str] = None
    ws_endpoint: Optional[str] = None
    is_active: Optional[bool] = None


# ── ASR 定价管理 ──

class ASRPricingSchema(Schema):
    """ASR 定价"""

    class Config:
        protected_namespaces = ()

    id: str
    meter_key: str
    scope: str
    unit_price: Decimal
    unit: str
    currency: str
    provider_key: str
    model_name: str
    is_active: bool
    effective_from: Optional[datetime.datetime] = None
    effective_to: Optional[datetime.datetime] = None
    priority: int


class ASRPricingUpdateSchema(Schema):
    """更新 ASR 定价"""
    unit_price: Optional[str] = None
    is_active: Optional[bool] = None


class ASRPricingListSchema(Schema):
    items: list[ASRPricingSchema]


# ── ASR 用量统计 ──

class ASRUsageSummarySchema(Schema):
    """ASR 用量汇总"""
    total_seconds: Decimal
    total_amount: Decimal
    total_events: int
    currency: str


class ASRUsageDailySchema(Schema):
    """每日 ASR 用量"""
    date: datetime.date
    seconds: Decimal
    amount: Decimal
    event_count: int


class ASRUsageByBizTypeSchema(Schema):
    """按业务类型分组"""
    biz_type: str
    seconds: Decimal
    amount: Decimal
    event_count: int


class ASRUsageStatsSchema(Schema):
    """ASR 用量统计响应"""
    summary: ASRUsageSummarySchema
    daily: list[ASRUsageDailySchema]
    by_biz_type: list[ASRUsageByBizTypeSchema]
    period_start: datetime.date
    period_end: datetime.date

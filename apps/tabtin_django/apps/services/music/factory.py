"""
音乐生成服务工厂

支持两种配置来源：
  1. 直接传参（脚本/测试）
  2. 从 LLMProvider(name='minimax') 获取 api_key（生产环境）

使用方式：
  # 方式 1: 直接配置
  bgm = get_music_service(provider="minimax", config={"api_key": "..."})

  # 方式 2: 从数据库/settings 自动获取
  bgm = get_music_service(provider="minimax")
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from django.conf import settings

from .base import BaseMusicService

logger = logging.getLogger(__name__)


class MusicServiceFactory:
    """音乐生成服务工厂"""

    SERVICE_CLASSES: dict[str, type[BaseMusicService]] = {}

    @classmethod
    def _ensure_registered(cls):
        if cls.SERVICE_CLASSES:
            return
        from .minimax_music import MiniMaxMusicService
        cls.SERVICE_CLASSES["minimax"] = MiniMaxMusicService

    @classmethod
    def create_service(cls, provider_name: str, config: dict[str, Any]) -> BaseMusicService:
        cls._ensure_registered()
        if provider_name not in cls.SERVICE_CLASSES:
            raise ValueError(f"不支持的音乐生成提供商: {provider_name}")

        service_class = cls.SERVICE_CLASSES[provider_name]
        config.setdefault("provider_name", provider_name)
        return service_class(config)

    @classmethod
    def register(cls, name: str, service_class: type[BaseMusicService]):
        cls.SERVICE_CLASSES[name] = service_class

    @classmethod
    def get_supported_providers(cls) -> list[str]:
        cls._ensure_registered()
        return list(cls.SERVICE_CLASSES.keys())


# 向后兼容别名
BGMServiceFactory = MusicServiceFactory


def get_music_service(
    provider: str = "minimax",
    config: Optional[dict[str, Any]] = None,
) -> BaseMusicService:
    """
    获取音乐生成服务实例

    Args:
        provider: 音乐生成提供商名称
        config: 直接传入配置（优先）；为 None 时从 settings / DB 获取
    """
    if config is not None:
        return MusicServiceFactory.create_service(provider, config)

    resolved_config = _resolve_config(provider)
    return MusicServiceFactory.create_service(provider, resolved_config)


# 向后兼容别名
get_bgm_service = get_music_service


def _resolve_config(provider: str) -> dict[str, Any]:
    """解析音乐生成配置：优先 DB → 回退 settings"""
    db_config = _try_load_from_db(provider)
    if db_config:
        return db_config
    return _load_from_settings(provider)


def _try_load_from_db(provider: str) -> Optional[dict[str, Any]]:
    """从 LLMProvider 获取 MiniMax api_key（含限流/熔断字段）。

    优先通过 ProviderRegistry 发现支持 bgm 能力的 Provider，
    回退到按 name 直接查询 LLMProvider。
    """
    try:
        from apps.services.llm.models import LLMProvider

        provider_obj = _discover_provider(provider)
        if not provider_obj:
            return None

        return {
            "provider_name": provider,
            "api_key": provider_obj.api_key,
            "api_url": getattr(settings, "MINIMAX_BGM_API_URL",
                               "https://api.minimaxi.com/v1/music_generation"),
            "model": getattr(settings, "MINIMAX_BGM_MODEL", "music-2.5"),
            "provider_id": str(provider_obj.id),
            "rate_limit": int(getattr(provider_obj, "rate_limit", 0) or 0),
        }
    except Exception as e:
        logger.debug("从 DB 加载音乐生成配置失败，回退 settings: %s", e)
        return None


def _discover_provider(provider_name: str):
    """通过 v0.1 ``capability_domain='audio_gen'`` 发现 BGM Provider。

    v0.1 把含糊的 ``"bgm"`` 归一到 ``audio_gen``（宝章 8 域之一），
    LLMProvider.is_active 已删（0022），可路由由 ``routing_enabled`` 表达。
    兼容服务名 ``minimax`` ↔ DB name ``minimax_bgm`` 的别名关系。
    """
    from apps.services.llm.models import LLMProvider

    db_names = [provider_name]
    if provider_name == "minimax":
        db_names = ["minimax_bgm", "minimax"]

    for db_name in db_names:
        obj = LLMProvider.objects.filter(
            name=db_name,
            capability_domains__contains=["audio_gen"],
            routing_enabled=True,
        ).first()
        if obj:
            return obj

    for db_name in db_names:
        obj = LLMProvider.objects.filter(name=db_name, routing_enabled=True).first()
        if obj:
            return obj
    return None


def _load_from_settings(provider: str) -> dict[str, Any]:
    """从 Django settings 加载音乐生成配置"""
    if provider == "minimax":
        return {
            "provider_name": "minimax",
            "api_key": getattr(settings, "MINIMAX_API_KEY", ""),
            "api_url": getattr(
                settings, "MINIMAX_BGM_API_URL",
                "https://api.minimaxi.com/v1/music_generation",
            ),
            "model": getattr(settings, "MINIMAX_BGM_MODEL", "music-2.5"),
        }

    raise ValueError(f"未配置音乐生成提供商 settings: {provider}")

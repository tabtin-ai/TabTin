"""
音效搜索服务工厂

使用方式：
  from apps.services.sound_effects import get_sound_effect_service
  svc = get_sound_effect_service(provider="freesound")
  result = svc.search(query="whoosh", page=1)
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .base import BaseSoundEffectService

logger = logging.getLogger(__name__)


class SoundEffectServiceFactory:
    """音效搜索服务工厂（可注册多 Provider）"""

    SERVICE_CLASSES: dict[str, type[BaseSoundEffectService]] = {}

    @classmethod
    def _ensure_registered(cls) -> None:
        if cls.SERVICE_CLASSES:
            return
        from .freesound import FreesoundService

        cls.SERVICE_CLASSES["freesound"] = FreesoundService

    @classmethod
    def create_service(
        cls,
        provider_name: str,
        config: dict[str, Any] | None = None,
    ) -> BaseSoundEffectService:
        cls._ensure_registered()
        if provider_name not in cls.SERVICE_CLASSES:
            raise ValueError(f"不支持的音效搜索提供商: {provider_name}")

        cfg = dict(config or {})
        cfg.setdefault("provider_name", provider_name)
        service_class = cls.SERVICE_CLASSES[provider_name]
        return service_class(cfg)

    @classmethod
    def register(cls, name: str, service_class: type[BaseSoundEffectService]) -> None:
        cls.SERVICE_CLASSES[name] = service_class

    @classmethod
    def get_supported_providers(cls) -> list[str]:
        cls._ensure_registered()
        return list(cls.SERVICE_CLASSES.keys())


def get_sound_effect_service(
    provider: str = "freesound",
    config: Optional[dict[str, Any]] = None,
) -> BaseSoundEffectService:
    """
    获取音效搜索服务实例。

    Args:
        provider: 提供商名称，当前支持 freesound
        config: 可选配置（覆盖默认）；为 None 时使用空配置，具体密钥仍从 Django settings 读取
    """
    return SoundEffectServiceFactory.create_service(provider, config)

"""
平台音效服务 — 音效搜索抽象层

Provider 模式：
  BaseSoundEffectService   ← 抽象接口
  FreesoundService         ← Freesound 实现
  get_sound_effect_service() ← 工厂入口

使用方式：
  from apps.services.sound_effects import get_sound_effect_service, search_sounds
  result = get_sound_effect_service().search(query="whoosh", page=1)
  # 或
  result = search_sounds(query="whoosh", page=1)
"""

from .base import BaseSoundEffectService, SoundEffectResult
from .factory import (
    SoundEffectServiceFactory,
    get_sound_effect_service,
)
from .freesound import FreesoundService, search_sounds

__all__ = [
    "BaseSoundEffectService",
    "SoundEffectResult",
    "SoundEffectServiceFactory",
    "FreesoundService",
    "get_sound_effect_service",
    "search_sounds",
]

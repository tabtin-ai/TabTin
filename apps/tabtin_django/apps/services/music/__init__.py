"""
平台音乐生成服务 — BGM 生成抽象层

Provider 模式：
  BaseMusicService   ← 抽象接口
  MiniMaxMusicService ← MiniMax music-2.5 实现
  get_music_service() ← 工厂入口

使用方式：
  from apps.services.music import get_music_service
  svc = get_music_service(provider="minimax")
  result = svc.generate(
      prompt="ambient electronic, cinematic, inspiring",
      target_duration=60.0,
  )

计费说明：
  调用 generate_bgm_task 时，应传入调用方自己的 biz_type 参数以区分计费归属：
  - TabSlide 调用：biz_type="tabslide_bgm"
  - 其他产品线调用：biz_type="{product}_bgm"

向后兼容别名：
  get_bgm_service = get_music_service
  BaseBGMService = BaseMusicService
  BGMResult = MusicResult
  BGMServiceFactory = MusicServiceFactory
"""

from .base import BaseMusicService, BaseBGMService, MusicResult, BGMResult, MusicSection
from .factory import get_music_service, get_bgm_service, MusicServiceFactory, BGMServiceFactory

__all__ = [
    # 新命名
    "BaseMusicService",
    "MusicResult",
    "MusicSection",
    "get_music_service",
    "MusicServiceFactory",
    # 向后兼容
    "BaseBGMService",
    "BGMResult",
    "get_bgm_service",
    "BGMServiceFactory",
]

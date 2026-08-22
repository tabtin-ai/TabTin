"""
TTS 服务模块 — 统一抽象层

所有 TTS 需求（实时对话、视频配音、CLI 等）统一收口到此模块。

Provider 模式（async）：
  BaseTTSService  ← 抽象接口
  ByteDanceHttpTTS / ByteDanceWsBidirectionalTTS ← 字节跳动实现
  get_tts_service() ← 工厂入口

同步桥接（Celery / 脚本）：
  synthesize_sync()    ← 同步合成，返回 TTSResult
  synthesize_to_file() ← 同步合成到 WAV，返回 TTSFileResult（含 ffprobe 时长）

音频工具：
  pcm_to_wav()       ← PCM → WAV 无损转换
  measure_duration() ← ffprobe 实测时长
  save_audio_to_file() ← 内存音频 → 文件
"""

from .base import BaseTTSService
from .factory import (
    TTSConfigError,
    TTSUpstreamError,
    TTSServiceFactory,
    get_tts_service,
    synthesize_sync,
    synthesize_to_file,
)
from .types import (
    TTSChunk,
    TTSFileResult,
    TTSResult,
    TTSSentence,
    TTSStreamEvent,
    TTSWordTimestamp,
)
from .audio_utils import measure_duration, pcm_to_wav, save_audio_to_file

__all__ = [
    # 服务
    "BaseTTSService",
    "TTSConfigError",
    "TTSUpstreamError",
    "TTSServiceFactory",
    "get_tts_service",
    # 同步桥接
    "synthesize_sync",
    "synthesize_to_file",
    "TTSFileResult",
    # 类型
    "TTSResult",
    "TTSChunk",
    "TTSSentence",
    "TTSWordTimestamp",
    "TTSStreamEvent",
    # 音频工具
    "pcm_to_wav",
    "measure_duration",
    "save_audio_to_file",
]

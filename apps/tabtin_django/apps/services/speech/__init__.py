"""
TabTin Speech Services — 语音识别 (ASR) & 语音合成 (TTS) 统一抽象层

ASR Provider 模式：
  BaseASRService  ← 抽象接口
  ByteDanceFlashASR / ByteDanceStandardASR / ByteDanceStreamingASR ← 字节跳动实现
  get_asr_service() ← 工厂入口

TTS Provider 模式：
  BaseTTSService  ← 抽象接口
  ByteDanceHttpTTS / ByteDanceWsBidirectionalTTS ← 字节跳动实现
  get_tts_service() ← 工厂入口

统一异常体系：
  SpeechError → SpeechConfigError / SpeechUpstreamError
  ASRConfigError / TTSConfigError ← SpeechConfigError
  ASRUpstreamError / TTSUpstreamError ← SpeechUpstreamError
"""
from .exceptions import SpeechConfigError, SpeechError, SpeechUpstreamError  # noqa: F401

"""
Speech 服务统一异常体系

层级：
  SpeechError                  ← 所有语音服务异常的基类
  ├── SpeechConfigError        ← 配置缺失或无效（凭证、provider、mode）
  └── SpeechUpstreamError      ← 上游服务（字节跳动等）返回错误

ASR / TTS 各自有子类（继承自基类，定义在各自 factory 中）：
  ASRConfigError(SpeechConfigError)       ← asr/factory.py
  TTSConfigError(SpeechConfigError)       ← tts/factory.py
  ASRUpstreamError(SpeechUpstreamError)   ← asr/factory.py
  TTSUpstreamError(SpeechUpstreamError)   ← tts/factory.py

API 层 / WS handler 可统一捕获基类，也可按需捕获子类。
"""


class SpeechError(Exception):
    """所有语音服务异常的基类。"""
    pass


class SpeechConfigError(SpeechError):
    """配置缺失或无效时抛出。下游可据此给用户友好提示。"""
    pass


class SpeechUpstreamError(SpeechError):
    """上游语音服务返回错误时抛出。"""
    pass

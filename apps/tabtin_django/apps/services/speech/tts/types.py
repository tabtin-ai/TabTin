"""
TTS 统一结果模型

所有 Provider 的合成结果都转换为此处定义的标准格式，
下游模块（TabVideo 配音、实时对话等）只依赖这些类型。
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class TTSWordTimestamp:
    """字/词级时间戳"""

    word: str
    start_time: float  # 秒
    end_time: float  # 秒
    confidence: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.word,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "confidence": self.confidence,
        }


@dataclass
class TTSSentence:
    """句子级信息（含字级时间戳）"""

    text: str
    words: list[TTSWordTimestamp] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "words": [w.to_dict() for w in self.words],
        }


@dataclass
class TTSChunk:
    """流式音频块（synthesize_stream 逐块返回）"""

    audio_data: bytes
    sentence: Optional[TTSSentence] = None
    is_last: bool = False
    event_type: str = "audio"  # audio / sentence_start / sentence_end / subtitle

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "audioData": base64.b64encode(self.audio_data).decode() if self.audio_data else "",
            "isLast": self.is_last,
            "eventType": self.event_type,
        }
        if self.sentence:
            d["sentence"] = self.sentence.to_dict()
        return d


@dataclass
class TTSResult:
    """TTS 合成完整结果"""

    audio_data: bytes
    format: str = "mp3"
    sample_rate: int = 24000
    duration: float = 0.0  # 秒（估算值，精确值需 ffprobe）
    sentences: list[TTSSentence] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)
    provider: str = ""
    mode: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "audioData": base64.b64encode(self.audio_data).decode() if self.audio_data else "",
            "audioSize": len(self.audio_data),
            "format": self.format,
            "sampleRate": self.sample_rate,
            "duration": self.duration,
            "sentences": [s.to_dict() for s in self.sentences],
            "usage": self.usage,
            "provider": self.provider,
            "mode": self.mode,
        }


@dataclass
class TTSFileResult:
    """同步合成到文件的结果（视频管线 / Celery task 专用）"""
    audio_path: str
    word_timestamps: list[dict[str, Any]] = field(default_factory=list)
    measured_duration: float = 0.0
    sample_rate: int = 24000
    channels: int = 1
    format: str = "pcm"


@dataclass
class TTSStreamEvent:
    """WS 双向流式事件（用于 WebSocket Gateway 推送）"""

    event_type: str  # session_started / audio / sentence_start / sentence_end / subtitle / done / error
    audio_data: Optional[bytes] = None
    sentence: Optional[TTSSentence] = None
    usage: Optional[dict[str, Any]] = None
    error_code: int = 0
    error_message: str = ""
    session_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "eventType": self.event_type,
            "sessionId": self.session_id,
        }
        if self.audio_data:
            d["audioData"] = base64.b64encode(self.audio_data).decode()
            d["audioSize"] = len(self.audio_data)
        if self.sentence:
            d["sentence"] = self.sentence.to_dict()
        if self.usage:
            d["usage"] = self.usage
        if self.error_code:
            d["errorCode"] = self.error_code
            d["errorMessage"] = self.error_message
        return d

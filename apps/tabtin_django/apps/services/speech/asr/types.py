"""
ASR 统一结果模型

所有 Provider 的识别结果都转换为此处定义的标准格式，
下游模块（TabVideo 字幕、会议纪要等）只依赖这些类型。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class ASRWord:
    """字/词级别时间戳"""

    text: str
    start_time: int  # 毫秒
    end_time: int  # 毫秒
    confidence: float = 0.0
    blank_duration: int = 0  # 毫秒，与前一个词的间隔

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "confidence": self.confidence,
            "blankDuration": self.blank_duration,
        }


@dataclass
class ASRUtterance:
    """句级分段（一句话）"""

    text: str
    start_time: int  # 毫秒
    end_time: int  # 毫秒
    definite: bool = True
    words: list[ASRWord] = field(default_factory=list)
    speaker_id: Optional[int] = None
    additions: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "text": self.text,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "definite": self.definite,
            "words": [w.to_dict() for w in self.words],
        }
        if self.speaker_id is not None:
            d["speakerId"] = self.speaker_id
        if self.additions:
            d["additions"] = self.additions
        return d


@dataclass
class ASRAudioInfo:
    """音频元信息"""

    duration: int = 0  # 毫秒

    def to_dict(self) -> dict[str, Any]:
        return {"duration": self.duration}


@dataclass
class ASRResult:
    """
    ASR 识别最终结果

    无论使用哪个 Provider / 哪种模式，最终都归一化为此结构。
    """

    text: str
    utterances: list[ASRUtterance] = field(default_factory=list)
    audio_info: ASRAudioInfo = field(default_factory=ASRAudioInfo)
    language: str = ""
    provider: str = ""
    mode: str = ""
    raw_response: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "utterances": [u.to_dict() for u in self.utterances],
            "audioInfo": self.audio_info.to_dict(),
            "language": self.language,
            "provider": self.provider,
            "mode": self.mode,
        }


@dataclass
class ASRTaskStatus:
    """标准版异步任务状态"""

    task_id: str
    status: str  # "queued" | "processing" | "completed" | "failed" | "silent"
    result: Optional[ASRResult] = None
    error_code: int = 0
    error_message: str = ""
    log_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "taskId": self.task_id,
            "status": self.status,
            "errorCode": self.error_code,
            "errorMessage": self.error_message,
            "logId": self.log_id,
        }
        if self.result:
            d["result"] = self.result.to_dict()
        return d


@dataclass
class ASRStreamEvent:
    """流式识别的单次事件"""

    text: str
    utterances: list[ASRUtterance] = field(default_factory=list)
    is_final: bool = False
    sequence: int = 0
    audio_info: ASRAudioInfo = field(default_factory=ASRAudioInfo)
    error_code: int = 0
    error_message: str = ""

    @property
    def has_error(self) -> bool:
        return bool(self.error_code or self.error_message)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "text": self.text,
            "utterances": [u.to_dict() for u in self.utterances],
            "isFinal": self.is_final,
            "sequence": self.sequence,
            "audioInfo": self.audio_info.to_dict(),
        }
        if self.error_code:
            d["errorCode"] = self.error_code
        if self.error_message:
            d["errorMessage"] = self.error_message
        return d

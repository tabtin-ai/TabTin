"""
Speech Services API Schemas
"""

from typing import Any, Optional

from ninja import Schema
from pydantic import field_validator, Field


# ── ASR 极速版 / 标准版共用 ──

class ASRRecognizeRequest(Schema):
    """极速版同步识别请求"""

    class Config:
        protected_namespaces = ()

    audio_url: Optional[str] = None
    audio_data: Optional[str] = None
    language: str = ""
    audio_format: str = "mp3"
    provider: str = "bytedance"
    mode: str = "flash"
    organization_id: str

    enable_itn: Optional[bool] = None
    enable_punc: Optional[bool] = None
    enable_ddc: Optional[bool] = None
    show_utterances: Optional[bool] = True
    enable_speaker_info: Optional[bool] = None
    enable_channel_split: Optional[bool] = None
    enable_lid: Optional[bool] = None
    enable_emotion_detection: Optional[bool] = None
    enable_gender_detection: Optional[bool] = None
    model_version: Optional[str] = None

    boosting_table_name: Optional[str] = None
    correct_table_name: Optional[str] = None
    context: Optional[str] = None


class ASRSubmitRequest(Schema):
    """标准版提交任务请求"""

    class Config:
        protected_namespaces = ()

    audio_url: str
    language: str = ""
    audio_format: str = "mp3"
    provider: str = "bytedance"
    organization_id: str
    callback_url: Optional[str] = None
    callback_data: Optional[str] = None

    enable_itn: Optional[bool] = None
    enable_punc: Optional[bool] = None
    enable_ddc: Optional[bool] = None
    show_utterances: Optional[bool] = True
    enable_speaker_info: Optional[bool] = None
    enable_channel_split: Optional[bool] = None
    show_speech_rate: Optional[bool] = None
    show_volume: Optional[bool] = None
    enable_lid: Optional[bool] = None
    enable_emotion_detection: Optional[bool] = None
    enable_gender_detection: Optional[bool] = None
    model_version: Optional[str] = None
    vad_segment: Optional[bool] = None
    end_window_size: Optional[int] = None
    sensitive_words_filter: Optional[str] = None

    boosting_table_name: Optional[str] = None
    correct_table_name: Optional[str] = None
    context: Optional[str] = None


class ASRQueryRequest(Schema):
    """标准版查询任务请求"""

    task_id: str
    provider: str = "bytedance"
    organization_id: str


class ASRProvidersRequest(Schema):
    """查询可用 Provider 列表"""

    pass


# ── TTS ──────────────────────────────────────────────────────────


class TTSSynthesizeRequest(Schema):
    """TTS 合成请求"""

    text: str
    speaker: str = "zh_female_vv_uranus_bigtts"
    model: str = ""
    format: str = "mp3"
    sample_rate: int = 24000
    speed_ratio: float = 1.0
    volume_ratio: float = 1.0
    pitch: int = 0
    emotion: str = ""
    enable_timestamp: bool = False
    provider: str = "bytedance"
    mode: str = "http"
    organization_id: str
    context_texts: list[str] = []


class TTSVoiceItemSchema(Schema):
    """单条 TTS 音色数据"""

    class Config:
        populate_by_name = True
        protected_namespaces = ()

    voice_type: str = Field(..., alias="voiceType")
    name: str = ""
    provider: str = "bytedance"
    language: str = "zh"
    category: str = "通用场景"
    model_version: str = Field("1.0", alias="modelVersion")
    emotions: list[str] = []
    supports_mix: bool = Field(True, alias="supportsMix")
    supports_bidirectional: bool = Field(True, alias="supportsBidirectional")
    is_active: bool = Field(True, alias="isActive")
    extra: dict = {}


class TTSVoiceSyncRequest(Schema):
    """批量同步/导入音色"""

    voices: list[TTSVoiceItemSchema]

    @field_validator("voices")
    @classmethod
    def check_max_items(cls, v: list[TTSVoiceItemSchema]) -> list[TTSVoiceItemSchema]:
        if len(v) > 500:
            raise ValueError("voices 最多 500 条")
        return v

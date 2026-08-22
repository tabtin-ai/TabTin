"""
Speech Services Models — 音色管理等
"""

from django.db import models


class TTSVoice(models.Model):
    """TTS 音色配置，通过 admindash 或 API 管理，不硬编码"""

    provider = models.CharField(max_length=50, default="bytedance", db_index=True)
    voice_type = models.CharField(
        max_length=200, unique=True,
        help_text="音色 ID，如 zh_female_vv_uranus_bigtts",
    )
    name = models.CharField(max_length=100, help_text="音色显示名称")
    language = models.CharField(
        max_length=100, default="zh",
        help_text="支持语种，逗号分隔，如 zh,en,ja",
    )
    category = models.CharField(
        max_length=50, default="通用场景", db_index=True,
        help_text="场景分类：通用场景、角色扮演、视频配音 等",
    )
    model_version = models.CharField(
        max_length=20, default="1.0",
        help_text="模型版本: 1.0 / 2.0",
    )
    emotions = models.JSONField(
        default=list, blank=True,
        help_text='支持的情感列表，如 ["happy","sad","angry"]',
    )
    supports_mix = models.BooleanField(
        default=True,
        help_text="是否支持混音",
    )
    supports_bidirectional = models.BooleanField(
        default=True,
        help_text="是否支持双向流式接口",
    )
    is_active = models.BooleanField(default=True, db_index=True)
    extra = models.JSONField(
        default=dict, blank=True,
        help_text="扩展字段（上线业务方、特殊能力等）",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "speech_tts_voice"
        ordering = ["category", "name"]
        verbose_name = "TTS Voice"
        verbose_name_plural = "TTS Voices"

    def __str__(self) -> str:
        return f"{self.name} ({self.voice_type})"

    def to_dict(self) -> dict:
        return {
            "id": self.pk,
            "provider": self.provider,
            "voiceType": self.voice_type,
            "name": self.name,
            "language": self.language,
            "category": self.category,
            "modelVersion": self.model_version,
            "emotions": self.emotions,
            "supportsMix": self.supports_mix,
            "supportsBidirectional": self.supports_bidirectional,
            "isActive": self.is_active,
            "extra": self.extra,
        }

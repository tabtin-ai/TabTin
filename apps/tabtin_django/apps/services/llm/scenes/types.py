"""SceneSpec + 8 个 CapabilityRequirements dataclass。

每个 capability_domain 一个 dataclass，
继承自 BaseCapabilityRequirements（共享 latency_class + cost_class）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal, Mapping

CapabilityDomain = Literal[
    "chat", "embedding", "vision", "asr", "tts",
    "image_gen", "video_gen", "audio_gen",
]


class ScenePayer(str, Enum):
    PLATFORM = "platform"
    USER = "user"


class ModelSource(str, Enum):
    OFFICIAL = "official"
    BYOK = "byok"

    @classmethod
    def from_provider_scope(cls, provider_scope: str | None) -> ModelSource | None:
        normalized_scope = (provider_scope or "").strip().lower()
        if normalized_scope == "global":
            return cls.OFFICIAL
        if normalized_scope in {"organization", "user"}:
            return cls.BYOK
        return None


class FundingPolicy(str, Enum):
    NONE = "none"
    EXISTING_USER_FUNDING = "existing_user_funding"


class FallbackPolicy(str, Enum):
    OFFICIAL_BINDING_ONLY = "official_binding_only"
    PRESERVE_SELECTED_SOURCE = "preserve_selected_source"
    NONE = "none"


@dataclass(frozen=True)
class ScenePolicy:
    scene_key: str
    enabled_default: bool
    payer: ScenePayer
    allowed_model_sources: frozenset[ModelSource]
    funding_policy: FundingPolicy
    fallback_policy: FallbackPolicy
    execution_key: str

    def __post_init__(self) -> None:
        if not self.scene_key or not self.execution_key:
            raise ValueError("ScenePolicy scene_key/execution_key 不能为空")
        if not isinstance(self.enabled_default, bool):
            raise TypeError("ScenePolicy enabled_default 必须是 bool")
        if not isinstance(self.payer, ScenePayer):
            raise TypeError("ScenePolicy payer 非法")
        if (
            not isinstance(self.allowed_model_sources, frozenset)
            or not self.allowed_model_sources
            or any(not isinstance(source, ModelSource) for source in self.allowed_model_sources)
        ):
            raise TypeError("ScenePolicy allowed_model_sources 非法")
        if not isinstance(self.funding_policy, FundingPolicy):
            raise TypeError("ScenePolicy funding_policy 非法")
        if not isinstance(self.fallback_policy, FallbackPolicy):
            raise TypeError("ScenePolicy fallback_policy 非法")


@dataclass(frozen=True)
class ResolvedScenePolicy:
    scene_key: str
    enabled: bool
    payer: ScenePayer
    allowed_model_sources: frozenset[ModelSource]
    funding_policy: FundingPolicy
    fallback_policy: FallbackPolicy
    execution_key: str
    policy_version: str


@dataclass(frozen=True)
class BaseCapabilityRequirements:
    """所有 domain 共有的 2 字段。"""
    latency_class: Literal["realtime", "interactive", "batch"]
    cost_class: Literal["cheap", "standard", "premium", "user_choice"]


@dataclass(frozen=True)
class ChatCapabilityRequirements(BaseCapabilityRequirements):
    """chat domain（含主对话 + 17 业务 scene + 4 system scene）。"""
    requires_json_mode: bool = False
    requires_vision: bool = False
    requires_function_calling: bool = False
    min_context_tokens: int = 4000
    max_output_tokens: int = 1000


@dataclass(frozen=True)
class EmbeddingCapabilityRequirements(BaseCapabilityRequirements):
    """embedding domain（8 个 scene）。"""
    embedding_dimensions: int = 1024
    max_input_tokens: int = 8192
    max_batch_size: int = 50
    requires_dimensions_reduction: bool = True


@dataclass(frozen=True)
class VisionCapabilityRequirements(BaseCapabilityRequirements):
    """vision domain（VLM 专用）。"""
    requires_json_mode: bool = True
    min_context_tokens: int = 16000
    max_output_tokens: int = 8192
    max_image_edge_px: int = 1600
    max_images_per_request: int = 1


@dataclass(frozen=True)
class ASRCapabilityRequirements(BaseCapabilityRequirements):
    """asr domain。"""
    requires_streaming: bool = False
    requires_speaker_diarization: bool = False
    requires_word_timestamps: bool = True
    max_audio_duration_sec: int = 7200
    supported_languages: tuple[str, ...] = ("zh", "en")


@dataclass(frozen=True)
class TTSCapabilityRequirements(BaseCapabilityRequirements):
    """tts domain。"""
    requires_streaming: bool = False
    requires_emotion: bool = True
    requires_voice_cloning: bool = False
    supported_formats: tuple[str, ...] = ("mp3", "wav", "ogg", "pcm")
    supported_sample_rates: tuple[int, ...] = (24000,)
    max_text_chars: int = 50000


@dataclass(frozen=True)
class ImageGenCapabilityRequirements(BaseCapabilityRequirements):
    """image_gen domain。"""
    requires_negative_prompt: bool = False
    requires_image_to_image: bool = False
    requires_seed_control: bool = True
    supported_sizes: tuple[str, ...] = ("1024*1024",)
    max_n_per_request: int = 4
    max_prompt_chars: int = 1500


@dataclass(frozen=True)
class VideoGenCapabilityRequirements(BaseCapabilityRequirements):
    """video_gen domain。"""
    requires_image_to_video: bool = True
    requires_audio_input: bool = False
    requires_seed_control: bool = True
    supported_sizes: tuple[str, ...] = ("1280*720",)
    supported_durations_sec: tuple[int, ...] = (5,)
    max_prompt_chars: int = 1500


@dataclass(frozen=True)
class AudioGenCapabilityRequirements(BaseCapabilityRequirements):
    """audio_gen domain（BGM + 未来 SFX）。"""
    requires_lyrics: bool = True
    requires_style_preset: bool = True
    max_target_duration_sec: int = 300
    output_formats: tuple[str, ...] = ("wav", "mp3")


DOMAIN_TO_REQ_CLASS: dict[str, type[BaseCapabilityRequirements]] = {
    "chat": ChatCapabilityRequirements,
    "embedding": EmbeddingCapabilityRequirements,
    "vision": VisionCapabilityRequirements,
    "asr": ASRCapabilityRequirements,
    "tts": TTSCapabilityRequirements,
    "image_gen": ImageGenCapabilityRequirements,
    "video_gen": VideoGenCapabilityRequirements,
    "audio_gen": AudioGenCapabilityRequirements,
}


@dataclass(frozen=True)
class SceneSpec:
    """SceneRegistry 的一个登记项。frozen=True 保证启动后不可变。"""
    scene_key: str
    display_name: str
    description: str
    capability_domain: CapabilityDomain
    is_system: bool = False
    capability_requirements: dict = field(default_factory=dict)
    default_params: dict = field(default_factory=dict)
    policy: ScenePolicy | None = None

    def __post_init__(self) -> None:
        if self.policy is not None and self.policy.scene_key != self.scene_key:
            raise ValueError(
                f"SceneSpec.policy.scene_key={self.policy.scene_key!r} "
                f"与 scene_key={self.scene_key!r} 不一致"
            )

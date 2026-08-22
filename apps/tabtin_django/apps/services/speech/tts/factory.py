"""
TTS 服务工厂

支持两种配置来源：
  1. 直接传参（适合脚本/测试/Celery task）
  2. 从 DB (LLMModel) 或 Django settings 获取凭证

使用方式：
  # HTTP 单向（async）
  svc = get_tts_service(provider="bytedance", mode="http")
  result = await svc.synthesize("你好世界")

  # WS 双向（async stream）
  svc = get_tts_service(provider="bytedance", mode="ws_bidirectional")
  async for chunk in svc.synthesize_stream("流式文本"):
      ...

  # 同步合成（Celery task / 脚本）
  result = synthesize_sync("你好世界", format="pcm", enable_timestamp=True)

  # 同步合成到文件（视频管线）
  file_result = synthesize_to_file("你好世界", output_dir="/tmp/tts")

Provider 别名：
  "doubao" → "bytedance"（向后兼容，TabVideo 历史遗留）
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import os
import tempfile
import uuid
from dataclasses import replace
from typing import Any, Optional

from django.conf import settings

from ..config_types import TTSProviderConfig
from .base import BaseTTSService
from .types import TTSFileResult, TTSResult
from ..exceptions import SpeechConfigError, SpeechUpstreamError

logger = logging.getLogger(__name__)


class TTSConfigError(SpeechConfigError):
    """TTS 配置缺失或无效时抛出，下游可据此给用户友好提示。"""
    pass


class TTSUpstreamError(SpeechUpstreamError):
    """上游 TTS 服务（字节跳动等）返回错误时抛出。"""
    pass


BYTEDANCE_MODES = {
    "http": "apps.services.speech.tts.providers.bytedance.http_unidirectional.ByteDanceHttpTTS",
    "ws_bidirectional": "apps.services.speech.tts.providers.bytedance.ws_bidirectional.ByteDanceWsBidirectionalTTS",
}

PROVIDER_ALIASES: dict[str, str] = {
    "doubao": "bytedance",
}


class TTSServiceFactory:
    """TTS 服务工厂"""

    PROVIDER_MODES: dict[str, dict[str, str]] = {
        "bytedance": BYTEDANCE_MODES,
    }

    @classmethod
    def create_service(
        cls,
        provider_name: str,
        mode: str,
        config: TTSProviderConfig,
    ) -> BaseTTSService:
        canonical = PROVIDER_ALIASES.get(provider_name, provider_name)
        modes = cls.PROVIDER_MODES.get(canonical)
        if not modes:
            raise TTSConfigError(f"不支持的 TTS 提供商: {provider_name}")

        class_path = modes.get(mode)
        if not class_path:
            raise TTSConfigError(
                f"提供商 {canonical} 不支持 TTS 模式 {mode}，"
                f"可选: {list(modes.keys())}"
            )

        if not config.app_id or not config.access_token:
            raise TTSConfigError(
                f"TTS 凭证未配置（provider={canonical}）。"
                f"请在 AdminDash 配置 bytedance Provider 的 capability_domains 包含 'tts'、"
                f"并在对应 LLMModel.capabilities_config 中填写 app_id（access_token 来自 Provider.api_key）。"
            )

        service_class = cls._import_class(class_path)
        config = replace(config, provider_name=canonical, mode=mode)
        return service_class(config)

    @classmethod
    def register_provider(cls, name: str, modes: dict[str, str]) -> None:
        cls.PROVIDER_MODES[name] = modes

    @classmethod
    def get_supported_providers(cls) -> dict[str, list[str]]:
        return {
            provider: list(modes.keys())
            for provider, modes in cls.PROVIDER_MODES.items()
        }

    @staticmethod
    def _import_class(class_path: str) -> type[BaseTTSService]:
        module_path, class_name = class_path.rsplit(".", 1)
        module = importlib.import_module(module_path)
        return getattr(module, class_name)


def get_tts_service(
    provider: str = "bytedance",
    mode: str = "http",
    config: Optional[dict[str, Any] | TTSProviderConfig] = None,
    config_overrides: Optional[dict[str, Any]] = None,
    model_info: Optional[Any] = None,
) -> BaseTTSService:
    """
    获取 TTS 服务实例

    Args:
        provider: TTS 提供商名称 ("bytedance" / "doubao")
        mode: 合成模式 ("http" / "ws_bidirectional")
        config: 直接传入完整配置（优先）；为 None 时自动解析
        config_overrides: 覆盖已解析配置中的部分字段
        model_info: capability 入口已解析好的 LLMModel；提供时直接据其 provider +
            capabilities_config 构造配置，绕过 DB 二次查询和 env fallback。

    配置优先级：
        1. config 直接传入
        2. model_info（capability 入口路径，推荐）
        3. _resolve_config(provider, mode)：DB 查询 + settings 兜底（兼容旧调用方）

    Raises:
        TTSConfigError: 配置缺失或无效
    """
    canonical = PROVIDER_ALIASES.get(provider, provider)
    if config is not None:
        if isinstance(config, TTSProviderConfig):
            resolved = config
        else:
            known = TTSProviderConfig.__dataclass_fields__
            resolved = TTSProviderConfig(**{
                k: v for k, v in config.items() if k in known
            })
    elif model_info is not None:
        resolved = _config_from_model_info(canonical, mode, model_info)
    else:
        resolved = _resolve_config(canonical, mode)

    if config_overrides:
        known = TTSProviderConfig.__dataclass_fields__
        resolved = replace(resolved, **{
            k: v for k, v in config_overrides.items() if k in known
        })

    return TTSServiceFactory.create_service(canonical, mode, resolved)


def _config_from_model_info(
    provider: str, mode: str, model_info: Any,
) -> TTSProviderConfig:
    """从 capability 入口传下来的 LLMModel 直接构造 TTSProviderConfig。

    v0.1 宪法 §provider-credentials-ssot：Provider 的 api_key / base_url 与模型的
    capabilities_config 是 LLM 服务的单一真理源；TTS 不应再回退到 env / settings。
    """
    provider_obj = getattr(model_info, "provider", None)
    if provider_obj is None:
        raise TTSConfigError(
            f"TTS model_info 缺少 provider 关联（model={getattr(model_info, 'model_name', '?')}）"
        )
    extra = getattr(model_info, "capabilities_config", None) or {}
    extra = extra if isinstance(extra, dict) else {}
    resource_ids = extra.get("resource_ids", {})
    if isinstance(resource_ids, dict):
        resource_id = resource_ids.get(mode, extra.get("resource_id", ""))
    else:
        resource_id = extra.get("resource_id", "")

    api_key = getattr(provider_obj, "api_key", "") or ""
    if not api_key:
        raise TTSConfigError(
            f"TTS Provider '{getattr(provider_obj, 'provider_key', '?')}' 未配置 api_key"
        )

    return TTSProviderConfig(
        provider_name=provider,
        app_id=extra.get("app_id", ""),
        access_token=api_key,
        default_speaker=extra.get("default_speaker", ""),
        resource_id=resource_id,
        provider_id=str(getattr(provider_obj, "id", "") or ""),
        rate_limit=int(getattr(provider_obj, "rate_limit", 0) or 0),
    )


# ── 同步合成桥接 ─────────────────────────────────────────────────────


def synthesize_sync(
    text: str,
    *,
    provider: str = "bytedance",
    mode: str = "http",
    config: Optional[dict[str, Any]] = None,
    speaker: str = "",
    format: str = "mp3",
    sample_rate: int = 24000,
    enable_timestamp: bool = False,
    max_retries: int = 3,
    **kwargs: Any,
) -> "TTSResult":
    """
    同步 TTS 合成（在新事件循环中运行 async synthesize）。

    适用于 Celery task、管理命令等非 async 上下文。
    内置重试（默认 3 次 + 指数退避），与原 DoubaoTTS 行为对齐。
    返回 Speech TTS 标准的 TTSResult。
    """
    svc = get_tts_service(provider=provider, mode=mode, config=config)

    last_exc: Exception = TTSUpstreamError("synthesize_sync 未知错误")

    for attempt in range(max_retries):
        try:
            return run_async(
                svc.synthesize(
                    text,
                    speaker=speaker,
                    format=format,
                    sample_rate=sample_rate,
                    enable_timestamp=enable_timestamp,
                    **kwargs,
                )
            )
        except SpeechConfigError:
            raise
        except Exception as e:
            last_exc = e
            if attempt < max_retries - 1:
                import time
                wait = 2 ** attempt
                logger.warning(
                    "TTS 第 %d 次失败，%ds 后重试: %s",
                    attempt + 1, wait, e,
                )
                time.sleep(wait)
            else:
                logger.error("TTS 合成失败（已重试 %d 次）: %s", max_retries, e)

    raise TTSUpstreamError(f"TTS 合成失败（已重试 {max_retries} 次）: {last_exc}") from last_exc


def run_async(coro) -> Any:
    """
    在独立事件循环中运行 coroutine 的安全包装。

    使用 asgiref.sync.async_to_sync 统一处理：
      - 无 running loop → 创建新 loop 运行
      - 有 running loop → 在新线程中运行
      - gevent/eventlet monkey-patched → 内部已兼容（不会像
        ThreadPoolExecutor 那样因 greenlet 与原生线程混用而死锁）
    """
    from asgiref.sync import async_to_sync

    async def _wrapper():
        return await coro

    return async_to_sync(_wrapper)()


def synthesize_to_file(
    text: str,
    *,
    provider: str = "bytedance",
    mode: str = "http",
    config: Optional[dict[str, Any]] = None,
    speaker: str = "",
    sample_rate: int = 24000,
    output_dir: Optional[str] = None,
    **kwargs: Any,
) -> TTSFileResult:
    """
    同步 TTS 合成并保存为 WAV 文件，使用 ffprobe 测量真实时长。

    专为视频管线设计：
      - 强制 PCM 格式（无 encoder delay）
      - ffprobe 实测时长（不信任 API 报告值）
      - 词级时间戳（enable_subtitle=True）
      - 返回 TTSFileResult（含文件路径）

    Args:
        text: 合成文本
        provider: TTS 提供商
        mode: 合成模式
        config: 直接传入配置
        speaker: 音色 ID
        sample_rate: 采样率
        output_dir: WAV 输出目录
    """
    from .audio_utils import measure_duration, pcm_to_wav

    if output_dir is None:
        output_dir = tempfile.mkdtemp(prefix="speech_tts_")
    os.makedirs(output_dir, exist_ok=True)

    tts_result = synthesize_sync(
        text,
        provider=provider,
        mode=mode,
        config=config,
        speaker=speaker,
        format="pcm",
        sample_rate=sample_rate,
        enable_timestamp=True,
        **kwargs,
    )

    wav_path = os.path.join(output_dir, f"{uuid.uuid4().hex}.wav")
    pcm_to_wav(tts_result.audio_data, wav_path, sample_rate=sample_rate)
    duration = measure_duration(wav_path)

    if duration <= 0 and tts_result.audio_data:
        duration = len(tts_result.audio_data) / (sample_rate * 2)  # PCM s16le: 2 bytes/sample
        logger.warning("ffprobe 返回 0, fallback 到 PCM 长度估算: %.2fs", duration)

    word_timestamps: list[dict[str, Any]] = []
    for sentence in tts_result.sentences:
        for w in sentence.words:
            word_timestamps.append({
                "text": w.word,
                "startTime": w.start_time,
                "endTime": w.end_time,
            })

    return TTSFileResult(
        audio_path=wav_path,
        word_timestamps=word_timestamps,
        measured_duration=duration,
        sample_rate=sample_rate,
        channels=1,
        format="pcm",
    )


# ── 配置解析 ──────────────────────────────────────────────────────


def _resolve_config(provider: str, mode: str = "http") -> TTSProviderConfig:
    """解析 TTS 配置 —— v0.1.x 单源真理：只从 DB 解析，不再走 settings fallback。

    v0.1.x 改动（宪法 §provider-credentials-ssot）：
    - 删除 ``BYTEDANCE_TTS_*`` 环境变量 fallback；TTS 配置必须在 AdminDash 配置
      bytedance Provider 的 ``capabilities_config``（app_id / resource_ids / default_speaker）。
    """
    from .._config_cache import get_cached_config

    cache_key = f"tts:{provider}:{mode}"
    db_config = get_cached_config(
        cache_key,
        loader=lambda: _try_load_from_db(provider, mode),
    )
    if db_config:
        return db_config
    raise TTSConfigError(
        f"TTS Provider '{provider}' 未在 DB 配置（v0.1.x 已删除 settings.BYTEDANCE_* fallback）。"
        f"请在 AdminDash 配置 bytedance Provider 的 capability_domains 包含 'tts'、"
        f"并补齐 LLMModel.capabilities_config（app_id / resource_ids / default_speaker）。"
    )


def _try_load_from_db(provider: str, mode: str = "http") -> Optional[TTSProviderConfig]:
    """从 LLMProvider/LLMModel 加载 TTS 配置。

    v0.1 schema：``capability_domain='tts'`` + provider.capability_domains 包含 'tts'。
    LLMModel.mode/is_active 已删（migration 0022）。
    """
    try:
        from apps.services.llm.models import LLMModel

        provider_obj = _discover_provider(provider)
        if not provider_obj:
            return None

        model_obj = LLMModel.objects.filter(
            provider=provider_obj,
            capability_domain="tts",
        ).first()
        if not model_obj:
            return None

        extra = model_obj.capabilities_config or {}
        resource_ids = extra.get("resource_ids", {})
        resource_id = resource_ids.get(mode, extra.get("resource_id", ""))

        return TTSProviderConfig(
            provider_name=provider,
            app_id=extra.get("app_id", ""),
            access_token=provider_obj.api_key,
            default_speaker=extra.get("default_speaker", ""),
            resource_id=resource_id,
            provider_id=str(provider_obj.id),
            rate_limit=int(getattr(provider_obj, "rate_limit", 0) or 0),
        )
    except Exception as e:
        # v0.1.x：env fallback 已删；本 log 仅通知运营 DB 异常，
        # 调用方拿到 None 后会立即抛 TTSConfigError 阻断业务。
        logger.warning("[TTS] 从 DB 加载配置失败，下游将抛 TTSConfigError: %s", e)
        return None


def _discover_provider(provider_name: str):
    """通过 ``capability_domains`` 集合发现 TTS Provider。"""
    from apps.services.llm.models import LLMProvider

    return LLMProvider.objects.filter(
        name=provider_name,
        capability_domains__contains=["tts"],
        routing_enabled=True,
    ).first()


# v0.1.x：已删除 ``_load_from_settings`` —— TTS 配置必须走 DB 单源。
# 旧 env 变量（BYTEDANCE_TTS_APP_ID / BYTEDANCE_TTS_ACCESS_TOKEN / BYTEDANCE_TTS_RESOURCE_ID /
# BYTEDANCE_TTS_DEFAULT_SPEAKER）已废弃，请在 AdminDash 配置 bytedance Provider 的
# capabilities_config 完成等价迁移。

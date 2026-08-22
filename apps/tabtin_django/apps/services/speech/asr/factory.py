"""
ASR 服务工厂

支持三种配置来源（按优先级）：
  1. 直接传参 config（适合脚本/测试/Celery task）
  2. 从 DB（LLMProvider + LLMModel）加载
  3. 从 Django settings 环境变量获取

使用方式：
  # 极速版
  svc = get_asr_service(provider="bytedance", mode="flash")
  result = svc.recognize(audio_url="https://...")

  # 标准版
  svc = get_asr_service(provider="bytedance", mode="standard")
  task = svc.submit(audio_url="https://...")

  # 流式版（支持 config_overrides 覆盖部分配置）
  svc = get_asr_service(provider="bytedance", mode="streaming",
                        config_overrides={"ws_endpoint": "bigmodel"})
"""

from __future__ import annotations

import importlib
import logging
from dataclasses import replace
from typing import Any, Optional

from django.conf import settings

from .base import BaseASRService
from ..config_types import ASRProviderConfig
from ..exceptions import SpeechConfigError, SpeechUpstreamError

logger = logging.getLogger(__name__)


class ASRConfigError(SpeechConfigError):
    """ASR 配置缺失或无效时抛出，下游可据此给用户友好提示。"""
    pass


class ASRUpstreamError(SpeechUpstreamError):
    """上游 ASR 服务（字节跳动等）返回错误时抛出。"""
    pass


BYTEDANCE_MODES = {
    "flash": "apps.services.speech.asr.providers.bytedance.flash.ByteDanceFlashASR",
    "standard": "apps.services.speech.asr.providers.bytedance.standard.ByteDanceStandardASR",
    "streaming": "apps.services.speech.asr.providers.bytedance.streaming.ByteDanceStreamingASR",
}

# 与 providers/bytedance/base.py VALID_WS_ENDPOINT_KEYS 保持同步
VALID_WS_ENDPOINTS = frozenset({"bigmodel", "bigmodel_async", "bigmodel_nostream"})


class ASRServiceFactory:
    """ASR 服务工厂"""

    PROVIDER_MODES: dict[str, dict[str, str]] = {
        "bytedance": BYTEDANCE_MODES,
    }

    @classmethod
    def create_service(
        cls,
        provider_name: str,
        mode: str,
        config: ASRProviderConfig,
    ) -> BaseASRService:
        modes = cls.PROVIDER_MODES.get(provider_name)
        if not modes:
            raise ASRConfigError(f"不支持的 ASR 提供商: {provider_name}")

        class_path = modes.get(mode)
        if not class_path:
            raise ASRConfigError(
                f"提供商 {provider_name} 不支持模式 {mode}，"
                f"可选: {list(modes.keys())}"
            )

        if not config.app_id or not config.access_token:
            raise ASRConfigError(
                f"ASR 凭证未配置（provider={provider_name}）。"
                f"请在 AdminDash 配置 bytedance Provider 的 capability_domains 包含 'asr'、"
                f"并在对应 LLMModel.capabilities_config 中填写 app_id（access_token 来自 Provider.api_key）。"
            )

        service_class = cls._import_class(class_path)
        config = replace(config, provider_name=provider_name, mode=mode)
        return service_class(config)

    @classmethod
    def register_provider(
        cls, name: str, modes: dict[str, str],
    ) -> None:
        cls.PROVIDER_MODES[name] = modes

    @classmethod
    def get_supported_providers(cls) -> dict[str, list[str]]:
        return {
            provider: list(modes.keys())
            for provider, modes in cls.PROVIDER_MODES.items()
        }

    @staticmethod
    def _import_class(class_path: str) -> type[BaseASRService]:
        module_path, class_name = class_path.rsplit(".", 1)
        module = importlib.import_module(module_path)
        return getattr(module, class_name)


def get_asr_service(
    provider: str = "bytedance",
    mode: str = "flash",
    config: Optional[ASRProviderConfig] = None,
    config_overrides: Optional[dict[str, Any]] = None,
    model_info: Optional[Any] = None,
) -> BaseASRService:
    """
    获取 ASR 服务实例

    Args:
        provider: ASR 提供商名称 ("bytedance")
        mode: 识别模式 ("flash" / "standard" / "streaming")
        config: 直接传入完整配置（优先）；为 None 时按下方优先级解析
        config_overrides: 覆盖已解析配置中的部分字段（如 ws_endpoint），接受普通 dict
        model_info: capability 入口已解析好的 LLMModel；提供时直接据其 provider + capabilities_config
            构造配置，绕过 DB 二次查询和 env fallback（v0.1 宪法单源真理）

    配置优先级：
        1. config 直接传入
        2. model_info（capability 入口路径，推荐）
        3. _resolve_config(provider, mode)：DB 查询 + settings 兜底（兼容旧调用方）

    Raises:
        ASRConfigError: 配置缺失或无效
    """
    if config is not None:
        resolved = config
    elif model_info is not None:
        resolved = _config_from_model_info(provider, mode, model_info)
    else:
        resolved = _resolve_config(provider, mode)

    if config_overrides:
        known = ASRProviderConfig.__dataclass_fields__
        resolved = replace(resolved, **{
            k: v for k, v in config_overrides.items() if k in known
        })

    return ASRServiceFactory.create_service(provider, mode, resolved)


def _config_from_model_info(
    provider: str, mode: str, model_info: Any,
) -> ASRProviderConfig:
    """从 capability 入口传下来的 LLMModel 直接构造 ASRProviderConfig。

    v0.1 宪法 §provider-credentials-ssot：Provider 的 api_key / base_url 与模型的
    capabilities_config 是 LLM 服务的单一真理源；ASR/TTS 不应再回退到 env / settings。
    """
    provider_obj = getattr(model_info, "provider", None)
    if provider_obj is None:
        raise ASRConfigError(
            f"ASR model_info 缺少 provider 关联（model={getattr(model_info, 'model_name', '?')}）"
        )
    extra = getattr(model_info, "capabilities_config", None) or {}
    resource_ids = extra.get("resource_ids", {}) if isinstance(extra, dict) else {}
    resource_id = ""
    if isinstance(resource_ids, dict):
        resource_id = resource_ids.get(mode, extra.get("resource_id", "")) if isinstance(extra, dict) else ""
    elif isinstance(extra, dict):
        resource_id = extra.get("resource_id", "")

    api_key = getattr(provider_obj, "api_key", "") or ""
    if not api_key:
        raise ASRConfigError(
            f"ASR Provider '{getattr(provider_obj, 'provider_key', '?')}' 未配置 api_key"
        )

    return ASRProviderConfig(
        provider_name=provider,
        app_id=extra.get("app_id", "") if isinstance(extra, dict) else "",
        access_token=api_key,
        secret_key=extra.get("secret_key", "") if isinstance(extra, dict) else "",
        model_version=extra.get("model_version", "") if isinstance(extra, dict) else "",
        ws_endpoint=(
            extra.get("ws_endpoint") if isinstance(extra, dict) else None
        ) or "bigmodel_async",
        resource_id=resource_id,
        provider_id=str(getattr(provider_obj, "id", "") or ""),
        rate_limit=int(getattr(provider_obj, "rate_limit", 0) or 0),
    )


def _resolve_config(provider: str, mode: str = "flash") -> ASRProviderConfig:
    """解析 ASR 配置 —— v0.1.x 单源真理：只从 DB 解析，不再走 settings fallback。

    v0.1.x 改动（宪法 §provider-credentials-ssot）：
    - 删除 ``BYTEDANCE_ASR_*`` 环境变量 fallback；ASR 配置必须在 AdminDash 配置
      bytedance Provider 的 ``capabilities_config``（app_id / resource_ids / ws_endpoint）。
    - DB 解析失败时直接 ASRConfigError，不再静默回退到 env（v0.1.0 的 bug：
      ``_try_load_from_db`` 抛 FieldError 后悄悄走 env 路径，导致整个 SceneBinding 体系失效）。
    """
    from .._config_cache import get_cached_config

    cache_key = f"asr:{provider}:{mode}"
    db_config = get_cached_config(
        cache_key,
        loader=lambda: _try_load_from_db(provider, mode),
    )
    if db_config:
        return db_config
    raise ASRConfigError(
        f"ASR Provider '{provider}' 未在 DB 配置（v0.1.x 已删除 settings.BYTEDANCE_* fallback）。"
        f"请在 AdminDash 配置 bytedance Provider 的 capability_domains 包含 'asr'、"
        f"并补齐 LLMModel.capabilities_config（app_id / resource_ids / ws_endpoint）。"
    )


def _try_load_from_db(provider: str, mode: str = "flash") -> Optional[ASRProviderConfig]:
    """从 LLMProvider/LLMModel 加载 ASR 配置。

    v0.1 schema：
    - 通过 ``capability_domains @> ['asr']`` 找 Provider（一个 bytedance 账号可同时 asr+tts）
    - LLMModel.mode/is_active 已删（migration 0022）；按 ``capability_domain='asr'`` 找 model
    - app_id / resource_ids / ws_endpoint 从 ``LLMModel.capabilities_config`` 读
    """
    try:
        from apps.services.llm.models import LLMModel

        provider_obj = _discover_provider(provider)
        if not provider_obj:
            return None

        model_obj = LLMModel.objects.filter(
            provider=provider_obj,
            capability_domain="asr",
        ).first()
        if not model_obj:
            return None

        extra = model_obj.capabilities_config or {}
        resource_ids = extra.get("resource_ids", {})
        resource_id = resource_ids.get(mode, extra.get("resource_id", ""))

        return ASRProviderConfig(
            provider_name=provider,
            app_id=extra.get("app_id", ""),
            access_token=provider_obj.api_key,
            secret_key=extra.get("secret_key", ""),
            model_version=extra.get("model_version", ""),
            ws_endpoint=extra.get("ws_endpoint") or "bigmodel_async",
            resource_id=resource_id,
            provider_id=str(provider_obj.id),
            rate_limit=int(getattr(provider_obj, "rate_limit", 0) or 0),
        )
    except Exception as e:
        # v0.1.x：env fallback 已删（_resolve_config 在 DB miss 时直接 raise）；
        # 本 log 仅用于通知运营 DB 查询本身异常（如 DB 不可达 / schema 不一致），
        # 调用方拿到 None 后会立即抛 ASRConfigError 阻断业务，不会有任何隐性兜底。
        logger.warning("[ASR] 从 DB 加载配置失败，下游将抛 ASRConfigError: %s", e)
        return None


def _discover_provider(provider_name: str):
    """通过 ``capability_domains`` 集合发现 ASR Provider。

    bytedance 账号通常同时提供 asr 和 tts；优先匹配 asr，未命中时退回任意启用 ASR 的同名 provider。
    """
    from apps.services.llm.models import LLMProvider

    return LLMProvider.objects.filter(
        name=provider_name,
        capability_domains__contains=["asr"],
        routing_enabled=True,
    ).first()


# v0.1.x：已删除 ``_load_from_settings`` —— ASR 配置必须走 DB 单源。
# 旧 env 变量（BYTEDANCE_ASR_APP_ID / BYTEDANCE_ASR_ACCESS_TOKEN / BYTEDANCE_ASR_SECRET_KEY /
# BYTEDANCE_ASR_RESOURCE_ID / BYTEDANCE_ASR_WS_ENDPOINT）已废弃，请在 AdminDash 配置 bytedance
# Provider 的 capabilities_config 完成等价迁移。

"""LiteLLM 配置构建器 — 从 ReactAgent 提取。

负责 provider 解析、model name 组合、TTL 缓存。
"""

from __future__ import annotations

import copy
import logging
import threading
import time
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

__all__ = [
    "build_litellm_config",
    "invalidate_litellm_config_cache",
    "preload_litellm_in_background",
]

_CONFIG_CACHE: Dict[str, tuple] = {}
_CONFIG_CACHE_TTL = 60
_CONFIG_CACHE_LOCK = threading.Lock()

_PRELOAD_STARTED = threading.Event()


def preload_litellm_in_background() -> threading.Thread | None:
    """在 AppConfig.ready() 中调用：后台线程预热 litellm 惰性导入。

    litellm 冷 import 需数秒且持 GIL；不预热时这笔税由 worker 重启后
    第一个 LLM proxy 请求承担（实测 proxy 前置 ~95ms → ~3.4s，见 ）。
    幂等：重复调用只启动一个线程。失败仅记日志，不影响请求路径上的
    惰性导入兜底。

    Returns:
        本次新启动的线程；已启动过则返回 None（便于测试断言幂等）。
    """
    if _PRELOAD_STARTED.is_set():
        return None
    _PRELOAD_STARTED.set()

    def _warm() -> None:
        t0 = time.monotonic()
        try:
            providers = get_litellm_provider_set()
            logger.info(
                "[LitellmConfig] litellm preloaded in %.0fms (providers=%d)",
                (time.monotonic() - t0) * 1000,
                len(providers),
            )
        except Exception as exc:
            logger.warning("[LitellmConfig] litellm preload failed: %s", exc)

    thread = threading.Thread(target=_warm, name="litellm-preload", daemon=True)
    thread.start()
    return thread


def invalidate_litellm_config_cache(model_id: str | None = None) -> int:
    """主动清除 litellm config 缓存。

    Args:
        model_id: 指定模型 ID 时只清除该条目；None 时清空全部缓存。

    Returns:
        被清除的缓存条目数。
    """
    with _CONFIG_CACHE_LOCK:
        if model_id is not None:
            removed = 1 if _CONFIG_CACHE.pop(model_id, None) is not None else 0
        else:
            removed = len(_CONFIG_CACHE)
            _CONFIG_CACHE.clear()
    if removed:
        logger.info("[LitellmConfig] cache invalidated: model_id=%s, removed=%d", model_id or "*", removed)
    return removed


def get_litellm_provider_set() -> set[str]:
    """读取 LiteLLM provider 列表；失败时返回兜底集合。"""
    try:
        import litellm

        providers: set[str] = set()
        for item in (getattr(litellm, "provider_list", []) or []):
            raw = getattr(item, "value", None) or str(item)
            raw = str(raw).strip().lower()
            if not raw:
                continue
            normalized = raw.split(".")[-1] if "." in raw else raw
            providers.add(normalized)
        if providers:
            return providers
    except Exception:
        pass  # defensive: litellm provider_list introspection 失败，使用内置默认 provider 集合
    return {
        "openai", "codex", "anthropic", "gemini",
        "dashscope", "moonshot", "minimax", "azure", "bedrock",
        "zhipu", "volcengine", "custom_openai",
    }


def expand_provider_hints(
    raw_value: str,
    *,
    known_providers: set[str],
    provider_aliases: dict[str, str],
) -> list[str]:
    value = str(raw_value or "").strip().lower()
    if not value:
        return []

    hints: list[str] = [value]
    if value not in known_providers:
        for separator in ("::", ":", "/", "."):
            if separator in value:
                hints.append(value.split(separator, 1)[0])
                break
        for separator in ("_", "-"):
            if separator in value:
                hints.append(value.split(separator, 1)[0])
                break

    normalized: list[str] = []
    for hint in hints:
        mapped = provider_aliases.get(hint, hint)
        if mapped:
            normalized.append(mapped)
    return normalized


def resolve_litellm_provider(
    provider: Any,
    known_providers: set[str],
    *,
    model: Any = None,
) -> Optional[str]:
    """v0.1.x Phase 2.5：base_url 从 model 取（Provider.base_url 已删）。

    新代码请传 model（必带）；老调用方未传时退化到只看 provider.name/provider_key。
    """
    from apps.services.agent_engine.configuration import OrchestrationConfiguration

    config = OrchestrationConfiguration.from_settings()
    provider_aliases = {
        str(k).strip().lower(): str(v).strip().lower()
        for k, v in (config.litellm_provider_aliases or {}).items()
        if str(k).strip() and str(v).strip()
    }

    candidates: list[str] = []
    base_url = str(getattr(model, "base_url", "") or "").strip().lower()
    if base_url:
        if "dashscope.aliyuncs.com" in base_url:
            candidates.append("dashscope")
        if "bigmodel.cn" in base_url:
            candidates.append("zhipu")
            candidates.append("custom_openai")
        if "anthropic.com" in base_url:
            candidates.append("anthropic")
        # MiniMax Token Plan / Anthropic 兼容口（运行时 LiteLLM 常无 minimax，须走 anthropic）。
        # 勿匹配 music 等非 anthropic 路径（如 …/v1/music_generation）。
        if "minimaxi.com" in base_url and "anthropic" in base_url:
            candidates.append("anthropic")
        if "chatgpt.com/backend-api/codex" in base_url:
            candidates.append("openai")
        if "zenmux.ai" in base_url:
            candidates.append("custom_openai")
        # 火山方舟 Ark：LiteLLM 原生 volcengine（OpenAI-like）；再兜底 custom_openai。
        if "volces.com" in base_url or "volcengineapi.com" in base_url:
            candidates.append("volcengine")
            candidates.append("custom_openai")

    provider_name = str(getattr(provider, "name", "") or "")
    provider_key = str(getattr(provider, "provider_key", "") or "")
    candidates.extend(
        expand_provider_hints(provider_name, known_providers=known_providers, provider_aliases=provider_aliases)
    )
    candidates.extend(
        expand_provider_hints(provider_key, known_providers=known_providers, provider_aliases=provider_aliases)
    )

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        if candidate in known_providers:
            return candidate
    return None


def compose_litellm_model_name(
    *,
    model_name: str,
    litellm_provider: Optional[str],
    known_providers: set[str],
) -> str:
    raw_model_name = str(model_name or "").strip()
    if not raw_model_name:
        return raw_model_name

    # dogfood 8f3a3f40 修复（OpenAI 兼容代理网关 model_name 透传）：
    #
    # 当 litellm_provider == 'custom_openai'（用户配的是 OpenAI 兼容代理网关，
    # 譬如 zenmux / openrouter / 其他多 vendor 路由），LiteLLM 不解释 model_name
    # 内部结构——网关自己拿完整 model_name 字段路由到具体上游 vendor。
    #
    # 原逻辑会把 `anthropic/claude-sonnet-4.6` 解析成"prefix=anthropic 是 LiteLLM
    # 已知 provider"，剥成 `claude-sonnet-4.6` 发给 zenmux，但 zenmux 注册的
    # alias 是带 prefix 的 `anthropic/claude-sonnet-4.6`，导致 upstream 404。
    #
    # 同 provider 下的 `google/gemini-3.1-flash-lite-preview` 工作正常是因为
    # `google` 不在 known_providers 集合里（LiteLLM 用 `gemini` 而非 `google`），
    # 没被剥前缀。所以 5 个 zenmux 模型里只有 google/* 系列侥幸不撞 bug。
    #
    # 修复：custom_openai 路径下 model_name 原样透传，不解释、不剥前缀。
    # 测试覆盖：`test_litellm_config.py::test_custom_openai_preserves_full_model_name`。
    if litellm_provider == "custom_openai":
        return f"custom_openai/{raw_model_name}"

    if "/" in raw_model_name:
        existing_prefix = raw_model_name.split("/", 1)[0].strip().lower()
        model_part = raw_model_name.split("/", 1)[1]

        if existing_prefix in known_providers:
            if litellm_provider:
                return f"{litellm_provider}/{model_part}"
            return raw_model_name

        if litellm_provider:
            return f"{litellm_provider}/{raw_model_name}"
        return raw_model_name

    if litellm_provider:
        return f"{litellm_provider}/{raw_model_name}"
    return raw_model_name


def build_litellm_config(model_id: str) -> dict:
    """构建 litellm 配置 dict（带 TTL 缓存）。

    Raises:
        RuntimeError: model_id 为空或不存在时抛出。
    """
    if not model_id:
        raise RuntimeError("缺少 model_id，无法构建 LiteLLM 配置")

    now = time.time()
    with _CONFIG_CACHE_LOCK:
        cached = _CONFIG_CACHE.get(model_id)
    if cached and (now - cached[1]) < _CONFIG_CACHE_TTL:
        logger.debug("[LitellmConfig] cache hit: model_id=%s", model_id)
        return copy.deepcopy(cached[0])

    from apps.services.llm.models import LLMModel
    from apps.services.agent_engine.configuration import OrchestrationConfiguration

    model = LLMModel.objects.select_related("provider").filter(id=model_id).first()
    if not model:
        raise RuntimeError(f"model_id 不存在: {model_id}")

    provider = model.provider
    # ：禁用渠道不得继续拼装上游配置（防御会话粘性 / 直查 UUID 绕过 catalog）。
    if not getattr(provider, "routing_enabled", False):
        raise RuntimeError(
            f"model_id={model_id} 的 Provider '{getattr(provider, 'name', '?')}' "
            "routing_enabled=False，渠道已禁用，拒绝调用"
        )

    from apps.services.llm.services.capability_guard import provider_supports_chat_capability
    if not provider_supports_chat_capability(provider.name):
        raise RuntimeError(
            f"model_id={model_id} 的 Provider '{provider.name}' 不支持 chat 能力域，"
            "请检查模型配置"
        )
    # v0.1：LLMModel.mode 字段已删（0022），用 capability_domain 判断是否适合对话链路。
    if model.capability_domain != "chat":
        logger.warning(
            "[LitellmConfig] model_id=%s capability_domain=%s 不是 chat，"
            "可能不适用于对话链路（embedding/其他域走此路径需确认合法性）",
            model_id, model.capability_domain,
        )
    known_providers = get_litellm_provider_set()
    # v0.1.x Phase 2.5：传 model 让 resolve_litellm_provider 从 model.base_url 取 URL hint
    litellm_provider = resolve_litellm_provider(provider, known_providers, model=model)
    litellm_model = compose_litellm_model_name(
        model_name=model.model_name,
        litellm_provider=litellm_provider,
        known_providers=known_providers,
    )

    # v0.1.x Phase 2.5：base_url 从 model 取（Provider.base_url 已删）。
    config: dict = {
        "model": litellm_model,
        "api_key": provider.api_key,
        "api_base": model.base_url,
    }
    logger.info(
        "[LitellmConfig] provider=%s model_name=%s -> litellm_provider=%s litellm_model=%s base=%s",
        provider.name, model.model_name, litellm_provider, litellm_model, model.base_url,
    )
    if litellm_provider:
        config["custom_llm_provider"] = litellm_provider
    if model.max_output_tokens:
        config["max_tokens"] = model.max_output_tokens

    capabilities = model.capabilities_config or {}
    api_variant = str(
        capabilities.get("api_variant")
        or capabilities.get("openai_api_variant")
        or capabilities.get("default_api_variant")
        or ""
    ).strip().lower()
    if api_variant in {"responses", "response"}:
        config["api_variant"] = "responses"
    supports_prompt_caching = capabilities.get("supports_prompt_caching")
    if isinstance(supports_prompt_caching, bool):
        config["supports_prompt_caching"] = supports_prompt_caching

    runtime_config = OrchestrationConfiguration.from_settings()
    config["prompt_cache_key_scope"] = runtime_config.prompt_cache_key_scope
    if runtime_config.prompt_cache_retention:
        config["prompt_cache_retention"] = runtime_config.prompt_cache_retention
    try:
        config["profile"] = {
            "max_input_tokens": int(model.max_input_tokens_resolved),
            "max_output_tokens": int(model.max_output_tokens_resolved),
            "context_window_tokens": int(model.context_window_tokens),
        }
    except Exception as exc:
        logger.warning(
            "[LitellmConfig] profile 构建失败，context window 信息缺失，可能影响压缩决策: model_id=%s err=%s",
            model_id, exc,
        )

    from apps.services.llm.utils.capabilities import get_capability_flag
    config["supports_function_calling"] = get_capability_flag(model, "supports_function_calling", default=True)
    config["supports_vision"] = get_capability_flag(model, "supports_vision", default=False)

    _custom_sse_timeout = capabilities.get("sse_read_timeout")
    if isinstance(_custom_sse_timeout, (int, float)) and _custom_sse_timeout > 0:
        config["sse_read_timeout"] = int(_custom_sse_timeout)

    config["_model_id"] = model_id

    with _CONFIG_CACHE_LOCK:
        _CONFIG_CACHE[model_id] = (config, now)
    return config


# --- MA-11: 信号驱动缓存失效 ---

def _on_llm_model_or_provider_saved(sender, instance, **kwargs):  # noqa: ARG001
    """LLMModel / LLMProvider 变更时立即清除相关缓存条目。"""
    model_id = None
    if sender.__name__ == "LLMModel":
        model_id = str(instance.pk) if instance.pk else None
    invalidate_litellm_config_cache(model_id=model_id)


def connect_cache_invalidation_signals():
    """在 AppConfig.ready() 中调用以注册 post_save 信号。

    延迟导入避免 AppRegistryNotReady；若导入失败仅记日志不阻断启动。
    """
    try:
        from django.db.models.signals import post_save
        from apps.services.llm.models import LLMModel, LLMProvider

        post_save.connect(
            _on_llm_model_or_provider_saved,
            sender=LLMModel,
            dispatch_uid="litellm_config_invalidate_model",
        )
        post_save.connect(
            _on_llm_model_or_provider_saved,
            sender=LLMProvider,
            dispatch_uid="litellm_config_invalidate_provider",
        )
        logger.info("[LitellmConfig] cache invalidation signals connected")
    except Exception as exc:
        logger.warning("[LitellmConfig] 无法注册缓存失效信号: %s", exc)

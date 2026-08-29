"""
LiteLLM 模型信息查询服务

使用 LiteLLM 的公开数据库自动识别模型的 Token 限制和定价信息。
数据源：https://github.com/BerriAI/litellm
"""

import logging
import math
import threading
import requests
from typing import Dict, Any, Optional
from django.core.cache import cache

logger = logging.getLogger(__name__)


class LiteLLMModelInfoService:
    """LiteLLM 模型信息查询服务"""

    MODEL_INFO_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

    CACHE_KEY = "litellm_model_info"
    CACHE_TIMEOUT = 86400

    _fetch_lock = threading.Lock()

    @classmethod
    def get_model_info(cls, model_name: str) -> Optional[Dict[str, Any]]:
        """
        获取指定模型的配置信息

        Args:
            model_name: 模型名称（如 'gpt-4o', 'claude-3-5-sonnet-20241022'）

        Returns:
            模型配置信息，包含：
            - max_tokens: 上下文窗口总容量
            - max_input_tokens: 最大输入 Token 数
            - max_output_tokens: 最大输出 Token 数
            - input_cost_per_token: 输入成本（每 Token）
            - output_cost_per_token: 输出成本（每 Token）
            - litellm_provider: 提供商
            - mode: 模式（chat/completion/embedding等）
            - 以及其他高级字段
        """
        try:
            # 从缓存或远程获取完整数据库
            model_database = cls._get_model_database()

            if not model_database:
                logger.warning("无法获取 LiteLLM 模型数据库")
                return None

            if model_name in model_database:
                return model_database[model_name]

            # 前缀匹配：输入 "gpt-4o" 匹配 "gpt-4o-2024-05-13"
            # 取最短 key 以选择最具体的匹配，避免依赖字典插入顺序
            prefix_matches = [
                k for k in model_database
                if k.startswith(model_name + "-") or k.startswith(model_name + "/")
            ]
            if prefix_matches:
                best = min(prefix_matches, key=len)
                logger.info("前缀匹配: %s -> %s", model_name, best)
                return model_database[best]

            logger.warning("未找到模型 '%s' 的配置信息", model_name)
            return None

        except Exception as e:
            logger.error("获取模型信息失败: %s", e, exc_info=True)
            return None

    @classmethod
    def extract_advanced_billing_config(cls, model_info: Dict[str, Any]) -> Dict[str, Any]:
        """
        从 LiteLLM 模型信息中提取高级计费配置

        Args:
            model_info: 从 LiteLLM 获取的原始模型信息

        Returns:
            高级计费配置字典，包含所有 *_cost_* 字段
        """
        advanced_billing = {}

        # 定义需要提取的高级计费字段
        billing_fields = [
            'input_cost_per_image',
            'output_cost_per_image',
            'input_cost_per_character',
            'output_cost_per_character',
            'input_cost_per_audio_per_second',
            'output_cost_per_audio_per_second',
            'input_cost_per_video_per_second',
            'output_cost_per_video_per_second',
            'input_cost_per_request',
            'output_cost_per_request',
            'input_cost_per_pixel',
            'output_cost_per_pixel',
            'cache_read_input_token_cost',
            'cache_creation_input_token_cost',
        ]

        # 提取所有存在的高级计费字段
        for field in billing_fields:
            if field in model_info and model_info[field] is not None:
                advanced_billing[field] = model_info[field]

        return advanced_billing

    @classmethod
    def extract_prompt_cache_pricing(cls, model_info: Dict[str, Any]) -> Dict[str, Any]:
        """
        提取 Prompt Caching 定价并转换为每 1K token 单价。

        返回键：
        - cache_read_input_price_per_1k
        - cache_write_input_price_per_1k
        """
        if not isinstance(model_info, dict):
            return {}

        read_candidates = (
            "cache_read_input_token_cost",
            "cache_read_input_cost_per_token",
        )
        write_candidates = (
            "cache_creation_input_token_cost",
            "cache_write_input_token_cost",
            "cache_creation_input_cost_per_token",
            "cache_write_input_cost_per_token",
        )

        def _first_float(candidates: tuple[str, ...]) -> Optional[float]:
            for key in candidates:
                if key not in model_info:
                    continue
                value = model_info.get(key)
                if value is None:
                    continue
                try:
                    parsed = float(value)
                except (TypeError, ValueError):
                    continue
                if math.isfinite(parsed) and parsed >= 0:
                    return parsed
            return None

        payload: Dict[str, Any] = {}
        read_per_token = _first_float(read_candidates)
        write_per_token = _first_float(write_candidates)
        if read_per_token is not None:
            payload["cache_read_input_price_per_1k"] = read_per_token * 1000
        if write_per_token is not None:
            payload["cache_write_input_price_per_1k"] = write_per_token * 1000
        return payload

    @classmethod
    def search_models(
        cls,
        keyword: str,
        *,
        provider_hints: set[str] | None = None,
    ) -> Dict[str, Dict[str, Any]]:
        """
        搜索包含指定关键词的模型

        Args:
            keyword: 搜索关键词（如 'gpt-4', 'claude', 'qwen'）
            provider_hints: 当前渠道对应的 LiteLLM provider；为空则不按渠道收窄

        Returns:
            匹配的模型配置字典
        """
        try:
            model_database = cls._get_model_database()
            if not model_database:
                return {}

            keyword_lower = keyword.lower()
            hints = {item.strip().lower() for item in (provider_hints or set()) if item and item.strip()}
            matched = {}

            for model_name, model_info in model_database.items():
                if keyword_lower not in model_name.lower():
                    continue
                if hints and not cls._matches_provider_hints(model_name, model_info or {}, hints):
                    continue
                matched[model_name] = model_info

            return matched

        except Exception as e:
            logger.error("搜索模型失败: %s", e, exc_info=True)
            return {}

    @staticmethod
    def _matches_provider_hints(
        model_name: str,
        model_info: Dict[str, Any],
        hints: set[str],
    ) -> bool:
        litellm_provider = str(model_info.get("litellm_provider") or "").strip().lower()
        name = model_name.lower()
        if litellm_provider and litellm_provider in hints:
            return True
        return any(name == hint or name.startswith(f"{hint}/") for hint in hints)

    @classmethod
    def get_all_providers(cls) -> Dict[str, list]:
        """
        获取所有提供商及其模型列表

        Returns:
            提供商 -> 模型列表的字典
        """
        try:
            model_database = cls._get_model_database()
            if not model_database:
                return {}

            providers = {}

            for model_name, model_info in model_database.items():
                provider = model_info.get('litellm_provider', 'unknown')
                if provider not in providers:
                    providers[provider] = []
                providers[provider].append(model_name)

            return providers

        except Exception as e:
            logger.error("获取提供商列表失败: %s", e, exc_info=True)
            return {}

    @classmethod
    def _get_model_database(cls) -> Optional[Dict[str, Dict[str, Any]]]:
        """
        获取完整的模型数据库（优先使用缓存）。

        使用 _fetch_lock 防止缓存到期时多线程并发拉取（thundering herd）。
        """
        cached_data = cache.get(cls.CACHE_KEY)
        if cached_data:
            return cached_data

        acquired = cls._fetch_lock.acquire(blocking=True, timeout=35)
        if not acquired:
            logger.warning("_get_model_database: 等待远程拉取超时，跳过")
            return None
        try:
            cached_data = cache.get(cls.CACHE_KEY)
            if cached_data:
                return cached_data

            logger.info("从远程获取 LiteLLM 模型数据库: %s", cls.MODEL_INFO_URL)
            response = requests.get(cls.MODEL_INFO_URL, timeout=30)
            response.raise_for_status()

            data = response.json()
            logger.info("成功获取 LiteLLM 模型数据库，包含 %d 个模型", len(data))

            cache.set(cls.CACHE_KEY, data, cls.CACHE_TIMEOUT)
            return data

        except Exception as e:
            logger.error("获取 LiteLLM 模型数据库失败: %s", e, exc_info=True)
            return None
        finally:
            cls._fetch_lock.release()

    @classmethod
    def clear_cache(cls):
        """清除缓存"""
        cache.delete(cls.CACHE_KEY)
        logger.info("已清除 LiteLLM 模型数据库缓存")


# 便捷函数

def get_model_token_limits(model_name: str) -> Optional[Dict[str, int]]:
    """
    获取模型的 Token 限制配置

    Args:
        model_name: 模型名称

    Returns:
        Token 限制配置，包含：
        - context_window_tokens: 上下文窗口总容量
        - max_input_tokens: 最大输入 Token 数
        - max_output_tokens: 最大输出 Token 数
    """
    model_info = LiteLLMModelInfoService.get_model_info(model_name)

    if not model_info:
        return None

    max_input = model_info.get('max_input_tokens')
    max_output = model_info.get('max_output_tokens')
    max_tokens = model_info.get('max_tokens')

    # LiteLLM 数据语义：
    #   max_tokens       = 上下文窗口总容量（如 GPT-4o = 128000）
    #   max_input_tokens = 总容量中可用于输入的部分（通常 == max_tokens）
    #   max_output_tokens = 模型单次最大生成量
    # 因此 context_window 应直接取 max_tokens，而非 max_input + max_output。
    if max_tokens:
        context_window = max_tokens
    elif max_input:
        context_window = max_input
    else:
        context_window = None

    return {
        'context_window_tokens': context_window,
        'max_input_tokens': max_input or context_window,
        'max_output_tokens': max_output or max_tokens,
    }


def get_model_pricing(model_name: str) -> Optional[Dict[str, float]]:
    """
    获取模型的定价信息

    Args:
        model_name: 模型名称

    Returns:
        定价信息，包含：
        - input_cost_per_token: 输入成本（每 Token）
        - output_cost_per_token: 输出成本（每 Token）
        - cost_per_1k_input_tokens: 输入成本（每 1K Token）
        - cost_per_1k_output_tokens: 输出成本（每 1K Token）
    """
    model_info = LiteLLMModelInfoService.get_model_info(model_name)

    if not model_info:
        return None

    input_cost = model_info.get('input_cost_per_token', 0)
    output_cost = model_info.get('output_cost_per_token', 0)

    return {
        'input_cost_per_token': input_cost,
        'output_cost_per_token': output_cost,
        'cost_per_1k_input_tokens': input_cost * 1000,
        'cost_per_1k_output_tokens': output_cost * 1000,
    }


def get_model_capabilities(model_name: str) -> Optional[Dict[str, Any]]:
    """
    获取模型的扩展能力配置

    Args:
        model_name: 模型名称

    Returns:
        能力配置字典，包含所有 supports_* 字段，例如：
        - supports_assistant_prefill
        - supports_computer_use
        - supports_pdf_input
        - supports_prompt_caching
        - supports_reasoning
        - supports_response_schema
        - supports_tool_choice
        - supports_parallel_function_calling
        - supports_system_messages
        等
    """
    model_info = LiteLLMModelInfoService.get_model_info(model_name)

    if not model_info:
        return None

    # 提取所有以 supports_ 开头的字段
    capabilities = {}
    for key, value in model_info.items():
        if key.startswith('supports_') and isinstance(value, bool):
            capabilities[key] = value

    return capabilities


def get_model_multimodal_limits(model_name: str) -> Optional[Dict[str, Any]]:
    """
    获取模型的多模态限制配置

    Args:
        model_name: 模型名称

    Returns:
        多模态限制配置字典，包含：
        - max_images_per_prompt: 每次请求最大图片数
        - max_video_length: 最大视频时长
        - max_videos_per_prompt: 每次请求最大视频数
        - max_audio_length_hours: 最大音频时长（小时）
        - max_audio_per_prompt: 每次请求最大音频数
        - max_pdf_size_mb: 最大 PDF 大小（MB）
        等
    """
    model_info = LiteLLMModelInfoService.get_model_info(model_name)

    if not model_info:
        return None

    # 定义多模态限制字段
    multimodal_fields = [
        'max_images_per_prompt',
        'max_video_length',
        'max_videos_per_prompt',
        'max_audio_length_hours',
        'max_audio_per_prompt',
        'max_pdf_size_mb',
        'supported_image_formats',
    ]

    # 提取多模态限制
    limits = {}
    for field in multimodal_fields:
        if field in model_info and model_info[field] is not None:
            limits[field] = model_info[field]

    return limits

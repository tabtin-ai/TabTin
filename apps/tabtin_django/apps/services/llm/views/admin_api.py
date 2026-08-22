"""
LiteLLM Admin API - 提供 Admin 界面的 AJAX 接口

已迁移到 Django Ninja Router + JWT 认证体系（BI-6 修复）。
"""

import logging

from ninja import Router
from ninja.errors import HttpError

from apps.users.auth.permissions import StaffAuth, SuperuserAuth

logger = logging.getLogger(__name__)

from apps.services.llm.services.litellm_model_info import (
    LiteLLMModelInfoService,
    get_model_token_limits,
    get_model_pricing,
    get_model_capabilities,
    get_model_multimodal_limits,
)

router = Router(auth=StaffAuth())

@router.get("/llm/model-info", auth=StaffAuth())
def get_model_info(request, model_name: str = ""):
    """获取模型配置信息"""

    model_name = model_name.strip()
    if not model_name:
        raise HttpError(400, "请提供模型名称")

    try:
        model_info = LiteLLMModelInfoService.get_model_info(model_name)

        if not model_info:
            return {
                'success': False,
                'error': f'未找到模型 "{model_name}" 的配置信息',
            }

        token_limits = get_model_token_limits(model_name)
        pricing = get_model_pricing(model_name)
        capabilities = get_model_capabilities(model_name)
        multimodal_limits = get_model_multimodal_limits(model_name)

        return {
            'success': True,
            'data': {
                'max_tokens': token_limits.get('context_window_tokens') if token_limits else None,
                'max_input_tokens': token_limits.get('max_input_tokens') if token_limits else None,
                'max_output_tokens': token_limits.get('max_output_tokens') if token_limits else None,
                'input_price_per_1k': pricing.get('cost_per_1k_input_tokens') if pricing else None,
                'output_price_per_1k': pricing.get('cost_per_1k_output_tokens') if pricing else None,
                'litellm_provider': model_info.get('litellm_provider'),
                'mode': model_info.get('mode'),
                'supports_function_calling': model_info.get('supports_function_calling', False),
                'supports_vision': model_info.get('supports_vision', False),
                'capabilities_config': capabilities or {},
                'multimodal_limits': multimodal_limits or {},
            },
            'message': f'成功获取 {model_name} 的配置信息',
        }

    except HttpError:
        raise
    except Exception as e:
        logger.error("获取模型信息失败: %s", e, exc_info=True)
        raise HttpError(500, "获取模型信息失败，请稍后重试")

@router.get("/llm/search-models", auth=StaffAuth())
def search_models(request, keyword: str = ""):
    """搜索模型"""

    keyword = keyword.strip()
    if not keyword:
        raise HttpError(400, "请提供搜索关键词")

    try:
        results = LiteLLMModelInfoService.search_models(keyword)

        limited_results = dict(list(results.items())[:50])

        return {
            'success': True,
            'data': {
                'total': len(results),
                'returned': len(limited_results),
                'models': list(limited_results.keys()),
            },
            'message': f'找到 {len(results)} 个模型（返回前 {len(limited_results)} 个）',
        }

    except HttpError:
        raise
    except Exception as e:
        logger.error("搜索模型失败: %s", e, exc_info=True)
        raise HttpError(500, "搜索失败，请稍后重试")

@router.post("/llm/clear-cache", auth=SuperuserAuth())
def clear_cache(request):
    """清除 LiteLLM 缓存"""

    try:
        LiteLLMModelInfoService.clear_cache()

        return {
            'success': True,
            'message': 'LiteLLM 缓存已清除',
        }

    except HttpError:
        raise
    except Exception as e:
        logger.error("清除缓存失败: %s", e, exc_info=True)
        raise HttpError(500, "清除缓存失败，请稍后重试")


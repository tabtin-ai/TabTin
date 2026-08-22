"""
初始化 MediaProvider 和 MediaModel 数据
使用现有的 DashScope LLM Provider 配置
"""

from decimal import Decimal
import logging

logger = logging.getLogger(__name__)


def init_dashscope_media_data():
    """从现有的 LLM DashScope 配置初始化媒体生成数据"""
    from apps.services.llm.models import LLMProvider
    from apps.services.media_generation.models import MediaProvider, MediaModel

    # v0.1：LLMProvider.is_active 已删（0022），可路由 = routing_enabled。
    llm_provider = LLMProvider.objects.filter(
        name='qwen', provider_key='dashscope', routing_enabled=True,
    ).first()
    if not llm_provider:
        logger.error("DashScope LLM Provider not found")
        return

    provider, created = MediaProvider.objects.get_or_create(
        provider_key='dashscope',
        scope='global',
        user_id=None,
        organization_id=None,
        defaults={
            'name': 'dashscope',
            'display_name': 'DashScope',
            'base_url': 'https://dashscope.aliyuncs.com/api/v1',
            'api_key': llm_provider.api_key,
            'is_active': True,
            'priority': 10,
        }
    )
    action = "Created" if created else "Exists"
    logger.info(f"[MediaInit] {action} MediaProvider: {provider.display_name}")

    models_data = [
        {
            'model_name': 'qwen-image-max',
            'display_name': 'Qwen Image Max',
            'task_type': 'text2image',
            'supported_sizes': ['1664*928', '928*1664', '1328*1328', '1472*1104', '1104*1472'],
            'max_prompt_length': 1500,
            'supports_negative_prompt': True,
            'supports_prompt_extend': True,
            'billing_type': 'image_count',
            'price_per_unit': Decimal('0.16'),
            'price_unit': 'CNY/image',
        },
        {
            'model_name': 'qwen-image-plus',
            'display_name': 'Qwen Image Plus',
            'task_type': 'text2image',
            'supported_sizes': ['1664*928', '928*1664', '1328*1328', '1472*1104', '1104*1472'],
            'max_prompt_length': 1500,
            'supports_negative_prompt': True,
            'supports_prompt_extend': True,
            'billing_type': 'image_count',
            'price_per_unit': Decimal('0.08'),
            'price_unit': 'CNY/image',
        },
        {
            'model_name': 'wan2.6-t2i',
            'display_name': 'Wan2.6 Text-to-Image',
            'task_type': 'text2image',
            'supported_sizes': ['1024*1024', '1280*720', '720*1280', '960*960'],
            'max_prompt_length': 1500,
            'supports_negative_prompt': True,
            'supports_prompt_extend': True,
            'billing_type': 'image_count',
            'price_per_unit': Decimal('0.06'),
            'price_unit': 'CNY/image',
        },
        {
            'model_name': 'wan2.2-t2i-flash',
            'display_name': 'Wan2.2 Flash Text-to-Image',
            'task_type': 'text2image',
            'supported_sizes': ['512-1440 custom'],
            'max_prompt_length': 800,
            'supports_negative_prompt': True,
            'supports_prompt_extend': True,
            'billing_type': 'image_count',
            'price_per_unit': Decimal('0.02'),
            'price_unit': 'CNY/image',
        },
        {
            'model_name': 'flux-merged',
            'display_name': 'FLUX Merged',
            'task_type': 'text2image',
            'supported_sizes': ['512*1024', '768*512', '768*1024', '1024*576', '576*1024', '1024*1024'],
            'max_prompt_length': 500,
            'supports_negative_prompt': False,
            'supports_prompt_extend': False,
            'billing_type': 'image_count',
            'price_per_unit': Decimal('0'),
            'price_unit': 'free trial',
        },
        {
            'model_name': 'wan2.6-t2v',
            'display_name': 'Wan2.6 Text-to-Video (1080P+audio)',
            'task_type': 'text2video',
            'supported_sizes': ['1920*1080', '1080*1920', '1440*1440', '1280*720', '720*1280'],
            'supported_durations': [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            'max_prompt_length': 1500,
            'supports_negative_prompt': True,
            'supports_prompt_extend': True,
            'supports_audio': True,
            'supports_multi_shot': True,
            'billing_type': 'resolution_seconds',
            'price_per_unit': Decimal('0.24'),
            'price_unit': 'CNY/sec(480P)',
        },
        {
            'model_name': 'wan2.2-t2v-plus',
            'display_name': 'Wan2.2 Text-to-Video Plus',
            'task_type': 'text2video',
            'supported_sizes': ['1920*1080', '1080*1920', '832*480', '480*832'],
            'supported_durations': [5],
            'max_prompt_length': 800,
            'supports_negative_prompt': True,
            'supports_prompt_extend': True,
            'billing_type': 'resolution_seconds',
            'price_per_unit': Decimal('0.24'),
            'price_unit': 'CNY/sec(480P)',
        },
        {
            'model_name': 'wanx2.1-t2v-turbo',
            'display_name': 'Wanx2.1 Text-to-Video Turbo',
            'task_type': 'text2video',
            'supported_sizes': ['1280*720', '720*1280', '960*960', '832*480', '480*832'],
            'supported_durations': [5],
            'max_prompt_length': 800,
            'supports_negative_prompt': True,
            'supports_prompt_extend': True,
            'billing_type': 'resolution_seconds',
            'price_per_unit': Decimal('0.12'),
            'price_unit': 'CNY/sec(480P)',
        },
        {
            'model_name': 'wan2.6-i2v-flash',
            'display_name': 'Wan2.6 Image-to-Video Flash',
            'task_type': 'image2video',
            'supported_sizes': ['1920*1080', '1080*1920', '1280*720', '720*1280'],
            'supported_durations': [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            'max_prompt_length': 1500,
            'supports_negative_prompt': True,
            'supports_prompt_extend': True,
            'supports_audio': True,
            'supports_multi_shot': True,
            'billing_type': 'resolution_seconds',
            'price_per_unit': Decimal('0.12'),
            'price_unit': 'CNY/sec(480P)',
        },
        {
            'model_name': 'wan2.2-i2v-plus',
            'display_name': 'Wan2.2 Image-to-Video Plus',
            'task_type': 'image2video',
            'supported_sizes': ['1280*720', '720*1280', '960*960', '832*480', '480*832'],
            'supported_durations': [5],
            'max_prompt_length': 800,
            'supports_negative_prompt': True,
            'supports_prompt_extend': True,
            'billing_type': 'resolution_seconds',
            'price_per_unit': Decimal('0.20'),
            'price_unit': 'CNY/sec(480P)',
        },
    ]

    created_count = 0
    for data in models_data:
        _, c = MediaModel.objects.get_or_create(
            provider=provider,
            model_name=data['model_name'],
            defaults=data,
        )
        if c:
            created_count += 1
            logger.info(f"[MediaInit] Created model: {data['model_name']}")

    logger.info(f"[MediaInit] Done: {created_count} models created, "
                f"{MediaModel.objects.filter(provider=provider).count()} total")
    return provider, created_count

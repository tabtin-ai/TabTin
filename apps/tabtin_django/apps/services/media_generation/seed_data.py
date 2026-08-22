"""
媒体生成服务 - 默认提供商和模型种子数据

包含平台目前支持的所有图片/视频生成渠道和模型配置。
来源: DashScope (阿里云百炼) 官方文档
"""

from decimal import Decimal


# ── 提供商定义 ──

DEFAULT_PROVIDERS = [
    {
        "name": "dashscope",
        "provider_key": "dashscope",
        "display_name": "阿里云百炼 DashScope",
        "base_url": "https://dashscope.aliyuncs.com/api/v1",
        "scope": "global",
        "priority": 10,
        "rate_limit": 30,
    },
]


# ── 万相 (Wan) 图片模型 ──

_WAN_IMAGE_SIZES = [
    "1024*1024", "768*1024", "1024*768",
    "720*1280", "1280*720",
]

_WAN_IMAGE_SIZES_EXTENDED = _WAN_IMAGE_SIZES + [
    "576*1024", "1024*576",
]

# ── FLUX 图片模型分辨率 ──

_FLUX_SIZES = [
    "512*1024", "768*512", "768*1024",
    "1024*1024", "512*768", "1024*512",
    "1024*768",
]

# ── 视频分辨率 ──

_VIDEO_SIZES_T2V = [
    "1280*720", "720*1280",
    "960*960",
]

_VIDEO_SIZES_T2V_EXTENDED = _VIDEO_SIZES_T2V + [
    "1920*1080", "1080*1920",
]

_VIDEO_SIZES_I2V = [
    "1280*720", "720*1280",
    "960*960",
]


# ── 模型定义 ──

DEFAULT_MODELS = [
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 文生图 (text2image) - 万相系列
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    {
        "provider_key": "dashscope",
        "model_name": "wan2.1-t2i-turbo",
        "display_name": "万相 2.1 文生图加速版",
        "description": "万相2.1系列加速版，速度快，适合批量生成场景",
        "task_type": "text2image",
        "supported_sizes": _WAN_IMAGE_SIZES,
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "image_count",
        "price_per_unit": Decimal("0.04"),
        "price_unit": "元/张",
    },
    {
        "provider_key": "dashscope",
        "model_name": "wan2.1-t2i-plus",
        "display_name": "万相 2.1 文生图增强版",
        "description": "万相2.1系列增强版，画质更好，适合高质量图片需求",
        "task_type": "text2image",
        "supported_sizes": _WAN_IMAGE_SIZES,
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "image_count",
        "price_per_unit": Decimal("0.08"),
        "price_unit": "元/张",
    },
    {
        "provider_key": "dashscope",
        "model_name": "wan2.5-t2i-preview",
        "display_name": "万相 2.5 文生图预览版",
        "description": "万相2.5系列预览版，新一代模型，画质和语义理解有显著提升",
        "task_type": "text2image",
        "supported_sizes": _WAN_IMAGE_SIZES_EXTENDED,
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "image_count",
        "price_per_unit": Decimal("0.10"),
        "price_unit": "元/张",
    },
    {
        "provider_key": "dashscope",
        "model_name": "wan2.6-t2i",
        "display_name": "万相 2.6 文生图",
        "description": "万相2.6最新版，目前画质最佳、语义理解最强的图片模型",
        "task_type": "text2image",
        "supported_sizes": _WAN_IMAGE_SIZES_EXTENDED,
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "image_count",
        "price_per_unit": Decimal("0.12"),
        "price_unit": "元/张",
    },

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 文生图 (text2image) - FLUX 系列
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    {
        "provider_key": "dashscope",
        "model_name": "flux-schnell",
        "display_name": "FLUX Schnell",
        "description": "FLUX 快速版，Black Forest Labs 出品，速度极快",
        "task_type": "text2image",
        "supported_sizes": _FLUX_SIZES,
        "max_prompt_length": 500,
        "supports_negative_prompt": False,
        "supports_prompt_extend": False,
        "billing_type": "image_count",
        "price_per_unit": Decimal("0.04"),
        "price_unit": "元/张",
    },
    {
        "provider_key": "dashscope",
        "model_name": "flux-dev",
        "display_name": "FLUX Dev",
        "description": "FLUX 开发版，Black Forest Labs 出品，画质更好",
        "task_type": "text2image",
        "supported_sizes": _FLUX_SIZES,
        "max_prompt_length": 500,
        "supports_negative_prompt": False,
        "supports_prompt_extend": False,
        "billing_type": "image_count",
        "price_per_unit": Decimal("0.06"),
        "price_unit": "元/张",
    },
    {
        "provider_key": "dashscope",
        "model_name": "flux-merged",
        "display_name": "FLUX Merged",
        "description": "FLUX 融合版，Black Forest Labs 出品，兼顾速度与质量",
        "task_type": "text2image",
        "supported_sizes": _FLUX_SIZES,
        "max_prompt_length": 500,
        "supports_negative_prompt": False,
        "supports_prompt_extend": False,
        "billing_type": "image_count",
        "price_per_unit": Decimal("0.06"),
        "price_unit": "元/张",
    },

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 文生视频 (text2video) - 万相系列
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    {
        "provider_key": "dashscope",
        "model_name": "wanx2.1-t2v-turbo",
        "display_name": "万相 2.1 文生视频加速版",
        "description": "万相2.1系列加速版文生视频，速度快，适合批量生成",
        "task_type": "text2video",
        "supported_sizes": _VIDEO_SIZES_T2V,
        "supported_durations": [5],
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "video_seconds",
        "price_per_unit": Decimal("0.10"),
        "price_unit": "元/秒",
    },
    {
        "provider_key": "dashscope",
        "model_name": "wanx2.1-t2v-plus",
        "display_name": "万相 2.1 文生视频增强版",
        "description": "万相2.1系列增强版文生视频，画质更好",
        "task_type": "text2video",
        "supported_sizes": _VIDEO_SIZES_T2V,
        "supported_durations": [5],
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "video_seconds",
        "price_per_unit": Decimal("0.20"),
        "price_unit": "元/秒",
    },
    {
        "provider_key": "dashscope",
        "model_name": "wan2.5-t2v-preview",
        "display_name": "万相 2.5 文生视频预览版",
        "description": "万相2.5系列预览版文生视频，支持更长时长和更高画质",
        "task_type": "text2video",
        "supported_sizes": _VIDEO_SIZES_T2V_EXTENDED,
        "supported_durations": [5, 10],
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "video_seconds",
        "price_per_unit": Decimal("0.24"),
        "price_unit": "元/秒",
    },
    {
        "provider_key": "dashscope",
        "model_name": "wan2.6-t2v",
        "display_name": "万相 2.6 文生视频",
        "description": "万相2.6最新版文生视频，画质最佳，运动效果最自然",
        "task_type": "text2video",
        "supported_sizes": _VIDEO_SIZES_T2V_EXTENDED,
        "supported_durations": [5, 10],
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "video_seconds",
        "price_per_unit": Decimal("0.30"),
        "price_unit": "元/秒",
    },

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 图生视频 (image2video) - 万相系列
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    {
        "provider_key": "dashscope",
        "model_name": "wanx2.1-i2v-turbo",
        "display_name": "万相 2.1 图生视频加速版",
        "description": "万相2.1系列加速版图生视频，基于参考图快速生成",
        "task_type": "image2video",
        "supported_sizes": _VIDEO_SIZES_I2V,
        "supported_durations": [5],
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "video_seconds",
        "price_per_unit": Decimal("0.10"),
        "price_unit": "元/秒",
    },
    {
        "provider_key": "dashscope",
        "model_name": "wanx2.1-i2v-plus",
        "display_name": "万相 2.1 图生视频增强版",
        "description": "万相2.1系列增强版图生视频，画质更好",
        "task_type": "image2video",
        "supported_sizes": _VIDEO_SIZES_I2V,
        "supported_durations": [5],
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "video_seconds",
        "price_per_unit": Decimal("0.20"),
        "price_unit": "元/秒",
    },
    {
        "provider_key": "dashscope",
        "model_name": "wan2.5-i2v-preview",
        "display_name": "万相 2.5 图生视频预览版",
        "description": "万相2.5系列预览版图生视频",
        "task_type": "image2video",
        "supported_sizes": _VIDEO_SIZES_I2V,
        "supported_durations": [5, 10],
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "video_seconds",
        "price_per_unit": Decimal("0.24"),
        "price_unit": "元/秒",
    },
    {
        "provider_key": "dashscope",
        "model_name": "wan2.6-i2v-flash",
        "display_name": "万相 2.6 图生视频闪电版",
        "description": "万相2.6最新版图生视频闪电版，速度快画质好",
        "task_type": "image2video",
        "supported_sizes": _VIDEO_SIZES_I2V,
        "supported_durations": [5, 10],
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "supports_audio": True,
        "billing_type": "video_seconds",
        "price_per_unit": Decimal("0.20"),
        "price_unit": "元/秒",
    },

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 视频编辑 (video_edit) - 万相系列
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    {
        "provider_key": "dashscope",
        "model_name": "wanx2.1-vace-plus",
        "display_name": "万相 2.1 视频编辑增强版",
        "description": "万相2.1 VACE 视频编辑增强版，支持视频续写、虚拟试穿等",
        "task_type": "video_edit",
        "supported_sizes": _VIDEO_SIZES_T2V,
        "supported_durations": [5],
        "max_prompt_length": 800,
        "supports_negative_prompt": True,
        "supports_prompt_extend": True,
        "billing_type": "video_seconds",
        "price_per_unit": Decimal("0.20"),
        "price_unit": "元/秒",
    },
]


def seed_default_data(api_key: str = "", dry_run: bool = False):
    """
    初始化默认提供商和模型数据。

    - 幂等操作: 已存在的记录不会被覆盖，只会创建缺失的
    - 返回 (created_providers, created_models, skipped_models) 统计
    """
    from .models import MediaProvider, MediaModel

    created_providers = 0
    created_models = 0
    skipped_models = 0
    details = []

    # 1. 创建提供商
    provider_map = {}
    for pdata in DEFAULT_PROVIDERS:
        key = pdata["provider_key"]
        existing = MediaProvider.objects.filter(
            name=pdata["name"],
            provider_key=key,
            scope=pdata.get("scope", "global"),
            organization_id=None,
            user_id=None,
        ).first()

        if existing:
            provider_map[key] = existing
            details.append(f"[跳过] 提供商已存在: {existing.display_name}")
        else:
            if dry_run:
                details.append(f"[待创建] 提供商: {pdata['display_name']}")
                created_providers += 1
                continue

            provider = MediaProvider.objects.create(
                name=pdata["name"],
                provider_key=key,
                display_name=pdata["display_name"],
                base_url=pdata["base_url"],
                api_key=api_key or "test-api-key",
                scope=pdata.get("scope", "global"),
                priority=pdata.get("priority", 0),
                rate_limit=pdata.get("rate_limit", 30),
            )
            provider_map[key] = provider
            created_providers += 1
            details.append(f"[创建] 提供商: {provider.display_name}")

    # 2. 创建模型
    for mdata in DEFAULT_MODELS:
        pk = mdata["provider_key"]
        provider = provider_map.get(pk)
        if not provider:
            details.append(f"[跳过] 提供商 {pk} 不存在，跳过模型 {mdata['model_name']}")
            skipped_models += 1
            continue

        existing = MediaModel.objects.filter(
            provider=provider,
            model_name=mdata["model_name"],
        ).first()

        if existing:
            skipped_models += 1
            details.append(f"[跳过] 模型已存在: {mdata['model_name']}")
            continue

        if dry_run:
            created_models += 1
            details.append(f"[待创建] 模型: {mdata['model_name']} ({mdata['display_name']})")
            continue

        MediaModel.objects.create(
            provider=provider,
            model_name=mdata["model_name"],
            display_name=mdata["display_name"],
            description=mdata.get("description", ""),
            task_type=mdata["task_type"],
            supported_sizes=mdata.get("supported_sizes", []),
            supported_durations=mdata.get("supported_durations", []),
            max_prompt_length=mdata.get("max_prompt_length", 500),
            supports_negative_prompt=mdata.get("supports_negative_prompt", False),
            supports_prompt_extend=mdata.get("supports_prompt_extend", True),
            supports_audio=mdata.get("supports_audio", False),
            supports_multi_shot=mdata.get("supports_multi_shot", False),
            billing_type=mdata.get("billing_type", "image_count"),
            price_per_unit=mdata.get("price_per_unit", Decimal("0")),
            price_unit=mdata.get("price_unit", ""),
            free_quota=mdata.get("free_quota", 0),
            is_active=True,
        )
        created_models += 1
        details.append(f"[创建] 模型: {mdata['model_name']} ({mdata['display_name']})")

    return {
        "created_providers": created_providers,
        "created_models": created_models,
        "skipped_models": skipped_models,
        "details": details,
    }

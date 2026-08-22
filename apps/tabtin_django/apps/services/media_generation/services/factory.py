"""
媒体生成服务工厂

根据 Provider 类型 + 任务类型，创建对应的服务实例。
已迁移到 LLMProvider/LLMModel 作为配置源（原 MediaProvider/MediaModel 不再使用）。
"""

from typing import Any, Dict, Optional
import logging
import re

from .base import BaseMediaService
from .image.dashscope_image_service import DashScopeImageService
from .image.fal_image_service import FalImageService
from .image.replicate_image_service import ReplicateImageService
from .image.volcengine_image_service import VolcengineImageService
from .video.dashscope_video_service import DashScopeVideoService
from .video.fal_video_service import FalVideoService
from .video.replicate_video_service import ReplicateVideoService
from apps.i18n import _
from ..errors import MediaErrorCode, MediaServiceError

logger = logging.getLogger(__name__)

# Agent 常把 catalog 的 id（LLMModel UUID）塞进 --model；能力层又写成 model_name。
# 形如 UUID 时按 model_id 查，避免「模型不存在」却只剩笼统报错（ 续）。
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _looks_like_uuid(value: str) -> bool:
    return bool(_UUID_RE.match((value or "").strip()))

_IMAGE_TASK_TYPES = {"text2image", "image2image", "image_edit"}
_VIDEO_TASK_TYPES = {"text2video", "image2video", "video_edit"}

# v0.1：LLMModel.mode 字段已删（0022），媒体类目改用 capability_domain。
_TASK_TYPE_TO_DOMAIN: dict[str, str] = {
    # CLI / catalog：按媒介过滤（与 tabtin image / tabtin media models -t 并存）
    "image": "image_gen",
    "video": "video_gen",
    "text2image": "image_gen",
    "image2image": "image_gen",
    "image_edit": "image_gen",
    "text2video": "video_gen",
    "image2video": "video_gen",
    "video_edit": "video_gen",
}

# 历史名兼容（外部如有引入仍可使用）
_TASK_TYPE_TO_MODE = _TASK_TYPE_TO_DOMAIN

SERVICE_MAP = {
    ("dashscope", "image"): DashScopeImageService,
    ("dashscope", "video"): DashScopeVideoService,
    ("fal", "image"): FalImageService,
    ("fal", "video"): FalVideoService,
    ("replicate", "image"): ReplicateImageService,
    ("replicate", "video"): ReplicateVideoService,
    ("volcengine", "image"): VolcengineImageService,
}


def _resolve_media_category(task_type: str) -> str:
    if task_type in _IMAGE_TASK_TYPES:
        return "image"
    if task_type in _VIDEO_TASK_TYPES:
        return "video"
    raise MediaServiceError(
        code=MediaErrorCode.INVALID_REQUEST,
        message=_("media_generation.unsupported_task_type", type=task_type),
    )


def _domain_for_task_type(task_type: str) -> str:
    """将媒体 task_type 映射到 v0.1 的 capability_domain（image_gen / video_gen）。"""
    domain = _TASK_TYPE_TO_DOMAIN.get(task_type)
    if not domain:
        raise MediaServiceError(
            code=MediaErrorCode.INVALID_REQUEST,
            message=_("media_generation.unsupported_task_type", type=task_type),
        )
    return domain


# 历史调用方仍按 mode 命名
_mode_for_task_type = _domain_for_task_type


def _infer_task_type_from_domain(domain: str) -> str:
    """从 v0.1 ``capability_domain`` 反推默认 task_type（取同域下最常用的）。"""
    if domain == "image_gen":
        return "text2image"
    if domain == "video_gen":
        return "text2video"
    return ""


# 兼容旧名
_infer_task_type_from_mode = _infer_task_type_from_domain


def _get_scene_bound_models(*, scene_key: str, capability_domain: str):
    """按 AdminDash SceneBinding 顺序返回可路由的媒体模型。

    执行目录只暴露运营明确绑定的 primary / fallback，不能把同能力域下的
    全部模型池泄漏给 Agent 自行挑选。
    """
    from apps.services.llm.models import LLMModel, LLMSceneBinding

    binding = (
        LLMSceneBinding.objects
        .filter(scene_key=scene_key, capability_domain=capability_domain)
        .only("primary_model_id", "fallback_models")
        .first()
    )
    if not binding or not binding.primary_model_id:
        return []

    model_ids = [str(binding.primary_model_id)]
    for entry in binding.fallback_models or []:
        model_id = entry.get("model_id") if isinstance(entry, dict) else None
        if model_id and str(model_id) not in model_ids:
            model_ids.append(str(model_id))

    models_by_id = {
        str(model.id): model
        for model in LLMModel.objects.select_related("provider").filter(
            id__in=model_ids,
            capability_domain=capability_domain,
            provider__routing_enabled=True,
            provider__scope="global",
        )
    }
    return [models_by_id[model_id] for model_id in model_ids if model_id in models_by_id]


def get_media_service(
    *,
    model_id: Optional[str] = None,
    model_name: Optional[str] = None,
    task_type: Optional[str] = None,
    user_id: Optional[str] = None,
    organization_id: Optional[str] = None,
    scene_key: Optional[str] = None,
) -> BaseMediaService:
    """
    获取媒体生成服务实例（从 LLMProvider/LLMModel 读取配置）。

    优先级：scene 绑定约束 → model_id → model_name → task_type 自动选择
    """
    from apps.services.llm.models import LLMModel, LLMProvider

    model_obj = None
    provider_obj = None

    # v0.1：LLMModel.mode 字段已删（0022），媒体生成走 capability_domain。
    _MEDIA_DOMAINS = {"image_gen", "video_gen"}

    if not model_id and model_name and _looks_like_uuid(model_name):
        logger.info(
            "[MediaFactory] model_name looks like UUID, treating as model_id: %s",
            model_name,
        )
        model_id = model_name.strip()
        model_name = None

    if scene_key:
        if not task_type:
            raise MediaServiceError(
                code=MediaErrorCode.INVALID_REQUEST,
                message=_("media_generation.must_provide_model_or_type"),
            )
        domain = _domain_for_task_type(task_type)
        bound_models = _get_scene_bound_models(
            scene_key=scene_key,
            capability_domain=domain,
        )
        if not bound_models:
            raise MediaServiceError(
                code=MediaErrorCode.MODEL_NOT_FOUND,
                message=_("media_generation.no_available_model", type=task_type),
            )

        if model_id or model_name:
            requested = str(model_id or model_name).strip()
            model_obj = next(
                (
                    model
                    for model in bound_models
                    if str(model.id) == requested or model.model_name == requested
                ),
                None,
            )
            if model_obj is None:
                raise MediaServiceError(
                    code=MediaErrorCode.MODEL_NOT_FOUND,
                    message=(
                        f"scene_key='{scene_key}' 未绑定模型 '{requested}'，"
                        "请在管理后台场景配置中选择允许的模型"
                    ),
                )
        else:
            model_obj = bound_models[0]
        provider_obj = model_obj.provider

    if model_obj is None and model_id:
        try:
            model_obj = LLMModel.objects.select_related('provider').get(
                id=model_id,
                provider__routing_enabled=True,
                provider__scope="global",
                capability_domain__in=_MEDIA_DOMAINS,
            )
        except LLMModel.DoesNotExist:
            raise MediaServiceError(
                code=MediaErrorCode.MODEL_NOT_FOUND,
                message=_("media_generation.model_not_found_or_disabled", model=model_id),
            )
        provider_obj = model_obj.provider
        if not task_type:
            task_type = (model_obj.capabilities_config or {}).get(
                "default_task_type",
                _infer_task_type_from_domain(model_obj.capability_domain),
            )

    elif model_obj is None and model_name:
        model_obj = (
            LLMModel.objects
            .select_related('provider')
            .filter(
                model_name=model_name,
                provider__routing_enabled=True,
                provider__scope="global",
                capability_domain__in=_MEDIA_DOMAINS,
            )
            .first()
        )
        if not model_obj:
            raise MediaServiceError(
                code=MediaErrorCode.MODEL_NOT_FOUND,
                message=_("media_generation.model_not_found_or_disabled", model=model_name),
            )
        provider_obj = model_obj.provider
        if not task_type:
            task_type = (model_obj.capabilities_config or {}).get(
                "default_task_type",
                _infer_task_type_from_domain(model_obj.capability_domain),
            )

    elif model_obj is None and task_type:
        domain = _domain_for_task_type(task_type)
        candidates = (
            LLMModel.objects
            .select_related('provider')
            .filter(
                capability_domain=domain,
                provider__routing_enabled=True,
                provider__scope="global",
            )
        )
        model_obj = (
            candidates
            .filter(capabilities_config__default_for_task_type=True)
            .order_by('-provider__priority')
            .first()
            or candidates.order_by('-provider__priority').first()
        )
        if not model_obj:
            raise MediaServiceError(
                code=MediaErrorCode.MODEL_NOT_FOUND,
                message=_("media_generation.no_available_model", type=task_type),
            )
        provider_obj = model_obj.provider

    elif model_obj is None:
        raise MediaServiceError(
            code=MediaErrorCode.INVALID_REQUEST,
            message=_("media_generation.must_provide_model_or_type"),
        )

    if not task_type:
        raise MediaServiceError(
            code=MediaErrorCode.INVALID_REQUEST,
            message=_("media_generation.cannot_determine_task_type"),
        )

    category = _resolve_media_category(task_type)
    provider_name = provider_obj.name
    service_key = (provider_name, category)

    service_cls = SERVICE_MAP.get(service_key)
    if not service_cls:
        raise MediaServiceError(
            code=MediaErrorCode.MODEL_NOT_FOUND,
            message=_("media_generation.unsupported_provider_combo", combo=f"{provider_name}/{category}"),
        )

    # v0.1.x Phase 2.5：base_url 从 model 取。
    # dashscope 同账号下 image_gen 走 /api/v1、chat 走 /compatible-mode/v1，
    # Provider 已无 base_url；endpoint 跟 model 走才能正确拼装媒体生成 URL。
    provider_config = {
        "name": provider_name,
        "api_key": provider_obj.api_key,
        "base_url": model_obj.base_url,
        "provider_obj": provider_obj,
        "model_obj": model_obj,
    }

    return service_cls(provider_config)


def get_available_models(
    task_type: Optional[str] = None,
    user_id: Optional[str] = None,
    organization_id: Optional[str] = None,
    scene_key: Optional[str] = None,
):
    """获取可用的媒体生成模型列表（从 LLMModel 读取）。"""
    from apps.services.llm.models import LLMModel
    from apps.services.media_generation.pricing import IMAGE_SUCCESS_UNIT_PRICE

    # v0.1：媒体类目改用 capability_domain。
    _MEDIA_DOMAINS = {"image_gen", "video_gen"}

    domain = _TASK_TYPE_TO_DOMAIN.get(task_type or "")
    if scene_key:
        if not domain:
            return []
        qs = _get_scene_bound_models(
            scene_key=scene_key,
            capability_domain=domain,
        )
    else:
        qs = LLMModel.objects.select_related('provider').filter(
            provider__routing_enabled=True,
            provider__scope="global",
            capability_domain__in=_MEDIA_DOMAINS,
        )
        if domain:
            qs = qs.filter(capability_domain=domain)

    results = []
    for m in qs:
        caps = m.capabilities_config or {}
        media_caps = caps.get("media_gen", {})
        inferred_task_type = caps.get(
            "default_task_type",
            _infer_task_type_from_domain(m.capability_domain),
        )
        results.append({
            "id": str(m.id),
            "model_name": m.model_name,
            "display_name": m.display_name,
            "description": m.description,
            "task_type": inferred_task_type,
            "provider": m.provider.display_name,
            "supported_sizes": media_caps.get("supported_sizes", []),
            "supported_durations": media_caps.get("supported_durations_sec", []),
            "supports_negative_prompt": media_caps.get("supports_negative_prompt", False),
            "supports_audio": media_caps.get("supports_audio_input", False),
            "supports_multi_shot": media_caps.get("max_n_per_request", 1) > 1,
            "billing_type": m.billing_type,
            "price_per_unit": str(
                IMAGE_SUCCESS_UNIT_PRICE
                if m.capability_domain == "image_gen"
                else m.price_per_request
            ),
            "price_unit": (
                "points/successful_image"
                if m.capability_domain == "image_gen"
                else media_caps.get("price_unit", "")
            ),
        })

    return results

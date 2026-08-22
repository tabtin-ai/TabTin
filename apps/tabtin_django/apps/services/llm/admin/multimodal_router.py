"""多模态聚合 API — v0.1 AdminDash

- Speech：TTS + ASR 各 scene 的 binding + 默认音色
- Vision：vision_parse_document scene binding + capability 校验
- 异步任务：image_gen / video_gen / audio_gen 任务列表 + 重试
"""

from __future__ import annotations

import logging
from typing import Optional

from ninja import Router

from apps.i18n.response import error_response_with_status, success_response
from apps.users.auth.permissions import StaffAuth

from ..models import LLMModel, LLMSceneBinding
from ..scenes.registry import SCENES
from .scenes_router import _check_capability_match

logger = logging.getLogger(__name__)

router = Router(tags=["Admin Multimodal"], auth=StaffAuth())

MULTIMODAL_DOMAINS = ("vision", "asr", "tts", "image_gen", "video_gen", "audio_gen")


# ─── 辅助：序列化 scene + binding 给前端 ─────────────────────────────────


def _scene_binding_payload(spec, binding: Optional[LLMSceneBinding]) -> dict:
    """把 (SceneSpec, LLMSceneBinding?) 折成前端 Speech/Vision 子页消费的字典。"""
    base = {
        "scene_key": spec.scene_key,
        "display_name": spec.display_name,
        "description": spec.description,
        "capability_domain": spec.capability_domain,
        "capability_requirements": dict(spec.capability_requirements or {}),
        "is_system": bool(getattr(spec, "is_system", False)),
        "binding": None,
        "available_voices": [],
        "capability_validation": "satisfied",
        "capability_issues": [],
    }

    if binding is None or binding.primary_model is None:
        base["capability_validation"] = "unsatisfied"
        base["capability_issues"] = ["primary_model 未绑定"]
        return base

    model = binding.primary_model
    caps = model.capabilities_config or {}
    speech_cfg = caps.get("speech") if isinstance(caps.get("speech"), dict) else {}
    voices = speech_cfg.get("available_voices") or []
    if not isinstance(voices, list):
        voices = []

    base["binding"] = {
        "id": str(binding.id),
        "primary_model": {
            "id": str(model.id),
            "model_name": model.model_name,
            "display_name": model.display_name,
            "provider_name": model.provider.name if model.provider_id else "",
            "provider_display_name": model.provider.display_name if model.provider_id else "",
        },
        "fallback_models": list(binding.fallback_models or []),
        "default_params": dict(binding.default_params or {}),
        "timeout_sec": binding.timeout_sec,
        "updated_at": binding.updated_at.isoformat() if binding.updated_at else None,
    }
    base["available_voices"] = [
        {
            "voice_id": v.get("voice_id") or v.get("id") or v.get("name") or "",
            "display_name": v.get("display_name") or v.get("name") or v.get("voice_id") or "",
            "gender": v.get("gender") or "",
            "language": v.get("language") or "",
        }
        if isinstance(v, dict)
        else {"voice_id": str(v), "display_name": str(v), "gender": "", "language": ""}
        for v in voices
    ]

    # capability 校验复用 scenes_router 的单一来源（避免漂移 — 宪法 §1.1.3）
    match = _check_capability_match(model, spec)
    base["capability_validation"] = "satisfied" if match.get("satisfied") else "unsatisfied"
    base["capability_issues"] = list(match.get("issues") or [])

    return base


def _list_scenes_with_bindings(domain: str) -> list[dict]:
    """按 domain 列出 scene + binding，前端 Speech/Vision 子页直接消费。"""
    specs = [s for s in SCENES.values() if s.capability_domain == domain]
    bindings = {
        b.scene_key: b
        for b in LLMSceneBinding.objects.select_related('primary_model__provider').filter(
            capability_domain=domain,
        )
    }
    return [_scene_binding_payload(spec, bindings.get(spec.scene_key)) for spec in specs]


# ─── Tab 1+2+3 共享：overview ──────────────────────────────────────────────


@router.get("/admin/multimodal/overview")
def multimodal_overview(request):
    """多模态总览 — 6 个 domain 的 scene 数 / binding 数 / 健康模型数。"""
    result: dict = {}
    for domain in MULTIMODAL_DOMAINS:
        scenes = [s for s in SCENES.values() if s.capability_domain == domain]
        active_bindings = LLMSceneBinding.objects.filter(
            capability_domain=domain, primary_model__isnull=False,
        ).count()
        healthy_models = LLMModel.objects.filter(
            capability_domain=domain, wave_status='ready',
        ).count()
        result[domain] = {
            "active_scenes": len(scenes),
            "active_bindings": active_bindings,
            "healthy_models": healthy_models,
        }
    return success_response(data=result)


# ─── Tab 1：Speech（TTS + ASR）──────────────────────────────────────────


@router.get("/admin/multimodal/speech")
def multimodal_speech(request):
    """Speech 子 Tab — TTS + ASR 全部 scene + 模型 + 默认音色。"""
    tts_scenes = _list_scenes_with_bindings("tts")
    asr_scenes = _list_scenes_with_bindings("asr")

    tts_provider_ids = {
        s["binding"]["primary_model"]["id"]
        for s in tts_scenes
        if s.get("binding") and s["binding"].get("primary_model")
    }
    asr_provider_ids = {
        s["binding"]["primary_model"]["id"]
        for s in asr_scenes
        if s.get("binding") and s["binding"].get("primary_model")
    }

    # 路线 B（宪法 §6 + §1.7）：embedding/vision/asr/tts/image_gen/video_gen/audio_gen
    # 全部 effective_provider_scope='global'，admin 列表也按 scope='global' 过滤
    tts_models = list(LLMModel.objects.filter(
        capability_domain="tts", wave_status='ready', provider__scope='global',
    ).select_related('provider'))
    asr_models = list(LLMModel.objects.filter(
        capability_domain="asr", wave_status='ready', provider__scope='global',
    ).select_related('provider'))

    return success_response(data={
        "tts": {
            "scenes": tts_scenes,
            "active_provider_ids": list(tts_provider_ids),
            "available_models": [
                {
                    "id": str(m.id),
                    "model_name": m.model_name,
                    "display_name": m.display_name,
                    "provider_name": m.provider.name if m.provider_id else "",
                    "provider_display_name": m.provider.display_name if m.provider_id else "",
                }
                for m in tts_models
            ],
        },
        "asr": {
            "scenes": asr_scenes,
            "active_provider_ids": list(asr_provider_ids),
            "available_models": [
                {
                    "id": str(m.id),
                    "model_name": m.model_name,
                    "display_name": m.display_name,
                    "provider_name": m.provider.name if m.provider_id else "",
                    "provider_display_name": m.provider.display_name if m.provider_id else "",
                }
                for m in asr_models
            ],
        },
    })


# ─── Tab 2：Vision ────────────────────────────────────────────────────────


@router.get("/admin/multimodal/vision")
def multimodal_vision(request):
    """Vision 子 Tab — VLM 当前 SceneBinding + capability 校验。"""
    scenes = _list_scenes_with_bindings("vision")
    available_models = list(LLMModel.objects.filter(
        capability_domain="vision", wave_status='ready', provider__scope='global',
    ).select_related('provider'))
    return success_response(data={
        "scenes": scenes,
        "available_models": [
            {
                "id": str(m.id),
                "model_name": m.model_name,
                "display_name": m.display_name,
                "provider_name": m.provider.name if m.provider_id else "",
                "provider_display_name": m.provider.display_name if m.provider_id else "",
                "supports_vision": bool((m.capabilities_config or {}).get("supports_vision")),
            }
            for m in available_models
        ],
    })


# ─── Tab 3：异步任务（image_gen / video_gen / audio_gen）────────────────


def _domain_to_task_type_filter(domain: Optional[str]) -> Optional[list[str]]:
    """把 capability_domain 翻译成 MediaTask.task_type 候选集。

    v0.1 SCENES 注册的 task_type（每个 capability_domain 一一对应）：
      image_gen → text2image / image2image / image_edit
      video_gen → text2video / image2video / video_edit
      audio_gen → bgm_generate（v0.1 仅此一个；audio_generate / sfx_generate 是
                  宪法 §5.1 标注的"未来扩展"，v0.1 不开放）
    """
    if not domain:
        return None
    if domain == "image_gen":
        return ["text2image", "image2image", "image_edit"]
    if domain == "video_gen":
        return ["text2video", "image2video", "video_edit"]
    if domain == "audio_gen":
        return ["bgm_generate"]
    return None


def _task_type_to_capability_domain(task_type: str) -> str:
    """task_type → capability_domain 的反向映射（用于前端展示）。

    v0.1 task_type 是封闭枚举集合，用精确白名单匹配（in tuple）。
    早期实现用 `'image' in task_type` 的 substring 匹配会把 'image2video'
    错归到 image_gen，已删除。
    """
    if not task_type:
        return "unknown"
    if task_type in ("text2video", "image2video", "video_edit"):
        return "video_gen"
    if task_type in ("text2image", "image2image", "image_edit"):
        return "image_gen"
    if task_type in ("bgm_generate", "audio_generate", "sfx_generate"):
        return "audio_gen"
    return "unknown"


@router.get("/admin/multimodal/tasks")
def list_multimodal_tasks(
    request,
    capability_domain: Optional[str] = None,
    status: Optional[str] = None,
    organization_id: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
):
    """异步任务列表 — 复用 MediaTask 表（详见宪法 §5.4）。

    注：MediaTask v0.1 没有 scene_key 字段（宪法 §5.4 的 schema 待 v0.2
    migration 补齐）。前端列表"Scene"列展示空字符串，后端不再做 scene_key 过滤。
    """
    try:
        from apps.services.media_generation.models import MediaTask
    except ImportError:
        return success_response(data={
            "tasks": [], "total": 0, "page": 1, "page_size": page_size,
        })

    qs = MediaTask.objects.select_related('provider', 'model').all().order_by('-created_at')

    task_types = _domain_to_task_type_filter(capability_domain)
    if task_types:
        qs = qs.filter(task_type__in=task_types)
    if status:
        qs = qs.filter(status=status)
    if organization_id:
        qs = qs.filter(organization_id=organization_id)

    total = qs.count()
    page = max(1, page)
    page_size = max(1, min(200, page_size))
    offset = (page - 1) * page_size
    tasks = list(qs[offset:offset + page_size])

    items = [{
        "id": str(t.id),
        "task_id": str(t.id),
        "task_type": t.task_type,
        "capability_domain": _task_type_to_capability_domain(t.task_type),
        "scene_key": "",  # v0.1：MediaTask 缺 scene_key 字段，待 v0.2 migration
        "status": t.status,
        "organization_id": t.organization_id or "",
        "user_id": t.user_id or "",
        "model_name": getattr(t.model, 'model_name', '') if t.model_id else getattr(t, 'model_name', ''),
        "model_display_name": getattr(t.model, 'display_name', '') if t.model_id else '',
        "prompt": (t.prompt or "")[:200],
        "error_code": getattr(t, 'error_code', '') or '',
        "error_message": (getattr(t, 'error_message', '') or '')[:500],
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "completed_at": t.completed_at.isoformat() if getattr(t, 'completed_at', None) else None,
    } for t in tasks]

    return success_response(data={
        "tasks": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@router.get("/admin/multimodal/tasks/{task_id}")
def multimodal_task_detail(request, task_id: str):
    """异步任务详情 — 用于前端"详情"按钮的弹窗。"""
    try:
        from apps.services.media_generation.models import MediaTask
    except ImportError:
        return error_response_with_status(
            code="MEDIA_GENERATION_UNAVAILABLE",
            message="media_generation 模块未启用",
            status_code=503,
        )

    try:
        t = MediaTask.objects.select_related('provider', 'model').get(id=task_id)
    except MediaTask.DoesNotExist:
        return error_response_with_status(
            code="TASK_NOT_FOUND",
            message=f"task_id '{task_id}' 不存在",
            status_code=404,
        )

    return success_response(data={
        "id": str(t.id),
        "task_id": str(t.id),
        "task_type": t.task_type,
        "capability_domain": _task_type_to_capability_domain(t.task_type),
        "scene_key": "",  # v0.1：MediaTask 缺 scene_key 字段
        "status": t.status,
        "organization_id": t.organization_id or "",
        "user_id": t.user_id or "",
        "model_name": getattr(t.model, 'model_name', '') if t.model_id else getattr(t, 'model_name', ''),
        "model_display_name": getattr(t.model, 'display_name', '') if t.model_id else '',
        "provider_name": getattr(t.provider, 'name', '') if t.provider_id else '',
        "prompt": t.prompt or "",
        "error_code": getattr(t, 'error_code', '') or '',
        "error_message": getattr(t, 'error_message', '') or '',
        "stored_urls": list(getattr(t, 'stored_urls', []) or []),
        "result_urls": list(getattr(t, 'result_urls', []) or []),
        "result_metadata": dict(getattr(t, 'result_metadata', {}) or {}),
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "submitted_at": t.submitted_at.isoformat() if getattr(t, 'submitted_at', None) else None,
        "completed_at": t.completed_at.isoformat() if getattr(t, 'completed_at', None) else None,
    })


@router.post("/admin/multimodal/tasks/{task_id}/retry")
def retry_multimodal_task(request, task_id: str):
    """重试失败的多模态任务 — 仅 status='failed' 可重试。

    复用 media_generation.tasks.polling.poll_media_task celery 任务，
    把 status 重置回 'pending' 后投递。
    """
    try:
        from apps.services.media_generation.models import MediaTask
    except ImportError:
        return error_response_with_status(
            code="MEDIA_GENERATION_UNAVAILABLE",
            message="media_generation 模块未启用",
            status_code=503,
        )

    try:
        task = MediaTask.objects.get(id=task_id)
    except MediaTask.DoesNotExist:
        return error_response_with_status(
            code="TASK_NOT_FOUND",
            message=f"task_id '{task_id}' 不存在",
            status_code=404,
        )

    if task.status != "failed":
        return error_response_with_status(
            code="TASK_NOT_RETRIABLE",
            message=f"仅 status='failed' 任务可重试，当前 status='{task.status}'",
            status_code=400,
            data={"current_status": task.status},
        )

    task.status = "pending"
    task.error_code = ""
    task.error_message = ""
    task.poll_count = 0
    task.completed_at = None
    update_fields = [
        "status", "error_code", "error_message", "poll_count",
        "completed_at", "updated_at",
    ]
    task.save(update_fields=update_fields)
    # 注：这里**保留 provider_task_id**，与旧版 media_generation/admin_api.retry_task
    # 语义一致 — "重试 = 重新轮询同一个 provider job"。
    #
    # 已知限制：如果 provider job 已彻底失败（非临时性故障），重试会再次拉到失败
    # 结果让 task.mark_failed 立刻终态，运营会观察到 status 反复在 pending→failed
    # 翻转。真"重新提交到 provider"语义需要重建 MediaRequest 并调
    # service.submit_task_with_protection，要重写本端点为 resubmit_media_task —
    # 已记录到 v0.2 路线图 (D3 Review B P1.1)，v0.1 暂保持简单语义。

    try:
        from apps.services.media_generation.tasks.polling import poll_media_task
        poll_media_task.delay(str(task.id))
    except Exception:  # noqa: BLE001 — celery 异常不该让 API 失败
        logger.exception("[multimodal.retry] celery dispatch failed task_id=%s", task_id)

    operator = getattr(request, "auth", None)
    operator_id = getattr(operator, "id", None) if operator else None
    logger.info(
        "[multimodal.retry] task_id=%s reset to pending (operator=%s)",
        task_id, operator_id,
    )

    return success_response(data={
        "task_id": str(task.id),
        "status": task.status,
        "message": "任务已重置为 pending 并重新投递轮询",
    })

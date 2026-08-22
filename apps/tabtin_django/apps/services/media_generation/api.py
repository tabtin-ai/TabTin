"""
媒体生成服务 API 接口

路由前缀: /api/services/media/
"""

from ninja import Router
from ninja.errors import HttpError
from typing import Optional
import logging
import uuid

from apps.i18n import get_text, _
from apps.users.auth.permissions import JWTAuth

from .schemas import (
    GenerateImageRequest,
    GenerateVideoRequest,
    TaskResponse,
    TaskDetailResponse,
    TaskListResponse,
    ModelCatalogResponse,
    ModelInfoResponse,
    BaseResponse,
)
from .services import get_media_service, get_available_models
from .models import MediaTask
from .tasks.execution import execute_media_generation
from .errors import MediaErrorCode, MediaServiceError
from apps.services.billing.decorators import billing_required

logger = logging.getLogger(__name__)

router = Router()

jwt_auth = JWTAuth()


def _media_error_http_status(error: MediaServiceError) -> int:
    """把供应商错误映射为平台 API 语义，避免上游 401 触发客户端登录刷新。"""
    if error.code == MediaErrorCode.AUTH_FAILED:
        return 502
    return error.status_code or 400


def _mark_submission_failed(task: MediaTask | None, *, code: str, message: str) -> None:
    """上游提交失败时关闭已创建的任务，避免无 provider_task_id 的 pending 脏记录。"""
    if task is None or task.is_terminal:
        return
    task.mark_failed(error_code=code, error_message=message)


def _enqueue_media_execution(task: MediaTask) -> None:
    """把 Provider 提交放到 Celery，HTTP 只负责立刻返回 task_id。"""
    try:
        execute_media_generation.delay(str(task.id))
    except Exception as exc:
        _mark_submission_failed(task, code="QUEUE_ERROR", message=str(exc)[:500])
        logger.exception("[MediaAPI] 媒体执行任务入队失败: task=%s", task.id)
        raise HttpError(503, get_text("media.generate_failed", detail="媒体任务排队失败，请稍后重试"))


def _legacy_result_urls(task: MediaTask) -> list[str]:
    """旧客户端仍拿到按原索引对齐的 URL；失败临时链不污染 stored_urls。"""
    original_urls = list(task.result_urls or [])
    if task.storage_status != 'partial':
        return list(task.stored_urls or original_urls)

    compatible_urls = original_urls[:]
    for stored_file in task.stored_files or []:
        if not isinstance(stored_file, dict):
            continue
        index = stored_file.get('index')
        access_url = stored_file.get('access_url')
        if (
            isinstance(index, int)
            and 0 <= index < len(compatible_urls)
            and isinstance(access_url, str)
            and access_url
        ):
            compatible_urls[index] = access_url
    return compatible_urls


def _reconcile_legacy_storage_delivery(task: MediaTask) -> None:
    """把滚动发布中旧 Worker 写下的永久 URL 升级为稳定文件身份。

    只有能通过该 MediaTask 的 FileUsage 反查到 FileRecord 的 URL 才升级；
    Provider 临时 URL 即使混入旧 ``stored_urls`` 也不会成为正式产物。
    """
    if task.storage_status not in ('not_started', 'storing'):
        return
    if task.stored_files or not task.stored_urls:
        return

    try:
        from apps.services.media_generation.tasks.storage import (
            artifact_message_id,
            enqueue_media_artifact_delivery,
        )
        from apps.services.oss.models import FileUsage

        usages = FileUsage.objects.filter(
            module='media_generation',
            context_id=str(task.id),
            is_active=True,
            file_record__status='completed',
            file_record__access_url__in=task.stored_urls,
        ).select_related('file_record')
        records_by_url = {
            usage.file_record.access_url: usage.file_record
            for usage in usages
            if usage.file_record.access_url
        }
        stable_files = []
        for index, access_url in enumerate(task.stored_urls):
            record = records_by_url.get(access_url)
            if record is None:
                continue
            stable_files.append({
                'index': index,
                'file_id': str(record.id),
                'file_name': record.file_name,
                'mime_type': record.mime_type,
                'file_size': int(record.file_size),
                'access_url': record.access_url,
                'artifact_message_id': artifact_message_id(
                    task_id=str(task.id),
                    file_id=str(record.id),
                    index=index,
                ),
            })
        if not stable_files:
            return
        expected_count = len(task.result_urls or []) or len(task.stored_urls)
        storage_status = 'succeeded' if len(stable_files) == expected_count else 'partial'
        task.mark_storage_result(
            storage_status=storage_status,
            stored_files=stable_files,
        )
        enqueue_media_artifact_delivery(task)
    except Exception:
        logger.exception("[MediaAPI] 旧 Worker 永久产物身份升级失败: task=%s", task.id)


# ── 图片生成 ──

@router.post("/generate/image", response=TaskResponse, auth=jwt_auth, tags=["媒体生成"])
@billing_required(
    service_key="media.image",
    scene_key="media_image_generate",
    skip_balance_check=True,
    enforce_organization_permission=True,
)
def generate_image(request, payload: GenerateImageRequest):
    """提交图片生成任务。

    立刻返回 MediaTask.id；Seedream 等同步 Provider 的真实调用在 Celery 中执行，
    避免生产网关 ~60s 超时导致客户端拿不到 task_id。
    """
    request_id = str(uuid.uuid4())
    user_id = str(request.auth.id)
    task = None

    try:
        organization_id = getattr(request, "_billing_organization_id", "") or payload.organization_id or ""

        # 提交前解析模型，缺模型/路由配置时快速失败；真正 submit 交给 Celery。
        service = get_media_service(
            model_id=payload.model_id,
            model_name=payload.model_name,
            task_type="text2image",
            scene_key="media_image_generate",
        )
        model_name = service.model_obj.model_name if service.model_obj else (payload.model_name or "")
        parameters = {
            "size": payload.size,
            "n": payload.n,
            "seed": payload.seed,
            "prompt_extend": payload.prompt_extend,
            "_llm_provider_name": service.provider_name,
            "_llm_model_name": model_name,
            **(payload.extra_params or {}),
        }
        from apps.services.llm.services._runtime.invocation import current_funding_mode

        parameters["_funding_mode"] = current_funding_mode()
        resolved_model_id = payload.model_id or getattr(service.model_obj, "id", None)
        if resolved_model_id:
            parameters["_llm_model_id"] = str(resolved_model_id)

        request_headers = getattr(request, "headers", {})
        source_session_id = request_headers.get("X-Tabtin-Session-Id", "").strip()
        source_tool_use_id = request_headers.get("X-Tabtin-Tool-Use-Id", "").strip()
        source_agent_run_id = request_headers.get("X-Tabtin-Agent-Run-Id", "").strip()
        task = MediaTask.objects.create(
            task_type="text2image",
            user_id=user_id,
            organization_id=organization_id,
            provider=None,
            model=None,
            prompt=payload.prompt,
            negative_prompt=payload.negative_prompt or "",
            parameters=parameters,
            source_session_id=source_session_id,
            source_tool_use_id=source_tool_use_id,
            source_agent_run_id=source_agent_run_id,
            artifact_delivery_status=(
                "pending" if source_session_id and source_tool_use_id else "not_required"
            ),
        )
        _enqueue_media_execution(task)

        return TaskResponse(
            success=True,
            message=_("media_generation.image_task_submitted"),
            task_id=str(task.id),
            task_type="text2image",
            status=task.status,
            provider_task_id=task.provider_task_id or None,
        )

    except MediaServiceError as e:
        _mark_submission_failed(task, code=e.code, message=str(e))
        logger.error(f"[{request_id}] 图片生成失败: {e.code} - {e}")
        raise HttpError(_media_error_http_status(e), str(e))
    except HttpError:
        raise
    except Exception as e:
        _mark_submission_failed(task, code="SERVICE_ERROR", message=str(e))
        logger.exception(f"[{request_id}] 图片生成异常: {e}")
        raise HttpError(500, get_text("media.generate_failed", detail=str(e)))


# ── 视频生成 ──

@router.post("/generate/video", response=TaskResponse, auth=jwt_auth, tags=["媒体生成"])
@billing_required(
    service_key="media.video",
    scene_key="media_video_generate",
    enforce_organization_permission=True,
)
def generate_video(request, payload: GenerateVideoRequest):
    """提交视频生成任务（与图片同路径：先返回 task_id，再 Celery 调 Provider）。"""
    request_id = str(uuid.uuid4())
    user_id = str(request.auth.id)
    task_type = payload.task_type or "text2video"
    task = None
    if payload.input_image_url and task_type == "text2video":
        task_type = "image2video"

    try:
        organization_id = getattr(request, "_billing_organization_id", "") or payload.organization_id or ""

        service = get_media_service(
            model_id=payload.model_id,
            model_name=payload.model_name,
            task_type=task_type,
        )
        model_name = service.model_obj.model_name if service.model_obj else (payload.model_name or "")
        parameters = {
            "size": payload.size,
            "duration": payload.duration,
            "seed": payload.seed,
            "prompt_extend": payload.prompt_extend,
            "_llm_provider_name": service.provider_name,
            "_llm_model_name": model_name,
            **(payload.extra_params or {}),
        }
        if payload.model_id:
            parameters["_llm_model_id"] = str(payload.model_id)

        task = MediaTask.objects.create(
            task_type=task_type,
            user_id=user_id,
            organization_id=organization_id,
            provider=None,
            model=None,
            prompt=payload.prompt,
            negative_prompt=payload.negative_prompt or "",
            parameters=parameters,
            input_resources={
                "image_url": payload.input_image_url or "",
                "audio_url": payload.input_audio_url or "",
            },
        )
        _enqueue_media_execution(task)

        return TaskResponse(
            success=True,
            message=_("media_generation.video_task_submitted"),
            task_id=str(task.id),
            task_type=task_type,
            status=task.status,
            provider_task_id=task.provider_task_id or None,
        )

    except MediaServiceError as e:
        _mark_submission_failed(task, code=e.code, message=str(e))
        logger.error(f"[{request_id}] 视频生成失败: {e.code} - {e}")
        raise HttpError(_media_error_http_status(e), str(e))
    except HttpError:
        raise
    except Exception as e:
        _mark_submission_failed(task, code="SERVICE_ERROR", message=str(e))
        logger.exception(f"[{request_id}] 视频生成异常: {e}")
        raise HttpError(500, get_text("media.generate_failed", detail=str(e)))


# ── 任务管理 ──

@router.get("/tasks/{task_id}", response=TaskDetailResponse, auth=jwt_auth, tags=["媒体生成"])
def get_task(request, task_id: str):
    """查询单个任务状态和结果"""
    user_id = str(request.auth.id)
    try:
        task = MediaTask.objects.get(id=task_id, user_id=user_id)
    except MediaTask.DoesNotExist:
        raise HttpError(404, _("media_generation.task_not_found"))

    _reconcile_legacy_storage_delivery(task)
    result_urls = _legacy_result_urls(task)
    return TaskDetailResponse(
        success=True,
        task_id=str(task.id),
        task_type=task.task_type,
        status=task.status,
        provider_task_id=task.provider_task_id,
        prompt=task.prompt,
        parameters=task.parameters,
        result_urls=result_urls,
        stored_urls=task.stored_urls,
        storage_status=task.storage_status,
        stored_files=task.stored_files,
        result_metadata=task.result_metadata,
        error_code=task.error_code or None,
        error_message=task.error_message or None,
        created_at=task.created_at.isoformat() if task.created_at else None,
        completed_at=task.completed_at.isoformat() if task.completed_at else None,
    )


@router.get("/tasks", response=TaskListResponse, auth=jwt_auth, tags=["媒体生成"])
def list_tasks(
    request,
    task_type: Optional[str] = None,
    status: Optional[str] = None,
    organization_id: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
):
    """查询用户的任务列表"""
    user_id = str(request.auth.id)
    qs = MediaTask.objects.filter(user_id=user_id)

    if task_type:
        qs = qs.filter(task_type=task_type)
    if status:
        qs = qs.filter(status=status)
    if organization_id:
        qs = qs.filter(organization_id=organization_id)

    total = qs.count()
    tasks = qs[offset:offset + limit]
    for task in tasks:
        _reconcile_legacy_storage_delivery(task)

    return TaskListResponse(
        success=True,
        total=total,
        tasks=[
            TaskDetailResponse(
                success=True,
                task_id=str(t.id),
                task_type=t.task_type,
                status=t.status,
                prompt=t.prompt,
                result_urls=_legacy_result_urls(t),
                stored_urls=t.stored_urls,
                storage_status=t.storage_status,
                stored_files=t.stored_files,
                error_code=t.error_code or None,
                error_message=t.error_message or None,
                created_at=t.created_at.isoformat() if t.created_at else None,
                completed_at=t.completed_at.isoformat() if t.completed_at else None,
            )
            for t in tasks
        ],
    )


@router.post("/tasks/{task_id}/cancel", response=BaseResponse, auth=jwt_auth, tags=["媒体生成"])
def cancel_task(request, task_id: str):
    """取消任务"""
    user_id = str(request.auth.id)
    try:
        task = MediaTask.objects.get(id=task_id, user_id=user_id)
    except MediaTask.DoesNotExist:
        raise HttpError(404, _("media_generation.task_not_found"))

    if task.is_terminal:
        return BaseResponse(success=False, message=_("media_generation.task_already_terminal", status=task.status))

    task.status = 'cancelled'
    task.completed_at = timezone.now()
    task.save(update_fields=['status', 'completed_at', 'updated_at'])

    return BaseResponse(success=True, message=_("media_generation.task_cancelled"))


# ── 模型目录 ──

@router.get("/catalog", response=ModelCatalogResponse, auth=jwt_auth, tags=["媒体生成"])
def model_catalog(request, task_type: Optional[str] = None):
    """获取可用的媒体生成模型列表"""
    scene_key = (
        "media_image_generate"
        if task_type in {"image", "text2image", "image2image", "image_edit"}
        else None
    )
    models = get_available_models(
        task_type=task_type,
        user_id=str(request.auth.id),
        scene_key=scene_key,
    )
    return ModelCatalogResponse(
        success=True,
        models=[ModelInfoResponse(**m) for m in models],
    )

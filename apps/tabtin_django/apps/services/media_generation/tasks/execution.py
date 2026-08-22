"""
媒体生成任务执行（Celery）

将 Provider 提交（含 Seedream 同步生图）移出 HTTP 请求路径，
避免生产网关 ~60s 超时导致客户端拿不到 task_id。
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)

_PARAM_KEYS_RESERVED = frozenset(
    {
        "size",
        "n",
        "seed",
        "prompt_extend",
        "duration",
        "_llm_provider_name",
        "_llm_model_name",
        "_llm_model_id",
    }
)


def complete_synchronous_media_task(task, result) -> None:
    """持久化同步 Provider 的结果，并复用既有计费与 OSS 转存链路。"""
    from ..errors import MediaServiceError
    from ..services import PollResult
    from .polling import _charge_media_task
    from .storage import enqueue_media_storage

    result_urls = result.metadata.get("result_urls", []) if result.metadata else []
    if not isinstance(result_urls, list) or not all(isinstance(url, str) for url in result_urls):
        raise MediaServiceError(
            code="API_ERROR",
            message="同步媒体 Provider 未返回有效的结果 URL 列表",
        )
    task.mark_running(result.provider_task_id)
    poll_result = PollResult(
        status="succeeded",
        result_urls=result_urls,
        metadata=result.metadata,
    )
    _charge_media_task(
        task,
        poll_result,
    )
    task.mark_succeeded(result_urls=result_urls, metadata=result.metadata)

    enqueue_media_storage(task)


def _build_media_request(task) -> Any:
    from ..services import MediaRequest

    params = dict(task.parameters or {})
    extra_params = {
        key: value
        for key, value in params.items()
        if key not in _PARAM_KEYS_RESERVED
    }
    n = params.get("n")
    try:
        n_int = int(n) if n is not None else 1
    except (TypeError, ValueError):
        n_int = 1
    if n_int > 1:
        extra_params["n"] = n_int

    prompt_extend = params.get("prompt_extend")
    if prompt_extend is None:
        prompt_extend = True

    duration = params.get("duration") or 0
    try:
        duration_int = int(duration)
    except (TypeError, ValueError):
        duration_int = 0

    input_resources = task.input_resources or {}
    return MediaRequest(
        task_type=task.task_type,
        prompt=task.prompt,
        model_name=params.get("_llm_model_name") or "",
        negative_prompt=task.negative_prompt or "",
        size=params.get("size") or "",
        duration=duration_int,
        seed=params.get("seed"),
        prompt_extend=bool(prompt_extend),
        input_image_url=input_resources.get("image_url") or "",
        input_audio_url=input_resources.get("audio_url") or "",
        extra_params=extra_params,
    )


@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=15,
    time_limit=300,
    soft_time_limit=280,
)
def execute_media_generation(self, task_id: str):
    """在后台执行 Provider 提交，避免阻塞 /generate/* HTTP 响应。"""
    from ..errors import MediaErrorCode, MediaServiceError
    from ..models import MediaTask
    from ..services import get_media_service
    from .polling import poll_media_task

    try:
        task = MediaTask.objects.get(id=task_id)
    except MediaTask.DoesNotExist:
        logger.warning("[MediaExecute] 任务不存在: %s", task_id)
        return

    if task.is_terminal:
        logger.info("[MediaExecute] 任务已终态，跳过: %s (%s)", task_id, task.status)
        return

    from apps.services.llm.scenes.policy import ScenePolicyResolver

    scene_key = (
        "media_image_generate"
        if task.task_type in {"text2image", "image2image", "image_edit"}
        else "media_video_generate"
    )
    if not ScenePolicyResolver.resolve(scene_key).enabled:
        from apps.services.llm.scenes.exceptions import SceneDisabled

        task.mark_failed(error_code="SCENE_DISABLED", error_message="Scene 已关闭")
        raise SceneDisabled(f"scene_key='{scene_key}' 已关闭", scene_key=scene_key)

    params = task.parameters or {}
    model_id = params.get("_llm_model_id") or None
    model_name = params.get("_llm_model_name") or None

    try:
        service = get_media_service(
            model_id=model_id,
            model_name=model_name,
            task_type=task.task_type,
        )
        media_request = _build_media_request(task)
        if not media_request.model_name and service.model_obj:
            media_request.model_name = service.model_obj.model_name

        result = service.submit_task_with_protection(media_request)
        if result.status == "succeeded":
            complete_synchronous_media_task(task, result)
            logger.info("[MediaExecute] 同步生图完成: task=%s", task_id)
            return

        task.mark_running(result.provider_task_id)
        countdown = 10 if task.task_type == "text2image" else 30
        task.next_poll_at = timezone.now() + timedelta(seconds=countdown)
        task.save(update_fields=["next_poll_at", "updated_at"])
        poll_media_task.apply_async(args=[str(task.id)], countdown=countdown)
        logger.info(
            "[MediaExecute] 异步任务已提交: task=%s provider_task_id=%s",
            task_id,
            result.provider_task_id,
        )
    except MediaServiceError as exc:
        if not task.is_terminal:
            task.mark_failed(error_code=exc.code, error_message=str(exc))
        logger.error("[MediaExecute] Provider 失败: task=%s code=%s err=%s", task_id, exc.code, exc)
        if exc.retryable and self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
    except Exception as exc:
        if not task.is_terminal:
            task.mark_failed(error_code=MediaErrorCode.SERVICE_ERROR, error_message=str(exc)[:500])
        logger.exception("[MediaExecute] 执行异常: task=%s", task_id)
        raise

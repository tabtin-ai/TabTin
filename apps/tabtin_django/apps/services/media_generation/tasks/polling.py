"""
媒体生成任务轮询

核心流程:
1. batch_poll_pending_tasks: Celery Beat 定期调度，扫描待轮询的任务
2. poll_media_task: 对单个任务执行一次轮询
3. 任务完成后触发 store_media_results 转存产物
4. 任务成功后执行计费扣款
"""

import logging
import time
from decimal import Decimal
from datetime import timedelta
from celery import shared_task
from django.db.models import F
from django.utils import timezone

from apps.services.media_metrics import (
    media_gen_calls_total,
    media_gen_duration_seconds,
    media_gen_cost_total,
)

logger = logging.getLogger(__name__)

DEFAULT_POLL_INTERVAL_SECONDS = 15
DEFAULT_MAX_POLL_COUNT = 120  # 15s × 120 = 30 分钟超时
BATCH_SIZE = 50


def _get_poll_config(task) -> tuple[int, int]:
    """从 LLMModel.capabilities_config 读取轮询配置，不存在则用默认值。

    capabilities_config 可配置:
      poll_interval_seconds: 每次轮询间隔（秒）
      max_poll_count: 最大轮询次数
    """
    params = task.parameters or {}
    model_name = params.get("_llm_model_name", "")
    if not model_name:
        return DEFAULT_POLL_INTERVAL_SECONDS, DEFAULT_MAX_POLL_COUNT

    try:
        from apps.services.llm.models import LLMModel
        model_obj = LLMModel.objects.filter(
            model_name=model_name, is_active=True,
        ).only("capabilities_config").first()
        if model_obj:
            caps = model_obj.capabilities_config or {}
            interval = int(caps.get("poll_interval_seconds", DEFAULT_POLL_INTERVAL_SECONDS))
            max_count = int(caps.get("max_poll_count", DEFAULT_MAX_POLL_COUNT))
            return max(1, interval), max(1, max_count)
    except Exception:
        pass

    return DEFAULT_POLL_INTERVAL_SECONDS, DEFAULT_MAX_POLL_COUNT

MEDIA_GENERATION_BEAT_SCHEDULE = {
    "media-generation-poll-pending": {
        "task": "apps.services.media_generation.tasks.polling.batch_poll_pending_tasks",
        "schedule": 15.0,
        "options": {"expires": 12},
    },
    "media-generation-recover-stale-storage": {
        "task": "apps.services.media_generation.tasks.storage.recover_stale_media_storage",
        "schedule": 300.0,
        "options": {"expires": 240},
    },
    "media-generation-recover-artifact-delivery": {
        "task": "apps.services.media_generation.tasks.storage.recover_media_artifact_delivery",
        "schedule": 60.0,
        "options": {"expires": 50},
    },
}


@shared_task(bind=True, max_retries=3, default_retry_delay=30, time_limit=600, soft_time_limit=560)
def poll_media_task(self, task_id: str):
    """对单个媒体生成任务执行一次轮询"""
    from ..models import MediaTask
    from ..services import get_media_service
    from ..errors import MediaErrorCode, MediaServiceError

    try:
        task = MediaTask.objects.select_related('provider', 'model').get(id=task_id)
    except MediaTask.DoesNotExist:
        logger.warning(f"[MediaPoll] 任务不存在: {task_id}")
        return

    if task.is_terminal:
        logger.info(f"[MediaPoll] 任务已终态，跳过: {task_id} ({task.status})")
        return

    if not task.provider_task_id:
        logger.warning(f"[MediaPoll] 任务无 provider_task_id: {task_id}")
        return

    poll_interval, max_poll_count = _get_poll_config(task)

    if task.poll_count >= max_poll_count:
        task.mark_failed(
            error_code=MediaErrorCode.TIMEOUT,
            error_message=f"轮询超时，已轮询 {task.poll_count} 次",
        )
        logger.error(f"[MediaPoll] 轮询超时: {task_id}, count={task.poll_count}")
        return

    try:
        _params = task.parameters or {}
        _model_name = _params.get("_llm_model_name", "")
        service = get_media_service(
            model_name=_model_name or None,
            task_type=task.task_type,
        )
        result = service.poll_task(task.provider_task_id)
    except MediaServiceError as exc:
        if exc.code == MediaErrorCode.MODEL_NOT_FOUND:
            task.mark_failed(
                error_code=MediaErrorCode.MODEL_NOT_FOUND,
                error_message=f"模型已停用或不存在: {exc}",
            )
            logger.error(f"[MediaPoll] 模型不可用，任务终止: {task_id}, error={exc}")
            return
        logger.exception(f"[MediaPoll] 轮询异常: {task_id}, error={exc}")
        MediaTask.objects.filter(id=task_id).update(
            poll_count=F('poll_count') + 1,
            next_poll_at=timezone.now() + timedelta(seconds=poll_interval * 2),
        )
        return
    except Exception as exc:
        logger.exception(f"[MediaPoll] 轮询异常: {task_id}, error={exc}")
        MediaTask.objects.filter(id=task_id).update(
            poll_count=F('poll_count') + 1,
            next_poll_at=timezone.now() + timedelta(seconds=poll_interval * 2),
        )
        return

    MediaTask.objects.filter(id=task_id).update(poll_count=F('poll_count') + 1)
    task.refresh_from_db(fields=['poll_count'])

    _params = task.parameters or {}
    _provider_key = _params.get("_llm_provider_name", "") or getattr(task.provider, "provider_key", "") or ""
    _model_name = _params.get("_llm_model_name", "") or getattr(task.model, "model_name", "") or ""
    _media_type = "video" if task.task_type in ("text2video", "image2video", "video_edit") else "image"

    if result.status == "succeeded":
        media_gen_calls_total.labels(
            provider=_provider_key, model=_model_name,
            media_type=_media_type, status="success",
        ).inc()
        if task.submitted_at:
            _elapsed = (timezone.now() - task.submitted_at).total_seconds()
            media_gen_duration_seconds.labels(provider=_provider_key, media_type=_media_type).observe(_elapsed)

        _charge_media_task(task, result)
        task.mark_succeeded(result_urls=result.result_urls, metadata=result.metadata)
        logger.info(f"[MediaPoll] 任务成功: {task_id}, urls={len(result.result_urls)}")
        from .storage import enqueue_media_storage
        enqueue_media_storage(task)

    elif result.status == "failed":
        task.mark_failed(
            error_code=result.error_code or MediaErrorCode.TASK_FAILED,
            error_message=result.error_message,
        )
        media_gen_calls_total.labels(
            provider=_provider_key, model=_model_name,
            media_type=_media_type, status="failed",
        ).inc()
        logger.error(f"[MediaPoll] 任务失败: {task_id}, error={result.error_message}")

    else:
        MediaTask.objects.filter(id=task_id).update(
            next_poll_at=timezone.now() + timedelta(seconds=poll_interval),
        )
        logger.debug(f"[MediaPoll] 任务进行中: {task_id}, status={result.status}, poll_count={task.poll_count}")


@shared_task(time_limit=600, soft_time_limit=560)
def batch_poll_pending_tasks():
    """批量扫描待轮询的任务，分发给 poll_media_task"""
    from ..models import MediaTask

    now = timezone.now()
    tasks = (
        MediaTask.objects
        .filter(
            status__in=['pending', 'running'],
            next_poll_at__lte=now,
        )
        .exclude(provider_task_id='')
        .values_list('id', flat=True)
        [:BATCH_SIZE]
    )

    task_ids = list(tasks)
    if not task_ids:
        return

    logger.info(f"[MediaPoll] 批量轮询: {len(task_ids)} 个任务")
    for tid in task_ids:
        poll_media_task.delay(str(tid))


def _charge_media_task(task, result) -> None:
    """媒体生成任务成功后执行计费扣款。

    优先从 parameters 中的 _llm_model_name 查找 LLMModel 获取计费信息，
    兼容旧任务的 MediaModel FK。
    """
    if not task.user_id:
        return

    if task.task_type in {"text2image", "image2image", "image_edit"}:
        from apps.services.media_generation.billing import settle_image_task

        settle_image_task(task, result)
        return

    try:
        from apps.users.wallet.services import CreditsService

        params = task.parameters or {}
        llm_model_name = params.get("_llm_model_name", "")
        llm_provider_name = params.get("_llm_provider_name", "")

        billing_type = "request"
        price_per_unit = None
        display_name = llm_model_name or "未知模型"
        model_name_str = llm_model_name
        provider_key = llm_provider_name

        if llm_model_name:
            try:
                # v0.1：LLMModel.is_active 字段已删（0022），下线模型直接 DELETE。
                from apps.services.llm.models import LLMModel
                llm_model = LLMModel.objects.select_related('provider').filter(
                    model_name=llm_model_name, provider__routing_enabled=True,
                ).first()
                if llm_model:
                    billing_type = llm_model.billing_type or "request"
                    display_name = llm_model.display_name
                    provider_key = llm_model.provider.provider_key if llm_model.provider else llm_provider_name
                    if llm_model.price_per_request > 0:
                        price_per_unit = llm_model.price_per_request
            except Exception as e:
                logger.debug("[MediaBilling] 从 LLMModel 加载计费信息失败: %s", e)
        elif task.model:
            billing_type = task.model.billing_type or "request"
            display_name = task.model.display_name
            model_name_str = task.model.model_name
            provider_key = task.model.provider.provider_key if task.model.provider else ""
            if task.model.price_per_unit > 0:
                price_per_unit = task.model.price_per_unit
        else:
            logger.warning("[MediaBilling] 任务无关联模型，跳过计费: %s", task.id)
            return

        if billing_type == "image_count":
            meter_key = "media.image.count"
            urls = result.result_urls or task.result_urls or []
            quantity = Decimal(len(urls))
            if quantity <= 0:
                logger.warning(
                    "[MediaBilling] result_urls 为空，quantity=0，跳过计费（漏费风险）: "
                    "task=%s billing_type=%s",
                    task.id, billing_type,
                )
            unit = "count"
        elif billing_type in ("video_seconds", "resolution_seconds", "time"):
            meter_key = "media.video.seconds"
            meta = result.metadata or {}
            task_metrics = meta.get("task_metrics", {})
            raw_duration = task_metrics.get("duration")
            if raw_duration is None:
                raw_duration = params.get("duration")
            if raw_duration is None:
                raw_duration = 5
                logger.warning(
                    "[MediaBilling] 无法从 task_metrics 或 parameters 获取视频时长，"
                    "降级使用默认值 5 秒，计费可能不准确: task=%s",
                    task.id,
                )
            quantity = Decimal(str(raw_duration))
            unit = "seconds"
        else:
            meter_key = "media.image.count"
            quantity = Decimal("1")
            unit = "request"

        if quantity <= 0:
            return

        charge_result = CreditsService.consume_credits(
            user_id=task.user_id,
            organization_id=task.organization_id or None,
            meter_key=meter_key,
            quantity=quantity,
            unit=unit,
            unit_price=price_per_unit,
            provider_key=provider_key,
            description=f"{display_name} {task.get_task_type_display()}",
            biz_type="media_generation",
            biz_id=str(task.id),
            idempotency_key=f"media:{task.id}",
            metadata={
                "task_type": task.task_type,
                "model_name": model_name_str,
                "billing_type": billing_type,
            },
        )

        if charge_result.get("charged"):
            task.cost_amount = charge_result["amount"]
            task.cost_unit = unit
            task.save(update_fields=["cost_amount", "cost_unit", "updated_at"])
            logger.info(
                "[MediaBilling] 计费成功: task=%s amount=%s %s",
                task.id, charge_result["amount"], unit,
            )
            try:
                _mt = "video" if task.task_type in ("text2video", "image2video", "video_edit") else "image"
                media_gen_cost_total.labels(provider=provider_key, media_type=_mt).inc(float(charge_result["amount"]))
            except Exception:
                pass
    except Exception as exc:
        logger.error("[MediaBilling] 计费失败（不影响主流程）: task=%s err=%s", task.id, exc)
        try:
            from apps.services.billing.services.degradation_tracker import track_billing_degradation
            track_billing_degradation(meter_key="media.billing", organization_id=task.organization_id or "", biz_type="media_generation", error=str(exc))
        except Exception:
            pass

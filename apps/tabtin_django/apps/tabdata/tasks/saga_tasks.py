"""TD-6 / W3.3: Saga Celery 任务 — 4 个 step task + 对账 beat 任务。

checkpoint-saga-statemachine.md §6: 调度方式。
§9: 5 分钟对账任务。

每个 step task 的结构完全同构:
1. 读 saga 行
2. 设 current_step + step_status=running
3. 调 step_xxx() 函数
4. 成功 → 推进到下一个 step → apply_async 链式触发
5. 失败 → retry / manual_intervention
"""
from __future__ import annotations

import logging
from datetime import timedelta
from uuid import UUID

from celery import shared_task
from django.conf import settings
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS

logger = logging.getLogger(__name__)

_STEP_RETRY_DEFAULTS = {
    'pause_outbox': 3,
    'restore_data': 3,
    'mark_collab': 3,
    'cleanup': 5,
}


def _get_max_retries(step: str) -> int:
    limits = getattr(settings, 'TABDATA_SAGA_STEP_RETRY_LIMITS', {})
    return int(limits.get(step, _STEP_RETRY_DEFAULTS.get(step, 3)))


def _compute_retry_delay(retry_count: int) -> float:
    backoff_max = getattr(settings, 'TABDATA_SAGA_STEP_RETRY_BACKOFF_MAX', 30)
    return min(2 ** retry_count, backoff_max)


def _run_saga_step(saga_id_str: str, step_name: str, step_fn, next_task_fn=None):
    """通用 step 执行器:读 saga → 调 step → 处理结果。"""
    from apps.tabdata.models_saga import (
        CheckpointRollbackSaga,
        SAGA_OVERALL_IN_PROGRESS,
        SAGA_OVERALL_MANUAL,
        SAGA_STEP_STATUS_FAILED,
        SAGA_STEP_STATUS_RUNNING,
        get_next_step,
    )

    saga_id = UUID(saga_id_str)
    saga = (
        CheckpointRollbackSaga.objects.using(TABDATA_DB_ALIAS)
        .filter(id=saga_id)
        .first()
    )
    if not saga:
        logger.warning('[saga] saga %s not found, skip %s', saga_id_str, step_name)
        return {'action': 'not_found'}

    if saga.overall_status != SAGA_OVERALL_IN_PROGRESS:
        logger.info('[saga] saga %s status=%s, skip %s', saga_id_str, saga.overall_status, step_name)
        return {'action': 'skipped', 'reason': f'status={saga.overall_status}'}

    saga.current_step = step_name
    saga.step_status = SAGA_STEP_STATUS_RUNNING
    saga.step_started_at = timezone.now()
    saga.save(using=TABDATA_DB_ALIAS, update_fields=[
        'current_step', 'step_status', 'step_started_at', 'updated_at',
    ])

    try:
        result = step_fn(saga)
    except Exception as e:
        logger.error(
            '[saga] %s raised for saga %s: %s', step_name, saga_id_str, e,
            exc_info=True,
        )
        result = {'failed': True, 'error': str(e)[:500]}

    if result.get('retry'):
        delay = result.get('retry_delay', 5)
        payload = result.get('payload')
        if payload:
            saga.refresh_from_db(using=TABDATA_DB_ALIAS)
            saga.step_payload.update(payload)
            saga.save(using=TABDATA_DB_ALIAS, update_fields=['step_payload', 'updated_at'])
        _STEP_TASK_MAP[step_name].apply_async(
            args=[saga_id_str],
            countdown=delay,
        )
        return {'action': 'retry_wait', 'step': step_name, 'delay': delay}

    if result.get('failed'):
        error = result.get('error', 'unknown')
        promote = result.get('promote_to_manual', False)
        payload = result.get('payload')

        saga.refresh_from_db(using=TABDATA_DB_ALIAS)
        saga.retry_count += 1
        max_retries = _get_max_retries(step_name)

        if promote or saga.retry_count >= max_retries:
            saga.overall_status = SAGA_OVERALL_MANUAL
            saga.step_status = SAGA_STEP_STATUS_FAILED
            saga.last_error = error
            if payload:
                saga.step_payload.update(payload)
            saga.save(using=TABDATA_DB_ALIAS)
            logger.warning(
                '[saga] %s manual_intervention saga=%s retries=%d/%d error=%s',
                step_name, saga_id_str, saga.retry_count, max_retries, error,
            )
            return {'action': 'manual_intervention', 'error': error}

        delay = _compute_retry_delay(saga.retry_count)
        saga.step_status = SAGA_STEP_STATUS_FAILED
        saga.last_error = error
        saga.next_retry_at = timezone.now() + timedelta(seconds=delay)
        if payload:
            saga.step_payload.update(payload)
        saga.save(using=TABDATA_DB_ALIAS)
        logger.info(
            '[saga] %s retry saga=%s attempt=%d/%d delay=%.1fs',
            step_name, saga_id_str, saga.retry_count, max_retries, delay,
        )

        _STEP_TASK_MAP[step_name].apply_async(
            args=[saga_id_str],
            countdown=delay,
        )
        return {'action': 'retry', 'attempt': saga.retry_count}

    payload = result.get('payload')
    saga.refresh_from_db(using=TABDATA_DB_ALIAS)
    saga.mark_step_succeeded(payload)

    nxt = get_next_step(step_name)
    if nxt and next_task_fn:
        saga.advance_to_step(nxt)
        saga.save(using=TABDATA_DB_ALIAS)
        next_task_fn.apply_async(args=[saga_id_str])
    elif nxt:
        saga.advance_to_step(nxt)
        saga.save(using=TABDATA_DB_ALIAS)
        if nxt in _STEP_TASK_MAP:
            _STEP_TASK_MAP[nxt].apply_async(args=[saga_id_str])
    else:
        saga.save(using=TABDATA_DB_ALIAS)

    return {'action': 'succeeded', 'step': step_name}


# ── Step Tasks ──────────────────────────────────────


@shared_task(
    name='tabdata.saga_pause_outbox',
    max_retries=0,
    ignore_result=True,
    soft_time_limit=360,
    time_limit=390,
    queue='heavy',
)
def saga_pause_outbox_task(saga_id: str) -> dict:
    from apps.tabdata.services.rollback_saga_service import step_pause_outbox
    return _run_saga_step(
        saga_id, 'pause_outbox', step_pause_outbox,
        next_task_fn=saga_restore_data_task,
    )


@shared_task(
    name='tabdata.saga_restore_data',
    max_retries=0,
    ignore_result=True,
    soft_time_limit=600,
    time_limit=660,
    queue='heavy',
)
def saga_restore_data_task(saga_id: str) -> dict:
    from apps.tabdata.services.rollback_saga_service import step_restore_data
    return _run_saga_step(
        saga_id, 'restore_data', step_restore_data,
        next_task_fn=saga_mark_collab_task,
    )


@shared_task(
    name='tabdata.saga_mark_collab',
    max_retries=0,
    ignore_result=True,
    soft_time_limit=30,
    time_limit=60,
    queue='heavy',
)
def saga_mark_collab_task(saga_id: str) -> dict:
    from apps.tabdata.services.rollback_saga_service import step_mark_collab
    return _run_saga_step(
        saga_id, 'mark_collab', step_mark_collab,
        next_task_fn=saga_cleanup_task,
    )


@shared_task(
    name='tabdata.saga_cleanup',
    max_retries=0,
    ignore_result=True,
    soft_time_limit=30,
    time_limit=60,
    queue='heavy',
)
def saga_cleanup_task(saga_id: str) -> dict:
    from apps.tabdata.services.rollback_saga_service import step_cleanup
    return _run_saga_step(saga_id, 'cleanup', step_cleanup)


_STEP_TASK_MAP = {
    'pause_outbox': saga_pause_outbox_task,
    'restore_data': saga_restore_data_task,
    'mark_collab': saga_mark_collab_task,
    'cleanup': saga_cleanup_task,
}


# ── 5 分钟对账 ──────────────────────────────────────


@shared_task(
    name='tabdata.saga_reconcile',
    max_retries=0,
    ignore_result=True,
    soft_time_limit=120,
    time_limit=150,
)
def saga_reconcile_task() -> dict:
    """每 5 分钟扫描 stuck saga 并尝试自愈(§9)。"""
    if not getattr(settings, 'TABDATA_SAGA_ENABLED', False):
        return {'action': 'disabled'}

    from apps.tabdata.models_saga import (
        CheckpointRollbackSaga,
        SAGA_OVERALL_IN_PROGRESS,
        SAGA_OVERALL_MANUAL,
        SAGA_STEP_MARK_COLLAB,
    )

    interval_minutes = getattr(settings, 'TABDATA_SAGA_RECONCILE_INTERVAL_MINUTES', 5)
    batch_size = getattr(settings, 'TABDATA_SAGA_RECONCILE_BATCH_SIZE', 100)
    deadline = timezone.now() - timedelta(minutes=interval_minutes)

    from django.db import transaction
    with transaction.atomic(using=TABDATA_DB_ALIAS):
        stuck_sagas = list(
            CheckpointRollbackSaga.objects.using(TABDATA_DB_ALIAS)
            .select_for_update(skip_locked=True)
            .filter(
                overall_status=SAGA_OVERALL_IN_PROGRESS,
                current_step=SAGA_STEP_MARK_COLLAB,
                mark_collab_at__isnull=True,
                step_started_at__lt=deadline,
            )
            .order_by('step_started_at')[:batch_size]
        )

    recovered = 0
    escalated = 0
    for saga in stuck_sagas:
        max_retries = _get_max_retries('mark_collab')
        if saga.retry_count >= max_retries:
            saga.overall_status = SAGA_OVERALL_MANUAL
            saga.step_status = SAGA_STEP_STATUS_FAILED
            saga.last_error = 'mark_collab_retry_exhausted_via_reconcile'
            saga.save(using=TABDATA_DB_ALIAS)
            escalated += 1
            logger.warning(
                '[saga_reconcile] escalated saga=%s to manual_intervention',
                saga.id,
            )
            continue

        saga.retry_count += 1
        saga.save(using=TABDATA_DB_ALIAS, update_fields=['retry_count', 'updated_at'])
        saga_mark_collab_task.apply_async(args=[str(saga.id)])
        recovered += 1
        logger.info('[saga_reconcile] re-triggered mark_collab for saga=%s', saga.id)

    return {
        'action': 'reconciled',
        'stuck_found': len(stuck_sagas),
        'recovered': recovered,
        'escalated': escalated,
    }


# ── beat schedule(让 celery.py 发现)──
SAGA_RECONCILE_BEAT_SCHEDULE = {
    'tabdata-saga-reconcile': {
        'task': 'tabdata.saga_reconcile',
        'schedule': 300.0,
        'options': {'expires': 600},
    },
}

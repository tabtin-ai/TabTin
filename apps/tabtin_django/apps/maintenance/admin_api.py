"""
Celery 管理后台 API

说明：
- 读接口：仅 staff 可访问
- 写接口（retry）：仅 superuser 可执行
- 路由挂载到 /api/auth/admin/maintenance/celery/*
"""

from __future__ import annotations

import logging
from datetime import timedelta

from celery import current_app
from django.db.models import Q
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.users.auth.permissions import StaffAuth, SuperuserAuth

from .celery_health import CeleryHealthChecker
from .models import FailedTaskRecord
from .schemas import (
    BatchResolveRequestSchema,
    BatchResolveResponseSchema,
    CeleryOverviewSchema,
    FailedTaskDetailSchema,
    FailedTaskItemSchema,
    FailedTaskListSchema,
    QueueInfoSchema,
    RetryResponseSchema,
    WorkerInfoSchema,
)

router = Router(auth=StaffAuth())
logger = logging.getLogger(__name__)

@router.get(
    '/maintenance/celery/overview',
    response=CeleryOverviewSchema,
    auth=StaffAuth(),
    tags=['后台 Celery 管理'],
)
def celery_overview(request):
    """Celery 综合面板：Worker 状态 + 队列深度 + 失败任务统计"""

    checker = CeleryHealthChecker()
    worker_result = checker.check_workers()
    queue_result = checker.check_queue_health()

    worker_list: list[WorkerInfoSchema] = []
    try:
        active = current_app.control.inspect().active()
        if active:
            for name, tasks in active.items():
                worker_list.append(WorkerInfoSchema(
                    name=name,
                    active_tasks=len(tasks),
                ))
    except Exception as exc:
        logger.warning("获取 worker 活跃任务失败: %s", exc)

    queues: list[QueueInfoSchema] = []
    for qname, pending in queue_result.get('queues', {}).items():
        queues.append(QueueInfoSchema(
            name=qname,
            pending=pending,
            warning=pending > 50,
        ))

    now = timezone.now()
    failed_open = FailedTaskRecord.objects.filter(resolved=False).count()
    failed_total_24h = FailedTaskRecord.objects.filter(
        failed_at__gte=now - timedelta(hours=24),
    ).count()

    issues = worker_result.get('issues', []) + queue_result.get('issues', [])

    return CeleryOverviewSchema(
        workers_healthy=len(worker_result.get('workers', [])),
        workers_total=len(worker_list) or len(worker_result.get('workers', [])),
        worker_list=worker_list,
        queues=queues,
        failed_open=failed_open,
        failed_total_24h=failed_total_24h,
        issues=issues,
    )

@router.get(
    '/maintenance/celery/failed-tasks',
    response=FailedTaskListSchema,
    auth=StaffAuth(),
    tags=['后台 Celery 管理'],
)
def list_failed_tasks(
    request,
    resolved: str = 'all',
    task_name: str = '',
    page: int = 1,
    page_size: int = 20,
):
    """DLQ 失败任务列表（分页 + 筛选）"""

    qs = FailedTaskRecord.objects.all()

    if resolved == 'true':
        qs = qs.filter(resolved=True)
    elif resolved == 'false':
        qs = qs.filter(resolved=False)

    if task_name:
        qs = qs.filter(task_name__icontains=task_name)

    total = qs.count()
    page = max(page, 1)
    page_size = max(1, min(page_size, 100))
    offset = (page - 1) * page_size
    records = qs[offset:offset + page_size]

    items = [
        FailedTaskItemSchema(
            id=r.id,
            task_id=r.task_id,
            task_name=r.task_name,
            exception=r.exception[:500],
            retries=r.retries,
            resolved=r.resolved,
            failed_at=r.failed_at,
            resolved_at=r.resolved_at,
        )
        for r in records
    ]

    return FailedTaskListSchema(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )

# ⚠️ 路由顺序：``GET /maintenance/celery/failed-tasks/{task_record_id}`` 通配符
# 必须在 ``/failed-tasks/batch-resolve`` 字面量之后注册——否则 POST batch-resolve
# 会被 GET 通配符吞掉返回 405。装饰器在文件末尾延后注册（搜 RR-LATE）。
def get_failed_task_detail(request, task_record_id: int):
    """失败任务详情（含 traceback）"""

    record = FailedTaskRecord.objects.filter(id=task_record_id).first()
    if not record:
        raise HttpError(404, '记录不存在')

    return FailedTaskDetailSchema(
        id=record.id,
        task_id=record.task_id,
        task_name=record.task_name,
        args=record.args,
        kwargs=record.kwargs,
        exception=record.exception,
        traceback=record.traceback,
        retries=record.retries,
        resolved=record.resolved,
        failed_at=record.failed_at,
        resolved_at=record.resolved_at,
    )

@router.post(
    '/maintenance/celery/failed-tasks/{task_record_id}/resolve',
    response={200: FailedTaskDetailSchema},
    auth=StaffAuth(),
    tags=['后台 Celery 管理'],
)
def resolve_failed_task(request, task_record_id: int):
    """标记失败任务已解决"""

    record = FailedTaskRecord.objects.filter(id=task_record_id).first()
    if not record:
        raise HttpError(404, '记录不存在')

    record.resolved = True
    record.resolved_at = timezone.now()
    record.save(update_fields=['resolved', 'resolved_at'])

    return record

@router.post(
    '/maintenance/celery/failed-tasks/{task_record_id}/retry',
    response={200: RetryResponseSchema},
    auth=SuperuserAuth(),
    tags=['后台 Celery 管理'],
)
def retry_failed_task(request, task_record_id: int):
    """重新投递失败任务到 Celery 队列（需要超管权限）"""

    record = FailedTaskRecord.objects.filter(id=task_record_id).first()
    if not record:
        raise HttpError(404, '记录不存在')

    result = current_app.send_task(
        record.task_name,
        args=record.args,
        kwargs=record.kwargs,
    )

    record.resolved = True
    record.resolved_at = timezone.now()
    record.save(update_fields=['resolved', 'resolved_at'])

    logger.info(
        "[Admin] 重新投递任务 %s (record_id=%d) -> new_task_id=%s, operator=%s",
        record.task_name, record.id, result.id, request.auth.id,
    )

    return RetryResponseSchema(
        new_task_id=result.id,
        task_name=record.task_name,
    )

@router.post(
    '/maintenance/celery/failed-tasks/batch-resolve',
    response={200: BatchResolveResponseSchema},
    auth=StaffAuth(),
    tags=['后台 Celery 管理'],
)
def batch_resolve_failed_tasks(request, payload: BatchResolveRequestSchema):
    """批量标记已解决"""

    if not payload.ids:
        raise HttpError(400, '请至少选择 1 条记录')
    if len(payload.ids) > 200:
        raise HttpError(400, '单次最多处理 200 条')

    count = FailedTaskRecord.objects.filter(
        id__in=payload.ids,
        resolved=False,
    ).update(resolved=True, resolved_at=timezone.now())

    return BatchResolveResponseSchema(resolved_count=count)


# ── RR-LATE: get_failed_task_detail ───────────────────────────────
router.get(
    '/maintenance/celery/failed-tasks/{task_record_id}',
    response=FailedTaskDetailSchema,
    auth=StaffAuth(),
    tags=['后台 Celery 管理'],
)(get_failed_task_detail)

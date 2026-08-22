"""
Celery 管理后台 API Schema
"""

from datetime import datetime
from typing import List, Optional

from ninja import Schema


# ---------- Overview ----------

class QueueInfoSchema(Schema):
    name: str
    pending: int
    warning: bool = False


class WorkerInfoSchema(Schema):
    name: str
    active_tasks: int


class CeleryOverviewSchema(Schema):
    workers_healthy: int
    workers_total: int
    worker_list: List[WorkerInfoSchema]
    queues: List[QueueInfoSchema]
    failed_open: int
    failed_total_24h: int
    issues: List[str] = []


# ---------- Failed Tasks ----------

class FailedTaskItemSchema(Schema):
    id: int
    task_id: str
    task_name: str
    exception: str
    retries: int
    resolved: bool
    failed_at: datetime
    resolved_at: Optional[datetime] = None


class FailedTaskDetailSchema(Schema):
    id: int
    task_id: str
    task_name: str
    args: list
    kwargs: dict
    exception: str
    traceback: str
    retries: int
    resolved: bool
    failed_at: datetime
    resolved_at: Optional[datetime] = None


class FailedTaskListSchema(Schema):
    items: List[FailedTaskItemSchema]
    total: int
    page: int
    page_size: int


class BatchResolveRequestSchema(Schema):
    ids: List[int]


class BatchResolveResponseSchema(Schema):
    resolved_count: int


class RetryResponseSchema(Schema):
    new_task_id: str
    task_name: str

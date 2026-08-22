"""Celery 任务：飞书多维表导入。"""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(
    name="integrations_feishu.run_import",
    bind=True,
    soft_time_limit=25 * 60,
    time_limit=30 * 60,
)
def run_feishu_import_task(self, job_id: str) -> dict:
    from .import_runner import run_feishu_import
    from .models import FeishuImportJob

    logger.info("[FeishuImportTask] start job_id=%s celery_id=%s", job_id, self.request.id)
    try:
        FeishuImportJob.objects.filter(id=job_id).update(celery_task_id=self.request.id or "")
        run_feishu_import(job_id)
        job = FeishuImportJob.objects.get(id=job_id)
        return {"task_id": str(job.id), "status": job.status}
    except Exception as exc:
        logger.exception("[FeishuImportTask] failed job_id=%s", job_id)
        return {"task_id": job_id, "status": "failed", "error": str(exc)[:500]}

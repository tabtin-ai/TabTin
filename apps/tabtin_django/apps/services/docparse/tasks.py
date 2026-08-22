"""
DocParse Celery 异步任务 (v0.4.1)

- 支持断点续传：重试时从 parsed_pages 处继续而非从零开始
- FileRecord.DoesNotExist 不重试（永久性错误）
- soft_time_limit 提高到 600s 以适应大文件
- 定时清理孤立临时文件
- SoftTimeLimitExceeded 时更新 DB 状态为 FAILED
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
from datetime import timedelta

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from celery.schedules import crontab

from apps.services.docparse.service import _TEMP_DIR_PREFIX

logger = logging.getLogger(__name__)

_TEMP_MAX_AGE_SECONDS = 3600  # 超过 1 小时的临时文件视为孤立
_IMPORT_JOB_SOFT_TIME_LIMIT = int(os.environ.get("DOCPARSE_IMPORT_JOB_SOFT_TIME_LIMIT", "900"))
_IMPORT_JOB_TIME_LIMIT = int(os.environ.get("DOCPARSE_IMPORT_JOB_TIME_LIMIT", "960"))
_PARSE_DOCUMENT_SOFT_TIME_LIMIT = int(os.environ.get("DOCPARSE_PARSE_DOCUMENT_SOFT_TIME_LIMIT", "900"))
_PARSE_DOCUMENT_TIME_LIMIT = int(os.environ.get("DOCPARSE_PARSE_DOCUMENT_TIME_LIMIT", "960"))

DOCPARSE_BEAT_SCHEDULE = {
    "docparse-cleanup-temp-files": {
        "task": "docparse.cleanup_temp_files",
        "schedule": crontab(minute="*/30"),
        "options": {"queue": "default"},
    },
    "docparse-watchdog-import-jobs": {
        "task": "docparse.watchdog_import_jobs",
        "schedule": crontab(minute="*/2"),
        "options": {"queue": "docparse"},
    },
}


@shared_task(
    name="docparse.execute_document_import_job",
    bind=True,
    queue="docparse",
    max_retries=0,
    soft_time_limit=_IMPORT_JOB_SOFT_TIME_LIMIT,
    time_limit=_IMPORT_JOB_TIME_LIMIT,
    acks_late=True,
    reject_on_worker_lost=True,
)
def execute_document_import_job_task(self, job_id: str):
    """Execute a DocumentImportJob inside the docparse worker queue."""
    from apps.services.docparse.service import DocParseService

    task_id = getattr(self.request, "id", "") or ""
    worker_id = getattr(self.request, "hostname", "") or ""
    job = DocParseService.execute_import_job(
        job_id,
        task_id=task_id,
        worker_id=worker_id,
    )
    return {"status": job.status, "job_id": str(job.id)}


@shared_task(
    name="docparse.watchdog_import_jobs",
    queue="docparse",
    ignore_result=True,
    soft_time_limit=60,
    time_limit=90,
)
def watchdog_import_jobs_task(limit: int = 100):
    """Requeue import jobs whose worker lease expired."""
    from apps.services.docparse.service import requeue_stale_import_jobs

    result = requeue_stale_import_jobs(limit=limit)
    if result.get("requeued") or result.get("failed"):
        logger.warning("docparse import watchdog: %s", result)
    return result


@shared_task(
    name="docparse.parse_document",
    bind=True,
    max_retries=3,
    default_retry_delay=30,
    soft_time_limit=_PARSE_DOCUMENT_SOFT_TIME_LIMIT,
    time_limit=_PARSE_DOCUMENT_TIME_LIMIT,
    acks_late=True,
    reject_on_worker_lost=True,
)
def parse_document_task(
    self,
    file_record_id: str,
    *,
    vision_model: str = "",
    selected_model_id: str | None = None,
):
    """异步解析文档任务（支持断点续传）。"""
    from apps.services.docparse.service import DocParseService
    from apps.services.oss.models import FileRecord

    try:
        execute_kwargs = {
            "force": False,
            "vision_model": vision_model,
        }
        if selected_model_id is not None:
            execute_kwargs["selected_model_id"] = selected_model_id
        parsed = DocParseService.execute(file_record_id, **execute_kwargs)
        logger.info(
            "异步解析完成: file_record=%s, status=%s, pages=%d, method=%s",
            file_record_id, parsed.status,
            parsed.total_pages, parsed.parse_method,
        )
        return {
            "status": parsed.status,
            "file_record_id": file_record_id,
            "total_pages": parsed.total_pages,
            "parse_method": parsed.parse_method,
        }
    except FileRecord.DoesNotExist:
        logger.error("异步解析终止: FileRecord 不存在 %s", file_record_id)
        return {"status": "failed", "file_record_id": file_record_id, "error": "file_not_found"}
    except SoftTimeLimitExceeded:
        logger.error("异步解析超时: file_record=%s (soft_time_limit)", file_record_id)
        from apps.services.docparse.models import ParsedDocument
        from django.utils import timezone as _tz
        try:
            # W1：补 failure_code=PARSE_TIMEOUT（与 SSoT 对齐）
            ParsedDocument.objects.filter(
                file_record_id=file_record_id,
                status=ParsedDocument.Status.PARSING,
            ).update(
                status=ParsedDocument.Status.FAILED,
                error_message="解析超时 (soft_time_limit)",
                failure_code=ParsedDocument.FailureCode.PARSE_TIMEOUT,
                updated_at=_tz.now(),
            )
        except Exception as db_exc:
            logger.warning("超时后更新 ParsedDocument 状态失败: %s", db_exc)
        return {"status": "failed", "file_record_id": file_record_id, "error": "parse_timeout"}
    except Exception as exc:
        logger.error(
            "异步解析失败 (attempt %d/%d): file_record=%s, error=%s",
            self.request.retries + 1, self.max_retries + 1,
            file_record_id, exc,
        )
        raise self.retry(exc=exc)


@shared_task(
    bind=True,
    name="docparse.trigger_rag_index",
    ignore_result=True,
    max_retries=2,
    default_retry_delay=15,
    time_limit=30,
    soft_time_limit=25,
)
def trigger_rag_index_task(self, file_record_id: str) -> None:
    """桥接任务：docparse 解析完成后触发 RAG 向量索引。

    独立任务而非直接在 _emit_completed 中 import rag，
    保持 docparse 与 rag 模块的松耦合。
    """
    from django.conf import settings

    if not getattr(settings, "RAG_ENABLED", True):
        logger.debug("RAG 已禁用，跳过索引: %s", file_record_id)
        return

    try:
        from apps.rag.tasks import index_parsed_document_chunks_task
        index_parsed_document_chunks_task.delay(file_record_id)
        logger.info(
            "已派发 RAG 索引任务: file_record=%s", file_record_id,
        )
    except Exception as exc:
        logger.warning(
            "派发 RAG 索引任务失败 (file_record=%s): %s",
            file_record_id, exc,
        )
        raise self.retry(exc=exc)


@shared_task(name="docparse.cleanup_temp_files", ignore_result=True, time_limit=60, soft_time_limit=50)
def cleanup_temp_files():
    """清理超时的 docparse 临时文件，防止磁盘泄漏。"""
    tmp_dir = tempfile.gettempdir()
    now = time.time()
    cleaned = 0

    try:
        for fname in os.listdir(tmp_dir):
            if not fname.startswith(_TEMP_DIR_PREFIX):
                continue
            fpath = os.path.join(tmp_dir, fname)
            if not os.path.isfile(fpath):
                continue
            try:
                age = now - os.path.getmtime(fpath)
                if age > _TEMP_MAX_AGE_SECONDS:
                    os.unlink(fpath)
                    cleaned += 1
            except OSError:
                pass
    except Exception as exc:
        logger.warning("临时文件清理异常: %s", exc)

    if cleaned:
        logger.info("清理 docparse 临时文件: %d 个", cleaned)
    return {"cleaned": cleaned}

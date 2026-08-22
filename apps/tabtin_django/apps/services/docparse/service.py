"""
DocParseService — 统一文档解析入口 (v0.5)

v0.5 改进：
- 解析器自注册机制：新增解析器零改动核心代码
- Excel (.xlsx) 解析器支持
- MIME 检测增强：ZIP 容器内部结构区分 docx/xlsx/pptx
- Agent 工具健壮性：PARSING/FAILED 状态感知
- WebSocket 事件推送：解析进度 + 完成通知

v0.4 改进：
- 数据库行锁、事务保护、临时文件管理
- 分页流式解析、断点续传、VLM 信号量限流
"""

from __future__ import annotations

import logging
import mimetypes
import os
import base64
import json
import tempfile
import time
import uuid
import hashlib
import html
import re
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path
from typing import Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.services.docparse.models import (
    DocumentChunk,
    DocumentImportJob,
    DocumentPage,
    ParsedDocument,
)
from apps.services.docparse.model_selection import (
    normalize_selected_model_id,
    resolve_model_selection_snapshot,
)
from apps.services.docparse.observability import job_log_extra
from apps.services.docparse.parsers.base import ChunkResult, PageResult, ParseResult
from apps.services.oss.models import FileRecord

import apps.services.docparse.parsers  # noqa: F401 — 触发解析器自注册

logger = logging.getLogger(__name__)

VISION_MODEL_DEFAULT = "qwen/qwen3-vl-plus"

_PARSING_TIMEOUT_SECONDS = 600  # PARSING 超时视为死锁
_VLM_MAX_CONCURRENT = 3  # 全局最大并发 VLM 调用数
_TEMP_DIR_PREFIX = "docparse_"
_VLM_REDIS_KEY = "docparse:vlm_concurrent"
_VLM_REDIS_TTL = 300  # 信号量自动过期，防止泄漏
MAX_FILE_SIZE = int(os.environ.get("DOCPARSE_MAX_FILE_SIZE", 100 * 1024 * 1024))  # 100 MB
_ZIP_BOMB_RATIO = 100  # 压缩比超过此值视为 zip bomb
_ZIP_MAX_UNCOMPRESSED = 500 * 1024 * 1024  # 解压后总大小上限 500 MB
_PDF_MAX_PAGES = int(os.environ.get("DOCPARSE_PDF_MAX_PAGES", "2000"))
_IMPORT_JOB_LEASE_SECONDS = int(os.environ.get("DOCPARSE_IMPORT_JOB_LEASE_SECONDS", "900"))
_IMPORT_JOB_MAX_RETRIES = int(os.environ.get("DOCPARSE_IMPORT_JOB_MAX_RETRIES", "3"))
_IMPORT_RESULT_INLINE_BYTES = int(os.environ.get("DOCPARSE_IMPORT_RESULT_INLINE_BYTES", str(512 * 1024)))
_IMPORT_JOB_SHARED_PARSE_WAIT_CODE = "shared_parse_in_progress"
_PDF_TEXT_IMAGE_TAG_RE = re.compile(r"<img\b(?P<attrs>[^>]*)>", re.IGNORECASE | re.DOTALL)
_PDF_TEXT_ATTR_RE = re.compile(
    r"(?P<name>[a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?P<quote>['\"])(?P<value>.*?)(?P=quote)",
    re.DOTALL,
)
_PDF_TEXT_CODE_LANG_RE = re.compile(r"^\[([A-Za-z0-9_+-]+)\](?:\s*\n|\s+)(.+)$", re.DOTALL)
_PDF_TEXT_IMAGE_MD_RE = re.compile(r"^!\[(?P<alt>.*?)\]\((?P<src>\S+?)(?:\s+\".*\")?\)$")
_PDF_TEXT_IMAGE_DIMENSION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$", re.IGNORECASE)
_PDF_TEXT_DATA_IMAGE_RE = re.compile(
    r"^data:(image/(?:png|jpeg|jpg|gif|webp));base64,(?P<payload>.+)$",
    re.IGNORECASE | re.DOTALL,
)
_MAX_PDF_TEXT_IMAGE_DIMENSION = 10000
_MAX_PDF_TEXT_EMBEDDED_IMAGE_BYTES = 5 * 1024 * 1024
_IMPORT_IMAGE_MIME_TO_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/webp": "webp",
}

_MAGIC_BYTES: list[tuple[bytes, str]] = [
    (b"%PDF", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"PK\x03\x04", "__zip__"),  # ZIP 容器需进一步区分子类型
    (b"\xd0\xcf\x11\xe0", "application/msword"),
]


# ======================================================================
# 临时文件上下文管理器
# ======================================================================

@contextmanager
def _temp_file(suffix: str = ".bin"):
    """确保临时文件在任何退出路径下都被清理。"""
    tmp = tempfile.NamedTemporaryFile(
        delete=False, suffix=suffix, prefix=_TEMP_DIR_PREFIX,
    )
    tmp_path = tmp.name
    tmp.close()
    try:
        yield tmp_path
    finally:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            pass


class _RedisVLMSemaphore:
    """基于 Redis Lua 脚本的分布式 VLM 并发控制信号量。

    使用原子 Lua 脚本保证 incr + expire + 阈值判断在同一 Redis 命令中完成，
    避免非原子操作导致的 TTL 丢失（信号量永久泄漏）。
    """

    _LUA_ACQUIRE = """\
local current = redis.call('incr', KEYS[1])
if current == 1 then
    redis.call('expire', KEYS[1], tonumber(ARGV[1]))
end
if current <= tonumber(ARGV[2]) then
    return 1
end
redis.call('decr', KEYS[1])
return 0
"""

    _LUA_RELEASE = """\
local val = redis.call('decr', KEYS[1])
if val < 0 then
    redis.call('set', KEYS[1], 0, 'EX', tonumber(ARGV[1]))
end
return val
"""

    def __init__(self, max_concurrent: int = _VLM_MAX_CONCURRENT):
        self._max = max_concurrent
        self._acquire_script = None
        self._release_script = None

    def _get_redis(self):
        from django.core.cache import cache
        client = getattr(cache, 'client', None)
        if client:
            conn = getattr(client, 'get_client', None)
            if conn:
                return conn()
        return None

    def _ensure_scripts(self, redis):
        if self._acquire_script is None:
            self._acquire_script = redis.register_script(self._LUA_ACQUIRE)
        if self._release_script is None:
            self._release_script = redis.register_script(self._LUA_RELEASE)

    def acquire(self, timeout: int = 120) -> bool:
        redis = self._get_redis()
        if redis is None:
            logger.warning("Redis 不可用，VLM 信号量降级放行")
            return True
        import time as _time
        try:
            self._ensure_scripts(redis)
        except Exception as exc:
            logger.warning("Redis Lua 脚本注册失败，降级放行: %s", exc)
            return True
        deadline = _time.monotonic() + timeout
        while _time.monotonic() < deadline:
            try:
                result = self._acquire_script(
                    keys=[_VLM_REDIS_KEY],
                    args=[_VLM_REDIS_TTL, self._max],
                )
                if result == 1:
                    return True
            except Exception as exc:
                logger.warning("VLM 信号量 acquire 异常，降级放行: %s", exc)
                return True
            _time.sleep(1.0)
        return False

    def release(self):
        try:
            redis = self._get_redis()
            if redis is None:
                return
            self._ensure_scripts(redis)
            self._release_script(
                keys=[_VLM_REDIS_KEY],
                args=[_VLM_REDIS_TTL],
            )
        except Exception as exc:
            logger.warning("VLM Redis 信号量释放异常: %s", exc)


_vlm_semaphore = _RedisVLMSemaphore(_VLM_MAX_CONCURRENT)


def get_vlm_semaphore() -> _RedisVLMSemaphore:
    """供 VisionParser 获取全局 VLM 信号量（Redis 分布式）。"""
    return _vlm_semaphore


# ======================================================================
# DocParseService
# ======================================================================

class DocParseService:
    """通用文档解析服务"""

    @staticmethod
    def parse(
        file_record_id: str,
        *,
        force: bool = False,
        vision_model: str = "",
        import_job_id: str = "",
        import_job_task_id: str = "",
        selected_model_id: uuid.UUID | str | None = None,
    ) -> ParsedDocument:
        """兼容旧内部调用；普通 HTTP 入口必须使用 enqueue/Job API。"""
        execute_kwargs = {
            "force": force,
            "vision_model": vision_model,
            "import_job_id": import_job_id,
            "import_job_task_id": import_job_task_id,
        }
        if selected_model_id is not None:
            execute_kwargs["selected_model_id"] = selected_model_id
        return DocParseService.execute(file_record_id, **execute_kwargs)

    @staticmethod
    def execute(
        file_record_id: str,
        *,
        force: bool = False,
        vision_model: str = "",
        import_job_id: str = "",
        import_job_task_id: str = "",
        selected_model_id: uuid.UUID | str | None = None,
    ) -> ParsedDocument:
        """
        Worker/management command 专用解析执行入口。

        并发安全机制：
        1. select_for_update 数据库行锁 — 同一文件只有一个 Worker 能进入解析
        2. 超时死锁检测 — PARSING 超过阈值的自动重置
        3. 分页写入 + 断点续传 — 重试时跳过已完成页
        """
        normalized_selected_model_id = normalize_selected_model_id(selected_model_id)

        try:
            file_record = FileRecord.objects.get(pk=file_record_id)
        except FileRecord.DoesNotExist:
            logger.warning("FileRecord 不存在: %s", file_record_id)
            parsed_doc, _ = ParsedDocument.objects.update_or_create(
                file_record_id=file_record_id,
                defaults={
                    "status": ParsedDocument.Status.FAILED,
                    "error_message": f"文件记录不存在: {file_record_id}",
                    "failure_code": ParsedDocument.FailureCode.FILE_NOT_FOUND,
                },
            )
            return parsed_doc

        # TDOC-7: 校验文件状态 —— 已删除/失败/上传中的文件不应尝试解析
        if file_record.status != "completed":
            logger.warning(
                "FileRecord 状态不可解析: %s (status=%s)",
                file_record_id, file_record.status,
            )
            parsed_doc, _ = ParsedDocument.objects.update_or_create(
                file_record=file_record,
                defaults={
                    "status": ParsedDocument.Status.FAILED,
                    "error_message": f"文件尚未就绪或已被删除 (status={file_record.status})",
                    "failure_code": ParsedDocument.FailureCode.INVALID_PARAMETER,
                },
            )
            return parsed_doc

        file_size = getattr(file_record, "file_size", None) or 0
        if file_size == 0:
            parsed_doc, _ = ParsedDocument.objects.update_or_create(
                file_record=file_record,
                defaults={
                    "status": ParsedDocument.Status.READY,
                    "total_pages": 0,
                    "error_message": "",
                    "failure_code": "",
                    "summary_text": "[空文件]",
                    "parsed_at": timezone.now(),
                },
            )
            return parsed_doc

        if file_size > MAX_FILE_SIZE:
            logger.warning(
                "文件超过大小限制: %s (%.1fMB > %.1fMB)",
                file_record.file_name,
                file_size / 1024 / 1024,
                MAX_FILE_SIZE / 1024 / 1024,
            )
            parsed_doc, _ = ParsedDocument.objects.update_or_create(
                file_record=file_record,
                defaults={
                    "status": ParsedDocument.Status.FAILED,
                    "error_message": (
                        f"文件过大 ({file_size / 1024 / 1024:.1f}MB)，"
                        f"超过限制 ({MAX_FILE_SIZE / 1024 / 1024:.0f}MB)"
                    ),
                    "failure_code": ParsedDocument.FailureCode.FILE_TOO_LARGE,
                },
            )
            return parsed_doc

        # --- 行锁：原子地检查状态 + 抢占 ---
        acquired = _try_acquire_parse_lock(file_record, force=force)
        if acquired is None:
            existing = ParsedDocument.objects.filter(
                file_record=file_record,
            ).first()
            if existing:
                return existing
            return _create_failed_doc(file_record, "并发锁获取失败")

        parsed_doc, should_parse = acquired
        if not should_parse:
            return parsed_doc

        # --- 实际解析 ---
        t0 = time.monotonic()
        try:
            DocParseService._do_parse_streaming(
                parsed_doc, file_record,
                vision_model=vision_model,
                import_job_id=import_job_id,
                import_job_task_id=import_job_task_id,
                selected_model_id=normalized_selected_model_id,
            )
            elapsed = time.monotonic() - t0
            logger.info(
                "文档解析完成: %s (%d 页, %.1fs)",
                file_record.file_name, parsed_doc.total_pages, elapsed,
            )
            return parsed_doc
        except Exception as exc:
            elapsed = time.monotonic() - t0
            parsed_doc.status = ParsedDocument.Status.FAILED
            parsed_doc.error_message = str(exc)[:2000]
            # W1：异常分类——根据 message 关键词推断 failure_code，与
            # @tabtin/file-pipeline-errors SSoT 字面值对齐。无法识别时兜底 UNKNOWN_ERROR。
            parsed_doc.failure_code = _classify_exception_to_failure_code(exc)
            parsed_doc.save(
                update_fields=["status", "error_message", "failure_code", "updated_at"],
            )
            _emit_failed(parsed_doc, str(exc))
            logger.error(
                "文档解析失败 (%s, %.1fs): %s",
                file_record.file_name, elapsed, exc, exc_info=True,
            )
            raise

    @staticmethod
    def enqueue(
        file_record_id: str,
        *,
        vision_model: str = "",
        selected_model_id: uuid.UUID | str | None = None,
    ) -> str | None:
        parse_kwargs = {"vision_model": vision_model}
        if selected_model_id is not None:
            parse_kwargs["selected_model_id"] = selected_model_id
        return DocParseService.parse_async(file_record_id, **parse_kwargs)

    @staticmethod
    def execute_import_job(job_id: str, *, task_id: str = "", worker_id: str = "") -> DocumentImportJob:
        job = _claim_import_job(job_id, task_id=task_id, worker_id=worker_id)
        if job is None:
            return DocumentImportJob.objects.select_related(
                "file_record", "parsed_document",
            ).get(id=job_id)
        if job.status not in DocumentImportJob.ACTIVE_STATUSES:
            return job

        try:
            request_payload = job.request_payload or {}
            if not request_payload and isinstance(job.result_payload, dict):
                request_payload = job.result_payload.get("request") or {}
            model_selection = resolve_model_selection_snapshot(request_payload)
            execute_kwargs = {
                "import_job_id": str(job.id),
                "import_job_task_id": task_id,
            }
            if model_selection.selected_model_id is not None:
                execute_kwargs["selected_model_id"] = model_selection.selected_model_id
            parsed = DocParseService.execute(str(job.file_record_id), **execute_kwargs)
            if parsed.status == ParsedDocument.Status.PARSING:
                return _defer_import_job_for_shared_parse(job.id, parsed, task_id=task_id)
        except Exception as exc:
            _fail_import_job(
                job.id,
                task_id=task_id,
                error_code="parse_failed",
                error_message=str(exc)[:2000],
            )
            raise

        try:
            return _finish_import_job(job.id, parsed, task_id=task_id)
        except Exception as exc:
            _fail_import_job(
                job.id,
                task_id=task_id,
                stage=DocumentImportJob.Stage.BUILDING_DRAFT,
                error_code="draft_build_failed",
                error_message=str(exc)[:2000],
            )
            raise

    @staticmethod
    def parse_async(
        file_record_id: str,
        *,
        vision_model: str = "",
        selected_model_id: uuid.UUID | str | None = None,
    ) -> str | None:
        """异步触发文档解析。若文档已就绪或正在解析中，跳过派发返回 None。

        使用 cache.add 原子操作作为唯一 dedup 门控，避免
        "先读状态再写缓存"的竞态窗口。
        """
        normalized_selected_model_id = normalize_selected_model_id(selected_model_id)

        try:
            from django.core.cache import cache
            dedup_key = f"docparse:async:{file_record_id}"
            if not cache.add(dedup_key, "1", timeout=300):
                logger.debug("parse_async 去重命中，跳过投递: %s", file_record_id)
                return None
        except Exception:
            pass

        existing = ParsedDocument.objects.filter(
            file_record_id=file_record_id,
        ).values_list("status", flat=True).first()

        if existing in (ParsedDocument.Status.READY, ParsedDocument.Status.PARSING):
            _clear_async_dedup(file_record_id)
            return None

        from apps.services.docparse.tasks import parse_document_task
        task_kwargs = {"vision_model": vision_model}
        if normalized_selected_model_id is not None:
            task_kwargs["selected_model_id"] = normalized_selected_model_id
        task = parse_document_task.delay(file_record_id, **task_kwargs)
        return task.id

    @staticmethod
    def get_parsed(file_record_id: str) -> ParsedDocument | None:
        return ParsedDocument.objects.filter(
            file_record_id=file_record_id,
            status=ParsedDocument.Status.READY,
        ).first()

    @staticmethod
    def get_chunks(file_record_id: str, *, page: int | None = None) -> list[DocumentChunk]:
        parsed = DocParseService.get_parsed(file_record_id)
        if not parsed:
            return []
        qs = DocumentChunk.objects.select_related("page").filter(page__document=parsed)
        if page is not None:
            qs = qs.filter(page__page_number=page)
        return list(qs.order_by("page__page_number", "sequence"))

    @staticmethod
    def get_summary(file_record_id: str, *, max_tokens: int = 2000) -> str:
        parsed = DocParseService.get_parsed(file_record_id)
        if not parsed:
            try:
                DocParseService.parse_async(file_record_id)
            except Exception as exc:
                logger.warning("get_summary 触发异步解析失败: %s", exc)
            return ""

        if parsed.status != ParsedDocument.Status.READY:
            return ""

        if parsed.summary_text:
            return parsed.summary_text

        summary = _build_smart_summary(parsed, max_tokens)
        parsed.summary_text = summary
        parsed.save(update_fields=["summary_text", "updated_at"])
        return summary

    @staticmethod
    def search_chunks(file_record_id: str, query: str) -> list[DocumentChunk]:
        parsed = DocParseService.get_parsed(file_record_id)
        if not parsed:
            return []
        return list(
            DocumentChunk.objects.select_related("page").filter(
                page__document=parsed,
                content__icontains=query,
            ).order_by("page__page_number", "sequence")[:50]
        )

    # ------------------------------------------------------------------
    # 内部：流式分页解析（核心改造）
    # ------------------------------------------------------------------

    @staticmethod
    def _do_parse_streaming(
        parsed_doc: ParsedDocument,
        file_record: FileRecord,
        *,
        vision_model: str = "",
        import_job_id: str = "",
        import_job_task_id: str = "",
        selected_model_id: str | None = None,
    ) -> None:
        """
        流式解析：下载文件 → 逐页解析 → 逐页写入 DB。
        支持断点续传：从 parsed_doc.parsed_pages 处继续。
        PDF 走专门的逐页流式路径，其他格式走通用批量路径。
        """
        from apps.services.docparse.parsers.registry import get_parser_for_mime

        suffix = Path(file_record.file_name).suffix or ".bin"

        with _temp_file(suffix=suffix) as local_path:
            _download_file(file_record, local_path)

            mime = _detect_mime(local_path, file_record.mime_type)
            parser_cls = get_parser_for_mime(mime)
            if not parser_cls:
                from apps.services.docparse.parsers.registry import get_supported_mimes
                raise ValueError(
                    f"不支持的文件类型: {mime} ({file_record.file_name})。"
                    f"已注册: {get_supported_mimes()}"
                )

            already_done = parsed_doc.parsed_pages or 0
            effective_vision_model = vision_model or VISION_MODEL_DEFAULT

            if mime == "application/pdf":
                # selected_model_id 已冻结在父 Worker 的 Job 快照中，但当前
                # streaming PDF 尚无父进程 Vision/OCR 阶段。子进程必须继续
                # 只做 native extraction，不能接收 UUID、凭证、计费或 LLM。
                _stream_parse_pdf(
                    parsed_doc, local_path, effective_vision_model, already_done,
                    import_job_id=import_job_id,
                    import_job_task_id=import_job_task_id,
                )
            else:
                _stream_parse_generic(
                    parsed_doc, local_path, parser_cls,
                    already_done, vision_model=vision_model,
                    import_job_id=import_job_id,
                    import_job_task_id=import_job_task_id,
                    selected_model_id=selected_model_id,
                )

    @staticmethod
    def _download_to_temp(file_record: FileRecord) -> str:
        """兼容旧调用方。新代码应使用 _temp_file + _download_file。"""
        suffix = Path(file_record.file_name).suffix or ".bin"
        tmp = tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, prefix=_TEMP_DIR_PREFIX,
        )
        tmp_path = tmp.name
        tmp.close()
        _download_file(file_record, tmp_path)
        return tmp_path

    @staticmethod
    def _persist_result(
        parsed_doc: ParsedDocument,
        result: ParseResult,
        *,
        vision_model: str = "",
    ) -> None:
        """兼容旧调用方。新代码应使用流式分页写入。"""
        with transaction.atomic():
            parsed_doc.pages.all().delete()
            for page_result in result.pages:
                _persist_one_page(parsed_doc, page_result)
            _finalize_document(parsed_doc, result, vision_model)


# ======================================================================
# DocumentImportJob lease / heartbeat / watchdog
# ======================================================================

def _claim_import_job(job_id: str, *, task_id: str = "", worker_id: str = "") -> DocumentImportJob | None:
    now = timezone.now()
    lease_expires_at = now + timedelta(seconds=_IMPORT_JOB_LEASE_SECONDS)
    with transaction.atomic():
        job = (
            DocumentImportJob.objects
            .select_for_update()
            .select_related("file_record")
            .get(id=job_id)
        )
        if job.status == DocumentImportJob.Status.CANCELLED:
            return job
        if job.status not in DocumentImportJob.ACTIVE_STATUSES:
            return job
        if (
            job.status == DocumentImportJob.Status.RUNNING
            and job.lease_expires_at
            and job.lease_expires_at > now
            and job.celery_task_id
            and task_id
        ):
            logger.info(
                "DocumentImportJob duplicate delivery skipped: job_id=%s task_id=%s active_task=%s",
                job.id, task_id, job.celery_task_id,
            )
            return None

        job.status = DocumentImportJob.Status.RUNNING
        job.stage = DocumentImportJob.Stage.EXTRACTING
        job.celery_task_id = task_id or job.celery_task_id
        job.worker_id = worker_id or job.worker_id
        job.heartbeat_at = now
        job.lease_expires_at = lease_expires_at
        job.started_at = job.started_at or now
        job.completed_at = None
        job.error_code = ""
        job.error_message = ""
        job.save(update_fields=[
            "status", "stage", "celery_task_id", "worker_id", "heartbeat_at",
            "lease_expires_at", "started_at", "completed_at",
            "error_code", "error_message", "updated_at",
        ])
        logger.info("docparse import job claimed", extra=job_log_extra(job=job))
        return job


def _heartbeat_import_job(
    job_id: str,
    *,
    task_id: str = "",
    stage: str | None = None,
    total_pages: int | None = None,
    processed_pages: int | None = None,
    failed_pages: int | None = None,
) -> bool:
    if not job_id:
        return True
    now = timezone.now()
    update: dict[str, object] = {
        "heartbeat_at": now,
        "lease_expires_at": now + timedelta(seconds=_IMPORT_JOB_LEASE_SECONDS),
        "updated_at": now,
    }
    if stage:
        update["stage"] = stage
    if total_pages is not None:
        update["total_pages"] = total_pages
    if processed_pages is not None:
        update["processed_pages"] = processed_pages
    if failed_pages is not None:
        update["failed_pages"] = failed_pages

    filters = {
        "id": job_id,
        "status__in": DocumentImportJob.ACTIVE_STATUSES,
    }
    if task_id:
        filters["celery_task_id"] = task_id
    updated = DocumentImportJob.objects.filter(**filters).update(**update)
    return updated == 1


def _fail_import_job(
    job_id: str,
    *,
    task_id: str = "",
    stage: str = DocumentImportJob.Stage.EXTRACTING,
    error_code: str,
    error_message: str,
) -> DocumentImportJob:
    now = timezone.now()
    with transaction.atomic():
        job = DocumentImportJob.objects.select_for_update().get(id=job_id)
        if job.status == DocumentImportJob.Status.CANCELLED:
            should_cleanup_assets = True
        elif task_id and job.celery_task_id != task_id:
            return job
        else:
            job.status = DocumentImportJob.Status.FAILED
            job.stage = stage
            job.error_code = error_code
            job.error_message = error_message[:2000]
            job.completed_at = now
            job.lease_expires_at = None
            job.save(update_fields=[
                "status", "stage", "error_code", "error_message",
                "completed_at", "lease_expires_at", "updated_at",
            ])
            should_cleanup_assets = True
    if should_cleanup_assets:
        _deactivate_import_job_asset_usages(job_id)
    return job


def _defer_import_job_for_shared_parse(
    job_id: uuid.UUID | str,
    parsed: ParsedDocument,
    *,
    task_id: str = "",
) -> DocumentImportJob:
    """Keep the import job active when another worker owns the shared parse."""
    now = timezone.now()
    retry_at = now + timedelta(seconds=min(30, _IMPORT_JOB_LEASE_SECONDS))
    with transaction.atomic():
        job = DocumentImportJob.objects.select_for_update().get(id=job_id)
        if job.status == DocumentImportJob.Status.CANCELLED:
            return job
        if task_id and job.celery_task_id != task_id:
            return job
        job.status = DocumentImportJob.Status.RETRYING
        job.stage = DocumentImportJob.Stage.EXTRACTING
        job.parsed_document = parsed
        job.total_pages = parsed.total_pages
        job.processed_pages = parsed.parsed_pages
        job.heartbeat_at = now
        job.lease_expires_at = retry_at
        job.error_code = _IMPORT_JOB_SHARED_PARSE_WAIT_CODE
        job.error_message = "源文件正在由另一个导入任务解析，稍后继续生成草稿"
        job.save(update_fields=[
            "status", "stage", "parsed_document", "total_pages", "processed_pages",
            "heartbeat_at", "lease_expires_at", "error_code", "error_message", "updated_at",
        ])
        return job


def _finish_import_job(
    job_id: uuid.UUID | str,
    parsed: ParsedDocument,
    *,
    task_id: str = "",
) -> DocumentImportJob:
    failed_pages = _count_failed_pages(parsed)
    job = _mark_import_job_draft_building(
        job_id,
        parsed,
        task_id=task_id,
        failed_pages=failed_pages,
    )
    if job.status == DocumentImportJob.Status.CANCELLED:
        return job
    if task_id and job.celery_task_id != task_id:
        return job

    result_payload = job.result_payload or {}
    if not isinstance(result_payload, dict):
        result_payload = {}
    result_payload.pop("request", None)
    result_payload["parsed_document"] = {
        "id": str(parsed.id),
        "status": parsed.status,
        "total_pages": parsed.total_pages,
        "processed_pages": parsed.parsed_pages,
        "failed_pages": failed_pages,
    }
    draft_payload = _build_tabdoc_import_draft(parsed, import_job=job)
    result_payload.update(draft_payload)
    result_payload["draft_status"] = "ready"
    result_payload["import_job_id"] = str(job.id)

    result_storage_key = ""
    result_storage_persisted = False
    encoded_payload = json.dumps(result_payload, ensure_ascii=False, default=str).encode("utf-8")
    try:
        if len(encoded_payload) > _IMPORT_RESULT_INLINE_BYTES:
            from apps.services.oss.services.factory import get_oss_service

            result_storage_key = _build_import_result_storage_key(
                job.id,
                task_id=task_id,
                encoded_payload=encoded_payload,
            )
            get_oss_service().upload_bytes(
                encoded_payload,
                result_storage_key,
                content_type="application/json; charset=utf-8",
            )
            persisted_result_payload = {
                "parsed_document": result_payload.get("parsed_document", {}),
                "draft_status": "ready",
                "import_job_id": str(job.id),
            }
        else:
            persisted_result_payload = result_payload

        now = timezone.now()
        result_saved = False
        should_cleanup_assets = False
        with transaction.atomic():
            job = DocumentImportJob.objects.select_for_update().get(id=job_id)
            if job.status == DocumentImportJob.Status.CANCELLED:
                should_cleanup_assets = True
            elif task_id and job.celery_task_id != task_id:
                pass
            else:
                job.lease_expires_at = None
                job.completed_at = now
                job.result_storage_key = result_storage_key
                job.result_payload = persisted_result_payload

                if parsed.status == ParsedDocument.Status.READY:
                    job.status = (
                        DocumentImportJob.Status.PARTIAL_READY
                        if failed_pages > 0
                        else DocumentImportJob.Status.READY
                    )
                    job.error_code = "partial_pages_failed" if failed_pages > 0 else ""
                    job.error_message = (
                        f"{failed_pages} 页解析失败，已生成部分结果"
                        if failed_pages > 0
                        else ""
                    )
                else:
                    job.status = DocumentImportJob.Status.FAILED
                    job.error_code = parsed.failure_code or "parse_failed"
                    job.error_message = parsed.error_message or "Document parse failed"
                    should_cleanup_assets = True

                job.save(update_fields=[
                    "parsed_document", "total_pages", "processed_pages", "failed_pages",
                    "stage", "status", "error_code", "error_message", "result_payload",
                    "result_storage_key", "completed_at", "lease_expires_at", "updated_at",
                ])
                result_saved = True

        if should_cleanup_assets:
            _deactivate_import_job_asset_usages(job_id)
        if result_saved:
            result_storage_persisted = bool(result_storage_key)
            logger.info("docparse import job finished", extra=job_log_extra(job=job))
        return job
    finally:
        if result_storage_key and not result_storage_persisted:
            _delete_import_result_best_effort(result_storage_key)


def _build_import_result_storage_key(
    job_id: uuid.UUID | str,
    *,
    task_id: str,
    encoded_payload: bytes,
) -> str:
    owner = hashlib.sha256((task_id or uuid.uuid4().hex).encode("utf-8")).hexdigest()[:16]
    digest = hashlib.sha256(encoded_payload).hexdigest()[:16]
    nonce = uuid.uuid4().hex[:12]
    return f"docparse/import-results/{job_id}/{owner}-{digest}-{nonce}.json"


def _delete_import_result_best_effort(storage_key: str) -> None:
    try:
        from apps.services.oss.services.factory import get_oss_service

        get_oss_service().delete_file(storage_key)
    except Exception:
        logger.warning(
            "Failed to clean up uncommitted import result: %s",
            storage_key,
            exc_info=True,
        )


def _deactivate_import_job_asset_usages(job_id: uuid.UUID | str) -> None:
    from apps.services.oss.models import FileUsage

    usages = FileUsage.objects.filter(
        module="tabdoc",
        context_type="document_import_job",
        context_id=str(job_id),
        is_active=True,
    )
    for usage in usages:
        usage.deactivate()


def _mark_import_job_draft_building(
    job_id: uuid.UUID | str,
    parsed: ParsedDocument,
    *,
    task_id: str = "",
    failed_pages: int,
) -> DocumentImportJob:
    now = timezone.now()
    with transaction.atomic():
        job = DocumentImportJob.objects.select_for_update().get(id=job_id)
        if job.status == DocumentImportJob.Status.CANCELLED:
            return job
        if task_id and job.celery_task_id != task_id:
            return job

        job.parsed_document = parsed
        job.total_pages = parsed.total_pages
        job.processed_pages = parsed.parsed_pages
        job.failed_pages = failed_pages
        job.stage = DocumentImportJob.Stage.BUILDING_DRAFT
        job.heartbeat_at = now
        job.lease_expires_at = now + timedelta(seconds=_IMPORT_JOB_LEASE_SECONDS)
        job.save(update_fields=[
            "parsed_document", "total_pages", "processed_pages", "failed_pages",
            "stage", "heartbeat_at", "lease_expires_at", "updated_at",
        ])
        return job


def _count_failed_pages(parsed: ParsedDocument) -> int:
    return (
        DocumentChunk.objects
        .filter(page__document=parsed, metadata__source="error")
        .values("page_id")
        .distinct()
        .count()
    )


def _pdf_text_chunk_to_markdown_lines(
    *,
    content: str,
    build_image_markdown,
) -> tuple[list[str], int, int]:
    """Convert recoverable PDF text-layer hints into Markdown blocks.

    Chromium-generated PDFs can expose rendered HTML image tags and code language
    labels as text spans. Converting these hints before markdown_to_pm_json keeps
    imported TabDoc content closer to the original rich document.
    """
    parts: list[str] = []
    uploaded_images = 0
    skipped_images = 0
    cursor = 0

    for match in _PDF_TEXT_IMAGE_TAG_RE.finditer(content):
        prefix = content[cursor:match.start()].strip()
        if prefix:
            parts.extend(_plain_pdf_text_to_markdown_blocks(prefix))

        image_markdown, uploaded = _pdf_text_image_tag_to_markdown(
            match.group(0),
            build_image_markdown,
        )
        parts.append(image_markdown)
        if uploaded:
            uploaded_images += 1
        else:
            skipped_images += 1
        cursor = match.end()

    suffix = content[cursor:].strip()
    if suffix:
        parts.extend(_plain_pdf_text_to_markdown_blocks(suffix))

    if not parts:
        parts.extend(_plain_pdf_text_to_markdown_blocks(content))

    return parts, uploaded_images, skipped_images


def _plain_pdf_text_to_markdown_blocks(content: str) -> list[str]:
    text = content.strip()
    if not text:
        return []

    code_match = _PDF_TEXT_CODE_LANG_RE.match(text)
    if code_match:
        lang = code_match.group(1).strip()
        body = code_match.group(2).strip()
        if body:
            return [f"```{lang}\n{body}\n```"]

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines and all(line.startswith(("☐", "☑")) for line in lines):
        return [
            f"- [{'x' if line.startswith('☑') else ' '}] {line[1:].strip()}"
            for line in lines
        ]
    if _looks_like_markdown_table_lines(lines):
        return ["\n".join(lines)]
    if len(lines) > 1:
        return [_plain_pdf_text_line_to_markdown_block(line) for line in lines]

    return [_plain_pdf_text_line_to_markdown_block(text)]


def _plain_pdf_text_line_to_markdown_block(line: str) -> str:
    code_match = _PDF_TEXT_CODE_LANG_RE.match(line.strip())
    if code_match:
        lang = code_match.group(1).strip()
        body = code_match.group(2).strip()
        if body:
            return f"```{lang}\n{body}\n```"
    return line


def _looks_like_markdown_table_lines(lines: list[str]) -> bool:
    if len(lines) < 3:
        return False
    if not all(line.startswith("|") and line.endswith("|") for line in lines[:3]):
        return False
    separator_cells = [cell.strip() for cell in lines[1].strip("|").split("|")]
    return bool(separator_cells) and all(
        re.fullmatch(r":?-{3,}:?", cell) is not None
        for cell in separator_cells
    )


def _pdf_text_image_tag_to_markdown(tag: str, build_image_markdown) -> tuple[str, bool]:
    attrs = _parse_pdf_text_img_attrs(tag)
    src = attrs.get("src", "")
    alt = attrs.get("alt") or "嵌入图片"
    metadata = _image_metadata_from_data_uri(src)
    image_markdown, uploaded = build_image_markdown(content=alt, metadata=metadata)
    if uploaded:
        image_markdown = _markdown_image_to_html_when_sized(
            image_markdown,
            alt=alt,
            dimensions=_pdf_text_image_dimensions(attrs),
        )
    return image_markdown, uploaded


def _parse_pdf_text_img_attrs(tag: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in _PDF_TEXT_ATTR_RE.finditer(tag):
        attrs[match.group("name").lower()] = html.unescape(match.group("value")).strip()
    return attrs


def _pdf_text_image_dimensions(attrs: dict[str, str]) -> dict[str, int]:
    dimensions: dict[str, int] = {}
    for name in ("width", "height"):
        raw_value = attrs.get(name)
        if not raw_value:
            continue
        match = _PDF_TEXT_IMAGE_DIMENSION_RE.match(raw_value)
        if not match:
            continue
        value = float(match.group(1))
        if value <= 0:
            continue
        dimensions[name] = min(_MAX_PDF_TEXT_IMAGE_DIMENSION, max(1, int(round(value))))
    return dimensions


def _image_dimensions_from_metadata(metadata: dict[str, object] | None) -> dict[str, int]:
    dimensions: dict[str, int] = {}
    for name in ("width", "height"):
        raw_value = (metadata or {}).get(name)
        if raw_value is None:
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        if value <= 0:
            continue
        dimensions[name] = min(_MAX_PDF_TEXT_IMAGE_DIMENSION, max(1, int(round(value))))
    return dimensions


def _markdown_image_to_html_when_sized(
    image_markdown: str,
    *,
    alt: str,
    dimensions: dict[str, int],
) -> str:
    if not dimensions:
        return image_markdown
    match = _PDF_TEXT_IMAGE_MD_RE.match(image_markdown.strip())
    if not match:
        return image_markdown
    src = match.group("src")
    attrs = [
        f'src="{html.escape(src, quote=True)}"',
        f'alt="{html.escape(alt, quote=True)}"',
    ]
    for name in ("width", "height"):
        if name in dimensions:
            attrs.append(f'{name}="{dimensions[name]}"')
    return f"<img {' '.join(attrs)}>"


def _image_metadata_from_data_uri(src: str) -> dict[str, str]:
    data_match = _PDF_TEXT_DATA_IMAGE_RE.match(src)
    if not data_match:
        return {}
    content_type = data_match.group(1).lower()
    if content_type == "image/jpg":
        content_type = "image/jpeg"
    image_b64 = "".join(data_match.group("payload").split())
    if not image_b64:
        return {}
    try:
        image_bytes = base64.b64decode(image_b64, validate=True)
    except Exception:
        return {}
    if len(image_bytes) > _MAX_PDF_TEXT_EMBEDDED_IMAGE_BYTES:
        return {}
    image_hash = hashlib.sha256(image_bytes).hexdigest()[:24]
    return {
        "image_b64": image_b64,
        "content_type": content_type,
        "image_hash": image_hash,
    }


def _build_import_image_markdown(
    *,
    content: str | None,
    metadata: dict[str, Any] | None,
    import_job_id: str = "",
    organization_id: str = "",
    user_id: str = "",
) -> tuple[str, bool]:
    """Stage an embedded image privately until the destination document exists."""
    image_metadata = metadata or {}
    alt = (content or "Embedded image").strip().strip("[]") or "Embedded image"
    image_b64 = image_metadata.get("image_b64")
    if not image_b64 or not import_job_id or not organization_id or not user_id:
        return f"[{alt}]", False

    try:
        image_data = base64.b64decode(image_b64, validate=True)
        content_type = str(image_metadata.get("content_type") or "image/png").lower()
        extension = _IMPORT_IMAGE_MIME_TO_EXT.get(content_type)
        if not extension:
            raise ValueError(f"unsupported imported image type: {content_type}")
        image_digest = hashlib.sha256(image_data).hexdigest()
        image_hash = image_digest[:24]
        object_key = (
            f"tabdoc/import-jobs/{organization_id}/{import_job_id}/"
            f"{image_hash}.{extension}"
        )

        from apps.services.oss.services.factory import get_oss_service
        from apps.services.oss.models import FileUsage
        from apps.services.oss.services.file_registry import FileRegistryService

        oss_service = get_oss_service()
        oss_service.upload_bytes(
            image_data,
            object_key,
            content_type=content_type,
        )
        if not oss_service.set_object_private(object_key):
            try:
                oss_service.delete_file(object_key)
            except Exception:
                logger.warning(
                    "Failed to clean up imported image after private ACL failure: %s",
                    object_key,
                    exc_info=True,
                )
            raise RuntimeError("private ACL failed for imported image")

        file_record = FileRegistryService.register_uploaded_file(
            object_key=object_key,
            file_name=f"imported-{image_hash}.{extension}",
            file_size=len(image_data),
            content_type=content_type,
            module="tabdoc",
            user_id=user_id,
            organization_id=organization_id,
            context_type="document_import_job",
            context_id=import_job_id,
            upload_source="document_import_job",
            file_hash=image_digest,
            hash_algorithm="sha256",
            is_public=False,
        )
        FileUsage.add_usage(
            file_record,
            user_id,
            module="tabdoc",
            context_type="document_import_job",
            context_id=import_job_id,
        )
        return f"![{alt}](tabtin-file://asset/{file_record.id})", True
    except Exception as exc:
        logger.warning("Failed to upload imported image: %s", exc)
        return f"[{alt}]", False


# DC-11: docx run 级 marks（bold/italic/underline/strike/superscript/subscript/
# color/highlight/link）直接映射到 pmJson text-node marks 的字段名。
_RUN_BOOL_MARK_NAMES = ("bold", "italic", "underline", "strike", "superscript", "subscript")
_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _pm_text_nodes_from_docx_runs(runs_meta: list[Any]) -> list[dict[str, Any]]:
    """把 DocxParser 提取的 run 级样式（见 docx_parser._extract_run_marks）
    转成 pmJson text node + marks，绕开会丢颜色/高亮/上下标的 markdown 中转。
    """
    nodes: list[dict[str, Any]] = []
    for run_data in runs_meta:
        if not isinstance(run_data, dict):
            continue
        text = str(run_data.get("text") or "")
        if not text:
            continue
        marks: list[dict[str, Any]] = []
        for mark_name in _RUN_BOOL_MARK_NAMES:
            if run_data.get(mark_name):
                marks.append({"type": mark_name})
        color = run_data.get("color")
        if isinstance(color, str) and _HEX_COLOR_RE.match(color):
            marks.append({"type": "textStyle", "attrs": {"color": color}})
        highlight = run_data.get("highlight")
        if isinstance(highlight, str) and highlight:
            marks.append({"type": "highlight", "attrs": {"color": highlight}})
        href = run_data.get("link")
        if isinstance(href, str) and href:
            marks.append({"type": "link", "attrs": {"href": href, "target": "_blank"}})
        node: dict[str, Any] = {"type": "text", "text": text}
        if marks:
            node["marks"] = marks
        nodes.append(node)
    return nodes


def _docx_rich_pm_node(chunk: DocumentChunk) -> dict[str, Any] | None:
    """若 chunk 带 DocxParser 产出的 run 级样式元数据，直接构建 pmJson
    paragraph/heading 节点（保留 marks + 段落对齐），否则返回 None 交由
    调用方走原有的 markdown 中转路径。

    仅覆盖 heading / paragraph——list 走单独的 _docx_list_meta /
    _docx_list_item_pm_content + _build_tabdoc_import_draft 内的 nested list
    组装逻辑（Refs ），因为列表需要按 numId/ilvl 合并成嵌套树，语义和
    heading/paragraph 的单节点转换不同。
    """
    if chunk.chunk_type not in (
        DocumentChunk.ChunkType.HEADING,
        DocumentChunk.ChunkType.PARAGRAPH,
    ):
        return None
    metadata = chunk.metadata if isinstance(chunk.metadata, dict) else {}
    runs_meta = metadata.get("runs")
    if not isinstance(runs_meta, list) or not runs_meta:
        return None

    text_nodes = _pm_text_nodes_from_docx_runs(runs_meta)
    attrs: dict[str, Any] = {}
    align = metadata.get("align")
    if align in ("center", "right", "justify"):
        attrs["textAlign"] = align

    if chunk.chunk_type == DocumentChunk.ChunkType.HEADING:
        attrs["level"] = max(1, min(int(chunk.heading_level or 1), 6))
        return {"type": "heading", "attrs": attrs, "content": text_nodes}

    node: dict[str, Any] = {"type": "paragraph"}
    if attrs:
        node["attrs"] = attrs
    node["content"] = text_nodes
    return node


def _docx_list_meta(chunk: DocumentChunk) -> dict[str, Any] | None:
    """若 chunk 带 DocxParser 产出的编号列表元数据（见
    docx_parser._resolve_list_info / _classify_paragraph 的启发式兜底），
    返回规范化后的 ``{"kind", "level", "numid", "start"}``；否则返回 None，
    交由调用方走原有的 markdown 中转路径（例如 PDF/纯文本解析器产出的
    "list" chunk，没有这套 numId/ilvl 元数据）。
    """
    if chunk.chunk_type != DocumentChunk.ChunkType.LIST:
        return None
    metadata = chunk.metadata if isinstance(chunk.metadata, dict) else {}
    kind = metadata.get("list_kind")
    if kind not in ("bullet", "ordered"):
        return None
    try:
        level = max(0, int(metadata.get("list_level") or 0))
    except (TypeError, ValueError):
        level = 0
    num_id = metadata.get("list_num_id")
    try:
        start = int(metadata["list_start"]) if metadata.get("list_start") is not None else None
    except (TypeError, ValueError):
        start = None
    return {
        "kind": kind,
        "level": level,
        "numid": str(num_id) if num_id is not None else None,
        "start": start,
    }


def _docx_list_item_pm_content(chunk: DocumentChunk) -> list[dict[str, Any]]:
    """构建 listItem 内的段落节点：有 run 级样式元数据时走 marks 保真路径
    （与 heading/paragraph 同级能力），否则退化为纯文本段落。
    """
    metadata = chunk.metadata if isinstance(chunk.metadata, dict) else {}
    runs_meta = metadata.get("runs")
    if isinstance(runs_meta, list) and runs_meta:
        text_nodes = _pm_text_nodes_from_docx_runs(runs_meta)
    else:
        content = (chunk.content or "").strip()
        text_nodes = [{"type": "text", "text": content}] if content else []
    paragraph: dict[str, Any] = {"type": "paragraph"}
    if text_nodes:
        paragraph["content"] = text_nodes
    return [paragraph]


def _build_tabdoc_import_draft(
    parsed: ParsedDocument,
    *,
    import_job: DocumentImportJob | None = None,
) -> dict[str, object]:
    from apps.tabdoc.services.markdown_exchange import markdown_to_pm_json

    request_payload = import_job.request_payload if import_job else {}
    if not isinstance(request_payload, dict):
        request_payload = {}
    import_job_id = str(import_job.id) if import_job else ""
    organization_id = str(
        (import_job.organization_id if import_job else "")
        or request_payload.get("organization_id")
        or ""
    )
    user_id = str(
        (import_job.requested_by_id if import_job else "")
        or request_payload.get("user_id")
        or ""
    )

    def _build_private_import_image(**kwargs):
        return _build_import_image_markdown(
            **kwargs,
            import_job_id=import_job_id,
            organization_id=organization_id,
            user_id=user_id,
        )

    markdown_lines: list[str] = []
    plaintext_lines: list[str] = []
    skipped_images = 0
    uploaded_images = 0

    # DC-11: pm_json 单独构建，与 markdown_lines 分离——markdown 字段仍走原
    # 全量拼接路径（保持既有字段的字节级兼容），pm_json 对 docx 富样式 chunk
    # 直接插入 rich node，其余 chunk 仍按原批次经 markdown_to_pm_json 转换。
    pm_content: list[dict[str, object]] = []
    pm_markdown_batch: list[str] = []

    def _flush_pm_batch() -> None:
        nonlocal pm_markdown_batch
        if not pm_markdown_batch:
            return
        batch_markdown = "\n\n".join(pm_markdown_batch).strip()
        pm_markdown_batch = []
        if not batch_markdown:
            return
        batch_content = markdown_to_pm_json(batch_markdown).get("content")
        if isinstance(batch_content, list):
            pm_content.extend(batch_content)

    # Refs : docx 编号列表（numId/ilvl）跨 chunk 组装成嵌套
    # bulletList/orderedList——每个 list_stack 条目对应树上一层已打开的
    # list 节点，靠 level/kind/numid 决定新增 item 挂在哪一层，或者要不要
    # 先收起更深的层级/开一个新的同级 list。
    list_stack: list[dict[str, Any]] = []

    def _close_list_stack() -> None:
        list_stack.clear()

    def _append_docx_list_item(list_meta: dict[str, Any], item_content: list[dict[str, Any]]) -> None:
        level = list_meta["level"]
        kind = list_meta["kind"]
        numid = list_meta["numid"]

        while list_stack and (
            list_stack[-1]["level"] > level
            or (
                list_stack[-1]["level"] == level
                and (list_stack[-1]["kind"] != kind or list_stack[-1]["numid"] != numid)
            )
        ):
            list_stack.pop()

        item_node: dict[str, Any] = {"type": "listItem", "content": list(item_content)}

        if list_stack and list_stack[-1]["level"] == level:
            list_stack[-1]["node"]["content"].append(item_node)
            return

        node_type = "orderedList" if kind == "ordered" else "bulletList"
        list_node: dict[str, Any] = {"type": node_type, "content": [item_node]}
        if kind == "ordered":
            start = list_meta.get("start")
            list_node["attrs"] = {"start": start if isinstance(start, int) and start > 0 else 1}

        if list_stack:
            parent_items = list_stack[-1]["node"]["content"]
            parent_items[-1]["content"].append(list_node)
        else:
            _flush_pm_batch()
            pm_content.append(list_node)

        list_stack.append({"level": level, "kind": kind, "numid": numid, "node": list_node})

    chunks = (
        DocumentChunk.objects
        .select_related("page")
        .filter(page__document=parsed)
        .order_by("page__page_number", "sequence")
    )
    for chunk in chunks:
        content = (chunk.content or "").strip()
        if not content:
            continue
        lines: list[str]
        if chunk.chunk_type == DocumentChunk.ChunkType.HEADING:
            level = chunk.heading_level or 1
            level = max(1, min(level, 6))
            lines = [f"{'#' * level} {content}"]
        elif chunk.chunk_type == DocumentChunk.ChunkType.TABLE:
            lines = [content]
        elif chunk.chunk_type == DocumentChunk.ChunkType.IMAGE:
            if content.startswith("!["):
                lines = [content]
                uploaded_images += 1
            else:
                line, uploaded = _build_private_import_image(
                    content=content,
                    metadata=chunk.metadata,
                )
                if uploaded:
                    uploaded_images += 1
                    line = _markdown_image_to_html_when_sized(
                        line,
                        alt=content.strip("[]") or "嵌入图片",
                        dimensions=_image_dimensions_from_metadata(chunk.metadata),
                    )
                else:
                    skipped_images += 1
                lines = [line]
        elif chunk.chunk_type in {
            DocumentChunk.ChunkType.PARAGRAPH,
            DocumentChunk.ChunkType.LIST,
        }:
            lines, uploaded, skipped = _pdf_text_chunk_to_markdown_lines(
                content=content,
                build_image_markdown=_build_private_import_image,
            )
            uploaded_images += uploaded
            skipped_images += skipped
        else:
            lines = [content]
        markdown_lines.extend(lines)
        plaintext_lines.append(content)

        list_meta = _docx_list_meta(chunk)
        if list_meta is not None:
            _append_docx_list_item(list_meta, _docx_list_item_pm_content(chunk))
            continue

        _close_list_stack()
        rich_node = _docx_rich_pm_node(chunk)
        if rich_node is not None:
            _flush_pm_batch()
            pm_content.append(rich_node)
        else:
            pm_markdown_batch.extend(lines)

    _flush_pm_batch()

    markdown = "\n\n".join(markdown_lines).strip()
    plaintext = "\n".join(plaintext_lines).strip()
    pm_json = {"type": "doc", "content": pm_content}
    title = parsed.title or (parsed.file_record.file_name if parsed.file_record_id else "")
    return {
        "pm_json": pm_json,
        "markdown": markdown,
        "plaintext": plaintext,
        "title": title,
        "total_pages": parsed.total_pages,
        "skipped_images": skipped_images,
        "uploaded_images": uploaded_images,
        "parsed_document_id": str(parsed.id),
    }


def requeue_stale_import_jobs(*, limit: int = 100) -> dict[str, int]:
    """Watchdog: reclaim expired active jobs and requeue while retry budget remains."""
    from apps.services.docparse.tasks import execute_document_import_job_task

    now = timezone.now()
    queued_cutoff = now - timedelta(seconds=_IMPORT_JOB_LEASE_SECONDS)
    candidates = list(
        DocumentImportJob.objects
        .filter(
            Q(
                status__in=(DocumentImportJob.Status.RUNNING, DocumentImportJob.Status.RETRYING),
                lease_expires_at__lt=now,
            )
            | Q(
                status=DocumentImportJob.Status.QUEUED,
                celery_task_id="",
                updated_at__lt=queued_cutoff,
            ),
        )
        .order_by("lease_expires_at")[:limit]
        .values_list("id", flat=True)
    )
    requeued = 0
    failed = 0
    failed_job_ids: list[uuid.UUID] = []
    for job_id in candidates:
        with transaction.atomic():
            job = DocumentImportJob.objects.select_for_update().get(id=job_id)
            if job.status not in (
                DocumentImportJob.Status.QUEUED,
                DocumentImportJob.Status.RUNNING,
                DocumentImportJob.Status.RETRYING,
            ):
                continue
            if job.status != DocumentImportJob.Status.QUEUED and job.lease_expires_at and job.lease_expires_at >= now:
                continue
            waiting_for_shared_parse = job.error_code == _IMPORT_JOB_SHARED_PARSE_WAIT_CODE
            if not waiting_for_shared_parse and job.retry_count >= _IMPORT_JOB_MAX_RETRIES:
                job.status = DocumentImportJob.Status.FAILED
                job.error_code = "lease_expired"
                job.error_message = "导入任务租约过期且已达到最大重试次数"
                job.completed_at = now
                job.lease_expires_at = None
                job.save(update_fields=[
                    "status", "error_code", "error_message",
                    "completed_at", "lease_expires_at", "updated_at",
                ])
                failed += 1
                failed_job_ids.append(job.id)
                continue
            job.status = DocumentImportJob.Status.RETRYING
            if not waiting_for_shared_parse:
                job.retry_count += 1
            job.celery_task_id = ""
            if not waiting_for_shared_parse:
                job.error_code = "lease_expired"
                job.error_message = "导入任务租约过期，已重新入队"
            job.heartbeat_at = now
            job.lease_expires_at = None
            job.save(update_fields=[
                "status", "retry_count", "celery_task_id", "error_code", "error_message",
                "heartbeat_at", "lease_expires_at", "updated_at",
            ])

        try:
            task = execute_document_import_job_task.apply_async(args=[str(job_id)], queue="docparse")
        except Exception as exc:
            DocumentImportJob.objects.filter(id=job_id).update(
                status=DocumentImportJob.Status.INTERRUPTED,
                error_code="enqueue_failed",
                error_message=str(exc)[:2000],
                completed_at=timezone.now(),
                lease_expires_at=None,
                updated_at=timezone.now(),
            )
            failed += 1
            failed_job_ids.append(job_id)
        else:
            DocumentImportJob.objects.filter(id=job_id).update(
                celery_task_id=task.id or "",
                updated_at=timezone.now(),
            )
            logger.warning("docparse import job requeued", extra=job_log_extra(job_id=str(job_id), task_id=task.id or ""))
            requeued += 1
    for failed_job_id in failed_job_ids:
        _deactivate_import_job_asset_usages(failed_job_id)
    return {"scanned": len(candidates), "requeued": requeued, "failed": failed}


# ======================================================================
# 计费上下文
# ======================================================================

def _resolve_billing_context(parsed_doc: ParsedDocument) -> tuple[str, str]:
    """从 ParsedDocument 推断 (user_id, organization_id)。用于 VisionParser 计费。

    W2-1b: 统一 resolver 负责 space→organization / personal fallback；
    模块特有的 FileUsage → context 反查保留。
    """
    from apps.services.billing.organization_resolver import (
        get_personal_organization_id,
        resolve_organization_id_from_space,
    )

    user_id = ""
    organization_id = ""
    try:
        fr = parsed_doc.file_record
        if not fr:
            return user_id, organization_id
        user_id = str(getattr(fr, "upload_user_id", "") or getattr(fr, "upload_user", "") or "")
        usage = fr.usages.filter(is_active=True).first() if hasattr(fr, "usages") else None
        if usage:
            ctx_type = usage.context_type or ""
            ctx_id = usage.context_id or ""
            if ctx_type and ctx_id:
                organization_id = _resolve_organization_from_context(usage.module, ctx_type, ctx_id)
        if not organization_id:
            meta = fr.metadata or {}
            organization_id = str(meta.get("organization_id", ""))
    except Exception as exc:
        logger.debug("_resolve_billing_context 失败: %s", exc)

    if not organization_id and user_id:
        organization_id = _get_personal_organization_id_via_resolver(user_id)
        if organization_id:
            logger.info(
                "_resolve_billing_context 回退到个人团队: user=%s wt=%s",
                user_id[:8], organization_id[:8],
            )

    return user_id, organization_id


def _get_personal_organization_id_via_resolver(user_id: str) -> str:
    """通过统一 resolver 获取 personal organization_id。"""
    from apps.services.billing.organization_resolver import get_personal_organization_id_by_user_id
    return get_personal_organization_id_by_user_id(user_id)


def _resolve_organization_from_context(module: str, ctx_type: str, ctx_id: str) -> str:
    """从 FileUsage 的 module/context 推断 organization_id。

    DocParse 特有逻辑：tabdata→Table / tabdoc→Document / chat→Session 的直接 organization_id 字段。
    与统一 resolver 的 space→organization 链路互补，不重叠。
    """
    try:
        if module == "tabdata":
            from apps.tabdata.models import Table
            table = Table.objects.filter(id=ctx_id).values_list("organization_id", flat=True).first()
            return str(table) if table else ""
        if module == "tabdoc":
            from apps.tabdoc.models import Document
            doc = Document.objects.filter(id=ctx_id).values_list("organization_id", flat=True).first()
            return str(doc) if doc else ""
        if module == "chat":
            from apps.services.billing.organization_resolver import resolve_organization_id_from_session
            result = resolve_organization_id_from_session(ctx_id)
            return result or ""
    except Exception:
        pass
    return ""


# ======================================================================
# 并发锁：select_for_update 行锁
# ======================================================================

def _try_acquire_parse_lock(
    file_record: FileRecord,
    *,
    force: bool = False,
) -> tuple[ParsedDocument, bool] | None:
    """
    原子地检查 + 抢占解析锁。

    Returns:
        (parsed_doc, should_parse):
            should_parse=True  → 调用者拿到锁，应开始解析
            should_parse=False → 已有结果或其他 Worker 正在解析，直接返回
        None → 意外情况
    """
    try:
        with transaction.atomic():
            doc = (
                ParsedDocument.objects
                .select_for_update(skip_locked=True)
                .filter(file_record=file_record)
                .first()
            )

            if doc is None:
                from django.db import IntegrityError
                try:
                    doc = ParsedDocument.objects.create(
                        file_record=file_record,
                        status=ParsedDocument.Status.PARSING,
                    )
                    return doc, True
                except IntegrityError:
                    doc = ParsedDocument.objects.filter(
                        file_record=file_record,
                    ).first()
                    if doc:
                        return doc, False
                    raise

            if not force and doc.status == ParsedDocument.Status.READY:
                return doc, False

            if not force and doc.status == ParsedDocument.Status.PARSING:
                age = (timezone.now() - doc.updated_at).total_seconds()
                if age < _PARSING_TIMEOUT_SECONDS:
                    logger.info(
                        "文档正在解析中 (%s, %.0fs)，跳过",
                        file_record.file_name, age,
                    )
                    return doc, False
                logger.warning(
                    "文档解析超时 (%s, %.0fs)，重置",
                    file_record.file_name, age,
                )

            doc.status = ParsedDocument.Status.PARSING
            doc.error_message = ""
            doc.failure_code = ""
            doc.save(update_fields=["status", "error_message", "failure_code", "updated_at"])
            return doc, True

    except Exception as exc:
        logger.error("获取解析锁失败: %s", exc, exc_info=True)
        return None


def _create_failed_doc(
    file_record: FileRecord,
    message: str,
    failure_code: str = ParsedDocument.FailureCode.UNKNOWN_ERROR,
) -> ParsedDocument:
    doc, _ = ParsedDocument.objects.update_or_create(
        file_record=file_record,
        defaults={
            "status": ParsedDocument.Status.FAILED,
            "error_message": message,
            "failure_code": failure_code,
        },
    )
    return doc


def _classify_exception_to_failure_code(exc: Exception) -> str:
    """
    把后端解析过程中抛出的异常归类到 ParsedDocument.FailureCode 13 类之一。

    W1 / L9：与 @tabtin/file-pipeline-errors SSoT 对齐。匹配启发式与
    `packages/local-docparse/src/error-classifier.ts` 同款，便于客户端 / 后端
    两条解析链路给出一致的失败信号。

    **W1.1 (2026-05-13 Review 反馈)**：
      - `'corrupt'` 改用更严格的 phrase 集合（避免把 "fetch corrupt stream"
        等网络错误误判为 CORRUPTED 不切云端）
      - `'abort'` 改用严格 name 匹配（避免把 `RetryableUploadAbortedException`
        等异常误判为用户取消）
      - `'unsupported file'` / `'unsupported zip'` 挪到 UNSUPPORTED_FORMAT
        （旧 xlsx 老格式不是损坏而是格式不支持）
    """
    msg = str(exc).lower()
    name = type(exc).__name__.lower()

    if "password" in msg or "password" in name or "encrypted" in msg or "加密" in msg:
        return ParsedDocument.FailureCode.ENCRYPTED
    # **W2 L22 升级（2026-05-13）**：Celery 硬时限 `TimeLimitExceeded` 与软时限
    # `SoftTimeLimitExceeded` 都归 PARSE_TIMEOUT；硬时限是 SIGKILL，进程被打
    # 断后异常 name 通常是 `TimeLimitExceeded`（无 "soft" 前缀）。
    # **W2.1 收尾（2026-05-13 Review 3 fix-9）**：删 `softtimelimitexceeded` 子串
    # 检测——前者是后者的子串，重复检测无意义且让读者困惑"两条分支语义是否不同"。
    if (
        "timelimitexceeded" in name        # 涵盖 SoftTimeLimitExceeded + TimeLimitExceeded
        or "timeoutexception" in name
        or "timed out" in msg
        or "task timeout" in msg
    ):
        return ParsedDocument.FailureCode.PARSE_TIMEOUT
    # 严格 name 匹配，不用裸 'abort' / 'cancel' 防误判
    if name in ("aborterror", "workertaskabortederror", "canceledfileerror"):
        return ParsedDocument.FailureCode.USER_ABORTED
    # 'unsupported file' / 'unsupported zip' 不归到 CORRUPTED（xlsx 老格式不是损坏）。
    #
    # **W4 L34 source comment 钉死顺序意图（2026-05-13）**：本条 phrase 与下方
    # 第 ~715 行的 "unsupported / not supported / 不支持旧版" 是**功能等价**两
    # 个 phrase 命中——都返 UNSUPPORTED_FORMAT。本条命中率更高（具体短语先匹配），
    # 不能调换顺序。未来如想把本条精化为 `LEGACY_OFFICE_FORMAT` 单独 enum，
    # 需先评估顺序敏感性（先调本条到具体分支 + 保持下方通用 phrase 兜底）。
    # 顺序保护测试见 `tests_failure_code_classifier.py`。
    if "unsupported file" in msg or "unsupported zip" in msg:
        return ParsedDocument.FailureCode.UNSUPPORTED_FORMAT
    # CORRUPTED 用特异词组：避免裸 'corrupt' 误匹配 "fetch corrupt stream" 等
    #
    # **W1.3 第 3 轮 Review 1 S1 修复（2026-05-13）**：补 `zipfile.BadZipFile` 异常
    # name 检测。python-docx / openpyxl 在 docx/xlsx 文件结构损坏时会直接外抛
    # `zipfile.BadZipFile`（不包装成自定义异常），其 message 通常是 "File is not
    # a zip file"——既不命中"not a valid zip"也不命中"corrupt (workbook|...)"，
    # 旧版本会 fallback 到 UNKNOWN_ERROR。高频生产异常，必须归入 CORRUPTED。
    #
    # **W2 L22 升级（2026-05-13）**：补 PyMuPDF / pdfplumber 三类生产高频异常：
    #   - `fitz.FzErrorFormat` / `FzErrorGeneric` —— PyMuPDF 解析底层 mupdf 报错，
    #     name 形如 `fzerrorformat` / `fzerrorgeneric`，覆盖 PDF 文件结构损坏 /
    #     超出 mupdf 处理范围的边缘 case。message 通常是 "format error: ..." /
    #     "cannot find startxref" 等。
    #   - `pdfplumber.PDFSyntaxError` —— pdfminer.six 在 PDF 解析层抛的语法错，
    #     name 形如 `pdfsyntaxerror`，覆盖 EOF marker 缺失 / xref table 损坏等。
    #   - 旧版本三类全 fallback UNKNOWN_ERROR，LLM 拿不到"建议重新导出"的精确信号。
    import re
    if (
        "invalid pdf" in msg
        or "pdf header" in msg
        or "not a valid zip" in msg
        or "is not a zip file" in msg
        or name == "badzipfile"
        # W2 L22：PyMuPDF / pdfplumber 高频损坏异常
        or "fzerror" in name  # PyMuPDF FzError* 系列
        or "pdfsyntaxerror" in name  # pdfplumber/pdfminer 语法错
        or "cannot find startxref" in msg
        or "cannot find trailer" in msg
        or ("format error" in msg and "pdf" in msg)  # 显式括号防误读 or/and 优先级
        or re.search(r"corrupt (workbook|sheet|pdf|file|zip|document)", msg)
    ):
        return ParsedDocument.FailureCode.CORRUPTED
    if "enoent" in msg or "no such file" in msg or "file not found" in msg:
        return ParsedDocument.FailureCode.FILE_NOT_FOUND
    if "permission denied" in msg or "eperm" in msg or "eacces" in msg:
        return ParsedDocument.FailureCode.PERMISSION_DENIED
    if "scanned" in msg:
        return ParsedDocument.FailureCode.SCANNED_PDF
    if "garbled_text_layer" in msg or "garbled text layer" in msg:
        return ParsedDocument.FailureCode.GARBLED_TEXT_LAYER
    # **W3 Review 1 H2 修复（2026-05-13）**：PPTX parser (`pptx_parser.py:282-307`)
    # 抛**中文** ValueError 但旧分类器只匹配英文 phrase，全 fallback 到 UNKNOWN_ERROR。
    # 用户撞 "PPTX 文件过大" / "PPTX 解压后体积过大" 拿到 UNKNOWN_ERROR hint
    # "contact support" —— W1 北极星"每条错误清晰原因 + actionable suggestion"
    # 在 PPTX 临时通道完全失效。补中文 phrase 匹配（与英文 phrase 同分支语义）：
    if (
        "too large" in msg or "exceeds maximum" in msg or "oversize" in msg
        or "文件过大" in msg or "解压后体积过大" in msg
    ):
        return ParsedDocument.FailureCode.FILE_TOO_LARGE
    # **W4 L34 顺序意图**：本条是通用 phrase 兜底（"unsupported" / "not supported"
    # 不带具体 file/zip 前缀），匹配老 Office 格式 / 不支持的 mime 等。本条必须
    # **在 corrupt phrase / FILE_TOO_LARGE / SCANNED_PDF 等具体分支之后**——否则
    # 误吞 "unsupported corrupt PDF" 等复合短语（虽罕见）。
    if "unsupported" in msg or "not supported" in msg or "不支持旧版" in msg:
        return ParsedDocument.FailureCode.UNSUPPORTED_FORMAT
    # **W3 Review 1 H2**：PPTX zip-bomb / 内部条目过多 / 压缩比异常 / 非 ZIP 头
    # 全归 CORRUPTED（损坏 / 异常结构）—— 与 BadZipFile / CORRUPTED 已有 phrase 同源。
    if (
        "不是有效的 pptx" in msg or "不是有效的 zip" in msg
        or "条目数过多" in msg or "压缩比异常" in msg or "zip-bomb" in msg
    ):
        return ParsedDocument.FailureCode.CORRUPTED
    if "network" in msg or "connection" in msg or "econnrefused" in msg or "enotfound" in msg:
        return ParsedDocument.FailureCode.NETWORK_ERROR
    return ParsedDocument.FailureCode.UNKNOWN_ERROR


# ======================================================================
# 分页流式解析 + 逐页写入
# ======================================================================


def _pdf_high_failure_threshold_hit(failed_pages: int, actually_parsed: int) -> bool:
    """W2 L23: 决定 PDF 是否触发">80% 页失败"高失败兜底分支。

    抽出来便于 unit test 钉死决策（不用 mock 整个 _stream_parse_pdf 链路）：
      - actually_parsed=10 / failed=8 → 0.8 不 > 0.8 → False（80% 整不算"超过"）
      - actually_parsed=10 / failed=9 → 0.9 > 0.8 → True
      - actually_parsed=0 → False（保护除零 + "全跳过"场景不进 fallback）
    """
    return actually_parsed > 0 and failed_pages / actually_parsed > 0.8


def _classify_high_failure_pdf_failure_code(
    parsed_doc: ParsedDocument,
    failed_pages: int,
) -> str:
    """W2 L23：>80% 失败的 PDF 由 ``skipped_scan`` chunks 占比决定归类。

    阈值 ``skipped_scan_count >= failed_pages * 0.5 and > 0`` →  SCANNED_PDF
    （引导用户走 VLM 按页计费提取，不再误推"重新导出文件"无效操作）；
    否则归 CORRUPTED（结构性问题 / 文本层乱码等，提示"建议重新导出"）。

    抽成独立 helper 便于 unit test 钉死决策行为——不用 mock 整个 fitz +
    pdfplumber + PDFParser 链路，单测只需 mock ``DocumentChunk.objects.filter
    (...).count()`` 即可覆盖三个 case（高占比扫描件 / 低占比仍 CORRUPTED /
    skipped_scan_count == 0 仍 CORRUPTED）。

    返回值是 ``ParsedDocument.FailureCode`` 枚举字面字符串。
    """
    skipped_scan_count = DocumentChunk.objects.filter(
        page__document=parsed_doc,
        metadata__source="skipped_scan",
    ).count()
    is_likely_scanned = (
        skipped_scan_count >= failed_pages * 0.5 and skipped_scan_count > 0
    )
    return (
        ParsedDocument.FailureCode.SCANNED_PDF
        if is_likely_scanned
        else ParsedDocument.FailureCode.CORRUPTED
    )


def _stream_parse_pdf(
    parsed_doc: ParsedDocument,
    file_path: str,
    vision_model: str,
    skip_pages: int,
    *,
    import_job_id: str = "",
    import_job_task_id: str = "",
) -> None:
    """逐批解析 PDF，每页独立写入 DB（带事务）。"""
    import fitz

    from apps.services.docparse.pdf_subprocess import (
        parse_pdf_page_batch_in_subprocess,
        pdf_child_batch_size,
    )

    user_id, organization_id = _resolve_billing_context(parsed_doc)
    file_size = os.path.getsize(file_path)
    if file_size > MAX_FILE_SIZE:
        raise ValueError(f"文件过大: {file_size} bytes > {MAX_FILE_SIZE} bytes")

    doc = None
    try:
        doc = fitz.open(file_path)
        if getattr(doc, "is_encrypted", False):
            raise ValueError("暂不支持解析加密 PDF")
        total = len(doc)
        if total > _PDF_MAX_PAGES:
            logger.warning(
                "PDF 页数 (%d) 超过上限 (%d)，仅处理前 %d 页: %s",
                total, _PDF_MAX_PAGES, _PDF_MAX_PAGES, file_path,
            )
            total = _PDF_MAX_PAGES
    finally:
        if doc is not None:
            doc.close()

    title = ""
    if skip_pages > 0:
        logger.info(
            "断点续传: %s 跳过前 %d 页（共 %d 页）",
            parsed_doc.file_record_id, skip_pages, total,
        )
        # PDF-TITLE-FIX: 断点续传跳过第 1 页，从 DB 已解析结果恢复 title
        first_heading = DocumentChunk.objects.filter(
            page__document=parsed_doc,
            page__page_number=1,
            chunk_type="heading",
        ).first()
        if first_heading:
            title = first_heading.content[:200]

    failed_pages = 0
    batch_size = pdf_child_batch_size()
    page_numbers = list(range(skip_pages + 1, total + 1))

    for start in range(0, len(page_numbers), batch_size):
        batch = page_numbers[start:start + batch_size]
        batch_results = parse_pdf_page_batch_in_subprocess(
            file_path=file_path,
            page_numbers=batch,
            vision_model=vision_model,
            user_id=user_id,
            organization_id=organization_id,
        )
        for page_result in batch_results:
            page_num = page_result.page_number
            if any(
                (chunk.metadata or {}).get("source") == "error"
                for chunk in page_result.chunks
            ):
                failed_pages += 1

            if page_num == 1 and page_result.chunks:
                first = page_result.chunks[0]
                if first.chunk_type == "heading":
                    title = first.content[:200]

            with transaction.atomic():
                _persist_one_page(parsed_doc, page_result)
                parsed_doc.parsed_pages = page_num
                parsed_doc.save(update_fields=["parsed_pages", "updated_at"])

            _heartbeat_import_job(
                import_job_id,
                task_id=import_job_task_id,
                stage=DocumentImportJob.Stage.EXTRACTING,
                total_pages=total,
                processed_pages=page_num,
                failed_pages=failed_pages,
            )
            _emit_progress(parsed_doc, page_num, total)

    # PDF-PAGE-DEGRADE: >80% 页面失败则整文档标记 FAILED
    actually_parsed = total - skip_pages
    if _pdf_high_failure_threshold_hit(failed_pages, actually_parsed):
        fail_msg = f"{failed_pages}/{actually_parsed} 页解析失败 (>80%)"
        failure_code = _classify_high_failure_pdf_failure_code(parsed_doc, failed_pages)
        with transaction.atomic():
            parsed_doc.status = ParsedDocument.Status.FAILED
            parsed_doc.total_pages = total
            parsed_doc.error_message = fail_msg
            parsed_doc.failure_code = failure_code
            parsed_doc.parsed_pages = total
            parsed_doc.save(update_fields=[
                "status", "total_pages", "error_message", "failure_code",
                "parsed_pages", "updated_at",
            ])
        _emit_failed(parsed_doc, fail_msg)
        return

    method = "text_layer"
    all_pages = DocumentPage.objects.filter(document=parsed_doc)
    has_vision = DocumentChunk.objects.filter(
        page__in=all_pages, metadata__source="vision",
    ).exists()
    has_text = DocumentChunk.objects.filter(
        page__in=all_pages, metadata__source="text_layer",
    ).exists()
    has_skipped_scan = DocumentChunk.objects.filter(
        page__in=all_pages, metadata__source="skipped_scan",
    ).exists()
    if has_vision and has_text:
        method = "hybrid"
    elif has_vision:
        method = "vision"
    elif has_skipped_scan and has_text:
        method = "hybrid"
    elif has_skipped_scan:
        method = "vision"

    with transaction.atomic():
        parsed_doc.status = ParsedDocument.Status.READY
        parsed_doc.parse_method = method
        parsed_doc.total_pages = total
        parsed_doc.title = title
        parsed_doc.parsed_at = timezone.now()
        parsed_doc.error_message = ""
        parsed_doc.failure_code = ""
        parsed_doc.parsed_pages = total
        parsed_doc.save(update_fields=[
            "status", "parse_method", "total_pages", "title",
            "parsed_at", "error_message", "failure_code", "parsed_pages", "updated_at",
        ])

    _emit_completed(parsed_doc)


def _stream_parse_generic(
    parsed_doc: ParsedDocument,
    file_path: str,
    parser_cls: type,
    skip_pages: int,
    *,
    vision_model: str = "",
    import_job_id: str = "",
    import_job_task_id: str = "",
    selected_model_id: str | None = None,
) -> None:
    """通用文档解析路径（Word / Excel / 未来的 PPT 等）— 逐页写入。"""
    parser = parser_cls()
    result = parser.parse(
        file_path,
        vision_model=vision_model,
        selected_model_id=selected_model_id,
    )
    total = len(result.pages)

    for page_result in result.pages:
        if page_result.page_number <= skip_pages:
            continue

        with transaction.atomic():
            _persist_one_page(parsed_doc, page_result)
            parsed_doc.parsed_pages = page_result.page_number
            parsed_doc.save(update_fields=["parsed_pages", "updated_at"])

        _heartbeat_import_job(
            import_job_id,
            task_id=import_job_task_id,
            stage=DocumentImportJob.Stage.EXTRACTING,
            total_pages=total,
            processed_pages=page_result.page_number,
        )
        _emit_progress(parsed_doc, page_result.page_number, total)

    with transaction.atomic():
        parsed_doc.status = ParsedDocument.Status.READY
        parsed_doc.parse_method = result.parse_method or "structural"
        parsed_doc.total_pages = total
        parsed_doc.title = result.title
        parsed_doc.language = result.language
        parsed_doc.parsed_at = timezone.now()
        parsed_doc.error_message = ""
        parsed_doc.failure_code = ""
        parsed_doc.parsed_pages = total
        parsed_doc.save(update_fields=[
            "status", "parse_method", "total_pages", "title",
            "language", "parsed_at", "error_message", "failure_code", "parsed_pages", "updated_at",
        ])

    _emit_completed(parsed_doc)


def _persist_one_page(parsed_doc: ParsedDocument, page_result: PageResult) -> None:
    """将单页按唯一键 upsert 写入 DB（调用方应在 transaction.atomic 内）。"""
    page_obj, _ = DocumentPage.objects.update_or_create(
        document=parsed_doc,
        page_number=page_result.page_number,
        defaults={
            "width": page_result.width,
            "height": page_result.height,
            "text_content": page_result.text_content,
        },
    )

    seen_sequences: set[int] = set()
    for chunk in page_result.chunks:
        seen_sequences.add(chunk.sequence)
        DocumentChunk.objects.update_or_create(
            page=page_obj,
            sequence=chunk.sequence,
            defaults={
                "chunk_type": chunk.chunk_type,
                "content": chunk.content,
                "bbox_x0": chunk.bbox[0] if chunk.bbox else None,
                "bbox_y0": chunk.bbox[1] if chunk.bbox else None,
                "bbox_x1": chunk.bbox[2] if chunk.bbox else None,
                "bbox_y1": chunk.bbox[3] if chunk.bbox else None,
                "heading_level": chunk.heading_level,
                "metadata": chunk.metadata,
            },
        )
    if seen_sequences:
        DocumentChunk.objects.filter(page=page_obj).exclude(sequence__in=seen_sequences).delete()
    else:
        DocumentChunk.objects.filter(page=page_obj).delete()


def _finalize_document(
    parsed_doc: ParsedDocument,
    result: ParseResult,
    vision_model: str,
) -> None:
    """最终化文档状态（调用方应在 transaction.atomic 内）。"""
    parsed_doc.status = ParsedDocument.Status.READY
    parsed_doc.parse_method = result.parse_method or "text_layer"
    parsed_doc.total_pages = len(result.pages)
    parsed_doc.title = result.title
    parsed_doc.language = result.language
    parsed_doc.parse_model = vision_model
    parsed_doc.parsed_at = timezone.now()
    parsed_doc.error_message = ""
    parsed_doc.failure_code = ""
    parsed_doc.parsed_pages = len(result.pages)
    parsed_doc.save(update_fields=[
        "status", "parse_method", "total_pages", "title",
        "language", "parse_model", "parsed_at", "error_message",
        "failure_code", "parsed_pages", "updated_at",
    ])


# ======================================================================
# 文件下载
# ======================================================================

def _download_file(file_record: FileRecord, local_path: str) -> None:
    from apps.services.oss.services.factory import get_oss_service

    oss_service = get_oss_service()
    result = oss_service.download_file(file_record.file_key, local_path=local_path)

    if not result.get("success"):
        raise RuntimeError(
            f"OSS 下载失败: {result.get('message', 'unknown error')}"
        )


# ======================================================================
# 文件类型检测
# ======================================================================

def _detect_mime(file_path: str, declared_mime: str) -> str:
    """
    文件类型检测。
    1. magic bytes 初步判断
    2. ZIP 容器进一步检查内部结构区分 docx / xlsx / pptx
    3. 回退到 declared_mime
    """
    try:
        with open(file_path, "rb") as f:
            header = f.read(16)
        if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
            if declared_mime != "image/webp":
                logger.info("MIME 校正: declared=%s, actual=image/webp", declared_mime)
            return "image/webp"
        for magic, mime in _MAGIC_BYTES:
            if header.startswith(magic):
                if mime == "__zip__":
                    detected = _detect_zip_subtype(file_path)
                    if detected:
                        if detected != declared_mime:
                            logger.info("ZIP MIME 校正: declared=%s, actual=%s", declared_mime, detected)
                        return detected
                    return declared_mime or ""
                if mime != declared_mime:
                    logger.info("MIME 校正: declared=%s, actual=%s", declared_mime, mime)
                return mime
    except ValueError:
        raise
    except Exception as exc:
        logger.debug("magic bytes 检测失败: %s", exc)

    if declared_mime and declared_mime != "application/octet-stream":
        return declared_mime

    guessed_mime, _ = mimetypes.guess_type(file_path)
    if guessed_mime:
        logger.info(
            "MIME 扩展名兜底: declared=%s, guessed=%s",
            declared_mime, guessed_mime,
        )
        return guessed_mime

    return declared_mime or ""


def _detect_zip_subtype(file_path: str) -> str | None:
    """检查 ZIP 内部结构区分 Office Open XML 子类型，同时进行 zip bomb 检测。"""
    import zipfile

    try:
        with zipfile.ZipFile(file_path) as zf:
            compressed_size = os.path.getsize(file_path)
            total_uncompressed = sum(info.file_size for info in zf.infolist())
            if total_uncompressed > _ZIP_MAX_UNCOMPRESSED:
                raise ValueError(
                    f"ZIP 解压后大小 ({total_uncompressed / 1024 / 1024:.0f}MB) "
                    f"超过上限 ({_ZIP_MAX_UNCOMPRESSED / 1024 / 1024:.0f}MB)"
                )
            if compressed_size > 0 and total_uncompressed / compressed_size > _ZIP_BOMB_RATIO:
                raise ValueError(
                    f"疑似 zip bomb：压缩比 {total_uncompressed / compressed_size:.0f}:1 "
                    f"超过阈值 {_ZIP_BOMB_RATIO}:1"
                )

            names = zf.namelist()
            if any(n.startswith("word/") for n in names):
                return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            if any(n.startswith("xl/") for n in names):
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if any(n.startswith("ppt/") for n in names):
                return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    except ValueError:
        raise
    except Exception as exc:
        logger.debug("ZIP 子类型检测失败: %s", exc)
    return None


# ======================================================================
# 智能摘要生成
# ======================================================================

def _build_smart_summary(parsed: ParsedDocument, max_tokens: int) -> str:
    char_limit = max_tokens * 3
    chunks = list(
        DocumentChunk.objects.filter(page__document=parsed)
        .only("chunk_type", "content", "heading_level", "metadata", "page", "sequence")
        .order_by("page__page_number", "sequence")
    )

    if not chunks:
        return ""

    headings: list[str] = []
    body_lines: list[str] = []

    for chunk in chunks:
        if chunk.chunk_type == "heading" and chunk.heading_level:
            prefix = "#" * chunk.heading_level + " "
            headings.append(prefix + chunk.content)
        elif chunk.chunk_type == "table":
            rows = chunk.metadata.get("rows", "?")
            cols = chunk.metadata.get("cols", "")
            desc = f"[表格: {rows} 行"
            if cols:
                desc += f" × {cols} 列"
            desc += "]"
            body_lines.append(desc)
        elif chunk.chunk_type == "image":
            continue
        else:
            body_lines.append(chunk.content)

    heading_budget = int(char_limit * 0.2) if headings else 0
    body_budget = char_limit - heading_budget

    parts: list[str] = []
    used = 0

    for h in headings:
        if used + len(h) > heading_budget:
            break
        parts.append(h)
        used += len(h)

    body_used = 0
    for line in body_lines:
        if body_used + len(line) > body_budget:
            remaining = body_budget - body_used
            if remaining > 50:
                parts.append(line[:remaining] + "…")
            parts.append(f"\n[文档内容已截断，共 {parsed.total_pages} 页]")
            break
        parts.append(line)
        body_used += len(line)

    return "\n\n".join(parts)


# ======================================================================
# WebSocket 事件推送
# ======================================================================

_PROGRESS_EMIT_INTERVAL = 3  # 最少每 3 页推送一次，避免高频推送

def _emit_progress(parsed_doc: ParsedDocument, current_page: int, total: int) -> None:
    """推送解析进度（每隔几页推送一次 + 最后一页必推）。"""
    if current_page == total or current_page % _PROGRESS_EMIT_INTERVAL == 0:
        try:
            from apps.services.docparse.events import publish_parse_progress
            publish_parse_progress(
                str(parsed_doc.file_record_id), current_page, total,
            )
        except Exception:
            pass


def _clear_async_dedup(file_record_id: str) -> None:
    try:
        from django.core.cache import cache
        cache.delete(f"docparse:async:{file_record_id}")
    except Exception:
        pass


def _emit_completed(parsed_doc: ParsedDocument) -> None:
    _clear_async_dedup(str(parsed_doc.file_record_id))
    try:
        from apps.services.docparse.events import publish_parse_completed
        publish_parse_completed(
            str(parsed_doc.file_record_id),
            parsed_doc.total_pages,
            parsed_doc.parse_method,
            parsed_doc.title,
        )
    except Exception:
        pass

    _trigger_rag_index(parsed_doc)


def _trigger_rag_index(parsed_doc: ParsedDocument) -> None:
    """解析成功后异步触发 RAG 向量索引，将文档内容写入 pgvector。"""
    try:
        from apps.services.docparse.tasks import trigger_rag_index_task
        trigger_rag_index_task.delay(str(parsed_doc.file_record_id))
    except Exception as exc:
        logger.warning(
            "解析完成后触发 RAG 索引失败 (file_record=%s): %s",
            parsed_doc.file_record_id, exc,
        )


def _emit_failed(parsed_doc: ParsedDocument, error: str) -> None:
    # 失败时不清除 dedup key — 让 TTL 自然过期，
    # 避免 Celery 重试窗口内产生重复任务投递。
    # W1 / L9：把 parsed_doc.failure_code 同步推送给前端 WebSocket 监听者，
    # 让 UI 能按结构化 failure_code 路由到 i18n 文案。
    try:
        from apps.services.docparse.events import publish_parse_failed
        publish_parse_failed(
            str(parsed_doc.file_record_id),
            error,
            failure_code=parsed_doc.failure_code or "",
        )
    except Exception:
        pass

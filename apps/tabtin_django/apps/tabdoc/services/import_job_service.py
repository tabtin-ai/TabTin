from __future__ import annotations

import json
import logging
from typing import Any
from uuid import UUID

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.services.docparse.models import DocumentImportJob
from apps.services.docparse.model_selection import (
    assert_model_selection_matches,
    build_model_selection_snapshot,
)
from apps.services.oss.models import FileRecord
from apps.tabdoc.services.document_service import DocumentService

logger = logging.getLogger(__name__)

_RESULT_INLINE_BYTES = 512 * 1024


class DocumentImportJobService(DocumentService):
    """TabDoc file import job orchestration.

    The service is intentionally limited to HTTP-safe work: permission checks,
    idempotent job creation, and Celery dispatch. Parsing and draft building run
    in docparse workers.
    """

    def create_job(
        self,
        *,
        organization_id: str,
        space_id: str | None = None,
        file_record_id: str,
        selected_model_id: UUID | str | None = None,
    ) -> tuple[DocumentImportJob, bool]:
        # ：只挂 Organization；space_id 列留空串以兼容唯一约束，不再做 Space 校验
        if space_id:
            logger.info(
                "create_job: ignoring deprecated space_id=%s (org-only )",
                space_id,
            )
        space_id_value = ""
        if not self.check_organization_permission(organization_id, required_role="editor"):
            raise PermissionError("tabdoc.no_permission_to_import")

        file_record = self._get_file_record(organization_id, file_record_id)
        if file_record.status != "completed":
            raise ValueError(f"文件尚未就绪或已被删除 (status={file_record.status})")
        if not file_record.file_size or file_record.file_size <= 0:
            raise ValueError("文件为空，请重新上传")

        existing = self._get_active_job(
            file_record.id,
            organization_id=organization_id,
            space_id=space_id_value,
        )
        if existing:
            assert_model_selection_matches(
                existing.request_payload,
                selected_model_id,
            )
            return existing, False

        request_payload = {
            "organization_id": organization_id,
            "space_id": space_id_value,
            "file_record_id": str(file_record.id),
            "user_id": str(getattr(self.user, "id", "") or ""),
            **build_model_selection_snapshot(selected_model_id),
        }

        try:
            with transaction.atomic():
                job = DocumentImportJob.objects.create(
                    file_record=file_record,
                    organization_id=organization_id,
                    space_id=space_id_value,
                    requested_by_id=request_payload["user_id"],
                    status=DocumentImportJob.Status.QUEUED,
                    stage=DocumentImportJob.Stage.VALIDATING,
                    request_payload=request_payload,
                )
        except IntegrityError:
            existing = self._get_active_job(
                file_record.id,
                organization_id=organization_id,
                space_id=space_id_value,
            )
            if existing:
                assert_model_selection_matches(
                    existing.request_payload,
                    selected_model_id,
                )
                return existing, False
            raise

        self._dispatch_job(job)
        return job, True

    def get_job(self, job_id: str) -> DocumentImportJob:
        job = (
            DocumentImportJob.objects
            .select_related("file_record", "parsed_document")
            .get(id=job_id)
        )
        self._assert_job_access(job, required_role="viewer")
        return job

    def get_result(self, job_id: str) -> DocumentImportJob:
        job = self.get_job(job_id)
        if job.status not in (
            DocumentImportJob.Status.READY,
            DocumentImportJob.Status.PARTIAL_READY,
        ):
            raise ValueError("导入任务尚未完成")
        return job

    def cancel_job(self, job_id: str) -> DocumentImportJob:
        self.get_job(job_id)
        with transaction.atomic():
            job = (
                DocumentImportJob.objects
                .select_for_update()
                .select_related("file_record")
                .get(id=job_id)
            )
            self._assert_job_access(job, required_role="editor")
            if job.status not in DocumentImportJob.ACTIVE_STATUSES:
                raise ValueError("只有排队或运行中的导入任务可以取消")
            job.status = DocumentImportJob.Status.CANCELLED
            job.error_code = "cancelled"
            job.error_message = "用户取消导入任务"
            job.lease_expires_at = None
            job.completed_at = timezone.now()
            job.save(update_fields=[
                "status", "error_code", "error_message", "lease_expires_at",
                "completed_at", "updated_at",
            ])
        from apps.services.docparse.service import _deactivate_import_job_asset_usages

        _deactivate_import_job_asset_usages(job.id)
        return job

    def retry_job(self, job_id: str) -> tuple[DocumentImportJob, bool]:
        job = self.get_job(job_id)
        self._assert_job_access(job, required_role="editor")
        if job.status not in (
            DocumentImportJob.Status.FAILED,
            DocumentImportJob.Status.INTERRUPTED,
            DocumentImportJob.Status.CANCELLED,
        ):
            raise ValueError("只有失败、中断或取消的导入任务可以重试")

        request = self._request_payload(job)
        retry, created = self.create_job(
            organization_id=request["organization_id"],
            space_id=request["space_id"] or None,
            file_record_id=request["file_record_id"],
        )
        if created:
            retry.retry_count = job.retry_count + 1
            retry.save(update_fields=["retry_count", "updated_at"])
        return retry, created

    def serialize_job(self, job: DocumentImportJob) -> dict[str, Any]:
        result_available = job.status in (
            DocumentImportJob.Status.READY,
            DocumentImportJob.Status.PARTIAL_READY,
        )
        return {
            "id": str(job.id),
            "file_record_id": str(job.file_record_id),
            "parsed_document_id": str(job.parsed_document_id) if job.parsed_document_id else None,
            "status": job.status,
            "stage": job.stage,
            "total_pages": job.total_pages,
            "processed_pages": job.processed_pages,
            "failed_pages": job.failed_pages,
            "retry_count": job.retry_count,
            "celery_task_id": job.celery_task_id or "",
            "worker_id": job.worker_id or "",
            "heartbeat_at": job.heartbeat_at.isoformat() if job.heartbeat_at else None,
            "lease_expires_at": job.lease_expires_at.isoformat() if job.lease_expires_at else None,
            "error_code": job.error_code or "",
            "error_message": job.error_message or "",
            "parser_version": job.parser_version or "",
            "result_available": result_available,
            "created_at": job.created_at.isoformat() if job.created_at else None,
            "updated_at": job.updated_at.isoformat() if job.updated_at else None,
            "started_at": job.started_at.isoformat() if job.started_at else None,
            "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        }

    def serialize_result(self, job: DocumentImportJob) -> dict[str, Any]:
        data = self.serialize_job(job)
        payload = job.result_payload or {}
        if job.result_storage_key:
            try:
                from apps.services.oss.services.factory import get_oss_service

                downloaded = get_oss_service().download_file(job.result_storage_key)
                if downloaded.get("success") is False:
                    raise RuntimeError(downloaded.get("message") or "OSS download failed")
                content = downloaded.get("content", b"")
                if not content and isinstance(downloaded.get("data"), dict):
                    content = downloaded["data"].get("content", b"")
                if not content:
                    raise RuntimeError("empty result payload")
                if isinstance(content, bytes):
                    content = content.decode("utf-8")
                data["result_payload"] = self._public_result_payload(json.loads(content or "{}"))
            except Exception as exc:
                logger.exception(
                    "failed to load import job result payload: job_id=%s key=%s",
                    job.id, job.result_storage_key,
                )
                data["result_payload"] = {
                    "omitted": True,
                    "reason": f"result_storage_unavailable: {exc}",
                }
            return data
        if len(json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")) > _RESULT_INLINE_BYTES:
            data["result_payload"] = {
                "omitted": True,
                "reason": "result_too_large",
            }
            return data
        data["result_payload"] = self._public_result_payload(payload)
        return data

    def _get_file_record(self, organization_id: str, file_record_id: str) -> FileRecord:
        try:
            return FileRecord.objects.get(
                pk=file_record_id,
                organization_id=organization_id,
            )
        except FileRecord.DoesNotExist:
            raise PermissionError("tabdoc.file_not_in_organization")

    def _get_active_job(
        self,
        file_record_id: str,
        *,
        organization_id: str,
        space_id: str = "",
    ) -> DocumentImportJob | None:
        return (
            DocumentImportJob.objects
            .select_related("file_record", "parsed_document")
            .filter(
                file_record_id=file_record_id,
                organization_id=organization_id,
                space_id=space_id or "",
                status__in=DocumentImportJob.ACTIVE_STATUSES,
            )
            .order_by("-created_at")
            .first()
        )

    def _assert_job_access(self, job: DocumentImportJob, *, required_role: str) -> None:
        request = self._request_payload(job)
        if request["space_id"]:
            self._ensure_space_context(request["organization_id"], request["space_id"])
        if not self.check_organization_permission(
            request["organization_id"],
            required_role=required_role,
        ):
            if required_role == "viewer":
                raise PermissionError("tabdoc.no_permission_to_view_import_job")
            raise PermissionError("tabdoc.no_permission_to_modify_import_job")

    def _request_payload(self, job: DocumentImportJob) -> dict[str, str]:
        request = job.request_payload or {}
        if not request:
            payload = job.result_payload or {}
            request = payload.get("request") if isinstance(payload, dict) else None
        if not isinstance(request, dict):
            request = {}
        organization_id = str(request.get("organization_id") or job.organization_id or "")
        # ：space_id 可为空（org-only 导入）；organization_id + file_record_id 必填
        space_id = str(request.get("space_id") or job.space_id or "")
        file_record_id = str(request.get("file_record_id") or job.file_record_id)
        if not organization_id or not file_record_id:
            raise ValueError("导入任务请求上下文不完整")
        return {
            "organization_id": organization_id,
            "space_id": space_id,
            "file_record_id": file_record_id,
        }

    def _public_result_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            return {}
        return {key: value for key, value in payload.items() if key != "request"}

    def _dispatch_job(self, job: DocumentImportJob) -> None:
        from apps.services.docparse.tasks import execute_document_import_job_task

        try:
            task = execute_document_import_job_task.apply_async(
                args=[str(job.id)],
                queue="docparse",
            )
        except Exception as exc:
            job.status = DocumentImportJob.Status.FAILED
            job.error_code = "enqueue_failed"
            job.error_message = str(exc)[:2000]
            job.completed_at = timezone.now()
            job.save(update_fields=[
                "status", "error_code", "error_message", "completed_at", "updated_at",
            ])
            logger.exception("failed to enqueue document import job: job_id=%s", job.id)
            raise

        job.celery_task_id = task.id or ""
        job.save(update_fields=["celery_task_id", "updated_at"])

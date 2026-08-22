"""
附件管理服务

封装 AITable 与 OSS 之间的附件上传、引用、复用逻辑：
- 创建/管理上传任务（基于 OSS UploadTask）
- 多分片上传、断点续传
- 附件引用同步、跨表复用、清理
"""

from __future__ import annotations

import copy
import math
import os
import logging
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID, uuid4

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone
from django.utils.text import slugify
from ninja import UploadedFile

from apps.tabdata.models import (
    Table,
    TableField,
    TableRecord,
    AttachmentUpload,
    AttachmentReference,
)
from apps.services.billing.services import OrganizationStorageBillingService
from apps.services.oss.constants import DANGEROUS_EXECUTABLE_MIMES, DANGEROUS_WEB_CONTENT_MIMES
from apps.services.oss.models import FileRecord, FileUsage, UploadTask
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.services.oss.services.file_access import resolve_authorized_file
from apps.services.oss.services.file_registry import SYSTEM_USER_UUID
from apps.services.oss.services.factory import get_oss_service
from apps.services.oss.utils.mime_utils import detect_mime_from_buffer, resolve_mime_type
from apps.services.common.utils import get_file_type_from_extension
from apps.tabdata.constants import TABDATA_DB_ALIAS, FILE_BASED_FIELD_TYPES
from apps.tabdata.history_events import emit_record_history_event, get_editor_type
from apps.tabdata.request_context import get_current_window_id
from apps.tabdata.services.base import BaseService
from apps.tabdata.utils.record_data_access import read_data, write_record_data

logger = logging.getLogger(__name__)


class AttachmentService(BaseService):
    """附件服务"""

    DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024  # 5MB
    OBJECT_KEY_SAFE_NAME_MAX_LEN = 60

    # ----------------------------
    # 上传任务相关
    # ----------------------------

    def create_upload_task(
        self,
        table_id: UUID,
        field_id: UUID,
        files: List[Dict[str, Any]],
        record_id: Optional[UUID] = None,
        task_type: str = 'chunk'
    ) -> Dict[str, Any]:
        """
        创建上传任务，并在数据库回滚时补偿已初始化的 OSS multipart。

        数据库事务无法回滚 OSS 外部副作用，因此事务必须在本方法内部结束：
        这样即使异常发生在 commit 阶段，也能在向 API 暴露可重试错误前终止
        已初始化的 multipart，保证客户端安全重放 POST。
        """
        oss_service = get_oss_service()
        initialized_multipart_uploads: List[Tuple[str, str]] = []

        try:
            return self._create_upload_task_transactional(
                table_id=table_id,
                field_id=field_id,
                files=files,
                record_id=record_id,
                task_type=task_type,
                oss_service=oss_service,
                initialized_multipart_uploads=initialized_multipart_uploads,
            )
        except Exception as create_error:
            cleanup_failed = False
            for object_key, upload_id in reversed(initialized_multipart_uploads):
                try:
                    abort_response = oss_service.abort_multipart_upload(object_key, upload_id)
                    if not abort_response.get('success'):
                        cleanup_failed = True
                        logger.error(
                            "创建附件上传任务失败后终止 multipart 失败: object_key=%s upload_id=%s error=%s",
                            object_key,
                            upload_id,
                            abort_response.get('message'),
                        )
                except Exception:
                    cleanup_failed = True
                    logger.exception(
                        "创建附件上传任务失败后终止 multipart 异常: object_key=%s upload_id=%s",
                        object_key,
                        upload_id,
                    )
            if cleanup_failed:
                # 不能证明 POST 的 OSS 副作用已补偿时，不再向 API 透出原始
                # retryable SQLSTATE，避免客户端重放并继续放大孤儿 multipart。
                raise RuntimeError(
                    "创建附件上传任务失败，且 OSS multipart 补偿未完成"
                ) from create_error
            raise

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def _create_upload_task_transactional(
        self,
        table_id: UUID,
        field_id: UUID,
        files: List[Dict[str, Any]],
        record_id: Optional[UUID],
        task_type: str,
        oss_service: Any,
        initialized_multipart_uploads: List[Tuple[str, str]],
    ) -> Dict[str, Any]:
        table, field, record = self._get_table_context(table_id, field_id, record_id, permission='editor')
        if field.field_type not in FILE_BASED_FIELD_TYPES:
            raise ValueError("目标字段不是附件类型")

        for f in files:
            declared_mime = (f.get('mime_type') or '').lower().strip()
            if declared_mime in self._DANGEROUS_MIME_TYPES:
                raise ValueError(
                    f"文件 {f.get('file_name', '?')} 的声明类型 {declared_mime} "
                    f"属于危险 MIME 类型，禁止上传"
                )

        organization_id = table.organization_id
        if not organization_id:
            raise ValueError("表格缺少组织信息")

        incoming_total_size = sum(file.get('file_size', 0) or 0 for file in files)
        if incoming_total_size > 0:
            OrganizationStorageBillingService.assert_storage_upload_allowed(
                organization_id=str(organization_id),
                incoming_bytes=int(incoming_total_size),
            )

        chunk_size_default = getattr(settings, 'TABDATA_ATTACHMENT_CHUNK_SIZE', self.DEFAULT_CHUNK_SIZE)

        upload_task = UploadTask.objects.using(TABDATA_DB_ALIAS).create(
            task_name=f"AITable-{table.name}-{timezone.now().strftime('%Y%m%d%H%M%S')}",
            task_type='chunk' if task_type not in ('single', 'chunk', 'batch') else task_type,
            total_files=len(files),
            total_size=incoming_total_size,
            created_by=str(self.user.id) if self.user else '',
            organization_id=str(organization_id),
        )

        responses: List[Dict[str, Any]] = []

        for file in files:
            file_name = file.get('file_name') or 'unnamed'
            file_size = int(file.get('file_size') or 0)
            if file_size <= 0:
                raise ValueError(f"文件 {file_name} 缺少有效的 file_size")

            chunk_size = int(file.get('chunk_size') or chunk_size_default)
            MIN_CHUNK_SIZE = 1048576  # 1MB
            MAX_TOTAL_PARTS = 1000
            if chunk_size < MIN_CHUNK_SIZE:
                chunk_size = max(chunk_size_default, MIN_CHUNK_SIZE)

            total_parts = max(1, math.ceil(file_size / chunk_size))
            if total_parts > MAX_TOTAL_PARTS:
                raise ValueError(
                    f"文件 {file_name} 分片数 {total_parts} 超过上限 {MAX_TOTAL_PARTS}，"
                    f"请增大 chunk_size（当前 {chunk_size}，文件大小 {file_size}）"
                )

            object_key = self._build_object_key(
                organization_id=str(organization_id),
                table_id=str(table.id),
                file_name=file_name
            )

            init_resp = oss_service.init_multipart_upload(
                object_key,
                content_type=file.get('mime_type', '')
            )
            if not init_resp.get('success'):
                raise RuntimeError(f"初始化分片上传失败: {init_resp.get('message')}")

            upload_id = (init_resp.get('data') or {}).get('upload_id')
            if not upload_id:
                raise RuntimeError("初始化分片上传失败: OSS 未返回 upload_id")
            initialized_multipart_uploads.append((object_key, upload_id))

            upload = AttachmentUpload.objects.using(TABDATA_DB_ALIAS).create(
                upload_task_id=upload_task.id,
                organization_id=organization_id,
                space_id=table.space_id,
                table=table,
                field=field,
                record=record,
                created_by=self.user if self.user else None,
                task_type=upload_task.task_type,
                file_name=file_name,
                file_size=file_size,
                chunk_size=chunk_size,
                mime_type=file.get('mime_type', ''),
                # Storage visibility is always private for new TabData assets.
                # Product-level access is granted by the table/share context
                # and resolved to a short-lived URL at read time.
                is_public=False,
                object_key=object_key,
                upload_id=upload_id,
                total_parts=total_parts,
                permission_scope=self._build_permission_scope(organization_id, table, field)
            )

            # 为每个分片生成预签名 PUT URL，前端可直传 OSS
            part_presigned_urls = {}
            try:
                gen_fn = getattr(oss_service, 'generate_part_presigned_url', None)
                if gen_fn:
                    for part_num in range(1, total_parts + 1):
                        part_url = gen_fn(object_key, upload_id, part_num, expiration=3600)
                        if part_url:
                            part_presigned_urls[part_num] = part_url
            except Exception as e:
                logger.warning("生成分片预签名 URL 失败，前端将回退到中转模式: %s", e)

            responses.append({
                'upload_item_id': str(upload.id),
                'file_name': file_name,
                'file_size': file_size,
                'chunk_size': chunk_size,
                'total_parts': total_parts,
                'object_key': object_key,
                'upload_id': upload.upload_id,
                'part_presigned_urls': part_presigned_urls,
                'direct_upload': bool(part_presigned_urls),
            })

        return {
            'task_id': str(upload_task.id),
            'files': responses,
            'task_type': upload_task.task_type
        }

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def upload_part(
        self,
        task_id: UUID,
        upload_item_id: UUID,
        part_number: int,
        chunk_file: UploadedFile
    ) -> Dict[str, Any]:
        """
        上传单个分片
        """
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            upload = AttachmentUpload.objects.select_for_update().using(TABDATA_DB_ALIAS).get(
                id=upload_item_id,
                upload_task_id=task_id
            )
            self._ensure_upload_permission(upload)

            if upload.status in ('completed', 'failed', 'cancelled'):
                raise ValueError("上传任务已结束，无法继续上传")
            if not upload.upload_id:
                raise ValueError("当前上传记录未初始化分片上传")

        chunk_content = chunk_file.read()
        if not chunk_content:
            raise ValueError("上传分片不能为空")

        oss_service = get_oss_service()
        resp = oss_service.upload_part(
            upload.object_key,
            upload.upload_id,
            part_number,
            chunk_content
        )
        if not resp.get('success'):
            upload.status = 'failed'
            upload.error_message = resp.get('message', '未知错误')
            upload.save(update_fields=['status', 'error_message', 'updated_at'])
            raise RuntimeError(upload.error_message)

        etag = resp['data']['etag']
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            upload = AttachmentUpload.objects.select_for_update().using(TABDATA_DB_ALIAS).get(
                id=upload_item_id,
                upload_task_id=task_id
            )
            part_list = [part for part in upload.part_etags if part['part_number'] != part_number]
            part_list.append({
                'part_number': part_number,
                'etag': etag,
                'size': len(chunk_content)
            })
            part_list.sort(key=lambda x: x['part_number'])

            upload.part_etags = part_list
            upload.completed_parts = len(part_list)
            upload.uploaded_size = sum(item['size'] for item in part_list)
            upload.status = 'uploading'
            upload.save(update_fields=['part_etags', 'completed_parts', 'uploaded_size', 'status', 'updated_at'])

        UploadTask.objects.using('default').filter(id=task_id).update(
            uploaded_size=F('uploaded_size') + len(chunk_content)
        )

        return {
            'upload_item_id': str(upload.id),
            'part_number': part_number,
            'etag': etag,
            'completed_parts': upload.completed_parts,
            'total_parts': upload.total_parts,
            'uploaded_size': upload.uploaded_size
        }

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def report_part_uploaded(
        self,
        task_id: UUID,
        upload_item_id: UUID,
        part_number: int,
        etag: str,
        part_size: int,
    ) -> Dict[str, Any]:
        """
        前端直传 OSS 后报告分片完成（不传文件内容，仅报告 etag）。
        """
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            upload = AttachmentUpload.objects.select_for_update().using(TABDATA_DB_ALIAS).get(
                id=upload_item_id,
                upload_task_id=task_id,
            )
            self._ensure_upload_permission(upload)

            if upload.status in ('completed', 'failed', 'cancelled'):
                raise ValueError("上传任务已结束")

            part_list = [p for p in upload.part_etags if p['part_number'] != part_number]
            part_list.append({
                'part_number': part_number,
                'etag': etag.strip('"'),
                'size': part_size,
            })
            part_list.sort(key=lambda x: x['part_number'])

            upload.part_etags = part_list
            upload.completed_parts = len(part_list)
            upload.uploaded_size = sum(item['size'] for item in part_list)
            upload.status = 'uploading'
            upload.save(update_fields=[
                'part_etags', 'completed_parts', 'uploaded_size', 'status', 'updated_at',
            ])

        UploadTask.objects.using('default').filter(id=task_id).update(
            uploaded_size=F('uploaded_size') + part_size,
        )

        return {
            'upload_item_id': str(upload.id),
            'part_number': part_number,
            'etag': etag,
            'completed_parts': upload.completed_parts,
            'total_parts': upload.total_parts,
            'uploaded_size': upload.uploaded_size,
        }

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def complete_upload(
        self,
        task_id: UUID,
        upload_item_id: UUID
    ) -> Dict[str, Any]:
        """
        完成分片上传，生成文件并创建引用
        """
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            upload = AttachmentUpload.objects.select_for_update().using(TABDATA_DB_ALIAS).get(
                id=upload_item_id,
                upload_task_id=task_id
            )
            self._ensure_upload_permission(upload)

            if upload.status == 'completed':
                return self._build_attachment_payload(upload)
            if upload.status in ('failed', 'cancelled'):
                raise ValueError("上传任务已失败或取消")

            if upload.total_parts and upload.completed_parts < upload.total_parts:
                raise ValueError("存在未上传完成的分片")

        oss_service = get_oss_service()
        parts_payload = [
            {'part_number': part['part_number'], 'etag': part['etag']}
            for part in sorted(upload.part_etags, key=lambda x: x['part_number'])
        ]
        complete_resp = oss_service.complete_multipart_upload(
            upload.object_key,
            upload.upload_id,
            parts_payload
        )
        if not complete_resp.get('success'):
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                upload = AttachmentUpload.objects.select_for_update().using(TABDATA_DB_ALIAS).get(
                    id=upload_item_id,
                    upload_task_id=task_id
                )
                upload.status = 'failed'
                upload.error_message = complete_resp.get('message', '')
                upload.save(update_fields=['status', 'error_message', 'updated_at'])
            raise RuntimeError(upload.error_message or "完成分片上传失败")

        file_info = oss_service.get_file_info(upload.object_key)
        if not file_info.get('success'):
            try:
                oss_service.delete_file(upload.object_key)
            except Exception:
                logger.warning("get_file_info 失败后清理 OSS 文件失败: %s", upload.object_key)
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                upload = AttachmentUpload.objects.select_for_update().using(
                    TABDATA_DB_ALIAS
                ).get(id=upload_item_id, upload_task_id=task_id)
                upload.status = 'failed'
                upload.error_message = f"获取文件信息失败: {file_info.get('message')}"
                upload.save(update_fields=['status', 'error_message', 'updated_at'])
            raise RuntimeError(f"获取文件信息失败: {file_info.get('message')}")

        file_data = file_info['data']

        private_acl_ok = oss_service.set_object_private(upload.object_key)
        if not private_acl_ok:
            try:
                oss_service.delete_file(upload.object_key)
            except Exception:
                logger.error("私有附件 ACL 失败后清理 OSS 文件失败: %s", upload.object_key)
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                upload = AttachmentUpload.objects.select_for_update().using(
                    TABDATA_DB_ALIAS
                ).get(id=upload_item_id, upload_task_id=task_id)
                upload.status = 'failed'
                upload.error_message = "私有附件访问权限设置失败，请检查 OSS Bucket/AK 权限"
                upload.save(update_fields=['status', 'error_message', 'updated_at'])
            raise RuntimeError(upload.error_message)

        # TDATA-5: MIME 头校验改为异步执行，避免同步 HTTP 请求（10s 超时）阻塞 Django 线程池。
        # 校验失败时异步标记 upload 为 failed 并清理 OSS 文件。
        header_check_url = oss_service.generate_presigned_url(
            upload.object_key,
            expiration=3600,
            method='GET',
        )
        if header_check_url:
            _upload_id = upload_item_id
            _task_id = task_id
            _object_key = upload.object_key
            _url = header_check_url
            _mime_type = upload.mime_type

            def _deferred_mime_check():
                try:
                    self._verify_file_header_mime_deferred(
                        upload_item_id=_upload_id,
                        task_id=_task_id,
                        object_key=_object_key,
                        access_url=_url,
                        declared_mime=_mime_type,
                    )
                except Exception as exc:
                    logger.error("异步 MIME 校验异常: upload=%s, err=%s", _upload_id, exc)

            transaction.on_commit(_deferred_mime_check, using=TABDATA_DB_ALIAS)

        storage_mime_type = (file_data.get('content_type') or '').strip().lower()
        if storage_mime_type and storage_mime_type != 'application/octet-stream':
            persisted_mime_type = storage_mime_type
        else:
            persisted_mime_type = (
                resolve_mime_type(upload.mime_type, upload.file_name)
                or storage_mime_type
                or 'application/octet-stream'
            )

        file_record = FileRecord.objects.using('default').create(
            file_name=upload.file_name,
            file_key=upload.object_key,
            file_path=os.path.dirname(upload.object_key),
            file_size=file_data.get('content_length', upload.file_size),
            file_type=get_file_type_from_extension(upload.file_name.split('.')[-1]),
            mime_type=persisted_mime_type,
            file_extension=upload.file_name.split('.')[-1].lower(),
            file_hash=complete_resp['data'].get('etag', ''),
            bucket_name=oss_service.config.get('bucket_name'),
            access_url=file_data.get('access_url') or complete_resp['data'].get('access_url', ''),
            cdn_url=complete_resp['data'].get('cdn_url', ''),
            is_public=False,
            upload_user=str(self.user.id) if self.user else '',
            upload_source='tabdata',
            status='completed',
            metadata={
                'organization_id': str(upload.organization_id),
                'space_id': str(upload.space_id) if upload.space_id else None,
                'table_id': str(upload.table_id),
                'field_id': str(upload.field_id),
                'record_id': str(upload.record_id) if upload.record_id else None
            },
            tags=['tabdata', upload.table.name]
        )

        try:
            FileUsage.add_usage(
                file_record=file_record,
                user_id=str(self.user.id) if self.user else SYSTEM_USER_UUID,
                module='tabdata',
                context_type='table_attachment',
                context_id=str(upload.table_id),
            )
        except Exception as exc:
            logger.warning(
                "FileUsage.add_usage 失败: file=%s, table=%s, err=%s",
                file_record.id, upload.table_id, exc,
            )

        with transaction.atomic(using=TABDATA_DB_ALIAS):
            upload = AttachmentUpload.objects.select_for_update().using(TABDATA_DB_ALIAS).get(
                id=upload_item_id,
                upload_task_id=task_id
            )
            # v0.1 §5.1：file_record 是软引用 property（无 setter），用 _id 字段赋值
            upload.file_record_id = file_record.id
            upload.status = 'completed'
            upload.updated_at = timezone.now()
            upload.save(update_fields=['file_record_id', 'status', 'updated_at'])

        upload_task = UploadTask.objects.using('default').get(id=upload.upload_task_id)
        upload_task.files.add(file_record)
        UploadTask.objects.using('default').filter(id=task_id).update(
            completed_files=F('completed_files') + 1
        )
        self._refresh_upload_task_status(upload_task)

        had_active_organization_ref = self._has_active_organization_file_reference(
            organization_id=str(upload.organization_id),
            file_id=str(file_record.id),
        )
        reference = self._ensure_reference(upload, file_record)
        if not had_active_organization_ref:
            self._record_storage_allocation(
                organization_id=str(upload.organization_id),
                file_record=file_record,
                biz_type='attachment_upload',
                biz_id=str(reference.id),
                metadata={
                    'table_id': str(upload.table_id),
                    'field_id': str(upload.field_id),
                    'record_id': str(upload.record_id) if upload.record_id else '',
                    'source': 'upload_complete',
                },
            )

        # 不再在 complete_upload 中直接写入记录数据（_attach_file_to_record），
        # 由前端 updateRecord → 后端 update_record → _sync_attachments 统一处理。
        # 这避免了前端 emitChange 触发的 updateRecord 导致的双写。

        return self._build_attachment_payload(upload)

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def abort_upload(self, task_id: UUID, upload_item_id: UUID) -> Dict[str, Any]:
        """取消上传"""
        upload = AttachmentUpload.objects.using(TABDATA_DB_ALIAS).select_for_update().get(id=upload_item_id, upload_task_id=task_id)
        self._ensure_upload_permission(upload)
        if upload.status in ('completed', 'cancelled'):
            return {'status': upload.status}

        oss_service = get_oss_service()
        if upload.upload_id:
            oss_service.abort_multipart_upload(upload.object_key, upload.upload_id)

        upload.status = 'cancelled'
        upload.save(update_fields=['status', 'updated_at'])
        UploadTask.objects.using('default').filter(id=task_id).update(
            failed_files=F('failed_files') + 1
        )
        upload_task = UploadTask.objects.using('default').get(id=upload.upload_task_id)
        self._refresh_upload_task_status(upload_task)
        return {'status': 'cancelled'}

    # ----------------------------
    # 删除清理
    # ----------------------------

    def cleanup_record_attachments(self, record_id: UUID) -> None:
        """记录软删除后批量清理其所有活跃附件引用。

        在 PG 事务内调用。AttachmentReference mark_deleted 立即执行（PG），
        FileUsage deactivation 和存储配额释放通过 on_commit 延迟到事务提交后执行（MySQL）。
        """
        refs = list(
            AttachmentReference.objects.using(TABDATA_DB_ALIAS)
            .filter(record_id=record_id, is_deleted=False)
        )
        if not refs:
            return
        self._bulk_cleanup_references(refs, source='record_delete')

    def cleanup_records_attachments_batch(self, record_ids: List[UUID]) -> None:
        """批量记录软删除后一次性清理所有活跃附件引用。

        将逐条 cleanup_record_attachments 的 O(N*M) 查询降为批量操作：
        一次查询获取所有 record_ids 的活跃引用，复用 _bulk_cleanup_references 处理。
        """
        if not record_ids:
            return
        refs = list(
            AttachmentReference.objects.using(TABDATA_DB_ALIAS)
            .filter(record_id__in=record_ids, is_deleted=False)
        )
        if not refs:
            return
        self._bulk_cleanup_references(refs, source='record_batch_delete')

    def cleanup_field_attachments(self, table_id: UUID, field_id: UUID) -> None:
        """字段删除时批量清理该字段所有活跃附件引用。

        在 PG 事务内调用。语义同 cleanup_record_attachments。
        """
        refs = list(
            AttachmentReference.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id, field_id=field_id, is_deleted=False)
        )
        if not refs:
            return
        self._bulk_cleanup_references(refs, source='field_delete')

    def _bulk_cleanup_references(
        self,
        refs: List[AttachmentReference],
        source: str,
    ) -> None:
        """批量清理附件引用的共享逻辑。

        1. 收集所有需要 deactivate / release 的 (table, file) 和 (organization, file) 对
        2. 批量 mark_deleted（PG）
        3. on_commit 调度 FileUsage deactivation 和存储配额释放（MySQL）
        """
        ref_ids = [ref.id for ref in refs]

        table_file_pairs: dict[tuple, None] = {}
        organization_file_map: dict[tuple, UUID] = {}
        for ref in refs:
            table_file_pairs[(ref.table_id, ref.file_id)] = None
            key = (str(ref.organization_id), ref.file_id)
            if key not in organization_file_map:
                organization_file_map[key] = ref.id

        now = timezone.now()
        AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            id__in=ref_ids,
        ).update(is_deleted=True, deleted_at=now, updated_at=now)

        table_files_to_deactivate = []
        for table_id, file_id in table_file_pairs:
            still_active = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                file_id=file_id,
                is_deleted=False,
            ).exists()
            if not still_active:
                table_files_to_deactivate.append((table_id, file_id))

        wt_files_to_release = []
        for (wt_str, file_id), first_ref_id in organization_file_map.items():
            still_active = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
                organization_id=wt_str,
                file_id=file_id,
                is_deleted=False,
            ).exists()
            if not still_active:
                wt_files_to_release.append((wt_str, file_id, first_ref_id))

        if table_files_to_deactivate or wt_files_to_release:
            _deactivate_pairs = list(table_files_to_deactivate)
            _release_triples = list(wt_files_to_release)
            _user = self.user
            _source = source

            def _post_commit():
                for tid, fid in _deactivate_pairs:
                    try:
                        self._deactivate_file_usage_for_table(tid, fid)
                    except Exception as exc:
                        logger.error(
                            "on_commit FileUsage deactivate 失败（需 reconciliation 修复）: "
                            "source=%s, table=%s, file=%s, err=%s",
                            _source, tid, fid, exc,
                        )
                for wt_id, fid, rid in _release_triples:
                    try:
                        file_record = self._get_file_record(fid)
                        if file_record:
                            self._record_storage_release(
                                organization_id=wt_id,
                                file_record=file_record,
                                biz_type=f'attachment_{_source}',
                                biz_id=str(rid),
                                metadata={'source': _source},
                            )
                    except Exception as exc:
                        logger.error(
                            "on_commit storage release 失败（需 reconciliation 修复）: "
                            "source=%s, organization=%s, file=%s, ref=%s, err=%s",
                            _source, wt_id, fid, rid, exc,
                        )

            transaction.on_commit(_post_commit, using=TABDATA_DB_ALIAS)

        logger.info(
            "批量清理附件引用: source=%s, count=%d, deactivate=%d, release=%d",
            source, len(refs), len(table_files_to_deactivate), len(wt_files_to_release),
        )

    # ----------------------------
    # 引用管理
    # ----------------------------

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def reuse_attachment(
        self,
        file_id: UUID,
        table_id: UUID,
        field_id: UUID,
        record_id: UUID
    ) -> Dict[str, Any]:
        """跨表复用附件"""
        table, field, record = self._get_table_context(table_id, field_id, record_id, permission='editor')
        if field.field_type not in FILE_BASED_FIELD_TYPES:
            raise ValueError("目标字段不是附件类型")

        file_record = FileRecord.objects.using('default').get(id=file_id, status='completed')
        organization_id = table.organization_id or record.table.organization_id
        self._ensure_file_record_can_bind_to_organization(
            file_record,
            organization_id,
        )
        self._ensure_file_record_source_access(
            file_record,
            target_table_id=table.id,
        )
        had_active_organization_ref = self._has_active_organization_file_reference(
            organization_id=str(organization_id) if organization_id else '',
            file_id=str(file_record.id),
        )
        if organization_id and not had_active_organization_ref:
            self._assert_organization_storage_capacity(
                organization_id=str(organization_id),
                incoming_bytes=int(file_record.file_size or 0),
                source='reuse',
            )
        reference = AttachmentReference.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=organization_id,
            space_id=table.space_id,
            table=table,
            field=field,
            record=record,
            file_id=file_record.id,
            created_by=self.user if self.user else None,
            permission_scope=self._build_permission_scope(organization_id, table, field),
            usage_metadata={'source': 'reuse'}
        )
        try:
            FileUsage.add_usage(
                file_record=file_record,
                user_id=str(self.user.id) if self.user else SYSTEM_USER_UUID,
                module='tabdata',
                context_type='table_attachment',
                context_id=str(table.id),
            )
        except Exception as exc:
            logger.warning(
                "FileUsage.add_usage 失败 (reuse): file=%s, table=%s, err=%s",
                file_record.id, table.id, exc,
            )
        if organization_id and not had_active_organization_ref:
            self._record_storage_allocation(
                organization_id=str(organization_id),
                file_record=file_record,
                biz_type='attachment_reuse',
                biz_id=str(reference.id),
                raise_on_error=True,
                metadata={
                    'table_id': str(table.id),
                    'field_id': str(field.id),
                    'record_id': str(record.id),
                    'source': 'reuse',
                },
            )

        self._attach_file_to_record(record, field, reference)
        return self._reference_to_dict(reference)

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def remove_reference(
        self,
        reference_id: UUID,
        delete_if_orphan: bool = False
    ) -> Dict[str, Any]:
        """移除附件引用"""
        reference = AttachmentReference.objects.using(TABDATA_DB_ALIAS).select_related('table', 'field', 'record').get(id=reference_id)
        self._ensure_table_permission(reference.table_id, 'editor')

        if reference.is_deleted:
            return {
                'reference_id': str(reference_id),
                'deleted_file_id': None
            }

        active_count_before = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            organization_id=reference.organization_id,
            file_id=reference.file_id,
            is_deleted=False
        ).count()

        reference.mark_deleted()
        if reference.record:
            self._detach_file_from_record(reference.record, reference.field, reference_id)

        removed_file_id = None
        file_record = self._get_file_record(reference.file_id)

        remaining_organization_refs = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            organization_id=reference.organization_id,
            file_id=reference.file_id,
            is_deleted=False
        ).exists()
        if active_count_before > 0 and not remaining_organization_refs and file_record:
            self._record_storage_release(
                organization_id=str(reference.organization_id),
                file_record=file_record,
                biz_type='attachment_unreference',
                biz_id=str(reference.id),
                metadata={
                    'table_id': str(reference.table_id),
                    'field_id': str(reference.field_id),
                    'record_id': str(reference.record_id) if reference.record_id else '',
                    'source': 'remove_reference',
                },
            )

        remaining_table_refs = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=reference.table_id,
            file_id=reference.file_id,
            is_deleted=False,
        ).exists()
        if not remaining_table_refs:
            self._deactivate_file_usage_for_table(reference.table_id, reference.file_id)

        if delete_if_orphan:
            remaining = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
                file_id=reference.file_id,
                is_deleted=False
            ).exists()
            if not remaining:
                oss_service = get_oss_service()
                if file_record:
                    oss_service.delete_file(file_record.file_key)
                    file_record.soft_delete()
                    removed_file_id = str(reference.file_id)

        return {
            'reference_id': str(reference_id),
            'deleted_file_id': removed_file_id
        }

    def list_record_attachments(self, record_id: UUID) -> List[Dict[str, Any]]:
        """列出记录附件"""
        references = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            record_id=record_id,
            is_deleted=False
        ).select_related('field', 'table')
        return [self._reference_to_dict(ref) for ref in references]

    def resolve_attachment_access(
        self,
        *,
        file_id: UUID,
        table_id: UUID,
        field_id: Optional[UUID] = None,
        record_id: Optional[UUID] = None,
        reference_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """按精确 TabData 引用上下文签发附件访问地址。

        ``file_id`` 只是稳定标识，不构成授权。调用者必须拥有表格读取权限，
        且文件必须存在于给定表/字段/记录（或明确引用）中。这样旧数据只剩
        ``file_id`` 时仍可恢复，同时不会把通用 OSS 文件接口放宽。
        """
        if not self.check_table_permission(str(table_id), 'viewer'):
            raise PermissionError("无权限访问该表格附件")

        reference_query = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            file_id=file_id,
            is_deleted=False,
            organization_id=F('table__organization_id'),
        )
        if field_id is not None:
            reference_query = reference_query.filter(field_id=field_id)
        if record_id is not None:
            reference_query = reference_query.filter(record_id=record_id)
        if reference_id is not None:
            reference_query = reference_query.filter(id=reference_id)

        reference = reference_query.first()
        if reference is None:
            raise AttachmentReference.DoesNotExist

        file_record = FileRecord.objects.using('default').filter(
            id=file_id,
            status='completed',
        ).first()
        if file_record is None or not self._reference_can_access_file(reference, file_record):
            raise FileRecord.DoesNotExist

        if file_record.is_public:
            url = build_public_asset_url(file_record.file_key) or file_record.access_url or ''
            expires_in = None
        else:
            accessible_file = resolve_authorized_file(file_record)
            url = accessible_file.url
            expires_in = accessible_file.expires_in

        return {
            'reference_id': str(reference.id),
            'file_id': str(file_record.id),
            'url': url,
            'expires_in': expires_in,
        }

    def can_access_existing_reference(self, file_record: FileRecord) -> bool:
        """兼容旧客户端：已有业务引用与表权限共同构成私有文件授权。"""
        if file_record.is_public:
            return True
        file_organization_id = str(file_record.organization_id or '')
        if not file_organization_id:
            return False
        table_ids = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            file_id=file_record.id,
            is_deleted=False,
            organization_id=F('table__organization_id'),
            table__organization_id=file_organization_id,
        ).values_list('table_id', flat=True)
        return Table.objects.using(TABDATA_DB_ALIAS).filter(
            id__in=table_ids,
        ).filter(
            self.build_table_permission_filter_q('viewer'),
        ).exists()

    def hydrate_authorized_records(
        self,
        records: List[Dict[str, Any]],
        *,
        table_id: UUID,
        visible_fields: List[TableField],
        field_key_type: str = 'name',
    ) -> List[Dict[str, Any]]:
        """Hydrate authorized record attachment cells with response-time URLs.

        The caller owns table/share authorization and supplies the already
        projected visible fields.  Only active references bound to the exact
        table + record + visible field are considered, preventing a share from
        turning an arbitrary ``file_id`` embedded in cell JSON into access.
        """
        if not records:
            return records

        attachment_fields = [
            field for field in visible_fields
            if field.field_type in FILE_BASED_FIELD_TYPES
        ]
        if not attachment_fields:
            return records

        hydrated = copy.deepcopy(records)
        records_by_id: Dict[str, Dict[str, Any]] = {}
        for record in hydrated:
            record_id = record.get('id') or record.get('record_id')
            if record_id:
                records_by_id[str(record_id)] = record
        if not records_by_id:
            return hydrated

        references = list(
            AttachmentReference.objects.using(TABDATA_DB_ALIAS)
            .filter(
                table_id=table_id,
                record_id__in=list(records_by_id.keys()),
                field_id__in=[field.id for field in attachment_fields],
                is_deleted=False,
            )
            .select_related('field')
            .order_by('created_at')
        )
        if not references:
            return hydrated

        file_records = {
            item.id: item
            for item in FileRecord.objects.filter(
                id__in={reference.file_id for reference in references},
                status='completed',
            )
        }
        payloads_by_cell: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for reference in references:
            field_key = (
                str(reference.field_id)
                if field_key_type == 'id'
                else reference.field.name
            )
            payloads_by_cell.setdefault(
                (str(reference.record_id), field_key), []
            ).append(self._reference_to_payload(reference, file_records))

        for (record_id, field_key), payloads in payloads_by_cell.items():
            record = records_by_id.get(record_id)
            if record is None:
                continue
            data = record.get('data')
            if isinstance(data, dict):
                data[field_key] = payloads
        return hydrated

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def sync_record_attachments(
        self,
        record: TableRecord,
        *,
        emit_history: bool = False,
    ) -> None:
        """
        将记录中的附件数据与引用表同步。

        常规记录写入已经由外层 create/update 生成用户可见历史；本方法仅负责
        认领引用和规范化持久化载荷（例如移除短期签名 URL），默认不能再写一条
        同字段历史，否则两条记录会被合并成错误的“附件 → 同一附件”。
        """
        # 协作 / native 落库用 field.id.hex；REST 可能用 dashed UUID 或字段名。
        table_fields_by_key: Dict[str, Any] = {}
        for field in record.table.fields.filter(is_deleted=False):
            table_fields_by_key[field.name] = field
            table_fields_by_key[str(field.id)] = field
            table_fields_by_key[field.id.hex] = field

        old_record_data = copy.deepcopy(read_data(record))
        record_data = copy.deepcopy(old_record_data)
        active_refs = {
            str(ref.id): ref
            for ref in AttachmentReference.objects.using(TABDATA_DB_ALIAS).select_related('field').filter(
                record=record, is_deleted=False
            )
        }

        # N+1 优化：预收集所有 file_id，一次批量加载 FileRecord
        all_file_ids: set = set()
        for ref in active_refs.values():
            if ref.file_id:
                all_file_ids.add(ref.file_id)
        for key, value in record_data.items():
            fld = table_fields_by_key.get(key)
            if not fld or fld.field_type not in FILE_BASED_FIELD_TYPES:
                continue
            for item in (value or []):
                if isinstance(item, dict) and item.get('file_id'):
                    try:
                        all_file_ids.add(UUID(str(item['file_id'])))
                    except (ValueError, AttributeError):
                        pass

        file_record_cache: Dict[UUID, FileRecord] = {}
        if all_file_ids:
            for fr in FileRecord.objects.using('default').filter(id__in=list(all_file_ids)):
                file_record_cache[fr.id] = fr

        updated = False
        seen_reference_ids = set()

        for key, value in list(record_data.items()):
            field = table_fields_by_key.get(key)
            if not field or field.field_type not in FILE_BASED_FIELD_TYPES:
                continue

            attachments = value or []
            normalized_list = []

            for item in attachments:
                if not isinstance(item, dict):
                    continue

                reference_id = item.get('reference_id')
                file_id = item.get('file_id')

                reference = None
                if reference_id and reference_id in active_refs:
                    reference = active_refs[reference_id]
                elif reference_id:
                    try:
                        orphan = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
                            id=reference_id,
                            record__isnull=True,
                            table=record.table,
                            field=field,
                            is_deleted=False,
                        ).first()
                        if orphan:
                            orphan.record = record
                            orphan.save(update_fields=['record', 'updated_at'])
                            active_refs[str(orphan.id)] = orphan
                            reference = orphan
                            updated = True
                    except Exception:
                        pass
                if not reference and file_id:
                    try:
                        fid = UUID(str(file_id))
                    except (ValueError, AttributeError):
                        fid = None
                    file_record = file_record_cache.get(fid) if fid else None
                    if file_record is None and fid:
                        file_record = self._get_file_record(fid)
                    if file_record:
                        if not self._file_record_can_bind_to_organization(
                            file_record,
                            record.table.organization_id,
                        ):
                            logger.warning(
                                "拒绝跨组织绑定私有附件: file=%s file_org=%s table=%s table_org=%s",
                                file_record.id,
                                file_record.organization_id,
                                record.table_id,
                                record.table.organization_id,
                            )
                            continue
                        if not self._can_access_file_source(
                            file_record,
                            target_table_id=record.table_id,
                        ):
                            logger.warning(
                                "拒绝复用无来源权限的私有附件: file=%s table=%s user=%s",
                                file_record.id,
                                record.table_id,
                                getattr(self.user, 'id', None),
                            )
                            continue
                        file_record_cache[file_record.id] = file_record
                        organization_id = record.table.organization_id
                        # TDATA-6: 使用 get_or_create 原子操作替代 filter+create，
                        # 并以 created 标志决定是否分配计费，消除并发双重计费窗口。
                        reference, ref_created = AttachmentReference.objects.using(
                            TABDATA_DB_ALIAS
                        ).get_or_create(
                            record=record,
                            field=field,
                            file_id=file_record.id,
                            is_deleted=False,
                            defaults={
                                'organization_id': record.table.organization_id,
                                'space_id': record.table.space_id,
                                'table': record.table,
                                'created_by': self.user if self.user else None,
                                'permission_scope': self._build_permission_scope(
                                    record.table.organization_id,
                                    record.table,
                                    field
                                ),
                                'usage_metadata': {'source': 'sync'},
                            },
                        )
                        if ref_created:
                            if organization_id:
                                self._assert_organization_storage_capacity(
                                    organization_id=str(organization_id),
                                    incoming_bytes=int(file_record.file_size or 0),
                                    source='sync',
                                )
                            try:
                                FileUsage.add_usage(
                                    file_record=file_record,
                                    user_id=str(self.user.id) if self.user else SYSTEM_USER_UUID,
                                    module='tabdata',
                                    context_type='table_attachment',
                                    context_id=str(record.table_id),
                                )
                            except Exception as exc:
                                logger.warning(
                                    "FileUsage.add_usage 失败 (sync): file=%s, table=%s, err=%s",
                                    file_record.id, record.table_id, exc,
                                )
                            if organization_id:
                                self._record_storage_allocation(
                                    organization_id=str(organization_id),
                                    file_record=file_record,
                                    biz_type='attachment_sync',
                                    biz_id=str(reference.id),
                                    raise_on_error=True,
                                    metadata={
                                        'table_id': str(record.table_id),
                                        'field_id': str(field.id),
                                        'record_id': str(record.id),
                                        'source': 'sync',
                                    },
                                )
                            active_refs[str(reference.id)] = reference
                            updated = True

                if reference:
                    seen_reference_ids.add(str(reference.id))
                    normalized_list.append(
                        self._reference_to_payload(
                            reference,
                            file_record_cache,
                            for_persistence=True,
                        )
                    )

            record_data[key] = normalized_list

        # 标记未使用的引用为已删除，收集需要 deactivate 的 pair 延迟到 on_commit 执行（避免 PG 事务内操作 MySQL）
        deferred_deactivate_pairs: List[Tuple] = []
        for reference_id, reference in active_refs.items():
            if reference_id not in seen_reference_ids:
                reference.mark_deleted()
                still_active = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=reference.table_id,
                    file_id=reference.file_id,
                    is_deleted=False,
                ).exists()
                if not still_active:
                    deferred_deactivate_pairs.append((reference.table_id, reference.file_id))
                updated = True

        if deferred_deactivate_pairs:
            _pairs = list(deferred_deactivate_pairs)

            def _sync_post_commit():
                for tid, fid in _pairs:
                    try:
                        self._deactivate_file_usage_for_table(tid, fid)
                    except Exception as exc:
                        logger.error(
                            "on_commit FileUsage deactivate 失败（需 reconciliation 修复）: "
                            "source=sync, table=%s, file=%s, err=%s",
                            tid, fid, exc,
                        )

            transaction.on_commit(_sync_post_commit, using=TABDATA_DB_ALIAS)

        field_changes = self._build_record_field_changes(old_record_data, record_data)
        if updated or field_changes:
            self._save_record_with_history_event(
                record=record,
                new_data=record_data,
                field_changes=field_changes if emit_history else {},
                action='update',
            )

    # ----------------------------
    # 工具方法
    # ----------------------------

    @staticmethod
    def _build_record_field_changes(
        old_data: Optional[Dict[str, Any]],
        new_data: Optional[Dict[str, Any]],
    ) -> Dict[str, Dict[str, Any]]:
        old_map = old_data or {}
        new_map = new_data or {}
        field_changes: Dict[str, Dict[str, Any]] = {}
        all_keys = set(old_map.keys()) | set(new_map.keys())

        for key in all_keys:
            old_value = old_map.get(key)
            new_value = new_map.get(key)
            if old_value != new_value:
                field_changes[str(key)] = {
                    "old": old_value,
                    "new": new_value,
                }

        return field_changes

    def _save_record_with_history_event(
        self,
        *,
        record: TableRecord,
        new_data: Dict[str, Any],
        field_changes: Dict[str, Any],
        action: str = "update",
        operation_group_id: Optional[UUID] = None,
        push_to_stack: bool = True,
    ) -> None:
        inherited_skip_history = bool(getattr(record, '_skip_record_history', False))
        from apps.tabdata.services.record_service import next_record_version
        fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=record.table_id, is_deleted=False))
        write_record_data(record, new_data, record.table, fields)
        record.version = next_record_version(record.table_id)
        record._skip_record_history = True
        try:
            record.save(update_fields=['data', 'version', 'updated_at'])
        finally:
            if inherited_skip_history:
                record._skip_record_history = True
            elif hasattr(record, '_skip_record_history'):
                delattr(record, '_skip_record_history')

        if inherited_skip_history or not field_changes:
            return

        emit_record_history_event(
            record=record,
            action=action,
            field_changes=field_changes,
            user=self.user,
            window_id=get_current_window_id(),
            operation_group_id=operation_group_id,
            push_to_stack=push_to_stack,
            editor_type=get_editor_type(),
            sender=self.__class__,
        )

    def _verify_file_header_mime_deferred(
        self,
        *,
        upload_item_id: UUID,
        task_id: UUID,
        object_key: str,
        access_url: str,
        declared_mime: str,
    ) -> None:
        """
        TDATA-5: 异步版 MIME 头校验。在 on_commit 后执行，不阻塞 Django 请求线程。
        校验失败时标记 upload 为 failed 并清理 OSS 文件。
        """
        try:
            import requests as _requests

            resp = _requests.get(
                access_url, headers={'Range': 'bytes=0-8191'}, timeout=10
            )
            if resp.status_code not in (200, 206) or not resp.content:
                logger.warning(
                    "异步 MIME 校验无法下载文件头: status=%s, key=%s",
                    resp.status_code, object_key,
                )
                return

            real_mime = detect_mime_from_buffer(
                resp.content,
                fallback=declared_mime or 'application/octet-stream',
            )
            if not real_mime:
                return

            if real_mime in self._DANGEROUS_MIME_TYPES:
                logger.warning(
                    "异步 MIME 校验拒绝: real=%s, declared=%s, key=%s",
                    real_mime, declared_mime, object_key,
                )
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    AttachmentUpload.objects.using(TABDATA_DB_ALIAS).filter(
                        id=upload_item_id, upload_task_id=task_id,
                    ).update(
                        status='failed',
                        error_message=f'文件真实类型 {real_mime} 不通过安全校验',
                        updated_at=timezone.now(),
                    )
                try:
                    get_oss_service().delete_file(object_key)
                except Exception:
                    logger.warning("异步 MIME 校验拒绝后删除 OSS 文件失败: %s", object_key)
        except Exception as exc:
            logger.warning("异步 MIME 头校验失败（非阻塞）: %s", exc)

    def _get_table_context(
        self,
        table_id: UUID,
        field_id: UUID,
        record_id: Optional[UUID],
        permission: str
    ) -> Tuple[Table, TableField, Optional[TableRecord]]:
        if not self.check_table_permission(str(table_id), permission):
            raise PermissionError("无权限操作该表格")

        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=field_id, table=table, is_deleted=False)
        record = None
        if record_id:
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id, table=table, is_deleted=False)
        return table, field, record

    def _ensure_upload_permission(self, upload: AttachmentUpload) -> None:
        self._ensure_table_permission(upload.table_id, 'editor')

    def _ensure_table_permission(self, table_id: UUID, role: str) -> None:
        if not self.check_table_permission(str(table_id), role):
            raise PermissionError("无权限执行该操作")

    # Extensions that should not be stored as-is (executable/script types)
    _BLOCKED_EXTENSIONS = frozenset({
        # Windows executables / installers
        '.exe', '.msi', '.scr', '.com', '.dll', '.sys',
        # Windows / PowerShell scripts
        '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.wsf', '.wsh', '.hta', '.reg',
        # Web scripts / XSS vectors
        '.html', '.htm', '.xhtml', '.shtml', '.svg',
        '.js', '.mjs', '.cjs',
        # Server-side scripts
        '.php', '.phtml', '.phar', '.pht',
        '.asp', '.aspx',
        '.jsp', '.jspx',
        '.cgi',
        # Unix / macOS shell scripts
        '.sh', '.bash', '.zsh', '.csh', '.ksh',
        # Scripting languages
        '.py', '.pyc', '.pyw',
        '.rb',
        '.pl', '.pm',
        # Java archives (executable code)
        '.jar', '.war',
    })

    _DANGEROUS_MIME_TYPES = DANGEROUS_EXECUTABLE_MIMES | DANGEROUS_WEB_CONTENT_MIMES

    def _build_object_key(self, organization_id: str, table_id: str, file_name: str) -> str:
        safe_name = slugify(os.path.splitext(file_name)[0]) or uuid4().hex
        if len(safe_name) > self.OBJECT_KEY_SAFE_NAME_MAX_LEN:
            safe_name = safe_name[: self.OBJECT_KEY_SAFE_NAME_MAX_LEN]
        extension = os.path.splitext(file_name)[1].lower()
        if extension in self._BLOCKED_EXTENSIONS:
            extension = extension + '.blocked'
            logger.warning("Blocked dangerous extension in upload: %s (organization=%s)", file_name, organization_id)
        timestamp = timezone.now().strftime('%Y%m%d%H%M%S')
        return f"tabdata/{organization_id}/{table_id}/{timestamp}_{uuid4().hex[:8]}_{safe_name}{extension}"

    def _build_permission_scope(self, organization_id: Optional[UUID], table: Table, field: TableField) -> Dict[str, Any]:
        return {
            'organization_id': str(organization_id) if organization_id else None,
            'table_id': str(table.id),
            'field_id': str(field.id),
            'table_is_public': table.is_public,
            'field_visibility_roles': field.visibility_roles if hasattr(field, 'visibility_roles') else []
        }

    @staticmethod
    def _file_record_can_bind_to_organization(
        file_record: FileRecord,
        organization_id: Optional[UUID],
    ) -> bool:
        """Private files may only be bound inside their owning organization."""
        if file_record.is_public:
            return True
        file_organization_id = str(file_record.organization_id or "")
        target_organization_id = str(organization_id or "")
        return bool(
            file_organization_id
            and target_organization_id
            and file_organization_id == target_organization_id
        )

    @classmethod
    def _ensure_file_record_can_bind_to_organization(
        cls,
        file_record: FileRecord,
        organization_id: Optional[UUID],
    ) -> None:
        if not cls._file_record_can_bind_to_organization(file_record, organization_id):
            raise PermissionError("附件不属于当前组织")

    def _can_access_file_source(
        self,
        file_record: FileRecord,
        *,
        target_table_id: UUID,
    ) -> bool:
        """Require an existing business grant; a private file UUID is not one."""
        if file_record.is_public:
            return True
        user_id = str(getattr(self.user, 'id', '') or '')
        if user_id and str(file_record.upload_user or '') == user_id:
            return True
        file_organization_id = str(file_record.organization_id or '')
        if not file_organization_id:
            return False
        source_table_ids = set(
            AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
                file_id=file_record.id,
                is_deleted=False,
                organization_id=F('table__organization_id'),
                table__organization_id=file_organization_id,
            ).values_list('table_id', flat=True).distinct()
        )
        if target_table_id in source_table_ids:
            return True
        return any(
            self.check_table_permission(str(source_table_id), 'viewer')
            for source_table_id in source_table_ids
        )

    def _ensure_file_record_source_access(
        self,
        file_record: FileRecord,
        *,
        target_table_id: UUID,
    ) -> None:
        if not self._can_access_file_source(
            file_record,
            target_table_id=target_table_id,
        ):
            raise PermissionError("无权复用该附件")

    @classmethod
    def _reference_can_access_file(
        cls,
        reference: AttachmentReference,
        file_record: FileRecord,
    ) -> bool:
        table_organization_id = Table.objects.using(TABDATA_DB_ALIAS).filter(
            id=reference.table_id,
        ).values_list('organization_id', flat=True).first()
        if str(reference.organization_id or '') != str(table_organization_id or ''):
            return False
        if cls._file_record_can_bind_to_organization(
            file_record,
            table_organization_id,
        ):
            return True
        if file_record.is_public or file_record.organization_id:
            return False
        reference_organizations = set(
            str(value)
            for value in AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
                file_id=file_record.id,
                is_deleted=False,
                organization_id=F('table__organization_id'),
            ).values_list('table__organization_id', flat=True).distinct()
        )
        return reference_organizations == {str(table_organization_id)}

    def _assert_organization_storage_capacity(
        self,
        *,
        organization_id: str,
        incoming_bytes: int,
        source: str,
    ) -> None:
        if not organization_id or incoming_bytes <= 0:
            return
        try:
            OrganizationStorageBillingService.assert_storage_upload_allowed(
                organization_id=organization_id,
                incoming_bytes=int(incoming_bytes),
            )
        except ValueError as exc:
            raise ValueError(f"附件空间校验失败（{source}）：{exc}") from exc

    def _ensure_reference(self, upload: AttachmentUpload, file_record: FileRecord) -> AttachmentReference:
        reference, _ = AttachmentReference.objects.using(TABDATA_DB_ALIAS).get_or_create(
            record=upload.record,
            field=upload.field,
            table=upload.table,
            organization_id=upload.organization_id,
            space_id=upload.space_id,
            file_id=file_record.id,
            defaults={
                'upload': upload,
                'created_by': self.user if self.user else None,
                'permission_scope': upload.permission_scope,
                'usage_metadata': {'source': 'upload_complete'}
            }
        )
        if reference.is_deleted:
            reference.is_deleted = False
            reference.deleted_at = None
            reference.upload = upload
            reference.save(update_fields=['is_deleted', 'deleted_at', 'upload', 'updated_at'])
        return reference

    def _has_active_organization_file_reference(self, organization_id: str, file_id: str) -> bool:
        if not organization_id or not file_id:
            return False
        return AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            organization_id=organization_id,
            file_id=file_id,
            is_deleted=False
        ).exists()

    def _record_storage_allocation(
        self,
        *,
        organization_id: str,
        file_record: FileRecord,
        biz_type: str,
        biz_id: str,
        raise_on_error: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not organization_id or not file_record:
            return
        try:
            OrganizationStorageBillingService.apply_storage_delta(
                organization_id=organization_id,
                file_id=str(file_record.id),
                delta_bytes=int(file_record.file_size or 0),
                user_id=str(self.user.id) if self.user else "",
                biz_type=biz_type,
                biz_id=biz_id,
                metadata=metadata or {},
            )
        except Exception as exc:
            logger.warning("记录附件空间分配失败: %s", exc)
            try:
                from apps.services.billing.services.degradation_tracker import track_billing_degradation
                track_billing_degradation(meter_key="storage.upload", organization_id=organization_id, biz_type=biz_type, error=str(exc))
            except Exception:
                pass
            if raise_on_error:
                raise

    def _record_storage_release(
        self,
        *,
        organization_id: str,
        file_record: FileRecord,
        biz_type: str,
        biz_id: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not organization_id or not file_record:
            return
        try:
            OrganizationStorageBillingService.apply_storage_delta(
                organization_id=organization_id,
                file_id=str(file_record.id),
                delta_bytes=-int(file_record.file_size or 0),
                user_id=str(self.user.id) if self.user else "",
                biz_type=biz_type,
                biz_id=biz_id,
                metadata=metadata or {},
            )
        except Exception as exc:
            logger.warning("记录附件空间释放失败: %s", exc)
            try:
                from apps.services.billing.services.degradation_tracker import track_billing_degradation
                track_billing_degradation(meter_key="storage.release", organization_id=organization_id, biz_type=biz_type, error=str(exc))
            except Exception:
                pass

    def _attach_file_to_record(self, record: TableRecord, field: TableField, reference: AttachmentReference) -> None:
        record_data = copy.deepcopy(read_data(record))
        # ⭐ 统一使用字段 UUID 作为 key
        key = str(field.id)
        attachments = list(record_data.get(key, []))
        old_attachments = copy.deepcopy(attachments)
        payload = self._reference_to_payload(reference, for_persistence=True)

        if payload not in attachments:
            attachments.append(payload)
            new_attachments = copy.deepcopy(attachments)
            record_data[key] = new_attachments
            self._save_record_with_history_event(
                record=record,
                new_data=record_data,
                field_changes={
                    key: {
                        'old': old_attachments,
                        'new': new_attachments,
                    }
                },
                action='update',
            )

    def _detach_file_from_record(self, record: TableRecord, field: TableField, reference_id: UUID) -> None:
        record_data = copy.deepcopy(read_data(record))
        # ⭐ 统一使用字段 UUID 作为 key
        key = str(field.id)
        attachments = list(record_data.get(key, []))
        old_attachments = copy.deepcopy(attachments)
        new_attachments = [item for item in attachments if str(item.get('reference_id')) != str(reference_id)]
        if len(new_attachments) != len(attachments):
            record_data[key] = new_attachments
            self._save_record_with_history_event(
                record=record,
                new_data=record_data,
                field_changes={
                    key: {
                        'old': old_attachments,
                        'new': new_attachments,
                    }
                },
                action='update',
            )

    def _reference_to_payload(
        self,
        reference: AttachmentReference,
        file_record_cache: Optional[Dict[UUID, 'FileRecord']] = None,
        *,
        for_persistence: bool = False,
    ) -> Dict[str, Any]:
        if file_record_cache is not None and reference.file_id in file_record_cache:
            file_record = file_record_cache[reference.file_id]
        else:
            file_record = self._get_file_record(reference.file_id)
        payload = {
            'reference_id': str(reference.id),
            'file_id': str(reference.file_id),
            'name': '',
            'url': '',
            'size': 0,
            'mime_type': '',
            'bucket': '',
            'key': '',
            'extra': reference.usage_metadata or {}
        }
        if file_record:
            if not self._reference_can_access_file(reference, file_record):
                logger.warning(
                    "拒绝为跨组织私有附件签发访问地址: reference=%s file=%s file_org=%s reference_org=%s",
                    reference.id,
                    file_record.id,
                    file_record.organization_id,
                    reference.organization_id,
                )
                file_record = None

        if file_record:
            if file_record.is_public:
                access_url = build_public_asset_url(file_record.file_key) or file_record.access_url
            elif for_persistence:
                # Private delivery URLs are short-lived capabilities. Persist
                # only the stable file_id and resolve a fresh URL after the
                # table/member/share authorization check on every read.
                access_url = ''
            else:
                access_url = resolve_authorized_file(file_record).url
            payload.update({
                'name': file_record.file_name,
                'url': access_url,
                'size': file_record.file_size,
                'mime_type': file_record.mime_type,
                'bucket': file_record.bucket_name,
                'key': file_record.file_key,
            })

        return payload

    def _reference_to_dict(self, reference: AttachmentReference) -> Dict[str, Any]:
        payload = self._reference_to_payload(reference)
        payload.update({
            'table_id': str(reference.table_id),
            'field_id': str(reference.field_id),
            'record_id': str(reference.record_id) if reference.record_id else None,
            'created_at': reference.created_at.isoformat(),
            'updated_at': reference.updated_at.isoformat(),
            'created_by': str(reference.created_by_id) if reference.created_by_id else None
        })
        return payload

    def _build_attachment_payload(self, upload: AttachmentUpload) -> Dict[str, Any]:
        reference = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            record=upload.record,
            field=upload.field,
            file_id=upload.file_record_id,
            is_deleted=False
        ).first()
        return {
            'upload_item_id': str(upload.id),
            'file_id': str(upload.file_record_id) if upload.file_record_id else None,
            'reference': self._reference_to_dict(reference) if reference else None,
            'status': upload.status
        }

    def _get_file_record(self, file_id: Optional[UUID]) -> Optional[FileRecord]:
        if not file_id:
            return None
        return FileRecord.objects.using('default').filter(id=file_id).first()

    def _deactivate_file_usage_for_table(self, table_id, file_id) -> None:
        """Deactivate 指定表中某文件的 FileUsage（该文件在此表已无活跃引用时调用）。"""
        try:
            usages = FileUsage.objects.filter(
                file_record_id=file_id,
                module='tabdata',
                context_type='table_attachment',
                context_id=str(table_id),
                is_active=True,
            )
            for usage in usages:
                usage.deactivate()
        except Exception as exc:
            logger.warning(
                "deactivate FileUsage 失败: table=%s, file=%s, err=%s",
                table_id, file_id, exc,
            )

    @classmethod
    def deactivate_all_table_file_usages(cls, table_id: UUID) -> int:
        """批量 deactivate 指定表格的所有 FileUsage。供表格永久删除时外部调用。"""
        try:
            usages = FileUsage.objects.filter(
                module='tabdata',
                context_type='table_attachment',
                context_id=str(table_id),
                is_active=True,
            )
            count = 0
            for usage in usages:
                usage.deactivate()
                count += 1
            if count:
                logger.info("已 deactivate %d 条 FileUsage: table=%s", count, table_id)
            return count
        except Exception as exc:
            logger.warning("批量 deactivate FileUsage 失败: table=%s, err=%s", table_id, exc)
            return 0

    def _refresh_upload_task_status(self, task: UploadTask) -> None:
        task = UploadTask.objects.using('default').get(id=task.id)
        total = task.total_files or 1
        progress = (task.completed_files / total) * 100
        updates = {'progress': progress, 'updated_at': timezone.now()}

        if task.completed_files >= task.total_files and task.status != 'completed':
            updates['status'] = 'completed'
            updates['completed_at'] = timezone.now()
        elif task.failed_files > 0 and task.status not in ('failed', 'cancelled'):
            updates['status'] = 'failed'
        elif task.uploaded_size > 0 and task.status == 'pending':
            updates['status'] = 'processing'

        UploadTask.objects.using('default').filter(id=task.id).update(**updates)

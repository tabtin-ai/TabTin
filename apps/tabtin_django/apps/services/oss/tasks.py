"""
OSS对象存储服务Celery异步任务
"""

from celery import shared_task
from celery.schedules import crontab
from typing import Dict, Any, List, Optional
from django.db import models
from django.utils import timezone
from django.core.files.uploadedfile import InMemoryUploadedFile, TemporaryUploadedFile
from datetime import datetime, timedelta
import logging
import os
import uuid
import hashlib
import requests
from io import BytesIO

OSS_BEAT_SCHEDULE = {
    "oss-cleanup-old-upload-tasks": {
        "task": "apps.services.oss.tasks.cleanup_old_upload_tasks",
        "schedule": crontab(hour=3, minute=0),
        "options": {"queue": "default"},
    },
    "oss-cleanup-orphan-files": {
        "task": "apps.services.oss.tasks.cleanup_orphan_files",
        "schedule": crontab(hour=4, minute=0),
        "options": {"queue": "default"},
    },
    "oss-reconcile-file-usages": {
        "task": "apps.services.oss.tasks.reconcile_file_usages_task",
        "schedule": crontab(hour=2, minute=30, day_of_week="monday"),
        "options": {"queue": "default"},
    },
}

_SYNC_MODE_MAX_FILE_SIZE = 50 * 1024 * 1024  # sync_mode 单文件上限 50MB

from .models import FileRecord, FileUsage, UploadTask
from .services.factory import get_oss_service
from .utils.mime_utils import detect_mime_from_file, extension_for_mime, normalize_mime_type
from apps.services.common.exceptions import OSSServiceException
from apps.services.common.utils import generate_request_id, get_file_type_from_extension

logger = logging.getLogger(__name__)


def _apply_file_usage_and_billing(
    file_record,
    file_size: int,
    *,
    organization_id: str = "",
    user_id: str = "",
    module: str = "",
    context_type: str = "",
    context_id: str = "",
    biz_type: str = "oss_upload",
) -> None:
    """为新上传的文件创建 FileUsage 并触发存储计费（失败不阻断主流程）。"""
    effective_uid = str(user_id) if user_id else str(uuid.uuid4())
    ownership_updates = []
    if organization_id and file_record.organization_id != organization_id:
        file_record.organization_id = organization_id
        ownership_updates.append("organization_id")
    if user_id and not file_record.upload_user:
        file_record.upload_user = str(user_id)
        ownership_updates.append("upload_user")
    if ownership_updates:
        file_record.save(update_fields=ownership_updates)

    if module:
        if not context_id:
            logger.warning(
                "post_upload_bookkeeping: 缺少 context_id，跳过 FileUsage 创建 "
                "(file_record=%s, module=%s, biz_type=%s)",
                file_record.pk, module, biz_type,
            )
        else:
            try:
                from .models import FileUsage
                FileUsage.add_usage(
                    file_record=file_record,
                    user_id=effective_uid,
                    module=module,
                    context_type=context_type,
                    context_id=context_id,
                )
            except Exception as exc:
                logger.warning("FileUsage 创建失败 (%s): %s", biz_type, exc)

    if organization_id and file_size > 0:
        try:
            from apps.services.billing.services import OrganizationStorageBillingService
            OrganizationStorageBillingService.apply_storage_delta(
                organization_id=organization_id,
                file_id=str(file_record.id),
                delta_bytes=int(file_size),
                user_id=effective_uid,
                biz_type=biz_type,
                biz_id=str(file_record.id),
            )
        except Exception as exc:
            logger.warning("存储计量失败 (%s): %s", biz_type, exc)
            try:
                from apps.services.billing.services.degradation_tracker import track_billing_degradation
                track_billing_degradation(meter_key="storage.async_upload", organization_id=organization_id, biz_type=biz_type, error=str(exc))
            except Exception:
                pass


def _check_storage_quota(organization_id: str, file_size: int) -> bool:
    """检查存储配额是否足够。返回 True 表示允许，False 表示配额不足或被计费防护阻断。"""
    if not organization_id or file_size <= 0:
        return True
    try:
        from apps.services.billing.services import OrganizationStorageBillingService
        OrganizationStorageBillingService.assert_storage_upload_allowed(
            organization_id=organization_id,
            incoming_bytes=file_size,
        )
        return True
    except ValueError as exc:
        logger.warning("存储配额预检未通过 (organization=%s, size=%d): %s", organization_id, file_size, exc)
        return False
    except Exception as exc:
        from apps.services.billing.services.guard_service import BillingBlockedError
        if isinstance(exc, BillingBlockedError):
            logger.warning("计费防护阻断 (organization=%s, size=%d): %s", organization_id, file_size, exc)
            return False
        raise


@shared_task(bind=True, max_retries=3, default_retry_delay=60, time_limit=600, soft_time_limit=560)
def upload_file_async(self, file_path: str, object_key: str,
                     task_id: str = None, **kwargs) -> Dict[str, Any]:
    """
    异步上传单个文件任务

    Args:
        file_path: 本地文件路径
        object_key: OSS对象键
        task_id: 关联的上传任务ID
        **kwargs: 其他参数

    Returns:
        Dict: 上传结果
    """
    try:
        logger.info(f"开始异步上传文件任务", extra={
            'task_id': self.request.id,
            'file_path': file_path,
            'object_key': object_key,
            'upload_task_id': task_id
        })

        # 检查文件是否存在
        if not os.path.exists(file_path):
            raise OSSServiceException(f"文件不存在: {file_path}")

        file_size = os.path.getsize(file_path)
        file_name = os.path.basename(file_path)
        file_extension = os.path.splitext(file_name)[1].lower().lstrip('.')

        md5 = hashlib.md5()
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                md5.update(chunk)
        file_hash = md5.hexdigest()

        mime_type = detect_mime_from_file(file_path)

        oss_service = get_oss_service()
        file_record = FileRecord.objects.filter(
            metadata__celery_task_id=self.request.id,
            status__in=['uploading', 'failed'],
        ).first()
        if file_record:
            file_record.status = 'uploading'
            meta = file_record.metadata or {}
            meta.pop('error_message', None)
            file_record.metadata = meta
            file_record.save(update_fields=['status', 'metadata', 'updated_at'])
        else:
            file_record = FileRecord.objects.create(
                file_name=file_name,
                file_key=object_key,
                file_path=os.path.dirname(object_key),
                file_size=file_size,
                file_type=get_file_type_from_extension(file_extension),
                mime_type=mime_type,
                file_extension=file_extension,
                file_hash=file_hash,
                bucket_name=oss_service.config.get('bucket_name'),
                is_public=kwargs.get('is_public', True),
                upload_source='async_task',
                tags=kwargs.get('tags', []),
                metadata={
                    'celery_task_id': self.request.id,
                    'upload_task_id': task_id,
                    'upload_method': 'async'
                },
                status='uploading'
            )

        # 上传文件到OSS
        upload_result = oss_service.upload_file_from_path(
            file_path,
            object_key,
            content_type=mime_type
        )

        if not upload_result['success']:
            file_record.mark_as_failed(upload_result['message'])
            raise OSSServiceException(f"文件上传失败: {upload_result['message']}")

        file_record.mark_as_completed(
            access_url=upload_result['data']['access_url'],
            cdn_url=upload_result['data'].get('cdn_url', '')
        )

        _apply_file_usage_and_billing(
            file_record, file_size,
            organization_id=kwargs.get('organization_id', ''),
            user_id=kwargs.get('user_id', ''),
            module=kwargs.get('module', ''),
            context_type=kwargs.get('context_type', ''),
            context_id=kwargs.get('context_id', ''),
            biz_type="oss_async_upload",
        )

        if task_id:
            try:
                ut = UploadTask.objects.filter(id=task_id)
                if ut.exists():
                    ut.first().files.add(file_record)
                    ut.update(
                        completed_files=models.F('completed_files') + 1,
                        uploaded_size=models.F('uploaded_size') + file_size,
                    )
                    refreshed = UploadTask.objects.get(id=task_id)
                    refreshed.update_progress()
                    if refreshed.completed_files + refreshed.failed_files >= refreshed.total_files:
                        refreshed.mark_as_completed()
                else:
                    logger.warning(f"上传任务不存在: {task_id}")
            except UploadTask.DoesNotExist:
                logger.warning(f"上传任务不存在: {task_id}")

        logger.info(f"异步文件上传成功", extra={
            'task_id': self.request.id,
            'file_id': str(file_record.id),
            'object_key': object_key
        })

        return {
            'success': True,
            'message': '文件上传成功',
            'data': {
                'file_id': str(file_record.id),
                'file_name': file_record.file_name,
                'file_key': file_record.file_key,
                'file_size': file_record.file_size,
                'mime_type': file_record.mime_type,
                'access_url': file_record.access_url,
                'cdn_url': file_record.cdn_url
            }
        }

    except OSSServiceException as e:
        logger.error(f"OSS服务异常: {e}", extra={'task_id': self.request.id})

        if task_id:
            UploadTask.objects.filter(id=task_id).update(
                failed_files=models.F('failed_files') + 1)

        if self.request.retries < self.max_retries:
            logger.info(f"准备重试上传文件，重试次数: {self.request.retries + 1}")
            raise self.retry(countdown=60 * (2 ** self.request.retries))

        return {'success': False, 'message': f'OSS服务异常: {e}'}

    except Exception as e:
        logger.error(f"异步上传文件任务异常: {e}", exc_info=True, extra={'task_id': self.request.id})

        if task_id:
            UploadTask.objects.filter(id=task_id).update(
                failed_files=models.F('failed_files') + 1)

        if self.request.retries < self.max_retries:
            logger.info(f"准备重试上传文件，重试次数: {self.request.retries + 1}")
            raise self.retry(countdown=60 * (2 ** self.request.retries))

        return {'success': False, 'message': f'上传失败: {e}'}


@shared_task(bind=True, max_retries=2, time_limit=1800, soft_time_limit=1740)
def batch_process_staged_files(self, staging_keys: List[str],
                               file_metas: List[Dict[str, Any]],
                               folder: str = '',
                               tags: List[str] = None, is_public: bool = True,
                               created_by: str = None,
                               organization_id: str = '',
                               module: str = '',
                               context_type: str = '',
                               context_id: str = '',
                               user_id: str = '') -> Dict[str, Any]:
    """
    处理已暂存到 OSS 的文件：从 _staging/ 复制到正式路径，创建 FileRecord。
    多服务器安全：不依赖本地文件系统。

    Args:
        staging_keys: OSS 暂存区的 object key 列表
        file_metas: 每个文件的元信息列表 [{original_name, file_size, content_type, file_extension}]
        folder: 目标文件夹
        tags: 文件标签
        is_public: 是否公开访问
        created_by: 创建用户
    """
    try:
        logger.info("开始处理暂存文件", extra={
            'task_id': self.request.id,
            'file_count': len(staging_keys),
            'folder': folder,
        })

        task_name = f"批量上传_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        total_size = sum(m.get('file_size', 0) for m in file_metas)
        upload_task = UploadTask.objects.create(
            task_name=task_name,
            task_type='batch',
            total_files=len(staging_keys),
            total_size=total_size,
            created_by=created_by or 'system',
            organization_id=organization_id or '',
            result_data={
                'celery_task_id': self.request.id,
                'folder': folder,
                'tags': tags or [],
                'organization_id': organization_id or '',
            }
        )
        upload_task.mark_as_started()

        folder = folder.strip('/') + '/' if folder.strip('/') else ''
        oss_service = get_oss_service()
        results = []

        for staging_key, meta in zip(staging_keys, file_metas):
            try:
                ext = meta.get('file_extension', 'bin')
                target_key = f"{folder}{uuid.uuid4().hex}.{ext}"

                # SVC-7: 先做配额预检，通过后再移动文件，避免文件已移动但无 FileRecord 的孤儿状态
                file_size_val = meta.get('file_size', 0)
                if not _check_storage_quota(organization_id, file_size_val):
                    UploadTask.objects.filter(id=upload_task.id).update(
                        failed_files=models.F('failed_files') + 1)
                    results.append({'staging_key': staging_key, 'success': False, 'message': 'storage_quota_exceeded'})
                    continue

                move_result = oss_service.move_file(staging_key, target_key)
                if not move_result['success']:
                    logger.error(f"移动暂存文件失败: {staging_key} -> {target_key}: {move_result['message']}")
                    UploadTask.objects.filter(id=upload_task.id).update(
                        failed_files=models.F('failed_files') + 1)
                    results.append({'staging_key': staging_key, 'success': False, 'message': move_result['message']})
                    continue

                file_record = FileRecord.objects.create(
                    file_name=meta.get('original_name', os.path.basename(target_key)),
                    file_key=target_key,
                    file_path=os.path.dirname(target_key),
                    file_size=meta.get('file_size', 0),
                    file_type=get_file_type_from_extension(ext),
                    mime_type=meta.get('content_type', 'application/octet-stream'),
                    file_extension=ext,
                    bucket_name=oss_service.config.get('bucket_name'),
                    is_public=is_public,
                    upload_user=user_id or created_by or '',
                    upload_source='async_staged',
                    tags=tags or [],
                    metadata={
                        'celery_task_id': self.request.id,
                        'upload_task_id': str(upload_task.id),
                        'upload_method': 'staged',
                    },
                    status='completed',
                    access_url=move_result['data'].get('access_url', ''),
                    cdn_url=oss_service.build_cdn_url(target_key),
                )

                upload_task.files.add(file_record)
                UploadTask.objects.filter(id=upload_task.id).update(
                    completed_files=models.F('completed_files') + 1,
                    uploaded_size=models.F('uploaded_size') + meta.get('file_size', 0),
                )

                _apply_file_usage_and_billing(
                    file_record, meta.get('file_size', 0),
                    organization_id=organization_id,
                    user_id=user_id,
                    module=module,
                    context_type=context_type,
                    context_id=context_id,
                    biz_type="oss_staged_upload",
                )

                results.append({
                    'staging_key': staging_key,
                    'target_key': target_key,
                    'success': True,
                    'file_id': str(file_record.id),
                })

            except Exception as e:
                logger.error(f"处理暂存文件异常: {staging_key}: {e}", exc_info=True)
                UploadTask.objects.filter(id=upload_task.id).update(
                    failed_files=models.F('failed_files') + 1)
                results.append({'staging_key': staging_key, 'success': False, 'message': str(e)})

        upload_task.refresh_from_db()
        upload_task.update_progress()
        if upload_task.completed_files + upload_task.failed_files >= upload_task.total_files:
            upload_task.mark_as_completed()

        return {
            'success': True,
            'message': f"暂存文件处理完成，成功 {upload_task.completed_files}，失败 {upload_task.failed_files}",
            'data': {
                'task_id': str(upload_task.id),
                'results': results,
            }
        }

    except Exception as e:
        logger.error(f"暂存文件处理异常: {e}", exc_info=True, extra={'task_id': self.request.id})
        try:
            if 'upload_task' in locals():
                upload_task.mark_as_failed(str(e))
        except:
            pass
        return {'success': False, 'message': f'暂存文件处理失败: {e}'}


@shared_task(bind=True, max_retries=3, default_retry_delay=60, rate_limit='20/m', time_limit=600, soft_time_limit=560)
def download_and_upload_from_url(self, url: str, object_key: str = None,
                                 folder: str = '', task_id: str = None,
                                 **kwargs) -> Dict[str, Any]:
    """
    从URL下载文件并上传到OSS

    Args:
        url: 文件URL
        object_key: OSS对象键（可选，自动生成）
        folder: 目标文件夹
        task_id: 关联的上传任务ID
        **kwargs: 其他参数

    Returns:
        Dict: 上传结果
    """
    try:
        is_public = kwargs.get('is_public', True)
        enforce_public_read_acl = bool(kwargs.get('enforce_public_read_acl', False))
        logger.info(f"开始从URL下载并上传任务", extra={
            'task_id': self.request.id,
            'url': url,
            'upload_task_id': task_id
        })

        # 调用方提供稳定对象键时，它就是上传幂等键。上一次 Worker 可能已经完成
        # OSS + FileRecord，只是在 Celery chord 回调前退出；此时直接复用记录，
        # 并用幂等账单 biz_id / FileUsage unique key 补齐记账，不重复下载和上传。
        if object_key:
            existing_completed = FileRecord.objects.filter(
                file_key_hash=FileRecord._calc_file_key_hash(object_key),
                status='completed',
            ).first()
            if existing_completed:
                if is_public and enforce_public_read_acl:
                    oss_service = get_oss_service()
                    if not oss_service.set_object_public_read(object_key):
                        raise OSSServiceException("设置公共读 ACL 失败")
                _apply_file_usage_and_billing(
                    existing_completed,
                    existing_completed.file_size,
                    organization_id=kwargs.get('organization_id', ''),
                    user_id=kwargs.get('user_id', ''),
                    module=kwargs.get('module', ''),
                    context_type=kwargs.get('context_type', ''),
                    context_id=kwargs.get('context_id', ''),
                    biz_type="oss_url_upload",
                )
                return {
                    'success': True,
                    'message': '文件已上传（幂等复用）',
                    'data': {
                        'file_id': str(existing_completed.id),
                        'file_name': existing_completed.file_name,
                        'file_key': existing_completed.file_key,
                        'file_size': existing_completed.file_size,
                        'mime_type': existing_completed.mime_type,
                        'access_url': existing_completed.access_url,
                        'cdn_url': existing_completed.cdn_url,
                    },
                }

        from apps.services.common.url_security import ssrf_safe_request
        response = ssrf_safe_request("GET", url, timeout=30, stream=True, allow_redirects=True)
        response.raise_for_status()

        # 获取文件信息
        content_type = normalize_mime_type(
            response.headers.get('Content-Type', 'application/octet-stream')
        )
        content_length = int(response.headers.get('Content-Length', 0))

        # 从URL或Content-Type推断文件扩展名
        url_path = url.split('?')[0]
        if object_key:
            file_extension = os.path.splitext(object_key)[1].lower().lstrip('.')
        else:
            file_name = os.path.basename(url_path)
            file_extension = os.path.splitext(file_name)[1].lower().lstrip('.')

            if not file_extension:
                file_extension = extension_for_mime(content_type)

            folder = folder.strip('/') + '/' if folder.strip('/') else ''
            object_key = f"{folder}{uuid.uuid4().hex}.{file_extension}"

        # 读取文件内容
        file_content = BytesIO()
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                file_content.write(chunk)

        file_size = file_content.tell()
        file_content.seek(0)

        file_content_bytes = file_content.read()
        file_hash = hashlib.md5(file_content_bytes).hexdigest()
        file_content = BytesIO(file_content_bytes)

        ws_id = kwargs.get('organization_id', '')
        effective_size = file_size or content_length
        if not _check_storage_quota(ws_id, effective_size):
            return {
                'success': False,
                'message': '存储配额不足，无法上传',
                'data': {'reason': 'quota_exceeded', 'url': url},
            }

        oss_service = get_oss_service()
        retry_identity = models.Q(metadata__celery_task_id=self.request.id)
        if object_key:
            retry_identity |= models.Q(
                file_key_hash=FileRecord._calc_file_key_hash(object_key),
            )
        file_record = FileRecord.objects.filter(
            retry_identity,
            status__in=['uploading', 'failed'],
        ).first()
        if file_record:
            file_record.status = 'uploading'
            meta = file_record.metadata or {}
            meta.pop('error_message', None)
            file_record.metadata = meta
            file_record.save(update_fields=['status', 'metadata', 'updated_at'])
        else:
            file_record = FileRecord.objects.create(
                file_name=os.path.basename(url_path),
                file_key=object_key,
                file_path=os.path.dirname(object_key),
                file_size=file_size or content_length,
                file_type=get_file_type_from_extension(file_extension),
                mime_type=content_type,
                file_extension=file_extension,
                file_hash=file_hash,
                bucket_name=oss_service.config.get('bucket_name'),
                is_public=is_public,
                upload_source='url',
                tags=kwargs.get('tags', []),
                metadata={
                    'source_url': url,
                    'celery_task_id': self.request.id,
                    'upload_task_id': task_id,
                    'upload_method': 'from_url'
                },
                status='uploading'
            )

        # 上传到OSS
        upload_result = oss_service.upload_file(
            file_content,
            object_key,
            content_type=content_type
        )

        if not upload_result['success']:
            file_record.mark_as_failed(upload_result['message'])
            raise OSSServiceException(f"文件上传失败: {upload_result['message']}")

        if (
            is_public
            and enforce_public_read_acl
            and not oss_service.set_object_public_read(object_key)
        ):
            message = "设置公共读 ACL 失败"
            file_record.mark_as_failed(message)
            raise OSSServiceException(message)

        file_record.mark_as_completed(
            access_url=upload_result['data']['access_url'],
            cdn_url=upload_result['data'].get('cdn_url', '')
        )

        _apply_file_usage_and_billing(
            file_record, file_size or content_length,
            organization_id=kwargs.get('organization_id', ''),
            user_id=kwargs.get('user_id', ''),
            module=kwargs.get('module', ''),
            context_type=kwargs.get('context_type', ''),
            context_id=kwargs.get('context_id', ''),
            biz_type="oss_url_upload",
        )

        if task_id:
            try:
                ut = UploadTask.objects.filter(id=task_id)
                if ut.exists():
                    ut.first().files.add(file_record)
                    ut.update(
                        completed_files=models.F('completed_files') + 1,
                        uploaded_size=models.F('uploaded_size') + file_size,
                    )
                    refreshed = UploadTask.objects.get(id=task_id)
                    refreshed.update_progress()
                    if refreshed.completed_files + refreshed.failed_files >= refreshed.total_files:
                        refreshed.mark_as_completed()
            except UploadTask.DoesNotExist:
                logger.warning(f"上传任务不存在: {task_id}")

        logger.info(f"从URL上传文件成功", extra={
            'task_id': self.request.id,
            'file_id': str(file_record.id),
            'url': url
        })

        return {
            'success': True,
            'message': '文件上传成功',
            'data': {
                'file_id': str(file_record.id),
                'file_name': file_record.file_name,
                'file_key': file_record.file_key,
                'file_size': file_record.file_size,
                'mime_type': file_record.mime_type,
                'access_url': file_record.access_url,
                'cdn_url': file_record.cdn_url
            }
        }

    except requests.RequestException as e:
        logger.error(f"下载文件失败: {e}", extra={'task_id': self.request.id, 'url': url})

        if task_id:
            UploadTask.objects.filter(id=task_id).update(
                failed_files=models.F('failed_files') + 1)

        if self.request.retries < self.max_retries:
            raise self.retry(exc=e, countdown=60 * (2 ** self.request.retries))

        return {'success': False, 'message': f'下载文件失败: {e}'}

    except Exception as e:
        logger.error(f"从URL上传文件任务异常: {e}", exc_info=True, extra={'task_id': self.request.id})

        if task_id:
            UploadTask.objects.filter(id=task_id).update(
                failed_files=models.F('failed_files') + 1)

        if self.request.retries < self.max_retries:
            raise self.retry(exc=e, countdown=60 * (2 ** self.request.retries))

        return {'success': False, 'message': f'上传失败: {e}'}


@shared_task(bind=True, rate_limit='5/m', time_limit=3600, soft_time_limit=3540)
def batch_download_and_upload_from_urls(self, urls: List[str], folder: str = '',
                                       tags: List[str] = None, is_public: bool = True,
                                       created_by: str = None,
                                       sync_mode: bool = False,
                                       organization_id: str = '',
                                       module: str = '',
                                       context_type: str = '',
                                       context_id: str = '',
                                       user_id: str = '') -> Dict[str, Any]:
    """
    批量从URL下载并上传文件

    Args:
        urls: 文件URL列表
        folder: 目标文件夹
        tags: 文件标签
        is_public: 是否公开访问
        created_by: 创建用户
        sync_mode: 是否同步模式（在当前任务内完成所有上传，不创建子任务）

    Returns:
        Dict: 批量上传结果
    """
    try:
        logger.info(f"开始批量从URL下载并上传任务", extra={
            'task_id': self.request.id,
            'url_count': len(urls),
            'folder': folder,
            'sync_mode': sync_mode
        })

        # 创建上传任务
        task_name = f"批量URL上传_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        upload_task = UploadTask.objects.create(
            task_name=task_name,
            task_type='batch',
            total_files=len(urls),
            created_by=created_by or 'system',
            organization_id=organization_id or '',
            result_data={
                'celery_task_id': self.request.id,
                'folder': folder,
                'tags': tags or [],
                'source': 'urls',
                'sync_mode': sync_mode,
                'organization_id': organization_id or '',
            }
        )

        upload_task.mark_as_started()

        # 准备文件夹路径
        folder = folder.strip('/') + '/' if folder.strip('/') else ''

        results = []

        if sync_mode:
            # 同步模式：在当前任务内完成所有下载上传
            oss_service = get_oss_service()

            for idx, url in enumerate(urls):
                try:
                    logger.info(f"开始下载并上传文件 ({idx+1}/{len(urls)})", extra={
                        'url': url,
                        'task_id': self.request.id
                    })

                    from apps.services.common.url_security import ssrf_safe_request
                    response = ssrf_safe_request("GET", url, timeout=30, stream=True, allow_redirects=True)
                    response.raise_for_status()

                    content_type = normalize_mime_type(
                        response.headers.get('Content-Type', 'application/octet-stream')
                    )
                    content_length = int(response.headers.get('Content-Length', 0))

                    if content_length > _SYNC_MODE_MAX_FILE_SIZE:
                        logger.warning(
                            "sync_mode 单文件超过 50MB 限制 (%d bytes), 跳过: %s",
                            content_length, url,
                        )
                        UploadTask.objects.filter(id=upload_task.id).update(
                            failed_files=models.F('failed_files') + 1)
                        results.append({
                            'url': url,
                            'success': False,
                            'message': f'文件过大 ({content_length} bytes > 50MB)，sync_mode 不支持',
                        })
                        response.close()
                        continue

                    url_path = url.split('?')[0]
                    file_name = os.path.basename(url_path)
                    file_extension = os.path.splitext(file_name)[1].lower().lstrip('.')

                    if not file_extension:
                        file_extension = extension_for_mime(content_type)

                    # 生成对象键
                    object_key = f"{folder}{uuid.uuid4().hex}.{file_extension}"

                    file_content = BytesIO()
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            file_content.write(chunk)
                            if file_content.tell() > _SYNC_MODE_MAX_FILE_SIZE:
                                logger.warning("sync_mode 下载中超过 50MB 限制, 中断: %s", url)
                                break

                    file_size = file_content.tell()
                    file_content.seek(0)

                    if file_size > _SYNC_MODE_MAX_FILE_SIZE:
                        UploadTask.objects.filter(id=upload_task.id).update(
                            failed_files=models.F('failed_files') + 1)
                        results.append({
                            'url': url,
                            'success': False,
                            'message': f'文件过大 ({file_size} bytes > 50MB)，sync_mode 不支持',
                        })
                        continue

                    file_content_bytes = file_content.read()
                    file_hash = hashlib.md5(file_content_bytes).hexdigest()
                    file_content = BytesIO(file_content_bytes)

                    effective_size = file_size or content_length
                    if not _check_storage_quota(organization_id, effective_size):
                        UploadTask.objects.filter(id=upload_task.id).update(
                            failed_files=models.F('failed_files') + 1)
                        results.append({
                            'url': url,
                            'success': False,
                            'message': '存储配额不足',
                        })
                        continue

                    # 创建文件记录
                    file_record = FileRecord.objects.create(
                        file_name=file_name,
                        file_key=object_key,
                        file_path=os.path.dirname(object_key),
                        file_size=file_size or content_length,
                        file_type=get_file_type_from_extension(file_extension),
                        mime_type=content_type,
                        file_extension=file_extension,
                        file_hash=file_hash,
                        bucket_name=oss_service.config.get('bucket_name'),
                        is_public=is_public,
                        upload_source='url',
                        tags=tags or [],
                        metadata={
                            'source_url': url,
                            'celery_task_id': self.request.id,
                            'upload_task_id': str(upload_task.id),
                            'upload_method': 'batch_from_url_sync'
                        },
                        status='uploading'
                    )

                    # 上传到OSS
                    upload_result = oss_service.upload_file(
                        file_content,
                        object_key,
                        content_type=content_type
                    )

                    if not upload_result['success']:
                        file_record.mark_as_failed(upload_result['message'])
                        UploadTask.objects.filter(id=upload_task.id).update(
                            failed_files=models.F('failed_files') + 1)
                        results.append({
                            'url': url,
                            'success': False,
                            'message': upload_result['message']
                        })
                    else:
                        file_record.mark_as_completed(
                            access_url=upload_result['data']['access_url'],
                            cdn_url=upload_result['data'].get('cdn_url', '')
                        )

                        _apply_file_usage_and_billing(
                            file_record, file_size,
                            organization_id=organization_id,
                            user_id=user_id,
                            module=module,
                            context_type=context_type,
                            context_id=context_id,
                            biz_type="oss_batch_url_upload",
                        )

                        upload_task.files.add(file_record)
                        UploadTask.objects.filter(id=upload_task.id).update(
                            completed_files=models.F('completed_files') + 1,
                            uploaded_size=models.F('uploaded_size') + file_size,
                        )

                        results.append({
                            'url': url,
                            'success': True,
                            'file_id': str(file_record.id),
                            'file_name': file_record.file_name,
                            'file_key': file_record.file_key,
                            'file_size': file_record.file_size,
                            'access_url': file_record.access_url,
                            'cdn_url': file_record.cdn_url
                        })

                        logger.info(f"文件上传成功 ({idx+1}/{len(urls)})", extra={
                            'file_id': str(file_record.id),
                            'url': url
                        })

                except requests.RequestException as e:
                    logger.error(f"下载文件失败: {e}", extra={'url': url})
                    UploadTask.objects.filter(id=upload_task.id).update(
                        failed_files=models.F('failed_files') + 1)
                    results.append({
                        'url': url,
                        'success': False,
                        'message': f'下载失败: {str(e)}'
                    })

                except Exception as e:
                    logger.error(f"上传文件失败: {e}", exc_info=True, extra={'url': url})
                    UploadTask.objects.filter(id=upload_task.id).update(
                        failed_files=models.F('failed_files') + 1)
                    results.append({
                        'url': url,
                        'success': False,
                        'message': f'上传失败: {str(e)}'
                    })

            upload_task.refresh_from_db()
            upload_task.mark_as_completed()

        else:
            for url in urls:
                try:
                    result = download_and_upload_from_url.apply_async(
                        args=[url],
                        kwargs={
                            'folder': folder,
                            'task_id': str(upload_task.id),
                            'tags': tags or [],
                            'is_public': is_public,
                            'organization_id': organization_id,
                            'module': module,
                            'context_type': context_type,
                            'context_id': context_id,
                            'user_id': user_id,
                        }
                    )

                    results.append({
                        'url': url,
                        'celery_task_id': result.id,
                        'status': 'submitted'
                    })

                except Exception as e:
                    logger.error(f"提交URL上传任务失败: {e}", extra={
                        'url': url,
                        'task_id': self.request.id
                    })
                    UploadTask.objects.filter(id=upload_task.id).update(
                        failed_files=models.F('failed_files') + 1)
                    results.append({
                        'url': url,
                        'success': False,
                        'message': str(e)
                    })

        upload_task.refresh_from_db()
        upload_task.result_data['results'] = results
        upload_task.save(update_fields=['result_data'])

        logger.info(f"批量URL上传任务完成", extra={
            'task_id': self.request.id,
            'upload_task_id': str(upload_task.id),
            'total': len(urls),
            'completed': upload_task.completed_files,
            'failed': upload_task.failed_files
        })

        return {
            'success': True,
            'message': f"批量URL上传完成，成功 {upload_task.completed_files} 个，失败 {upload_task.failed_files} 个",
            'data': {
                'task_id': str(upload_task.id),
                'task_name': task_name,
                'total_files': len(urls),
                'completed_files': upload_task.completed_files,
                'failed_files': upload_task.failed_files,
                'results': results,
                'sync_mode': sync_mode
            }
        }

    except Exception as e:
        logger.error(f"批量URL上传任务异常: {e}", exc_info=True, extra={'task_id': self.request.id})

        try:
            if 'upload_task' in locals():
                upload_task.mark_as_failed(str(e))
        except:
            pass

        return {'success': False, 'message': f'批量URL上传失败: {e}'}


@shared_task(time_limit=300, soft_time_limit=270)
def cleanup_old_upload_tasks():
    """
    清理旧的上传任务记录。

    - 30天前已完成/失败/取消的任务（按 completed_at）
    - 7天前仍处于 pending 状态的僵死任务（按 created_at）
    - cancelled 且 completed_at 为空的任务（按 created_at 回退）
    """
    try:
        logger.info("开始清理旧的上传任务记录")

        cutoff_date = timezone.now() - timedelta(days=30)
        pending_cutoff = timezone.now() - timedelta(days=7)

        finished_deleted, _ = UploadTask.objects.filter(
            status__in=['completed', 'failed', 'cancelled'],
            completed_at__lt=cutoff_date,
        ).delete()

        stale_cancelled, _ = UploadTask.objects.filter(
            status='cancelled',
            completed_at__isnull=True,
            created_at__lt=cutoff_date,
        ).delete()

        stale_pending, _ = UploadTask.objects.filter(
            status='pending',
            created_at__lt=pending_cutoff,
        ).delete()

        total = finished_deleted + stale_cancelled + stale_pending
        logger.info(
            "旧上传任务清理完成: finished=%d, stale_cancelled=%d, stale_pending=%d",
            finished_deleted, stale_cancelled, stale_pending,
        )
        return {
            'deleted_count': total,
            'finished_deleted': finished_deleted,
            'stale_cancelled': stale_cancelled,
            'stale_pending': stale_pending,
        }

    except Exception as e:
        logger.error(f"清理旧上传任务记录异常: {e}", exc_info=True)
        return {'error': str(e)}


def _file_record_ids_retained_by_trashed_tabfiles(file_record_ids) -> set[str]:
    """仍由回收站中的 tabfiles ContextItem 持有的 FileRecord，不得物理删除。

    TabFiles trash 会 deactivate FileUsage（ref_count→0）以释放活跃配额，
    但 OSS 对象必须保留到用户永久删除或回收站过期清理掉 ContextItem 为止。
    查询失败时 fail-closed（视为全部保留），避免误删导致无法还原。
    """
    ids = [str(i) for i in file_record_ids if i]
    if not ids:
        return set()
    try:
        from apps.tabtinspace.models import ContextItem
        retained = ContextItem.objects.filter(
            item_type='tabfiles',
            resource_id__in=ids,
        ).filter(
            models.Q(trashed_at__isnull=False) | models.Q(status='trashed'),
        ).values_list('resource_id', flat=True)
        return {str(rid) for rid in retained if rid}
    except Exception:
        logger.exception(
            "查询 trashed tabfiles 保留集失败，本批孤儿清理全部跳过以防误删",
        )
        return set(ids)


def _file_record_ids_retained_by_trashed_tabdocs(
    file_record_ids,
    *,
    now=None,
) -> set[str]:
    """返回仍处于组织套餐回收站保留期内的 TabDoc 文件 ID。

    TabDoc 进入回收站后会停用图片、封面等 FileUsage 来释放活跃存储
    额度。物理对象仍必须以 Document.trashed_at 为起点，跟随组织当前
    套餐的回收站保留期；套餐或关联查询异常时 fail-closed，避免不可恢复
    的数据损失。
    """
    ids = [str(file_id) for file_id in file_record_ids if file_id]
    if not ids:
        return set()

    try:
        from apps.services.billing.services.entitlement_limits_service import (
            EntitlementLimitsService,
        )
        from apps.tabdoc.models import Document

        usage_rows = list(
            FileUsage.objects.filter(
                file_record_id__in=ids,
                module="tabdoc",
                context_type__in=["document", "document_cover"],
                is_active=False,
            ).values("file_record_id", "context_id")
        )
        if not usage_rows:
            return set()

        file_ids_by_document_id: dict[str, set[str]] = {}
        valid_document_ids = []
        for row in usage_rows:
            document_id = str(row["context_id"] or "")
            try:
                uuid.UUID(document_id)
            except (TypeError, ValueError, AttributeError):
                continue
            valid_document_ids.append(document_id)
            file_ids_by_document_id.setdefault(document_id, set()).add(
                str(row["file_record_id"]),
            )

        if not valid_document_ids:
            return set()

        trashed_documents = list(
            Document.objects.filter(
                id__in=valid_document_ids,
                trashed_at__isnull=False,
            ).values("id", "organization_id", "trashed_at")
        )
        if not trashed_documents:
            return set()

        retention_days_by_organization: dict[str, int] = {}
        for document in trashed_documents:
            organization_id = str(document["organization_id"])
            if organization_id in retention_days_by_organization:
                continue
            retention_days = EntitlementLimitsService.get_recycle_retention_days(
                organization_id,
            )
            if retention_days < 1:
                raise ValueError(
                    "组织回收站保留期无效: "
                    f"organization={organization_id}, days={retention_days}",
                )
            retention_days_by_organization[organization_id] = retention_days

        retained: set[str] = set()
        reference_time = now or timezone.now()
        for document in trashed_documents:
            organization_id = str(document["organization_id"])
            retention_days = retention_days_by_organization[organization_id]
            expires_at = document["trashed_at"] + timedelta(days=retention_days)
            if expires_at > reference_time:
                retained.update(
                    file_ids_by_document_id.get(str(document["id"]), set()),
                )
        return retained
    except Exception:
        logger.exception(
            "查询套餐保留期内的 trashed TabDoc 文件失败，本批孤儿清理全部跳过",
        )
        return set(ids)


@shared_task(time_limit=1800, soft_time_limit=1740)
def cleanup_orphan_files(grace_days: int = 7):
    """
    清理无引用的物理文件。

    FileRecord.ref_count 归零且超过 grace_days 宽限期后，
    从 OSS 删除物理文件并软删除记录。建议每天执行一次。

    使用 Redis 分布式锁防止多 worker 并发执行。
    同时清理 status='failed' 的残留记录（仅清 DB，不删 OSS）。

    例外：仍在回收站保留期内的 TabFiles / TabDoc 所引用的 FileRecord
    （trash 后 ref_count 可为 0）必须跳过，直到对应资源永久删除或保留期届满。
    """
    from django.core.cache import cache as django_cache

    lock_key = "lock:cleanup_orphan_files"
    lock_acquired = django_cache.add(lock_key, "1", timeout=1800)
    if not lock_acquired:
        logger.info("cleanup_orphan_files 分布式锁未获取，跳过本次执行")
        return {'skipped': True, 'reason': 'lock_not_acquired'}

    try:
        logger.info(f"开始清理孤儿文件（宽限期 {grace_days} 天）")

        now = timezone.now()
        cutoff = now - timedelta(days=grace_days)

        orphans = FileRecord.objects.filter(
            ref_count=0,
            status='completed',
            updated_at__lt=cutoff,
        )

        deleted_count = 0
        skipped_count = 0
        oss_service = get_oss_service()

        # 分批加载后查回收站保留集，避免 iterator 逐条跨库查询。
        orphan_batch: list = []
        batch_size = 200

        def _flush_orphan_batch(batch: list) -> None:
            nonlocal deleted_count, skipped_count
            if not batch:
                return
            retained = _file_record_ids_retained_by_trashed_tabfiles(
                [str(r.id) for r in batch],
            )
            retained.update(
                _file_record_ids_retained_by_trashed_tabdocs(
                    [str(r.id) for r in batch],
                    now=now,
                )
            )
            for record in batch:
                if str(record.id) in retained:
                    skipped_count += 1
                    continue
                if record.usages.filter(is_active=True).exists():
                    skipped_count += 1
                    continue
                try:
                    delete_result = oss_service.delete_file(record.file_key)
                    if not delete_result.get('success'):
                        logger.error(
                            "孤儿清理 OSS 物理删除失败，跳过 soft_delete: file=%s, key=%s, err=%s",
                            record.id, record.file_key, delete_result.get('message', 'unknown'),
                        )
                        skipped_count += 1
                        continue

                    record.soft_delete()
                    deleted_count += 1
                except Exception as e:
                    logger.error(f"删除孤儿文件失败: file_id={record.id}, error={e}")

        for record in orphans.iterator():
            orphan_batch.append(record)
            if len(orphan_batch) >= batch_size:
                _flush_orphan_batch(orphan_batch)
                orphan_batch = []
        _flush_orphan_batch(orphan_batch)

        failed_cutoff = timezone.now() - timedelta(days=grace_days)
        failed_cleaned = 0
        failed_orphans = FileRecord.objects.filter(
            ref_count=0,
            status='failed',
            updated_at__lt=failed_cutoff,
        )
        for record in failed_orphans.iterator():
            try:
                record.soft_delete()
                failed_cleaned += 1
            except Exception as e:
                logger.error("清理 failed FileRecord 失败: file_id=%s, error=%s", record.id, e)

        logger.info(
            "孤儿文件清理完成: 删除 %d 个, 跳过 %d 个, failed 清理 %d 个",
            deleted_count, skipped_count, failed_cleaned,
        )
        return {
            'deleted_count': deleted_count,
            'skipped_count': skipped_count,
            'failed_cleaned': failed_cleaned,
        }

    except Exception as e:
        logger.error(f"孤儿文件清理异常: {e}", exc_info=True)
        return {'error': str(e)}
    finally:
        django_cache.delete(lock_key)


@shared_task(time_limit=1800, soft_time_limit=1740)
def reconcile_file_usages_task():
    """
    FileUsage 对账定时任务 — 周期性校验 ref_count 一致性并检测孤儿 FileUsage。

    通过调用 management command 实现，等价于:
        python manage.py reconcile_file_usages

    使用 Redis 分布式锁防止多 worker 并发执行。
    """
    from django.core.cache import cache as django_cache
    from django.core.management import call_command
    from io import StringIO

    lock_key = "lock:reconcile_file_usages"
    lock_acquired = django_cache.add(lock_key, "1", timeout=1800)
    if not lock_acquired:
        logger.info("reconcile_file_usages_task 分布式锁未获取，跳过本次执行")
        return {"skipped": True, "reason": "lock_not_acquired"}

    _MAX_OUTPUT_LEN = 8000

    out = StringIO()
    try:
        logger.info("reconcile_file_usages_task 开始执行")
        call_command("reconcile_file_usages", stdout=out)
        output = out.getvalue()
        if len(output) > _MAX_OUTPUT_LEN:
            truncated = output[:_MAX_OUTPUT_LEN] + f"\n... (截断，总长 {len(output)} 字符)"
        else:
            truncated = output
        logger.info("reconcile_file_usages_task 完成:\n%s", truncated)
        return {"success": True, "output": truncated}
    except Exception as exc:
        logger.error("reconcile_file_usages_task 异常: %s", exc, exc_info=True)
        return {"success": False, "error": str(exc)}
    finally:
        django_cache.delete(lock_key)

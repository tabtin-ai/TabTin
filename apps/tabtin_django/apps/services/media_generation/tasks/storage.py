"""
媒体产物转存

任务成功后，将 Provider 返回的临时 URL（24h有效）下载并转存到 OSS，
替换为永久 URL。

SVC-14 修复：改用 celery group() 并行上传，避免串行阻塞撞 time_limit。
TVIDEO-4 修复：转存失败时不 mark_stored()，保留重试能力。
TVIDEO-5 修复：转存成功后为源模块注册额外 FileUsage，解决跨模块归属断层。
TVIDEO-8 修复：改用 chord 替代 group().get()，父任务不再阻塞 worker。
"""

import logging
import uuid
from datetime import timedelta
from urllib.parse import urlparse, unquote
from pathlib import PurePosixPath
from celery import shared_task, chord
from celery.exceptions import Retry
from django.db.models import Q
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)

STORAGE_LEASE_TIMEOUT = timedelta(minutes=15)
STORAGE_RECOVERY_BATCH_SIZE = 100
ARTIFACT_MESSAGE_NAMESPACE = uuid.UUID('08a32212-9fcb-4e43-bfc5-b9f5c547b6c2')


def _has_stable_file_identity(result) -> bool:
    """永久产物必须足以跨签名 URL 生命周期重新寻址和展示。"""
    if not isinstance(result, dict):
        return False
    required_text = ('file_id', 'file_name', 'mime_type', 'access_url')
    if not all(isinstance(result.get(key), str) and result[key].strip() for key in required_text):
        return False
    file_size = result.get('file_size')
    index = result.get('index')
    return (
        isinstance(file_size, int) and not isinstance(file_size, bool) and file_size >= 0
        and isinstance(index, int) and not isinstance(index, bool) and index >= 0
    )


def enqueue_media_storage(task) -> None:
    """提交永久转存；Broker 故障只影响交付状态，不回滚生成成功。"""
    try:
        store_media_results.delay(str(task.id))
    except Exception as exc:
        logger.exception("[MediaStorage] 转存任务入队失败: task=%s", task.id)
        metadata = dict(task.result_metadata or {})
        metadata["storage_enqueue_error"] = str(exc)[:500]
        task.result_metadata = metadata
        task.save(update_fields=[
            'result_metadata', 'updated_at',
        ])


@shared_task(time_limit=60, soft_time_limit=50)
def recover_stale_media_storage() -> int:
    """重新投递超过租约时间仍处于转存中的任务。

    周期任务只负责发现并投递，真正的抢占仍由 ``store_media_results``
    的条件更新完成。即使多个 Beat/Worker 重复投递，也只有一个任务能
    获得新的租约。
    """
    from ..models import MediaTask

    cutoff = timezone.now() - STORAGE_LEASE_TIMEOUT
    stale_task_ids = list(
        MediaTask.objects.filter(status='succeeded')
        .filter(
            Q(storage_status='storing', updated_at__lt=cutoff)
            | Q(
                storage_status__in=('not_started', 'failed'),
                result_metadata__has_key='storage_enqueue_error',
            )
        )
        .exclude(result_urls=[])
        .order_by('updated_at')
        .values_list('id', flat=True)[:STORAGE_RECOVERY_BATCH_SIZE]
    )
    for task_id in stale_task_ids:
        store_media_results.delay(str(task_id))

    if stale_task_ids:
        logger.warning(
            "[MediaStorage] 重新投递过期转存任务: count=%d",
            len(stale_task_ids),
        )
    return len(stale_task_ids)


def _storage_object_key(
    *,
    task_id: str,
    task_type: str,
    user_id: str,
    index: int,
    extension: str,
) -> str:
    """同一媒体任务重试时复用对象键，避免重复对象、文件记录和计费。"""
    folder = f"media-gen/{task_type}/{str(user_id)[:8]}"
    return f"{folder}/{task_id}_{index}{extension}"


def artifact_message_id(*, task_id: str, file_id: str, index: int) -> str:
    return str(uuid.uuid5(
        ARTIFACT_MESSAGE_NAMESPACE,
        f"{task_id}:{file_id}:{index}",
    ))


@shared_task(bind=True, max_retries=3, default_retry_delay=60, time_limit=600, soft_time_limit=560)
def store_media_results(self, task_id: str):
    """将媒体生成结果从临时 URL 转存到 OSS（group 并行）"""
    from ..models import MediaTask

    try:
        task = MediaTask.objects.get(id=task_id)
    except MediaTask.DoesNotExist:
        logger.warning("[MediaStorage] 任务不存在: %s", task_id)
        return

    if task.status != 'succeeded':
        logger.info("[MediaStorage] 任务非成功态，跳过: %s (%s)", task_id, task.status)
        return

    if not task.result_urls:
        logger.info("[MediaStorage] 无结果 URL: %s", task_id)
        MediaTask.objects.filter(id=task.id).update(storage_status='failed')
        return

    if task.storage_status in ('succeeded', 'partial'):
        logger.info("[MediaStorage] 已有永久存储终态，跳过: %s (%s)", task_id, task.storage_status)
        return

    claimed_at = timezone.now()
    claimed = MediaTask.objects.filter(
        Q(storage_status__in=('not_started', 'failed'))
        | Q(
            storage_status='storing',
            updated_at__lt=claimed_at - STORAGE_LEASE_TIMEOUT,
        ),
        id=task.id,
    ).update(storage_status='storing', updated_at=claimed_at)
    if not claimed:
        logger.info("[MediaStorage] 转存已由其他任务接管，跳过: %s", task_id)
        return

    metadata = dict(task.result_metadata or {})
    if metadata.pop('storage_enqueue_error', None) is not None:
        MediaTask.objects.filter(id=task.id).update(result_metadata=metadata)
        task.result_metadata = metadata

    params = task.parameters or {}
    source_module = params.get('source_module', '')
    source_context_id = params.get('source_context_id', '')

    upload_signatures = []
    for idx, url in enumerate(task.result_urls):
        file_ext = _guess_extension(url, task.task_type)
        object_key = _storage_object_key(
            task_id=str(task.id),
            task_type=task.task_type,
            user_id=str(task.user_id),
            index=idx,
            extension=file_ext,
        )
        upload_signatures.append(
            _upload_single_to_oss.s(url, object_key, task_id, task.task_type,
                                    task.organization_id or '', task.user_id or '', idx,
                                    source_module, source_context_id)
        )

    if not upload_signatures:
        return

    # TVIDEO-8: 使用 chord 替代 group().get()，回调在子任务全部完成后异步触发，
    # 父任务立即返回，不再阻塞 Worker —— 彻底消除有限 Worker 下的死锁风险。
    callback = _finalize_media_storage.s(task_id)
    try:
        chord(upload_signatures)(callback)
    except Exception as exc:
        metadata = dict(task.result_metadata or {})
        metadata['storage_enqueue_error'] = str(exc)[:500]
        MediaTask.objects.filter(id=task.id, storage_status='storing').update(
            storage_status='not_started',
            result_metadata=metadata,
        )
        logger.exception("[MediaStorage] chord 提交失败: task=%s", task_id)
        raise self.retry(exc=exc)
    logger.info("[MediaStorage] chord 已提交: %s, upload_count=%d", task_id, len(upload_signatures))


@shared_task(bind=True, max_retries=2, default_retry_delay=30, time_limit=180, soft_time_limit=160)
def _upload_single_to_oss(self, source_url: str, object_key: str,
                          task_id: str, task_type: str,
                          organization_id: str, user_id: str, index: int,
                          source_module: str = '', source_context_id: str = '') -> dict:
    """并行子任务：上传单个 URL 到 OSS，返回结果字典。

    TVIDEO-5: 若 source_module / source_context_id 非空，额外注册一条
    归属源模块的 FileUsage，确保源项目删除时能正确匹配和清理。
    """
    try:
        from apps.services.oss.tasks import download_and_upload_from_url
        is_public = not settings.MEDIA_GENERATION_PRIVATE_OSS_ENABLED
        # 当前任务本身已经是 chord 子任务。这里若再用 ``apply().get()``，
        # Celery 会在 worker 内拒绝同步等待另一个 task（E_WOULDBLOCK），导致
        # 每次真实转存都稳定失败。复用 OSS task 的同步实现即可；重试与并行边界
        # 仍由本层 ``_upload_single_to_oss`` 负责。
        result = download_and_upload_from_url.run(
            source_url,
            object_key=object_key,
            is_public=is_public,
            enforce_public_read_acl=is_public,
            tags=['media-generation', task_type],
            organization_id=organization_id,
            module='media_generation',
            context_type=task_type,
            context_id=task_id,
            user_id=user_id,
        )

        if result and result.get('success') and result.get('data', {}).get('access_url'):
            data = result['data']
            _register_source_module_usage(
                file_id=data.get('file_id', ''),
                source_module=source_module,
                source_context_id=source_context_id,
                task_type=task_type,
                user_id=user_id,
            )
            return {
                'index': index,
                'file_id': data.get('file_id', ''),
                'file_name': data.get('file_name', ''),
                'mime_type': data.get('mime_type', ''),
                'file_size': int(data.get('file_size') or 0),
                'access_url': data['access_url'],
            }

        logger.warning("[MediaStorage] OSS 上传返回失败: idx=%d, result=%s", index, result)
        return {'index': index, 'error': 'oss_upload_failed'}

    except Retry as exc:
        # 被同步复用的 OSS task 会把瞬时错误包装成 Celery Retry。把该信号
        # 转换为当前 chord 子任务的重试，不能当成普通失败吞掉，否则装饰器上
        # 的 max_retries 永远不会生效，网络抖动会直接落 storage_status=failed。
        cause = exc.exc if isinstance(exc.exc, Exception) else exc
        logger.warning(
            "[MediaStorage] OSS 上传请求重试: idx=%d, error=%s",
            index,
            cause,
        )
        if self.request.retries < self.max_retries:
            raise self.retry(exc=cause)
        return {'index': index, 'error': str(cause)[:500]}
    except ImportError:
        logger.warning("[MediaStorage] OSS 服务不可用, idx=%d", index)
        return {'index': index, 'error': 'oss_service_unavailable'}
    except Exception as exc:
        logger.error("[MediaStorage] OSS 上传异常: idx=%d, error=%s", index, exc)
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        return {'index': index, 'error': str(exc)[:500]}


@shared_task(bind=True, max_retries=2, default_retry_delay=30)
def _finalize_media_storage(self, results: list, task_id: str):
    """聚合并行上传结果并保存永久交付终态。

    Celery chord 调用 ``.s(task_id)`` 时先注入 group 结果，参数顺序是
    ``(group_results, task_id)``。失败项只保留在 ``MediaTask.result_urls``，
    绝不写入 ``stored_urls``；仅数据库落终态失败时重试本回调。
    """
    from apps.services.media_generation.models import MediaTask

    try:
        task = MediaTask.objects.get(id=task_id)
    except MediaTask.DoesNotExist:
        logger.warning("[MediaStorage] finalize 找不到任务: %s", task_id)
        return

    stored_files = sorted(
        (
            dict(result)
            for result in (results or [])
            if _has_stable_file_identity(result)
        ),
        key=lambda item: int(item.get('index', 0)),
    )
    for stored_file in stored_files:
        stored_file['artifact_message_id'] = artifact_message_id(
            task_id=str(task.id),
            file_id=stored_file['file_id'],
            index=stored_file['index'],
        )
    expected_count = len(task.result_urls or []) or len(results or [])
    succeeded_count = len(stored_files)
    if succeeded_count == expected_count and expected_count > 0:
        storage_status = 'succeeded'
    elif succeeded_count > 0:
        storage_status = 'partial'
    else:
        storage_status = 'failed'

    if storage_status != 'succeeded':
        logger.warning(
            "[MediaStorage] 转存未全部成功: task=%s, status=%s, permanent=%d, expected=%d",
            task_id, storage_status, succeeded_count, expected_count,
        )

    try:
        task.mark_storage_result(
            storage_status=storage_status,
            stored_files=stored_files,
        )
    except Exception as exc:
        logger.error("[MediaStorage] 永久存储终态落库异常: task=%s, error=%s", task_id, exc)
        raise self.retry(exc=exc)

    if storage_status in ('succeeded', 'partial'):
        enqueue_media_artifact_delivery(task)

    logger.info(
        "[MediaStorage] 转存完成: %s, status=%s, permanent=%d, expected=%d",
        task_id, storage_status, succeeded_count, expected_count,
    )


def enqueue_media_artifact_delivery(task) -> None:
    """转存成功后异步投递正式图片；Broker 故障由周期任务补偿。"""
    session_id = getattr(task, 'source_session_id', '')
    tool_use_id = getattr(task, 'source_tool_use_id', '')
    if not isinstance(session_id, str) or not session_id or not isinstance(tool_use_id, str) or not tool_use_id:
        if getattr(task, 'artifact_delivery_status', '') != 'not_required':
            task.artifact_delivery_status = 'not_required'
            task.save(update_fields=['artifact_delivery_status', 'updated_at'])
        return
    try:
        deliver_media_artifacts.delay(str(task.id))
    except Exception as exc:
        logger.exception("[MediaStorage] 正式产物投递入队失败: task=%s", task.id)
        task.artifact_delivery_status = 'pending'
        task.artifact_delivery_error = str(exc)[:1000]
        task.save(update_fields=[
            'artifact_delivery_status', 'artifact_delivery_error', 'updated_at',
        ])


def _media_image_artifact_event(task, stored_file: dict) -> dict:
    filename = stored_file['file_name']
    file_id = stored_file['file_id']
    message_id = stored_file['artifact_message_id']
    return {
        'type': 'agent.stream.persist_message',
        'payload': {
            'message_id': message_id,
            'role': 'assistant',
            'message_kind': 'tool_artifact',
            'agent_run_id': task.source_agent_run_id,
            'blocks_json': [{
                'type': 'tabtin_rich_content',
                'kind': 'image',
                'summary': filename,
                'payload': {
                    'artifact_kind': 'oss_file',
                    'file_id': file_id,
                    'file_type': 'image',
                    'filename': filename,
                    'url': f'tabtin://resource/file/{file_id}?hint=tabfiles',
                    'mime_type': stored_file['mime_type'],
                    'file_size': stored_file['file_size'],
                    'access_url': stored_file['access_url'],
                    'source_tool_use_id': task.source_tool_use_id,
                    'self_check': {
                        'status': 'passed',
                        'summary': 'Media generation result stored in OSS.',
                    },
                },
            }],
        },
    }


def _sync_write_media_artifact(*, task, event: dict) -> bool:
    from apps.services.common.ws.handlers.relay_message_writer import _sync_write_critical_events

    result = _sync_write_critical_events(
        task.source_session_id,
        f'chat-session-{task.source_session_id}',
        str(task.user_id),
        [event],
    )
    return bool(result.success)


@shared_task(bind=True, max_retries=3, default_retry_delay=60, time_limit=120, soft_time_limit=100)
def deliver_media_artifacts(self, task_id: str) -> int:
    """把已转存图片幂等写入对话；稳定 message_id 同时兼容 Host 实时投影。"""
    from ..models import MediaTask

    try:
        task = MediaTask.objects.get(id=task_id)
    except MediaTask.DoesNotExist:
        return 0
    if task.storage_status not in ('succeeded', 'partial'):
        return 0
    if not task.source_session_id or not task.source_tool_use_id:
        MediaTask.objects.filter(id=task.id).update(artifact_delivery_status='not_required')
        return 0

    try:
        delivered = 0
        for stored_file in task.stored_files or []:
            if not _has_stable_file_identity(stored_file) or not stored_file.get('artifact_message_id'):
                continue
            event = _media_image_artifact_event(task, stored_file)
            if not _sync_write_media_artifact(task=task, event=event):
                raise RuntimeError('persist_message write failed')
            delivered += 1
        if delivered == 0:
            raise RuntimeError('no deliverable stored_files')
        MediaTask.objects.filter(id=task.id).update(
            artifact_delivery_status='delivered',
            artifact_delivery_error='',
            artifact_delivered_at=timezone.now(),
        )
        return delivered
    except Exception as exc:
        MediaTask.objects.filter(id=task.id).update(
            artifact_delivery_status='failed',
            artifact_delivery_error=str(exc)[:1000],
        )
        raise self.retry(exc=exc)


@shared_task(time_limit=60, soft_time_limit=50)
def recover_media_artifact_delivery() -> int:
    """补投已永久保存但尚未进入对话的正式图片产物。"""
    from ..models import MediaTask

    task_ids = list(
        MediaTask.objects.filter(
            storage_status__in=('succeeded', 'partial'),
            artifact_delivery_status__in=('pending', 'failed'),
        )
        .exclude(source_session_id='')
        .exclude(source_tool_use_id='')
        .order_by('updated_at')
        .values_list('id', flat=True)[:STORAGE_RECOVERY_BATCH_SIZE]
    )
    for task_id in task_ids:
        deliver_media_artifacts.delay(str(task_id))
    return len(task_ids)


def _register_source_module_usage(
    file_id: str,
    source_module: str,
    source_context_id: str,
    task_type: str,
    user_id: str,
) -> None:
    """为源模块注册额外 FileUsage，解决跨模块归属断层（TVIDEO-5）。

    当 media_generation 为 tabvideo 等外部模块转存产物时，
    只有 media_generation 的 FileUsage 会被创建。源模块删除项目时
    按自身 module 过滤无法命中，导致 OSS 文件永久泄漏。
    """
    if not source_module or not source_context_id or not file_id:
        return
    try:
        from apps.services.oss.models import FileRecord, FileUsage
        file_record = FileRecord.objects.get(id=file_id)
        FileUsage.add_usage(
            file_record=file_record,
            user_id=user_id,
            module=source_module,
            context_type=f"ai_{task_type}",
            context_id=source_context_id,
        )
    except Exception as exc:
        logger.warning(
            "[MediaStorage] 源模块 FileUsage 注册失败（不影响转存）: "
            "file_id=%s, source_module=%s, source_context_id=%s, error=%s",
            file_id, source_module, source_context_id, exc,
        )


def _guess_extension(url: str, task_type: str) -> str:
    parsed = urlparse(url)
    path = unquote(parsed.path)
    suffix = PurePosixPath(path).suffix
    if suffix in ('.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm'):
        return suffix
    if 'image' in task_type:
        return '.png'
    return '.mp4'

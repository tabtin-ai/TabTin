"""
Chat 消息信号 — 管理 OSS FileUsage 引用的生命周期（W3 §3.3.1 字段重命名）。

- post_save: 消息创建时从 content_blocks_json 提取 file_id，创建 FileUsage
- pre_delete(ChatMessage): 消息删除前 deactivate FileUsage，使 ref_count 递减
- pre_delete(ChatSession): 会话删除前批量释放所有消息关联的 FileUsage（DEL-10）

W3 字段迁移：blocks_json → content_blocks_json（Anthropic ContentBlock[]）。
file_id 字段在 Anthropic 协议下的位置：
- `image` block：`source.type='file_id'` 时 `source.file_id`
- `document` block：同上
- `tabtin_rich_content(kind='file')` block：`payload.file_id` 兜底
"""

import logging
from django.db.models.signals import post_save, pre_delete, post_delete
from django.db import transaction
from django.dispatch import receiver

logger = logging.getLogger(__name__)


@receiver(post_save, sender='tabchat.HandoffEvent')
def refresh_handoff_im_projection(sender, instance, created, **kwargs):
    """交接状态提交后刷新原 IM 卡片；详情仍以 handoff API 为准。"""
    if not created:
        return

    event_id = instance.pk
    transaction.on_commit(
        lambda: _enqueue_handoff_im_projection_refresh(event_id),
        using=kwargs.get('using'),
    )


def _enqueue_handoff_im_projection_refresh(event_id: int) -> None:
    from apps.chat.conversation.tasks import refresh_handoff_im_projection

    try:
        refresh_handoff_im_projection.apply_async(
            args=[event_id],
            queue='realtime_delivery',
        )
    except Exception:
        logger.exception('交接 IM 卡片刷新任务入队失败: event=%s', event_id)


_FILE_BEARING_BLOCK_TYPES = frozenset({
    'image', 'file', 'video', 'audio',
    'doc_ref', 'design_ref', 'slide_ref', 'video_ref',
    'document', 'attachment',
})


@receiver(post_save, sender='conversation.ChatMessage')
def sync_active_session_share_resource_grants(sender, instance, **kwargs):
    """消息产物落库后写可靠任务；网络与 ACL 副作用不阻塞消息保存。"""
    from apps.chat.conversation.services.session_share_resource_permission_service import (
        enqueue_session_share_resource_sync,
    )

    enqueue_session_share_resource_sync(message=instance)


def _extract_file_ids_from_blocks(blocks_json: list) -> list[str]:
    """从 content_blocks_json 中提取所有 file_id（W3 Anthropic ContentBlock 兼容版）。

    覆盖位置（v3 §2.2 schema）：
    - `image` block：`source.file_id`（FileIdImageSource type='file_id'）
    - `document` block：同上 FileIdDocumentSource
    - `tabtin_rich_content(kind='file')` block：`payload.file_id`
    - 老 `attachment` / 自定义 ref block 顶层 `file_id`（向后兼容老数据）
    """
    file_ids = []
    if not isinstance(blocks_json, list):
        return file_ids
    for block in blocks_json:
        if not isinstance(block, dict):
            continue
        block_type = block.get('type', '')

        # W3 新形态：image / document 用 source.file_id
        if block_type in ('image', 'document'):
            source = block.get('source')
            if isinstance(source, dict) and source.get('type') == 'file_id':
                fid = source.get('file_id')
                if fid:
                    file_ids.append(fid)
                    continue

        # 正式富内容资产：老文件块与 Agent Host 的 OSS 图片块都以 payload.file_id
        # 作为稳定身份。任意 image URL 不属于托管文件，不能误登记 FileUsage。
        if block_type == 'tabtin_rich_content':
            payload = block.get('payload')
            kind = block.get('kind') or (payload.get('kind') if isinstance(payload, dict) else None)
            artifact_kind = payload.get('artifact_kind') if isinstance(payload, dict) else None
            is_managed_asset = kind == 'file' or (
                kind == 'image' and artifact_kind == 'oss_file'
            )
            if is_managed_asset and isinstance(payload, dict) and payload.get('file_id'):
                file_ids.append(payload['file_id'])
                continue

        # 老形态兼容：顶层 file_id（v2 / v1 历史数据 + 自定义 ref block）
        if block_type in _FILE_BEARING_BLOCK_TYPES and block.get('file_id'):
            file_ids.append(block['file_id'])
    return file_ids


@receiver(post_save, sender='conversation.ChatMessage')
def register_message_file_usages(sender, instance, created, **kwargs):
    """消息创建或更新后：为 content_blocks_json 中的文件建立 FileUsage（W3 §3.3.1 字段重命名）。

    CHAT-4: 同时处理 created=True 和 created=False（消息编辑/更新），
    更新时先 deactivate 旧文件引用再注册新文件引用，确保 FileUsage 同步。
    """
    try:
        file_ids = _extract_file_ids_from_blocks(instance.content_blocks_json or [])

        from apps.services.oss.models import FileRecord, FileUsage

        user_id = None
        if hasattr(instance, 'session') and instance.session:
            user_id = instance.session.user_id
        user_id_str = str(user_id) if user_id else ''
        msg_id_str = str(instance.id)

        if not created:
            # CHAT-4: 消息更新 —— 找出当前活跃的 FileUsage 中不在新 blocks_json 的旧引用
            existing_usages = FileUsage.objects.filter(
                module='chat',
                context_type='message',
                context_id=msg_id_str,
                is_active=True,
            ).select_related('file_record')

            new_file_id_set = set(file_ids)
            for usage in existing_usages:
                if str(usage.file_record_id) not in new_file_id_set:
                    usage.deactivate()
                    logger.info(
                        "Chat 消息更新释放旧 FileUsage: message=%s, file_record=%s",
                        msg_id_str, usage.file_record_id,
                    )

        if not file_ids:
            return

        records = FileRecord.objects.filter(id__in=file_ids, status='completed')
        count = 0
        for record in records:
            FileUsage.add_usage(
                file_record=record,
                user_id=user_id_str,
                module='chat',
                context_type='message',
                context_id=msg_id_str,
            )
            count += 1

            if created:
                # CHAT-2: 清理 confirm-upload 阶段因无 contextId 而生成的孤儿 FileUsage
                orphans = FileUsage.objects.filter(
                    file_record=record,
                    module='chat',
                    context_type='message',
                    context_id='',
                    is_active=True,
                )
                for orphan in orphans:
                    orphan.deactivate()
                    logger.info(
                        "Chat 清理孤儿 FileUsage: file_record=%s, orphan_context_id=%s",
                        record.id, orphan.context_id,
                    )

        if count:
            logger.info(
                "Chat 消息%s: message_id=%s, 注册 %d FileUsage(s)",
                "创建" if created else "更新", msg_id_str, count,
            )

    except Exception as e:
        logger.error("Chat 消息 FileUsage 注册失败: %s", e, exc_info=True)


@receiver(post_save, sender='conversation.ChatMessage')
def sync_shared_task_artifact_permissions(sender, instance, **kwargs):
    """运行中任务在发卡后新增产物时，同步给当前共享接收人。"""
    if instance.role != 'assistant':
        return

    from apps.tabtinspace.services.project_task_results import iter_resource_pointers

    if not any(iter_resource_pointers(instance.content_blocks_json)):
        return

    message_id = instance.id

    def _sync():
        try:
            from apps.chat.conversation.models import ChatMessage, SessionShare
            from apps.chat.conversation.services.session_share_resource_permission_service import (
                sync_session_share_resource_grants,
            )

            message = ChatMessage.objects.select_related('session__user').filter(
                id=message_id,
            ).first()
            if message is None:
                return
            shares = SessionShare.objects.filter(
                session_id=message.session_id,
                status='active',
            )
            for share in shares:
                sync_session_share_resource_grants(
                    share=share,
                    owner_user=message.session.user,
                )
        except Exception:
            logger.exception(
                "[SessionShare] 新产物权限同步失败: message=%s",
                message_id,
            )

    transaction.on_commit(_sync)


@receiver(pre_delete, sender='conversation.ChatMessage')
def cleanup_message_file_usages(sender, instance, **kwargs):
    """DEL-16: 消息删除前捕获数据，通过 on_commit 延迟执行 MySQL deactivation。

    避免 pre_delete 内直接操作 MySQL 导致的跨库非原子问题：
    若外层事务回滚，MySQL 侧 deactivate 无法跟随回滚。
    """
    try:
        # W3 §3.3.1：blocks_json → content_blocks_json
        file_ids = _extract_file_ids_from_blocks(instance.content_blocks_json or [])
        if not file_ids:
            return

        _msg_id = str(instance.id)
        _organization_id = ""
        _user_id = ""
        if hasattr(instance, 'session') and instance.session:
            _organization_id = getattr(instance.session, 'organization_id', '') or ''
            _user_id = str(getattr(instance.session, 'user_id', '')) if instance.session.user_id else ''

        from django.db import transaction as db_transaction

        def _do_deactivate():
            try:
                from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
                count = deactivate_file_usages_and_release_storage(
                    module='chat',
                    context_filter={
                        'context_type': 'message',
                        'context_id': _msg_id,
                    },
                    organization_id=_organization_id,
                    user_id=_user_id,
                    biz_type='chat_message_delete',
                    biz_id=_msg_id,
                    log_prefix='[Chat]',
                )
                if count:
                    logger.info(
                        "Chat 消息删除清理: message_id=%s, deactivated %d FileUsage(s)",
                        _msg_id, count,
                    )
            except Exception as e:
                logger.error("Chat 消息删除清理 FileUsage 失败: msg=%s, %s", _msg_id, e, exc_info=True)

        db_transaction.on_commit(_do_deactivate)

    except Exception as e:
        logger.error("Chat 消息删除 pre_delete 数据捕获失败: %s", e, exc_info=True)


@receiver(pre_delete, sender='conversation.ChatSession')
def cleanup_session_file_usages(sender, instance, **kwargs):
    """DEL-10: 会话删除前批量释放所有消息关联的 FileUsage。

    虽然 Django CASCADE 通过 Collector 会逐条触发 ChatMessage 的 pre_delete 信号，
    但为防御非标准删除路径（raw SQL、queryset.delete() 等）导致的 FileUsage 泄漏，
    在 session 级统一做一次批量 deactivate。deactivate 内部是幂等的，不会重复操作。
    """
    try:
        from apps.chat.conversation.models import ChatMessage

        message_ids = list(
            ChatMessage.objects.filter(session=instance).values_list("id", flat=True)
        )
        if not message_ids:
            return

        organization_id = getattr(instance, 'organization_id', '') or ''
        user_id = str(instance.user_id) if instance.user_id else ''

        from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage

        str_ids = [str(mid) for mid in message_ids]
        count = deactivate_file_usages_and_release_storage(
            module='chat',
            context_filter={
                'context_type': 'message',
                'context_id__in': str_ids,
            },
            organization_id=organization_id,
            user_id=user_id,
            biz_type='chat_session_delete',
            biz_id=str(instance.id),
            log_prefix='[Chat Session]',
        )

        if count:
            logger.info(
                "Chat 会话删除清理: session_id=%s, messages=%d, deactivated %d FileUsage(s)",
                instance.id, len(message_ids), count,
            )

    except Exception as e:
        logger.error(
            "Chat 会话删除清理 FileUsage 失败: session=%s, %s",
            instance.id, e, exc_info=True,
        )


@receiver(pre_delete, sender='conversation.ChatSession')
def invalidate_thread_context_cache_on_delete(sender, instance, **kwargs):
    """DEV-P1-02: 会话删除时主动失效 DeviceDispatchService 的 thread context 缓存。"""
    try:
        from apps.services.agent_engine.services.device_dispatch_service import DeviceDispatchService
        DeviceDispatchService.invalidate_thread_context_cache(str(instance.id))
    except Exception:
        pass


# ════════════════════════════════════════════════════════════════════════════
#  ChatSession.space 删除语义
# ════════════════════════════════════════════════════════════════════════════
#
# 单库治理后 ChatSession.space 已是物理 FK(on_delete=SET_NULL)——删 Space 时由
# Django Collector（同库，正常工作）+ DB 约束把 space_id 置空，chat 历史不连带删。
# 原跨库 install_softref_cascade(set_null) 信号随之退役（双库时代因 Space/ChatSession
# 异库、Collector 跨库反查失败才需要它）。

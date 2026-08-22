"""会话消息队列尾部恢复任务。"""

from __future__ import annotations

import logging
import uuid

from celery import shared_task

logger = logging.getLogger(__name__)

_RETRY_DELAYS = (1, 5, 15, 60, 180, 600)


def _retry_delay(retries: int) -> int:
    return _RETRY_DELAYS[min(max(retries, 0), len(_RETRY_DELAYS) - 1)]


@shared_task(
    bind=True,
    ignore_result=True,
    acks_late=True,
    reject_on_worker_lost=True,
    max_retries=len(_RETRY_DELAYS),
    time_limit=660,
    soft_time_limit=630,
)
def recover_chat_queue(self, *, session_id: str, user_id: str, thread_id: str):
    """重新抢会话锁并 drain，覆盖 owner 释放后的尾部入队窗口。"""
    from django.contrib.auth import get_user_model

    from apps.chat.conversation.models import ChatSession
    from apps.services.agent_engine.services.message_intake import (
        drain_queue_until_safely_released,
        load_queue_settings,
        push_queue_error,
    )
    from apps.services.agent_engine.services.message_queue_service import (
        LockResult,
        LockWatchdog,
        MessageQueueService,
    )
    from apps.services.agent_execution.chat_service import ChatService

    User = get_user_model()
    queue_service = MessageQueueService()
    queue_settings = load_queue_settings(queue_service)
    lock_ttl = int(queue_settings.get("lock_ttl", 600))
    lock_token = uuid.uuid4().hex
    lock_result = queue_service.acquire_lock(
        thread_id,
        lock_token,
        ttl=lock_ttl,
    )

    if lock_result != LockResult.ACQUIRED:
        # HELD_BY_OTHER 也要重试：owner 可能在 Celery 本次检查后异常退出，
        # 下一轮负责在锁到期后接管，避免必须等用户再发一条消息才能恢复。
        reason = RuntimeError(
            f"queue recovery lock unavailable: thread={thread_id} result={lock_result.value}"
        )
        raise self.retry(
            exc=reason,
            countdown=_retry_delay(self.request.retries),
        )

    try:
        user = User.objects.get(id=user_id)
        session = ChatSession.objects.get(id=session_id)
        with LockWatchdog(
            queue_service, thread_id, lock_token, lock_ttl,
        ) as watchdog:
            drain_queue_until_safely_released(
                session=session,
                user=user,
                thread_id=thread_id,
                queue_service=queue_service,
                queue_settings=queue_settings,
                lock_token=lock_token,
                watchdog=watchdog,
                process_fn=ChatService._process_message_sync_core,
                error_fn=push_queue_error,
            )
    except (User.DoesNotExist, ChatSession.DoesNotExist):
        logger.info(
            "[QueueRecovery] Session or user disappeared; dropping recovery: thread=%s",
            thread_id,
        )
        queue_service.release_lock(thread_id, lock_token)
    except Exception as exc:
        queue_service.release_lock(thread_id, lock_token)
        logger.warning(
            "[QueueRecovery] Drain failed; scheduling retry: thread=%s error=%s",
            thread_id,
            exc,
            exc_info=True,
        )
        raise self.retry(
            exc=exc,
            countdown=_retry_delay(self.request.retries),
        )

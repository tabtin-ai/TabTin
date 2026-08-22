"""进宝 Celery 任务：回声消息。

⚠️ P0-1：文件名必须是 `tasks.py`——Celery `app.autodiscover_tasks()` 默认
`related_name='tasks'`，只会 import 每个 app 的 `tasks.py`。
错名 `echo_task.py` 会让 worker 看不到 'jinbao.echo_message'，echo 永远不响。
"""

from __future__ import annotations

import logging
import time

from celery import shared_task

from apps.tabchat.constants import MessageType
from apps.tabchat.models import Message
from apps.tabchat.services.message_service import (
    MAX_CONTENT_LENGTH,
    MessageService,
)

from .constants import ECHO_PREFIX, ECHO_THINK_SECONDS, JINBAO_USER_ID

logger = logging.getLogger(__name__)


@shared_task(
    name='jinbao.echo_message',
    bind=True,
    max_retries=2,
    default_retry_delay=5,
    ignore_result=True,
)
def echo_message(self, message_id: int):
    """以进宝身份回发原消息内容（加 🔁 前缀）。

    等待 ECHO_THINK_SECONDS 后走 MessageService.send_message。

    防递归：进宝自己发的消息直接 return（双重保险 + signal handler 也判一次）。
    只回 TEXT，避免文件/图片附件复杂度。
    P1-1：trim 到 MAX_CONTENT_LENGTH - len(ECHO_PREFIX) 防超长。
    """
    try:
        original = Message.objects.get(pk=message_id)
    except Message.DoesNotExist:
        logger.warning('[jinbao.echo] message=%s not found, skip', message_id)
        return

    if original.sender_id == JINBAO_USER_ID:
        return

    if original.message_type != MessageType.TEXT:
        logger.info(
            '[jinbao.echo] skip non-text message=%s type=%s',
            message_id, original.message_type,
        )
        return

    conv_id = str(original.conversation_id)

    # 模拟真人 1.2s 回复延迟
    time.sleep(ECHO_THINK_SECONDS)

    # P1-1：trim 防超长。len(ECHO_PREFIX) 用字符长度（与 send_message 校验逻辑一致）。
    trimmed = (original.content or '')[:MAX_CONTENT_LENGTH - len(ECHO_PREFIX)]

    try:
        MessageService.send_message(
            conversation_id=conv_id,
            sender_id=JINBAO_USER_ID,
            content=f'{ECHO_PREFIX}{trimmed}',
            message_type=MessageType.TEXT,
        )
        logger.info('[jinbao.echo] echoed message=%s', message_id)
    except PermissionError:
        # 进宝不是该会话成员——不该发生（dm 创建会自动加），但留 log
        logger.exception(
            '[jinbao.echo] not a member of conv=%s for msg=%s',
            conv_id, message_id,
        )
    except Exception as exc:
        logger.exception('[jinbao.echo] failed for msg=%s: %s', message_id, exc)
        raise self.retry(exc=exc)

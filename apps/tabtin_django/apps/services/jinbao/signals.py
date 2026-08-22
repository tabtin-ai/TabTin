"""进宝 signal 监听器。

两个关注点：
1. organization 创建（TEAM 类型）→ 自动加进宝
2. tabchat message_created → 判断是否给进宝、是则 enqueue echo task
"""

from __future__ import annotations

import logging

from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.tabchat.constants import ConversationType
from apps.tabchat.models import ConversationMember
from apps.tabchat.signals import message_created
from apps.tabtinspace.models import Organization

from .constants import JINBAO_USER_ID
from .provisioner import ensure_jinbao_in_organization

logger = logging.getLogger(__name__)


@receiver(post_save, sender=Organization)
def _on_organization_created(sender, instance, created, **kwargs):
    """新 organization 创建后自动加进宝。

    P0-4：跳过 personal organization。
    P0-6：用 transaction.on_commit 包一层，避免 PG 事务未提交时 ensure 查不到。
    """
    if not created:
        return
    if instance.type != Organization.OrganizationType.TEAM:
        return

    organization_id = str(instance.id)

    def _do_join() -> None:
        try:
            ensure_jinbao_in_organization(organization_id)
        except Exception:
            logger.exception(
                '[jinbao] auto-join failed for organization=%s', organization_id,
            )

    try:
        transaction.on_commit(_do_join, using='postgresql')
    except Exception:
        # 不在事务里时 on_commit 会立即执行；任何意外不能影响 organization 创建主路径
        logger.exception(
            '[jinbao] on_commit dispatch failed for organization=%s', organization_id,
        )


@receiver(message_created)
def _on_message_created(sender, message, conversation, **kwargs):
    """检测是不是发给进宝的 DM，是则触发回声。

    防递归：进宝自己发的消息直接 return。
    群聊不回声（避免炸群，对应 plan §7.2）。
    """
    try:
        if message.sender_id == JINBAO_USER_ID:
            return

        if conversation.type != ConversationType.DM:
            return

        other_member_ids = set(
            ConversationMember.objects
            .filter(conversation_id=conversation.id)
            .exclude(user_id=message.sender_id)
            .values_list('user_id', flat=True)
        )
        if JINBAO_USER_ID not in other_member_ids:
            return

        # lazy import 避免循环依赖
        from .tasks import echo_message

        echo_message.apply_async(args=[message.id])
    except Exception:
        # signal handler 异常不能影响 send_message 主路径
        logger.exception('[jinbao] on_message_created dispatch failed')

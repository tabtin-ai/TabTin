"""COM-13 P0 回归测试。

确保 cleanup_old_chat_messages 第二步（活跃 session 旧消息清理）正常工作。
"""

from __future__ import annotations

import inspect
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase, SimpleTestCase
from django.utils import timezone

from apps.chat.conversation.models import ChatMessage, ChatSession

User = get_user_model()


def _disconnect_user_signals():
    """临时断开 User post_save 信号，避免触发 Organization 创建（查询 PostgreSQL）。"""
    receivers = post_save.receivers[:]
    post_save.receivers = [
        r for r in post_save.receivers
        if "create_default_organization" not in str(r[1])
        and "sync_bot_agent" not in str(r[1])
    ]
    return receivers


def _restore_user_signals(receivers):
    post_save.receivers = receivers


class COM13CleanupActiveSessionMessagesTest(TestCase):
    """COM-13: cleanup_old_chat_messages 应清理活跃 session 中超过 retention_days 的旧消息。"""

    @classmethod
    def setUpClass(cls):
        cls._saved_receivers = _disconnect_user_signals()
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        _restore_user_signals(cls._saved_receivers)

    def setUp(self):
        self.user = User.objects.create_user(
            email="test_com13@test.local", password="pass",
        )

    def _create_session(self, status="active"):
        return ChatSession.objects.create(
            user=self.user,
            organization_id="ws_test",
            title="Test",
            status=status,
        )

    def _create_message(self, session, age_days=0):
        msg = ChatMessage.objects.create(
            session=session,
            role="user",
            content=f"message created {age_days} days ago",
        )
        if age_days > 0:
            old_time = timezone.now() - timedelta(days=age_days)
            ChatMessage.objects.filter(pk=msg.pk).update(created_at=old_time)
            msg.refresh_from_db()
        return msg

    def test_active_session_old_messages_deleted(self):
        """活跃 session 中超过 retention_days 的消息应被清理。"""
        session = self._create_session(status="active")
        old_msg = self._create_message(session, age_days=100)
        recent_msg = self._create_message(session, age_days=10)

        from apps.chat.conversation.tasks import cleanup_old_chat_messages

        result = cleanup_old_chat_messages(retention_days=90)

        self.assertFalse(ChatMessage.objects.filter(pk=old_msg.pk).exists())
        self.assertTrue(ChatMessage.objects.filter(pk=recent_msg.pk).exists())
        self.assertGreaterEqual(result["deleted"], 1)

    def test_archived_session_old_messages_deleted(self):
        """归档 session 中超过 retention_days 的消息也应被清理（第一步）。"""
        session = self._create_session(status="archived")
        old_msg = self._create_message(session, age_days=100)
        recent_msg = self._create_message(session, age_days=10)

        from apps.chat.conversation.tasks import cleanup_old_chat_messages

        result = cleanup_old_chat_messages(retention_days=90)

        self.assertFalse(ChatMessage.objects.filter(pk=old_msg.pk).exists())
        self.assertTrue(ChatMessage.objects.filter(pk=recent_msg.pk).exists())
        self.assertGreaterEqual(result["deleted"], 1)

    def test_recent_messages_not_deleted(self):
        """未超过 retention_days 的消息不应被删除。"""
        session = self._create_session(status="active")
        msg1 = self._create_message(session, age_days=30)
        msg2 = self._create_message(session, age_days=60)

        from apps.chat.conversation.tasks import cleanup_old_chat_messages

        result = cleanup_old_chat_messages(retention_days=90)

        self.assertTrue(ChatMessage.objects.filter(pk=msg1.pk).exists())
        self.assertTrue(ChatMessage.objects.filter(pk=msg2.pk).exists())
        self.assertEqual(result["deleted"], 0)


class COM13TaskConfigTest(SimpleTestCase):
    """COM-13 / COM-53 附带修复：task 配置检查。"""

    def test_bind_true_removed(self):
        """task 不应再使用 bind=True（因为不使用 self）。"""
        from apps.chat.conversation.tasks import cleanup_old_chat_messages

        sig = inspect.signature(cleanup_old_chat_messages)
        param_names = list(sig.parameters.keys())
        self.assertNotIn("self", param_names)

    def test_beat_schedule_registered(self):
        """CONVERSATION_BEAT_SCHEDULE 应注册到 celery.py。"""
        from tabtin.celery import _SCHEDULE_EXPORTS

        modules = [spec["module"] for spec in _SCHEDULE_EXPORTS]
        self.assertIn("apps.chat.conversation.tasks", modules)

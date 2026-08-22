"""
用户消息单一身份收口落库测试（DB）。

验证「一条用户消息全程同一个 id」在服务端两条落库路径成立：
  - relay 路径 `_upsert_chat_message`：普通 user echo 无 message_id 时用
    client_event_id 作 ChatMessage.id；带 message_id 时用 message_id（合成 user）。
  - HTTP 路径 `persist_user_messages`：用客户端 UUID 作 ChatMessage.id。
  - 两路撞库幂等（复用同一行，不落重复）。

这是「乐观气泡 → USER echo → ACK → HTTP 回灌 → 落库」全程同 id 的服务端地基，
彻底消除前端短暂双条（配套前端 sendMessageAction 乐观 id = client_message_id）。
"""
from __future__ import annotations

import os
import sys
import uuid

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.test import TestCase  # noqa: E402

from apps.chat.conversation.models import ChatMessage, ChatSession  # noqa: E402
from apps.services.common.ws.handlers.relay_message_writer import (  # noqa: E402
    _upsert_chat_message,
)
from apps.services.agent_engine.services.persistence_pipeline import (  # noqa: E402
    persist_user_messages,
)

User = get_user_model()


class UserMessageIdCollapseTests(TestCase):
    """用户消息落库 id 收口到 client_event_id。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.user = User.objects.create_user(
            username="id_collapse_user",
            email="id_collapse@example.com",
            password="testpass123",
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id="test-organization",
            title="id collapse test",
        )

    def _upsert_user(self, cid: uuid.UUID, payload: dict) -> uuid.UUID:
        return _upsert_chat_message(
            session_id=str(self.session.id),
            client_event_uuid=cid,
            role="user",
            content=payload.get("content", "你好"),
            payload=payload,
            user_id=str(self.user.id),
            client_event_id_str=str(cid),
        )

    def test_relay_user_echo_uses_client_event_id_as_pk(self):
        """普通 user echo（无 message_id）落库 id == client_event_id。"""
        cid = uuid.uuid4()
        server_id = self._upsert_user(cid, {"client_event_id": str(cid), "content": "你好"})

        self.assertEqual(str(server_id), str(cid))
        msg = ChatMessage.objects.get(id=cid)
        self.assertEqual(str(msg.id), str(cid))
        self.assertEqual(str(msg.client_event_id), str(cid))

    def test_relay_synthetic_user_prefers_message_id_as_pk(self):
        """合成 user（带合法 message_id）落库 id == message_id（对齐 assistant 语义）。"""
        cid = uuid.uuid4()
        mid = uuid.uuid4()
        server_id = self._upsert_user(
            cid, {"client_event_id": str(cid), "message_id": str(mid), "content": "push"},
        )

        self.assertEqual(str(server_id), str(mid))
        msg = ChatMessage.objects.get(id=mid)
        self.assertEqual(str(msg.client_event_id), str(cid))

    def test_relay_user_echo_is_idempotent(self):
        """同一 client_event_id 重复写复用同一行，不落重复 user。"""
        cid = uuid.uuid4()
        first = self._upsert_user(cid, {"client_event_id": str(cid), "content": "只此一条"})
        second = self._upsert_user(cid, {"client_event_id": str(cid), "content": "只此一条"})

        self.assertEqual(str(first), str(second))
        self.assertEqual(
            ChatMessage.objects.filter(session=self.session, role="user").count(),
            1,
        )

    def test_persist_user_messages_uses_client_uuid_as_pk(self):
        """HTTP 路径 persist_user_messages 用客户端 UUID 作 ChatMessage.id。"""
        cid = uuid.uuid4()
        result = persist_user_messages(
            self.session,
            ["你好，世界"],
            None,
            model_instance=None,
            blocks=None,
            attachments=None,
            client_message_id=str(cid),
        )

        self.assertEqual(len(result), 1)
        self.assertEqual(str(result[0].id), str(cid))
        self.assertEqual(str(result[0].client_event_id), str(cid))

    def test_persist_then_relay_same_client_id_no_duplicate(self):
        """HTTP 先落库、relay echo 后到（同 client_event_id）→ 复用同一行，不双写。"""
        cid = uuid.uuid4()
        persisted = persist_user_messages(
            self.session,
            ["同一条消息"],
            None,
            model_instance=None,
            blocks=None,
            attachments=None,
            client_message_id=str(cid),
        )
        relay_server_id = self._upsert_user(cid, {"client_event_id": str(cid), "content": "同一条消息"})

        self.assertEqual(str(persisted[0].id), str(cid))
        self.assertEqual(str(relay_server_id), str(cid))
        self.assertEqual(
            ChatMessage.objects.filter(session=self.session, role="user").count(),
            1,
        )

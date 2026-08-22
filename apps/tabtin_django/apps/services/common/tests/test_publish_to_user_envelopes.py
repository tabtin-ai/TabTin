"""W1 用户级事件治理 — ``publish_to_user`` 三条 publisher 路径契约测试。

锁定三条路径都满足同一组协议 invariant：

* envelope ``type`` **严格等于** ``agent.user.<short>`` 完整路径
  （短名 / 旧 topic 名都不行 —— 前端 router 按完整 type 路径分发）；
* publisher 调 ``publish_to_user(user_id, envelope)``——投递走 channel layer
  group ``user.{user_id}``（不绑 topic 订阅），``publish_to_user`` 内部
  在 ``user.{user_id}`` 上调 ``group_send``；
* 离线/断网期间不补送（2026-05 删除 inbox 兜底机制；用户重连后由各模块
  「打开拉最新」路径自洽，不依赖事件流补送）。

覆盖：

1. ``ChatStreamPublisher.publish_title_update`` → ``agent.user.title_updated``
2. ``NotificationService._push_ws`` → ``agent.user.notification.new``
3. ``BaseService.broadcast_permission_changed`` → ``agent.user.permission.changed``

反退化保险：任何路径回到旧 ``publish_ws_event(f'notifications.{user_id}', ...)``
/ ``publish_ws(thread_id, 'title_updated', ...)`` 等"伪用户级 topic"投递，
本测试都会立即 fail。

测试策略：mock ``publish_to_user`` 与 ``_group_send_with_retry`` 验证调用
形状；不需要真 channel layer / Redis（与 W0
``test_user_events.py`` 同风格）。
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.agent_protocol.constants import AgentUserEvent  # noqa: E402
from apps.services.common.agent_protocol.namespace import user_event_type  # noqa: E402


class TestPublishTitleUpdate(SimpleTestCase):
    """``ChatStreamPublisher.publish_title_update`` —— ``agent.user.title_updated``。"""

    def test_envelope_type_is_full_user_path(self):
        from apps.services.common.chat_stream_publisher import ChatStreamPublisher

        with patch(
            "apps.services.common.chat_stream_publisher.publish_to_user",
        ) as mock_pub:
            ChatStreamPublisher.publish_title_update(
                "user-123",
                session_id="sess-1",
                title="Python 学习",
                thread_id="chat-session-sess-1",
            )

        mock_pub.assert_called_once()
        args, _kwargs = mock_pub.call_args
        # call signature: publish_to_user(user_id, envelope)
        user_id_arg, envelope_arg = args[0], args[1]
        self.assertEqual(user_id_arg, "user-123")
        self.assertEqual(
            envelope_arg["type"],
            "agent.user.title_updated",
            "envelope.type 必须是完整 agent.user.* 路径，禁短名",
        )
        self.assertEqual(envelope_arg["type"], user_event_type(AgentUserEvent.TITLE_UPDATED))
        self.assertEqual(envelope_arg["payload"]["session_id"], "sess-1")
        self.assertEqual(envelope_arg["payload"]["title"], "Python 学习")
        self.assertEqual(envelope_arg["payload"]["thread_id"], "chat-session-sess-1")

    def test_skipped_when_user_id_empty(self):
        """user_id 为空时不应 publish（事件无法落到 user.{user_id} group）。"""
        from apps.services.common.chat_stream_publisher import ChatStreamPublisher

        with patch(
            "apps.services.common.chat_stream_publisher.publish_to_user",
        ) as mock_pub:
            ChatStreamPublisher.publish_title_update(
                "",
                session_id="sess-x",
                title="ignored",
            )

        mock_pub.assert_not_called()

    def test_lands_in_user_group(self):
        """端到端：publish_to_user 内部把 envelope group_send 到 user.{user_id}。

        反退化：旧实现走 ``publish_ws(thread_id, 'title_updated', ...)`` 把事件
        发到 ``topic.agent.stream.{thread_id}`` group —— 一旦此路径回归，本断言
        立即 fail。
        """
        from apps.services.common.chat_stream_publisher import ChatStreamPublisher

        captured_groups: list[str] = []

        def fake_group_send(group, message):
            captured_groups.append(group)

        with patch(
            "apps.services.common.ws.bus._group_send_with_retry",
            side_effect=fake_group_send,
        ):
            ChatStreamPublisher.publish_title_update(
                "user-abc",
                session_id="sess-1",
                title="hi",
            )

        self.assertEqual(captured_groups, ["user.user-abc"])


class TestPublishTeamSessionCreated(SimpleTestCase):
    """``ChatStreamPublisher.publish_team_session_created`` —— /#6889 已退役为空操作。"""

    def test_no_longer_publishes_private_session_schema(self):
        from apps.services.common.chat_stream_publisher import ChatStreamPublisher

        session_payload = {
            "id": "sess-team-1",
            "space_id": "space-team-1",
            "title": "成员新建会话",
        }
        with patch(
            "apps.services.common.chat_stream_publisher.publish_to_user",
        ) as mock_pub:
            ChatStreamPublisher.publish_team_session_created(
                ["user-owner", "user-member"],
                space_id="space-team-1",
                session_payload=session_payload,
            )

        mock_pub.assert_not_called()

    def test_empty_member_list_is_noop(self):
        from apps.services.common.chat_stream_publisher import ChatStreamPublisher

        with patch(
            "apps.services.common.chat_stream_publisher.publish_to_user",
        ) as mock_pub:
            ChatStreamPublisher.publish_team_session_created(
                [],
                space_id="space-team-1",
                session_payload={"id": "sess-1"},
            )

        mock_pub.assert_not_called()


class TestNotificationPushWs(SimpleTestCase):
    """``NotificationService._push_ws`` —— ``agent.user.notification.new``。"""

    def _make_notif(self, user_id="user-9"):
        notif = MagicMock()
        notif.id = "notif-id-1"
        notif.type = "system"
        notif.title = "title"
        notif.body = "body"
        notif.metadata = {}
        notif.organization_id = "wt-1"
        notif.space_id = ""
        notif.priority = "normal"
        notif.category = "general"
        notif.source_extension_id = ""
        notif.source_event_id = ""
        notif.channels_delivered = []
        notif.is_read = False
        notif.read_at = None
        notif.created_at = MagicMock()
        notif.created_at.isoformat = MagicMock(return_value="2026-05-03T12:00:00")
        return notif

    def test_envelope_type_is_full_user_path(self):
        from apps.services.notification.services.notification_service import NotificationService

        notif = self._make_notif()
        with patch(
            "apps.services.common.ws.bus.publish_to_user",
        ) as mock_pub:
            NotificationService._push_ws("user-9", notif)

        mock_pub.assert_called_once()
        args, kwargs = mock_pub.call_args
        user_id_arg, envelope_arg = args[0], args[1]
        self.assertEqual(user_id_arg, "user-9")
        self.assertEqual(
            envelope_arg["type"],
            "agent.user.notification.new",
            "envelope.type 必须是完整 agent.user.notification.new 路径",
        )
        self.assertEqual(envelope_arg["type"], user_event_type(AgentUserEvent.NOTIFICATION_NEW))

    def test_lands_in_user_group(self):
        from apps.services.notification.services.notification_service import NotificationService

        notif = self._make_notif()
        captured_groups: list[str] = []

        def fake_group_send(group, message):
            captured_groups.append(group)

        with patch(
            "apps.services.common.ws.bus._group_send_with_retry",
            side_effect=fake_group_send,
        ):
            NotificationService._push_ws("user-9", notif)

        self.assertEqual(captured_groups, ["user.user-9"])


class TestBroadcastPermissionChanged(SimpleTestCase):
    """``BaseService.broadcast_permission_changed`` —— ``agent.user.permission.changed``。"""

    def test_envelope_type_is_full_user_path(self):
        from apps.tabtinspace.services.base import BaseService

        with patch(
            "apps.services.common.ws.bus.publish_to_user",
        ) as mock_pub:
            BaseService.broadcast_permission_changed(
                user_id="user-7",
                organization_id="wt-uuid-1234",
                space_id="space-1",
            )

        mock_pub.assert_called_once()
        args, kwargs = mock_pub.call_args
        user_id_arg, envelope_arg = args[0], args[1]
        self.assertEqual(user_id_arg, "user-7")
        self.assertEqual(
            envelope_arg["type"],
            "agent.user.permission.changed",
            "envelope.type 必须是完整 agent.user.permission.changed 路径",
        )
        self.assertEqual(
            envelope_arg["type"],
            user_event_type(AgentUserEvent.PERMISSION_CHANGED),
        )
        self.assertEqual(envelope_arg["payload"]["organization_id"], "wt-uuid-1234")
        self.assertEqual(envelope_arg["payload"]["space_id"], "space-1")

    def test_lands_in_user_group(self):
        from apps.tabtinspace.services.base import BaseService

        captured_groups: list[str] = []

        def fake_group_send(group, message):
            captured_groups.append(group)

        with patch(
            "apps.services.common.ws.bus._group_send_with_retry",
            side_effect=fake_group_send,
        ):
            BaseService.broadcast_permission_changed(
                user_id="user-7",
                organization_id="wt-uuid-12345",
                space_id="",
            )

        self.assertEqual(captured_groups, ["user.user-7"])


class TestNoLegacyTopicFallback(SimpleTestCase):
    """反退化：三条路径都不应再调老 ``publish_ws_event`` 把事件发到伪 topic。"""

    def test_title_update_does_not_call_publish_ws_event(self):
        from apps.services.common.chat_stream_publisher import ChatStreamPublisher

        with (
            patch(
                "apps.services.common.chat_stream_publisher.publish_to_user",
            ),
            patch(
                "apps.services.common.chat_stream_publisher.publish_ws_event",
            ) as mock_ws,
            patch(
                "apps.services.common.chat_stream_publisher.publish_ws_event_reliable",
            ) as mock_ws_reliable,
        ):
            ChatStreamPublisher.publish_title_update(
                "user-1",
                session_id="s-1",
                title="t",
            )

        mock_ws.assert_not_called()
        mock_ws_reliable.assert_not_called()

    def test_notification_does_not_call_publish_ws_event(self):
        from apps.services.notification.services.notification_service import NotificationService

        notif = MagicMock()
        notif.id = "n-1"
        notif.type = "system"
        notif.title = "t"
        notif.body = "b"
        notif.metadata = {}
        notif.organization_id = "wt-1"
        notif.space_id = ""
        notif.priority = "normal"
        notif.category = "general"
        notif.source_extension_id = ""
        notif.source_event_id = ""
        notif.channels_delivered = []
        notif.is_read = False
        notif.read_at = None
        notif.created_at = MagicMock()
        notif.created_at.isoformat = MagicMock(return_value="2026-05-03T12:00:00")

        with (
            patch(
                "apps.services.common.ws.bus.publish_to_user",
            ),
            patch(
                "apps.services.common.ws.bus.publish_ws_event",
            ) as mock_ws,
        ):
            NotificationService._push_ws("user-2", notif)

        mock_ws.assert_not_called()

    def test_permission_changed_does_not_call_publish_ws_event(self):
        from apps.tabtinspace.services.base import BaseService

        with (
            patch(
                "apps.services.common.ws.bus.publish_to_user",
            ),
            patch(
                "apps.services.common.ws.bus.publish_ws_event",
            ) as mock_ws,
        ):
            BaseService.broadcast_permission_changed(
                user_id="user-3",
                organization_id="wt-3",
                space_id="space-3",
            )

        mock_ws.assert_not_called()


if __name__ == "__main__":
    unittest.main()

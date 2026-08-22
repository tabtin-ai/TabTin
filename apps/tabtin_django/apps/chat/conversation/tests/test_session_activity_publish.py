"""#8605 — ``publish_session_activity`` 契约测试。

覆盖：
* envelope.type == ``chat.session.activity.updated``
* payload 字段与 reason（created / message）
* 空 user_id 不发
* publish 失败吞异常不抛
"""
from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timezone as dt_timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.chat.conversation.services.session_activity_publisher import (  # noqa: E402
    ACTIVITY_EVENT,
    publish_session_activity,
)


def _make_session(**overrides):
    session = MagicMock()
    session.id = "11111111-1111-1111-1111-111111111111"
    session.user_id = "user-owner-1"
    session.organization_id = "org-1"
    session.title = "新会话"
    session.status = "active"
    session.workspace_id = "ws-1"
    session.project_id = None
    session.agent_id = "agent-1"
    # 显式挂 Agent，避免 MagicMock 自动造 agent 或误触 DB 回查。
    session.agent = SimpleNamespace(
        name="冲浪版",
        settings={"avatar_key": "web-researcher"},
    )
    session.last_message_at = datetime(2026, 8, 1, 3, 0, 0, tzinfo=dt_timezone.utc)
    session.updated_at = datetime(2026, 8, 1, 2, 0, 0, tzinfo=dt_timezone.utc)
    session.created_at = datetime(2026, 8, 1, 1, 0, 0, tzinfo=dt_timezone.utc)
    session.effective_thread_id = "chat-session-11111111-1111-1111-1111-111111111111"
    # MagicMock 会自动造 message_count；显式关掉，走 reason 启发式。
    session.message_count = None
    session._total_message_count = None
    session._visible_message_count = None
    for key, value in overrides.items():
        setattr(session, key, value)
    return session


def _immediate_on_commit(fn, **_kwargs):
    fn()


class TestPublishSessionActivity(SimpleTestCase):
    @patch(
        "apps.chat.conversation.services.session_activity_publisher.transaction.on_commit",
        side_effect=_immediate_on_commit,
    )
    @patch(
        "apps.chat.conversation.services.session_activity_publisher.publish_to_user",
    )
    def test_envelope_type_and_payload_fields(self, mock_pub, _on_commit):
        session = _make_session()
        publish_session_activity(session, reason="message")

        mock_pub.assert_called_once()
        user_id_arg, envelope = mock_pub.call_args[0]
        self.assertEqual(user_id_arg, "user-owner-1")
        self.assertEqual(envelope["type"], ACTIVITY_EVENT)
        self.assertEqual(envelope["type"], "chat.session.activity.updated")

        payload = envelope["payload"]
        self.assertEqual(payload["session_id"], str(session.id))
        self.assertEqual(payload["organization_id"], "org-1")
        self.assertEqual(payload["reason"], "message")
        self.assertEqual(payload["title"], "新会话")
        self.assertEqual(payload["status"], "active")
        self.assertEqual(payload["workspace_id"], "ws-1")
        self.assertIsNone(payload["project_id"])
        self.assertEqual(payload["agent_id"], "agent-1")
        self.assertEqual(payload["agent_name"], "冲浪版")
        self.assertEqual(payload["agent_avatar"], "web-researcher")
        self.assertEqual(
            payload["last_message_at"],
            "2026-08-01T03:00:00+00:00",
        )
        self.assertEqual(payload["updated_at"], "2026-08-01T02:00:00+00:00")
        self.assertEqual(payload["created_at"], "2026-08-01T01:00:00+00:00")
        self.assertEqual(payload["thread_id"], session.effective_thread_id)
        # MagicMock 非 ORM：reason=message 降级至少 1，并带 has_messages。
        self.assertEqual(payload["message_count"], 1)
        self.assertTrue(payload["has_messages"])
        self.assertFalse(payload["is_agent_mention_session"])

    @patch(
        "apps.chat.conversation.services.session_activity_publisher.transaction.on_commit",
        side_effect=_immediate_on_commit,
    )
    @patch(
        "apps.chat.conversation.services.session_activity_publisher.publish_to_user",
    )
    @patch(
        "apps.chat.conversation.services.agent_mention_sessions.session_is_agent_mention",
        return_value=True,
    )
    def test_payload_marks_agent_mention_session(self, _is_mention, mock_pub, _on_commit):
        session = _make_session()
        publish_session_activity(session, reason="message")

        payload = mock_pub.call_args[0][1]["payload"]
        self.assertTrue(payload["is_agent_mention_session"])

    @patch(
        "apps.chat.conversation.services.session_activity_publisher.transaction.on_commit",
        side_effect=_immediate_on_commit,
    )
    @patch(
        "apps.chat.conversation.services.session_activity_publisher.publish_to_user",
    )
    def test_reason_created(self, mock_pub, _on_commit):
        session = _make_session(last_message_at=None)
        publish_session_activity(session, reason="created")

        mock_pub.assert_called_once()
        payload = mock_pub.call_args[0][1]["payload"]
        self.assertEqual(payload["reason"], "created")
        self.assertIsNone(payload["last_message_at"])
        self.assertEqual(payload["message_count"], 0)
        self.assertFalse(payload["has_messages"])

    @patch(
        "apps.chat.conversation.services.session_activity_publisher.transaction.on_commit",
        side_effect=_immediate_on_commit,
    )
    @patch(
        "apps.chat.conversation.services.session_activity_publisher.publish_to_user",
    )
    def test_message_count_prefers_annotated_total(self, mock_pub, _on_commit):
        session = _make_session(_total_message_count=7)
        publish_session_activity(session, reason="message")

        payload = mock_pub.call_args[0][1]["payload"]
        self.assertEqual(payload["message_count"], 7)
        self.assertTrue(payload["has_messages"])

    @patch(
        "apps.chat.conversation.services.session_activity_publisher.transaction.on_commit",
        side_effect=_immediate_on_commit,
    )
    @patch(
        "apps.chat.conversation.services.session_activity_publisher.publish_to_user",
    )
    @patch(
        "apps.chat.conversation.services.session_activity_publisher._count_visible_messages",
        return_value=4,
    )
    def test_message_count_uses_visible_count_when_no_annotate(
        self, _count, mock_pub, _on_commit,
    ):
        session = _make_session()
        publish_session_activity(session, reason="agent_switched")

        payload = mock_pub.call_args[0][1]["payload"]
        self.assertEqual(payload["message_count"], 4)
        self.assertTrue(payload["has_messages"])

    @patch(
        "apps.chat.conversation.services.session_activity_publisher.transaction.on_commit",
        side_effect=_immediate_on_commit,
    )
    @patch(
        "apps.chat.conversation.services.session_activity_publisher.publish_to_user",
    )
    def test_skipped_when_user_id_empty(self, mock_pub, _on_commit):
        session = _make_session(user_id=None)
        publish_session_activity(session, reason="created")
        mock_pub.assert_not_called()

        session = _make_session(user_id="")
        publish_session_activity(session, reason="message")
        mock_pub.assert_not_called()

    @patch(
        "apps.chat.conversation.services.session_activity_publisher.transaction.on_commit",
        side_effect=_immediate_on_commit,
    )
    @patch(
        "apps.chat.conversation.services.session_activity_publisher.publish_to_user",
        side_effect=RuntimeError("bus down"),
    )
    def test_publish_failure_does_not_raise(self, _mock_pub, _on_commit):
        session = _make_session()
        # 不应向外抛
        publish_session_activity(session, reason="message")


if __name__ == "__main__":
    unittest.main()

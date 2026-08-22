"""
publish_to_user helper 单元测试。

验证：
  1. publish_to_user 直接发到 ``user.{user_id}`` group（不走 ``topic.user.{user_id}``）
  2. 与 auth.py 的 ``_join_group(f"user.{user_id}")`` 严格匹配，使
     ``agent.user.*`` 三类事件（title_updated / notification.new /
     permission.changed）实际可达前端
  3. 不写 Redis Stream（用户级广播不需要 buffer）
  4. user_id 为空 / None → 返回 False，无副作用
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.ws.bus import publish_to_user  # noqa: E402


class TestPublishToUser(SimpleTestCase):
    """publish_to_user 行为合约。"""

    def test_publishes_to_user_group_directly(self):
        """publish_to_user → ``user.{user_id}`` group（不是 ``topic.user.{user_id}``）。"""
        envelope = {"type": "agent.user.title_updated", "payload": {"x": 1}}

        with patch("apps.services.common.ws.bus._group_send_with_retry") as mock_send:
            ok = publish_to_user("user-123", envelope)

        self.assertTrue(ok)
        mock_send.assert_called_once()
        called_group = mock_send.call_args.args[0]
        # 关键断言：group 名称是 user.user-123（不是 topic.user.user-123）
        self.assertEqual(called_group, "user.user-123")

        called_msg = mock_send.call_args.args[1]
        self.assertEqual(called_msg["type"], "broadcast_message")
        self.assertEqual(called_msg["message"]["type"], "agent.user.title_updated")

    def test_does_not_write_to_redis_stream(self):
        """publish_to_user 不写 Redis Stream（用户级广播不需要 per-thread buffer）。"""
        envelope = {"type": "agent.user.notification.new", "payload": {}}

        with (
            patch("apps.services.common.ws.bus._append_to_buffer") as mock_buf,
            patch("apps.services.common.ws.bus._group_send_with_retry"),
        ):
            publish_to_user("user-buf-test", envelope)

        mock_buf.assert_not_called()

    def test_empty_user_id_returns_false(self):
        """user_id 空字符串 / None / 缺失 → 返回 False，不调 group_send。"""
        envelope = {"type": "agent.user.title_updated", "payload": {}}

        with patch("apps.services.common.ws.bus._group_send_with_retry") as mock_send:
            self.assertFalse(publish_to_user("", envelope))
            self.assertFalse(publish_to_user(None, envelope))  # type: ignore[arg-type]

        mock_send.assert_not_called()

    def test_group_send_failure_returns_false_no_raise(self):
        """group_send 抛异常 → 返回 False（不阻塞调用方）。"""
        envelope = {"type": "agent.user.title_updated", "payload": {}}

        with patch(
            "apps.services.common.ws.bus._group_send_with_retry",
            side_effect=RuntimeError("channel layer down"),
        ):
            ok = publish_to_user("user-fail", envelope)

        self.assertFalse(ok)

    def test_envelope_is_copied_not_mutated(self):
        """publish_to_user 不修改调用方的 envelope（避免外部状态污染）。"""
        original = {"type": "agent.user.title_updated", "payload": {"a": 1}}
        snapshot = dict(original)

        with patch("apps.services.common.ws.bus._group_send_with_retry"):
            publish_to_user("user-imm", original)

        self.assertEqual(original, snapshot)

    def test_user_id_with_special_chars_normalized(self):
        """user_id 含特殊字符（如 UUID 中的破折号）通过 normalize → 仍 user.<id>。"""
        envelope = {"type": "agent.user.title_updated", "payload": {}}

        with patch("apps.services.common.ws.bus._group_send_with_retry") as mock_send:
            publish_to_user("550e8400-e29b-41d4-a716-446655440000", envelope)

        called_group = mock_send.call_args.args[0]
        # CHANNEL_SAFE_PATTERN 允许 hyphen/underscore/dot/alnum，UUID 含 hyphen 不会被替换
        self.assertEqual(called_group, "user.550e8400-e29b-41d4-a716-446655440000")


if __name__ == "__main__":
    unittest.main()

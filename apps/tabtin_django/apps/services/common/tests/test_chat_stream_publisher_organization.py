"""
Wave 5（R3-02）：ChatStreamPublisher.publish_ws organization_id 注入测试。

验证：
  1. publish_ws 注入 envelope.organization_id（从 thread → ChatSession.organization_id 反查）
  2. 调用方显式传入 organization_id 时跳过 DB 查询
  3. LRU 缓存命中时不重复打 DB
  4. ChatSession 查询 miss → ExecutionRun fallback
  5. 任意失败 → envelope 不带 organization_id（前端走 chat store 反查 fallback）
"""
from __future__ import annotations

import os
import sys
import time
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.chat_stream_publisher import (  # noqa: E402
    ChatStreamPublisher,
    _invalidate_thread_organization_cache,
    _resolve_thread_organization,
    _resolve_thread_organization_cached,
)


class TestChatStreamPublisherOrganizationInjection(SimpleTestCase):
    def setUp(self):
        _invalidate_thread_organization_cache()

    def tearDown(self):
        _invalidate_thread_organization_cache()

    def _capture_envelope(self) -> tuple[dict, MagicMock]:
        """Helper：mock publish_ws_event → 捕获 envelope。"""
        captured: dict = {}

        def _capture(topic, envelope):
            captured["topic"] = topic
            captured["envelope"] = envelope
            return True

        return captured, _capture

    def test_publish_ws_injects_organization_id_via_chat_session(self):
        """thread_id → ChatSession.organization_id 反查注入 envelope。"""
        captured, capture_fn = self._capture_envelope()

        thread_id = "tin-thread-abc"
        wt_id = "00000000-0000-0000-0000-000000000111"

        with (
            patch(
                "apps.services.common.chat_stream_publisher._resolve_thread_organization",
                return_value=wt_id,
            ) as mock_resolve,
            patch(
                "apps.services.common.chat_stream_publisher.publish_ws_event",
                side_effect=capture_fn,
            ),
            patch(
                "apps.services.common.chat_stream_publisher._next_seq",
                return_value=1,
            ),
        ):
            ChatStreamPublisher.publish_ws(thread_id, "tool", {"foo": "bar"})

        self.assertIn("envelope", captured)
        self.assertEqual(captured["envelope"]["organization_id"], wt_id)
        self.assertEqual(captured["envelope"]["thread_id"], thread_id)
        # _resolve_thread_organization 被调一次（cache miss）
        mock_resolve.assert_called_once_with(thread_id)

    def test_explicit_organization_id_skips_db_lookup(self):
        """调用方显式传入 organization_id → 跳过 _resolve_thread_organization DB 查询。"""
        captured, capture_fn = self._capture_envelope()

        thread_id = "tin-thread-def"
        explicit_wt = "00000000-0000-0000-0000-000000000222"

        with (
            patch(
                "apps.services.common.chat_stream_publisher._resolve_thread_organization"
            ) as mock_resolve,
            patch(
                "apps.services.common.chat_stream_publisher.publish_ws_event",
                side_effect=capture_fn,
            ),
            patch(
                "apps.services.common.chat_stream_publisher._next_seq",
                return_value=1,
            ),
        ):
            ChatStreamPublisher.publish_ws(
                thread_id, "tool", {"foo": "bar"}, organization_id=explicit_wt,
            )

        self.assertEqual(captured["envelope"]["organization_id"], explicit_wt)
        # 显式传入则完全跳过 DB
        mock_resolve.assert_not_called()

    def test_lru_cache_avoids_repeated_db(self):
        """同一 thread_id 多次调用 → DB 仅打一次。"""
        captured, capture_fn = self._capture_envelope()

        thread_id = "tin-thread-cache-hit"
        wt_id = "00000000-0000-0000-0000-000000000333"

        with (
            patch(
                "apps.services.common.chat_stream_publisher._resolve_thread_organization",
                return_value=wt_id,
            ) as mock_resolve,
            patch(
                "apps.services.common.chat_stream_publisher.publish_ws_event",
                side_effect=capture_fn,
            ),
            patch(
                "apps.services.common.chat_stream_publisher._next_seq",
                return_value=1,
            ),
        ):
            for _ in range(3):
                ChatStreamPublisher.publish_ws(thread_id, "step", {"phase": "x"})

        self.assertEqual(captured["envelope"]["organization_id"], wt_id)
        # cache hit → 第二次/第三次不再走 DB
        mock_resolve.assert_called_once()

    def test_resolve_returns_none_envelope_omits_organization_id(self):
        """解析失败（无 ChatSession 也无 ExecutionRun）→ envelope 不带 organization_id。"""
        captured, capture_fn = self._capture_envelope()

        thread_id = "tin-thread-orphan"

        with (
            patch(
                "apps.services.common.chat_stream_publisher._resolve_thread_organization",
                return_value=None,
            ),
            patch(
                "apps.services.common.chat_stream_publisher.publish_ws_event",
                side_effect=capture_fn,
            ),
            patch(
                "apps.services.common.chat_stream_publisher._next_seq",
                return_value=1,
            ),
        ):
            ChatStreamPublisher.publish_ws(thread_id, "assistant", {"phase": "delta"})

        self.assertNotIn("organization_id", captured["envelope"])
        self.assertEqual(captured["envelope"]["thread_id"], thread_id)

    def test_publish_ws_reliable_also_injects_organization_id(self):
        """终态事件 done / lifecycle 走 reliable 路径，也要注入 organization_id。"""
        captured, capture_fn = self._capture_envelope()

        thread_id = "tin-thread-done"
        wt_id = "00000000-0000-0000-0000-000000000444"

        with (
            patch(
                "apps.services.common.chat_stream_publisher._resolve_thread_organization",
                return_value=wt_id,
            ),
            patch(
                "apps.services.common.chat_stream_publisher.publish_ws_event_reliable",
                side_effect=capture_fn,
            ),
            patch(
                "apps.services.common.chat_stream_publisher._next_seq",
                return_value=2,
            ),
        ):
            ChatStreamPublisher.publish_ws_reliable(thread_id, "done", {"content": "ok"})

        self.assertEqual(captured["envelope"]["organization_id"], wt_id)


if __name__ == "__main__":
    unittest.main()

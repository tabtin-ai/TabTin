"""
SDI-019 回归测试

SDI-019: parse_pptx 必须有 per-user 频率限制，防止资源滥用。
验证频率限制到达上限后返回 429，正常请求放行。
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabslide import api as slide_api
from apps.tabslide.schemas import ParsePptxRequest

User = get_user_model()


def _unwrap(resp):
    if isinstance(resp, tuple):
        return resp[0], resp[1]
    return 200, resp


class SDI019ParsePptxRateLimitTests(TestCase):
    """SDI-019: parse_pptx per-user 频率限制。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.user = User.objects.create_user(
            username=f"sdi019_user_{uuid.uuid4().hex[:6]}",
            email=f"sdi019_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        cls.user2 = User.objects.create_user(
            username=f"sdi019_user2_{uuid.uuid4().hex[:6]}",
            email=f"sdi019_user2_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )

    def _make_request(self, user=None):
        return SimpleNamespace(auth=user or self.user)

    def _make_body(self):
        return ParsePptxRequest(file_base64="UEsDBBQ=")

    @patch("apps.tabslide.api._cache")
    def test_rate_limit_blocks_after_threshold(self, mock_cache):
        """超出频率限制后应返回 429。"""
        mock_cache.get.return_value = 10

        req = self._make_request()
        status, body = _unwrap(slide_api.parse_pptx(req, self._make_body()))

        self.assertEqual(status, 429, f"应返回 429，实际返回 {status}: {body}")
        self.assertIn("频繁", str(body))

    @patch("apps.tabslide.api._cache")
    def test_rate_limit_allows_under_threshold(self, mock_cache):
        """未超限时请求应放行（后续解析可能失败，不影响本测试目标）。"""
        mock_cache.get.return_value = 5
        mock_cache.incr.return_value = 6

        req = self._make_request()
        status, body = _unwrap(slide_api.parse_pptx(req, self._make_body()))

        self.assertNotEqual(status, 429, "未超限时不应返回 429")

    @patch("apps.tabslide.api._cache")
    def test_rate_limit_per_user_isolation(self, mock_cache):
        """不同用户的频率限制互相独立。"""
        call_count = 0

        def mock_get(key, default=0):
            nonlocal call_count
            call_count += 1
            if str(self.user.id) in key:
                return 10
            return 0

        mock_cache.get.side_effect = mock_get
        mock_cache.incr.return_value = 1

        req1 = self._make_request(self.user)
        status1, _ = _unwrap(slide_api.parse_pptx(req1, self._make_body()))
        self.assertEqual(status1, 429, "user1 应被限流")

        req2 = self._make_request(self.user2)
        status2, _ = _unwrap(slide_api.parse_pptx(req2, self._make_body()))
        self.assertNotEqual(status2, 429, "user2 不应被限流")

    @patch("apps.tabslide.api._cache")
    def test_rate_limit_first_request_initializes_counter(self, mock_cache):
        """首次请求时 cache.incr 抛出 ValueError，应降级到 cache.set 初始化。"""
        mock_cache.get.return_value = 0
        mock_cache.incr.side_effect = ValueError("Key not found")

        req = self._make_request()
        status, _ = _unwrap(slide_api.parse_pptx(req, self._make_body()))

        mock_cache.set.assert_called_once()
        args = mock_cache.set.call_args
        self.assertEqual(args[0][0], f"tabslide:parse_pptx:rate:{self.user.id}")
        self.assertEqual(args[0][1], 1)
        self.assertEqual(args[0][2], 60)

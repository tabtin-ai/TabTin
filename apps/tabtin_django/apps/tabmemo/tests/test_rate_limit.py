"""
TabMemo bookmark_preview 频率限制测试

使用 SimpleTestCase + mock 验证 is_rate_limited 集成。
"""

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

RATE_LIMITED_PATH = "apps.services.common.utils.is_rate_limited"


class BookmarkPreviewRateLimitTests(SimpleTestCase):
    """验证 bookmark_preview 端点的频率限制"""

    def _call_bookmark_preview(self, url: str = "https://example.com", user_id: str = "user-123"):
        from apps.tabmemo.api import bookmark_preview
        from apps.tabmemo.schemas import BookmarkPreviewRequest

        request = MagicMock()
        request.auth = MagicMock()
        request.auth.id = user_id
        payload = BookmarkPreviewRequest(url=url)
        return bookmark_preview(request, payload)

    @patch(RATE_LIMITED_PATH, return_value=True)
    def test_should_return_429_when_rate_limited(self, mock_limited):
        result = self._call_bookmark_preview()
        self.assertIsInstance(result, tuple)
        status_code, body = result
        self.assertEqual(status_code, 429)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "RATE_LIMIT_EXCEEDED")

    @patch(RATE_LIMITED_PATH, return_value=True)
    def test_rate_limited_message(self, mock_limited):
        _, body = self._call_bookmark_preview()
        self.assertEqual(body["message"], "请求过于频繁，请稍后再试")

    @patch(RATE_LIMITED_PATH, return_value=True)
    def test_rate_limited_key_contains_user_id(self, mock_limited):
        self._call_bookmark_preview(user_id="abc-456")
        mock_limited.assert_called_once()
        key = mock_limited.call_args[0][0]
        self.assertEqual(key, "tabmemo:bookmark_preview:abc-456")

    @patch(RATE_LIMITED_PATH, return_value=True)
    def test_rate_limited_params_limit_and_window(self, mock_limited):
        self._call_bookmark_preview()
        _, kwargs = mock_limited.call_args
        self.assertEqual(kwargs.get("limit"), 10)
        self.assertEqual(kwargs.get("window"), 60)

    @patch("apps.tabmemo.api._is_safe_url", return_value=False)
    @patch(RATE_LIMITED_PATH, return_value=False)
    def test_should_proceed_past_rate_limit_when_not_limited(self, mock_limited, mock_safe):
        result = self._call_bookmark_preview()
        self.assertIsInstance(result, tuple)
        status_code, _ = result
        self.assertNotEqual(status_code, 429)

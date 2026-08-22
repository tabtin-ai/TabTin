"""video_media_resolver 单测。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.llm.wire_adapter.image_fetcher import ImageFetchError
from apps.services.llm.wire_adapter.video_media_resolver import (
    VideoResolveError,
    resolve_video_bytes,
)


class VideoMediaResolverTests(SimpleTestCase):

    def test_data_url_mp4(self):
        url = "data:video/mp4;base64,AAAA"
        video = resolve_video_bytes(url, fallback_filename="clip.bin")
        self.assertEqual(video.content, b"\x00\x00\x00")
        self.assertTrue(video.filename.endswith(".mp4"))
        self.assertEqual(video.mime_type, "video/mp4")

    def test_remote_allowlisted_url(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = b"\x00\x00\x00\x18ftypmp42"
        mock_resp.headers = {"content-type": "video/mp4"}
        mock_resp.url = "https://cdn.example.com/a.mp4"

        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.get.return_value = mock_resp

        with patch(
            "apps.services.llm.wire_adapter.video_media_resolver._validate_fetch_url",
        ), patch(
            "apps.services.llm.wire_adapter.video_media_resolver.httpx.Client",
            return_value=mock_client,
        ):
            video = resolve_video_bytes(
                "https://cdn.example.com/a.mp4",
                fallback_filename="fallback.bin",
            )

        self.assertEqual(video.content, b"\x00\x00\x00\x18ftypmp42")
        self.assertEqual(video.filename, "a.mp4")
        self.assertEqual(video.mime_type, "video/mp4")

    def test_remote_forbidden_url_maps_unsupported(self):
        with patch(
            "apps.services.llm.wire_adapter.video_media_resolver._validate_fetch_url",
            side_effect=ImageFetchError(
                reason="forbidden_url",
                host="evil.example",
                detail="not allowlisted",
            ),
        ):
            with self.assertRaises(VideoResolveError) as cm:
                resolve_video_bytes("https://evil.example/a.mp4")
        self.assertEqual(cm.exception.reason, "unsupported_url")

    def test_empty_url_invalid(self):
        with self.assertRaises(VideoResolveError) as cm:
            resolve_video_bytes("")
        self.assertEqual(cm.exception.reason, "invalid_url")

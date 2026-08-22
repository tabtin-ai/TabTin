"""upload-image 端点回归测试 (BS-001 fix)"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from apps.tabslide import api as slide_api


class UploadImageEndpointTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="slide_user",
            email="slide_user@test.com",
            password="pass123",
        )
        self.request = SimpleNamespace(auth=self.user)
        self.png_1x1 = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
            b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00"
            b"\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00"
            b"\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
        )

    def _make_file(self, content: bytes, name: str = "test.png", content_type: str = "image/png"):
        return SimpleUploadedFile(name, content, content_type=content_type)

    @staticmethod
    def _unwrap(resp):
        """Django Ninja 错误响应为 (status_code, dict)，成功响应为 dict。"""
        if isinstance(resp, tuple):
            return resp[0], resp[1]
        return 200, resp

    # ── 路由存在性 ──

    def test_upload_image_function_exists(self):
        self.assertTrue(
            hasattr(slide_api, "upload_image"),
            "upload_image function should exist in api module",
        )

    # ── 正常上传 ──

    @patch("apps.tabslide.services.slide_service.build_oss_image_handler")
    def test_upload_image_success(self, mock_build):
        mock_handler = MagicMock(return_value="https://cdn.example.com/test.png")
        mock_build.return_value = mock_handler

        file = self._make_file(self.png_1x1)
        status, body = self._unwrap(
            slide_api.upload_image(self.request, organization_id="ws-1", file=file)
        )

        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["url"], "https://cdn.example.com/test.png")
        self.assertEqual(body["data"]["content_type"], "image/png")
        self.assertEqual(body["data"]["size"], len(self.png_1x1))
        mock_build.assert_called_once_with(
            organization_id="ws-1",
            user_id=str(self.user.id),
            context_type="slide_upload",
        )
        mock_handler.assert_called_once_with(self.png_1x1, "image/png")

    # ── 格式校验 ──

    @patch("apps.tabslide.services.slide_service.build_oss_image_handler")
    def test_upload_image_rejects_non_image(self, mock_build):
        file = self._make_file(b"not an image", name="doc.pdf", content_type="application/pdf")
        status, body = self._unwrap(
            slide_api.upload_image(self.request, file=file)
        )

        self.assertEqual(status, 400)
        self.assertFalse(body["success"])
        mock_build.assert_not_called()

    # ── 大小校验 ──

    @patch("apps.tabslide.services.slide_service.build_oss_image_handler")
    def test_upload_image_rejects_oversized_file(self, mock_build):
        big_file = self._make_file(b"\x00" * (20 * 1024 * 1024 + 1))
        status, body = self._unwrap(
            slide_api.upload_image(self.request, file=big_file)
        )

        self.assertEqual(status, 400)
        self.assertFalse(body["success"])
        mock_build.assert_not_called()

    # ── OSS 不可用 ──

    @patch("apps.tabslide.services.slide_service.build_oss_image_handler")
    def test_upload_image_returns_error_when_oss_unavailable(self, mock_build):
        mock_build.return_value = None
        file = self._make_file(self.png_1x1)
        status, body = self._unwrap(
            slide_api.upload_image(self.request, file=file)
        )

        self.assertIn(status, (400, 500))
        self.assertFalse(body["success"])

    # ── OSS 异常 ──

    @patch("apps.tabslide.services.slide_service.build_oss_image_handler")
    def test_upload_image_handles_oss_exception(self, mock_build):
        mock_handler = MagicMock(side_effect=RuntimeError("OSS timeout"))
        mock_build.return_value = mock_handler
        file = self._make_file(self.png_1x1)
        status, body = self._unwrap(
            slide_api.upload_image(self.request, file=file)
        )

        self.assertFalse(body["success"])

    # ── 各种图片格式 ──

    @patch("apps.tabslide.services.slide_service.build_oss_image_handler")
    def test_upload_image_accepts_jpeg(self, mock_build):
        mock_build.return_value = MagicMock(return_value="https://cdn.example.com/photo.jpg")
        file = self._make_file(b"\xff\xd8\xff", name="photo.jpg", content_type="image/jpeg")
        status, body = self._unwrap(
            slide_api.upload_image(self.request, file=file)
        )

        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["content_type"], "image/jpeg")

    @patch("apps.tabslide.services.slide_service.build_oss_image_handler")
    def test_upload_image_accepts_webp(self, mock_build):
        mock_build.return_value = MagicMock(return_value="https://cdn.example.com/photo.webp")
        file = self._make_file(b"RIFF", name="photo.webp", content_type="image/webp")
        status, body = self._unwrap(
            slide_api.upload_image(self.request, file=file)
        )

        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["content_type"], "image/webp")

    # ── 文档声明一致性 ──

    def test_docstring_declares_upload_image_endpoint(self):
        docstring = slide_api.__doc__ or ""
        self.assertIn("POST   /upload-image/", docstring)

    # ── 孤立函数已删除 ──

    def test_orphan_build_oss_image_handler_removed(self):
        self.assertFalse(
            hasattr(slide_api, "_build_oss_image_handler"),
            "_build_oss_image_handler should be removed (orphan code)",
        )

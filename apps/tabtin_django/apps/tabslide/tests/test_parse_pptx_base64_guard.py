"""
W3-06 回归测试：J3-18 parse_pptx base64 大小预检

验证 parse_pptx 在 base64 解码前先检查字符串长度，
避免 ~67MB base64 全部解码消耗内存后才被拒绝。
"""

from __future__ import annotations

import base64
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabslide import api as slide_api
from apps.tabslide.schemas import ParsePptxRequest

User = get_user_model()


def _make_request(user):
    return SimpleNamespace(auth=user)


class ParsePptxBase64SizeGuardTests(TestCase):
    """parse_pptx 端点：base64 字符串长度预检。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.user = User.objects.create_user(
            username="pptx_guard_test",
            email="pptx_guard_test@test.com",
            password="pass123",
        )

    def test_oversized_base64_rejected_before_decode(self):
        """超过 50MB 等价 base64 长度的请求应被立即拒绝，返回 400。"""
        MAX_FILE_SIZE = 50 * 1024 * 1024
        oversized_b64 = "A" * (MAX_FILE_SIZE * 4 // 3 + 100)

        body = ParsePptxRequest(file_base64=oversized_b64)
        req = _make_request(self.user)

        resp = slide_api.parse_pptx(req, body)

        status = resp[0] if isinstance(resp, tuple) else 200
        self.assertEqual(status, 400)

    def test_small_base64_passes_length_check(self):
        """小于上限的 base64 应通过长度预检（后续解析失败不影响本测试目标）。"""
        small_data = b"PK" + b"\x00" * 100
        small_b64 = base64.b64encode(small_data).decode()

        body = ParsePptxRequest(file_base64=small_b64)
        req = _make_request(self.user)

        with patch("apps.tabslide.api.pptx_io") as mock_pptx:
            mock_pptx.validate_pptx_file.side_effect = ValueError("not a valid pptx")
            resp = slide_api.parse_pptx(req, body)

        status = resp[0] if isinstance(resp, tuple) else 200
        self.assertNotEqual(status, 400, "小文件不应被大小预检拒绝")

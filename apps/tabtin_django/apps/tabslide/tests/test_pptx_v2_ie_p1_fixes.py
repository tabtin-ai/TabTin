"""
V2 Import/Export P1 修复回归测试 — F3-05, F3-02

F3-05: _guess_image_format WebP 魔数大小写修复
F3-02: _resolve_font_data_for_embed SSRF 防护
"""

import importlib.util
import types
import sys
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch, MagicMock

_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_v2_ie_p1_test", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

_guess_image_format = _PPTX_IO._guess_image_format
_resolve_font_data_for_embed = _PPTX_IO._resolve_font_data_for_embed


class TestGuessImageFormatWebP(TestCase):
    """F3-05: WebP 魔数必须匹配大写 RIFF/WEBP。"""

    @staticmethod
    def _make_webp_bytes(size: int = 64) -> bytes:
        header = b"RIFF" + (size - 8).to_bytes(4, "little") + b"WEBP"
        return header + b"\x00" * (size - 12)

    def test_valid_webp_detected(self):
        data = self._make_webp_bytes()
        self.assertEqual(_guess_image_format(data), "webp")

    def test_webp_with_no_src_hint(self):
        data = self._make_webp_bytes(128)
        self.assertEqual(_guess_image_format(data, src_hint=None), "webp")

    def test_non_webp_riff_not_detected_as_webp(self):
        header = b"RIFF\x00\x00\x00\x00AVI "
        data = header + b"\x00" * 52
        result = _guess_image_format(data)
        self.assertNotEqual(result, "webp")

    def test_lowercase_riff_not_detected(self):
        header = b"riff\x00\x00\x00\x00WEBP"
        data = header + b"\x00" * 52
        result = _guess_image_format(data)
        self.assertIsNone(result)

    def test_png_still_detected(self):
        data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 56
        self.assertEqual(_guess_image_format(data), "png")

    def test_jpg_still_detected(self):
        data = b"\xff\xd8\xff\xe0" + b"\x00" * 60
        self.assertEqual(_guess_image_format(data), "jpg")


class TestResolveFontDataSsrf(TestCase):
    """F3-02: OSS URL 必须经过 validate_url_ssrf 检查。"""

    @patch("apps.services.common.url_security.validate_url_ssrf", return_value=True)
    def test_ssrf_blocked_url_returns_none(self, mock_validate):
        entry = {"name": "EvilFont", "oss_url": "http://169.254.169.254/latest/meta-data/"}
        result = _resolve_font_data_for_embed(entry)
        self.assertIsNone(result)
        mock_validate.assert_called_once_with("http://169.254.169.254/latest/meta-data/")

    @patch("apps.services.common.url_security.validate_url_ssrf", return_value=False)
    @patch("urllib.request.urlopen")
    def test_safe_url_proceeds_to_download(self, mock_urlopen, mock_validate):
        font_data = b"\x00\x01\x00\x00" + b"\x00" * 60
        mock_resp = MagicMock()
        mock_resp.read.return_value = font_data
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        entry = {"name": "SafeFont", "oss_url": "https://cdn.example.com/fonts/safe.ttf"}
        result = _resolve_font_data_for_embed(entry)
        self.assertEqual(result, font_data)
        mock_validate.assert_called_once_with("https://cdn.example.com/fonts/safe.ttf")

    def test_base64_path_unaffected(self):
        import base64
        raw = b"\x00\x01\x00\x00" + b"\x00" * 28
        entry = {"name": "B64Font", "data_base64": base64.b64encode(raw).decode()}
        result = _resolve_font_data_for_embed(entry)
        self.assertEqual(result, raw)

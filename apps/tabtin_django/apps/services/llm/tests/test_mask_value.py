"""LLM 服务敏感值脱敏测试。"""

from django.test import SimpleTestCase

from ..services.base import _mask_value, _sanitize_dict, _sanitize_headers


class MaskValueTestCase(SimpleTestCase):
    """_mask_value 对齐 credential_vault mask_value 标准口径。"""

    def test_empty_and_none_return_full_mask(self):
        self.assertEqual(_mask_value(""), "****")
        self.assertEqual(_mask_value(None), "****")

    def test_non_str_returns_full_mask(self):
        self.assertEqual(_mask_value(12345), "****")

    def test_short_values_up_to_12_chars_fully_masked(self):
        for length in (4, 5, 8, 12):
            value = "a" * length
            with self.subTest(length=length):
                self.assertEqual(_mask_value(value), "****")

    def test_long_values_show_prefix_and_suffix(self):
        self.assertEqual(_mask_value("a" * 13), "aaaa****aaaa")
        self.assertEqual(_mask_value("sk-abcdefghijklmnop"), "sk-a****mnop")

    def test_sanitize_dict_uses_standard_mask(self):
        cleaned = _sanitize_dict({"api_key": "short-key"})
        self.assertEqual(cleaned["api_key"], "****")

    def test_sanitize_headers_uses_standard_mask(self):
        cleaned = _sanitize_headers({"Authorization": "short-token"})
        self.assertEqual(cleaned["Authorization"], "****")

    def test_sanitize_empty_sensitive_field_returns_full_mask(self):
        self.assertEqual(_sanitize_dict({"api_key": ""})["api_key"], "****")
        self.assertEqual(_sanitize_headers({"x-api-key": ""})["x-api-key"], "****")

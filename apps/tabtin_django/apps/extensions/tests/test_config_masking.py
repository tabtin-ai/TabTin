"""Extension connection config 脱敏回归测试。"""

from __future__ import annotations

from unittest.mock import patch

from django.test import SimpleTestCase

from apps.extensions.api import _mask_config, _mask_value


class MaskValueTests(SimpleTestCase):
    def test_short_values_fully_masked(self):
        for length in (8, 9, 12):
            with self.subTest(length=length):
                value = "a" * length
                self.assertEqual(_mask_value(value), "****")

    def test_long_values_show_prefix_and_suffix(self):
        self.assertEqual(_mask_value("a" * 13), "aaaa****aaaa")
        self.assertEqual(_mask_value("abcdefghij1234567890"), "abcd****7890")


class MaskConfigTests(SimpleTestCase):
    @patch("apps.extensions.api._get_sensitive_keys", return_value={"secret", "token"})
    def test_password_fields_masked_non_sensitive_preserved(self, _mock_sensitive):
        config = {
            "secret": "abcdefghij1234567890",
            "token": "shorttok",
            "endpoint": "https://example.com",
            "enabled": True,
        }
        masked = _mask_config(config, extension_id="demo")

        self.assertEqual(masked["secret"], "abcd****7890")
        self.assertEqual(masked["token"], "****")
        self.assertEqual(masked["endpoint"], "https://example.com")
        self.assertIs(masked["enabled"], True)

    @patch("apps.extensions.api._get_sensitive_keys", return_value={"secret"})
    def test_empty_password_field_becomes_none(self, _mock_sensitive):
        masked = _mask_config({"secret": ""}, extension_id="demo")
        self.assertIsNone(masked["secret"])

    def test_empty_config_returns_empty_dict(self):
        self.assertEqual(_mask_config({}), {})
        self.assertEqual(_mask_config(None), {})

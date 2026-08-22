"""TDP-007 / TDP-011 回归测试：validate_config 前置检查第三方依赖。

TDP-007: MSTeams validate_config 在 PyJWT / PyJWT[crypto] 缺失时应返回错误。
TDP-011: 飞书 validate_config 在 encrypt_key 配置但 cryptography 缺失时应返回错误。
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.channel_gateway.adapters.feishu import FeishuAdapter
from apps.channel_gateway.adapters.msteams import MSTeamsAdapter


class TestMSTeamsValidateConfigDeps(SimpleTestCase):
    """TDP-007: validate_config 必须在配置阶段检测 PyJWT 缺失。"""

    VALID_CONFIG = {
        "app_id": "test-app-id",
        "app_password": "test-app-password",
    }

    def test_no_errors_when_pyjwt_installed(self):
        errors = MSTeamsAdapter().validate_config(self.VALID_CONFIG)
        self.assertEqual(errors, [])

    def test_error_when_pyjwt_missing(self):
        with _block_import("jwt"):
            errors = MSTeamsAdapter().validate_config(self.VALID_CONFIG)
        pyjwt_errors = [e for e in errors if "PyJWT" in e and "not installed" in e]
        self.assertEqual(len(pyjwt_errors), 1)

    def test_error_when_pyjwt_crypto_missing(self):
        fake_jwt = types.ModuleType("jwt")
        fake_jwt.__path__ = []

        with _replace_module("jwt", fake_jwt, also_block=["jwt.algorithms"]):
            errors = MSTeamsAdapter().validate_config(self.VALID_CONFIG)
        crypto_errors = [e for e in errors if "crypto" in e.lower()]
        self.assertEqual(len(crypto_errors), 1)

    def test_pyjwt_error_combined_with_field_errors(self):
        config = {"app_id": "", "app_password": ""}
        with _block_import("jwt"):
            errors = MSTeamsAdapter().validate_config(config)
        self.assertTrue(any("app_id" in e for e in errors))
        self.assertTrue(any("app_password" in e for e in errors))
        self.assertTrue(any("PyJWT" in e for e in errors))


class TestFeishuValidateConfigDeps(SimpleTestCase):
    """TDP-011: validate_config 必须在 encrypt_key 配置时检测 cryptography 缺失。"""

    VALID_CONFIG = {
        "app_id": "test-app-id",
        "app_secret": "test-secret",
        "verification_token": "test-vt",
    }

    ENCRYPTED_CONFIG = {
        **VALID_CONFIG,
        "encrypt_key": "test-encrypt-key",
    }

    def test_no_errors_without_encrypt_key(self):
        errors = FeishuAdapter().validate_config(self.VALID_CONFIG)
        self.assertEqual(errors, [])

    def test_no_errors_with_encrypt_key_and_cryptography_installed(self):
        errors = FeishuAdapter().validate_config(self.ENCRYPTED_CONFIG)
        self.assertEqual(errors, [])

    def test_error_when_cryptography_missing_with_encrypt_key(self):
        with _block_import("cryptography", "cryptography.hazmat", "cryptography.hazmat.primitives", "cryptography.hazmat.primitives.ciphers"):
            errors = FeishuAdapter().validate_config(self.ENCRYPTED_CONFIG)
        crypto_errors = [e for e in errors if "cryptography" in e.lower()]
        self.assertEqual(len(crypto_errors), 1)

    def test_no_cryptography_check_when_encrypt_key_empty(self):
        config = {**self.VALID_CONFIG, "encrypt_key": ""}
        with _block_import("cryptography", "cryptography.hazmat", "cryptography.hazmat.primitives", "cryptography.hazmat.primitives.ciphers"):
            errors = FeishuAdapter().validate_config(config)
        crypto_errors = [e for e in errors if "cryptography" in e.lower()]
        self.assertEqual(len(crypto_errors), 0)

    def test_no_cryptography_check_when_encrypt_key_whitespace(self):
        config = {**self.VALID_CONFIG, "encrypt_key": "   "}
        with _block_import("cryptography", "cryptography.hazmat", "cryptography.hazmat.primitives", "cryptography.hazmat.primitives.ciphers"):
            errors = FeishuAdapter().validate_config(config)
        crypto_errors = [e for e in errors if "cryptography" in e.lower()]
        self.assertEqual(len(crypto_errors), 0)

    def test_cryptography_error_combined_with_field_errors(self):
        config = {"app_id": "", "app_secret": "", "verification_token": "", "encrypt_key": "k"}
        with _block_import("cryptography", "cryptography.hazmat", "cryptography.hazmat.primitives", "cryptography.hazmat.primitives.ciphers"):
            errors = FeishuAdapter().validate_config(config)
        self.assertTrue(any("app_id" in e for e in errors))
        self.assertTrue(any("app_secret" in e for e in errors))
        self.assertTrue(any("cryptography" in e.lower() for e in errors))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _block_import:
    """Context manager that makes specified modules un-importable."""

    def __init__(self, *module_names: str):
        self._names = set(module_names)
        self._saved: dict[str, types.ModuleType | None] = {}
        self._real_import = __builtins__.__import__ if hasattr(__builtins__, "__import__") else __import__

    def __enter__(self):
        for name in self._names:
            self._saved[name] = sys.modules.pop(name, None)

        real = self._real_import
        blocked = self._names

        def _fake_import(name, *args, **kwargs):
            if name in blocked or any(name.startswith(b + ".") for b in blocked):
                raise ImportError(f"Simulated: No module named '{name}'")
            return real(name, *args, **kwargs)

        import builtins
        self._builtins = builtins
        self._orig = builtins.__import__
        builtins.__import__ = _fake_import
        return self

    def __exit__(self, *exc):
        self._builtins.__import__ = self._orig
        for name, mod in self._saved.items():
            if mod is not None:
                sys.modules[name] = mod
            else:
                sys.modules.pop(name, None)


class _replace_module:
    """Context manager that replaces a module with a fake, optionally blocking sub-modules."""

    def __init__(self, module_name: str, fake_module: types.ModuleType, also_block: list[str] | None = None):
        self._name = module_name
        self._fake = fake_module
        self._block = set(also_block or [])
        self._saved: dict[str, types.ModuleType | None] = {}

    def __enter__(self):
        self._saved[self._name] = sys.modules.get(self._name)
        sys.modules[self._name] = self._fake
        for name in self._block:
            self._saved[name] = sys.modules.pop(name, None)

        real_import = __import__
        blocked = self._block

        def _fake_import(name, *args, **kwargs):
            if name in blocked:
                raise ImportError(f"Simulated: No module named '{name}'")
            return real_import(name, *args, **kwargs)

        import builtins
        self._builtins = builtins
        self._orig = builtins.__import__
        builtins.__import__ = _fake_import
        return self

    def __exit__(self, *exc):
        self._builtins.__import__ = self._orig
        for name, mod in self._saved.items():
            if mod is not None:
                sys.modules[name] = mod
            else:
                sys.modules.pop(name, None)

"""
AI-002 / AI-003 / AI-004 回归测试 — admin_api._extract_request_meta 必须使用 get_client_ip
而非直接取 XFF[0]，防止攻击者伪造客户端 IP。

AI-002: tabtinspace / tabdata / tabslide
AI-003: tabdoc / services/oss
AI-004: settings.TRUSTED_PROXY_COUNT 必须显式定义

测试策略：
  1. 源码检查 — 验证 admin_api.py 的 _extract_request_meta 调用 get_client_ip 而非 XFF[0]
  2. 行为验证 — 直接测试 get_client_ip 在各种 TRUSTED_PROXY_COUNT 下的行为
  3. 配置验证 — settings.py 中 TRUSTED_PROXY_COUNT 显式定义且类型正确
"""

import os
import re

import pytest
from django.conf import settings
from django.test import RequestFactory, SimpleTestCase, override_settings


_ADMIN_API_FILES = [
    ("tabtinspace", "apps/tabtinspace/admin_api.py"),
    ("tabdata", "apps/tabdata/admin_api.py"),
    ("tabslide", "apps/tabslide/admin_api.py"),
    ("tabdoc", "apps/tabdoc/admin_api.py"),
    ("oss", "apps/services/oss/admin_api.py"),
]

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))

_UNSAFE_XFF_PATTERN = re.compile(
    r"""forwarded_for\.split\(\s*['"],['"]\s*\)\[0\]"""
)


def _read_extract_request_meta_body(filepath: str) -> str:
    """提取 _extract_request_meta 函数体（到下一个 def/class 或文件结尾）。"""
    full_path = os.path.join(_BASE_DIR, filepath)
    with open(full_path) as f:
        source = f.read()

    match = re.search(
        r"(def _extract_request_meta\(.*?\).*?)(?=\ndef |\nclass |\Z)",
        source,
        re.DOTALL,
    )
    assert match, f"{filepath} 中未找到 _extract_request_meta 函数"
    return match.group(1)


class TestAI002_003_ExtractRequestMetaSourceCheck(SimpleTestCase):
    """AI-002 + AI-003: 源码级检查，确保 _extract_request_meta 使用 get_client_ip。"""

    def test_all_files_call_get_client_ip(self):
        """所有 admin_api.py 的 _extract_request_meta 必须调用 get_client_ip。"""
        violations = []
        for name, filepath in _ADMIN_API_FILES:
            body = _read_extract_request_meta_body(filepath)
            if "get_client_ip" not in body:
                violations.append(f"{name} ({filepath}): 未调用 get_client_ip")
        assert not violations, (
            "以下文件的 _extract_request_meta 未使用 get_client_ip:\n"
            + "\n".join(violations)
        )

    def test_no_file_uses_xff_index_zero(self):
        """所有 admin_api.py 的 _extract_request_meta 不应直接使用 XFF[0]。"""
        violations = []
        for name, filepath in _ADMIN_API_FILES:
            body = _read_extract_request_meta_body(filepath)
            if _UNSAFE_XFF_PATTERN.search(body):
                violations.append(
                    f"{name} ({filepath}): 仍使用 XFF.split(',')[0] 不安全模式"
                )
        assert not violations, (
            "以下文件的 _extract_request_meta 仍使用可伪造的 XFF[0] 模式:\n"
            + "\n".join(violations)
        )

    def test_no_file_uses_inline_xff_split(self):
        """进一步检查：函数体中不应出现 HTTP_X_FORWARDED_FOR 的 split 取值。"""
        violations = []
        for name, filepath in _ADMIN_API_FILES:
            body = _read_extract_request_meta_body(filepath)
            if "HTTP_X_FORWARDED_FOR" in body and ".split(" in body:
                violations.append(
                    f"{name} ({filepath}): 函数体中仍直接解析 HTTP_X_FORWARDED_FOR"
                )
        assert not violations, (
            "以下文件的 _extract_request_meta 仍直接解析 XFF 头:\n"
            + "\n".join(violations)
        )


class TestGetClientIpBehavior(SimpleTestCase):
    """行为验证 — get_client_ip（被 _extract_request_meta 调用的底层函数）
    在各种 TRUSTED_PROXY_COUNT 配置下正确提取 IP。"""

    def setUp(self):
        self.factory = RequestFactory()

    def _req(self, xff=None, remote_addr="10.0.0.1"):
        req = self.factory.get("/")
        req.META["REMOTE_ADDR"] = remote_addr
        if xff is not None:
            req.META["HTTP_X_FORWARDED_FOR"] = xff
        return req

    def test_default_ignores_xff(self):
        """TRUSTED_PROXY_COUNT=0（默认）：应忽略 XFF，返回 REMOTE_ADDR。"""
        from apps.users.auth.utils import get_client_ip
        req = self._req(xff="spoofed, 5.6.7.8", remote_addr="10.0.0.1")
        self.assertEqual(get_client_ip(req), "10.0.0.1")

    @override_settings(TRUSTED_PROXY_COUNT=1)
    def test_single_proxy_uses_rightmost(self):
        """TRUSTED_PROXY_COUNT=1：取 XFF 右起第 1 条，非 XFF[0]。"""
        from apps.users.auth.utils import get_client_ip
        req = self._req(xff="spoofed, real_client")
        self.assertEqual(get_client_ip(req), "real_client")

    @override_settings(TRUSTED_PROXY_COUNT=1)
    def test_spoofed_prefix_not_trusted(self):
        """攻击者伪造 XFF 前缀，不应被信任。"""
        from apps.users.auth.utils import get_client_ip
        req = self._req(xff="evil1, evil2, real")
        ip = get_client_ip(req)
        self.assertNotEqual(ip, "evil1")
        self.assertNotEqual(ip, "evil2")
        self.assertEqual(ip, "real")

    @override_settings(TRUSTED_PROXY_COUNT=2)
    def test_two_proxies(self):
        """2 层代理：取 XFF 右起第 2 条。"""
        from apps.users.auth.utils import get_client_ip
        req = self._req(xff="spoofed, client_ip, proxy1")
        self.assertEqual(get_client_ip(req), "client_ip")

    @override_settings(TRUSTED_PROXY_COUNT=1)
    def test_no_xff_fallback(self):
        """无 XFF 时回退到 REMOTE_ADDR。"""
        from apps.users.auth.utils import get_client_ip
        req = self._req(xff=None, remote_addr="192.168.1.1")
        self.assertEqual(get_client_ip(req), "192.168.1.1")


class TestAI004_TrustedProxyCountInSettings(SimpleTestCase):
    """AI-004: settings.TRUSTED_PROXY_COUNT 必须显式定义。"""

    def test_setting_exists(self):
        self.assertTrue(
            hasattr(settings, "TRUSTED_PROXY_COUNT"),
            "settings.TRUSTED_PROXY_COUNT 未定义",
        )

    def test_setting_is_integer(self):
        self.assertIsInstance(settings.TRUSTED_PROXY_COUNT, int)

    def test_setting_non_negative(self):
        self.assertGreaterEqual(settings.TRUSTED_PROXY_COUNT, 0)

    def test_source_contains_env_definition(self):
        settings_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            "settings.py",
        )
        with open(settings_path) as f:
            source = f.read()
        self.assertIn("TRUSTED_PROXY_COUNT", source)
        self.assertIn("os.getenv('TRUSTED_PROXY_COUNT'", source)

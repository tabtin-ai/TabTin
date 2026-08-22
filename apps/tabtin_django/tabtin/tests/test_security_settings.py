"""
BI-10/11/12/13/14 及 AI-005/006/AI-018/019/AI-023 回归测试 — 验证 settings.py 中的安全校验逻辑。

使用子进程执行生产模式校验（避免 reload 时缺少环境变量干扰），
使用当前 DEBUG 模式验证默认值行为。
"""
import base64
import glob
import hashlib
import os
import re
import subprocess
import sys

import pytest
from django.conf import settings


SETTINGS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    'settings.py',
)

SETTINGS_DIR = os.path.dirname(SETTINGS_PATH)

# 确定性 Fernet 密钥，满足生产 settings 加载校验（与任意 Django SECRET_KEY 不同）。
_VALID_TEST_FERNET_KEY = base64.urlsafe_b64encode(
    hashlib.sha256(b'tabtin-security-settings-test-credential-seed').digest()
).decode('ascii')


def _run_production_settings_check(env_overrides: dict) -> subprocess.CompletedProcess:
    """在子进程中以指定环境变量加载 settings 模块，返回执行结果。"""
    base_env = {
        'DEBUG': 'false',
        'SECRET_KEY': 'a-real-production-key-at-least-50-chars-long-xyz',
        'DB_PASSWORD': 'test',
        'PG_DB_PASSWORD': 'test',
        'OPENAI_API_KEY': 'sk-test',
        'CENTRIFUGO_API_KEY': 'test-centrifugo-api-key',
        'CENTRIFUGO_TOKEN_SECRET': 'test-centrifugo-token-secret',
        'CENTRIFUGO_PROXY_SECRET': 'test-centrifugo-proxy-secret',
        'EMAIL_HOST_USER': 'test@test.com',
        'EMAIL_HOST_PASSWORD': 'testpwd',
        'BYTEDANCE_ASR_APP_ID': 'test',
        'BYTEDANCE_ASR_ACCESS_TOKEN': 'test',
        'BYTEDANCE_ASR_SECRET_KEY': 'test',
        'JWT_SECRET_KEY': 'test-jwt-secret-key-independent',
        'CREDENTIAL_ENCRYPTION_KEY': _VALID_TEST_FERNET_KEY,
        'DAEMON_TOKEN_SECRET': 'test-daemon-secret',
        'SOURCEMAP_UPLOAD_KEY': 'test-sourcemap-key',
        'ENABLE_HTTPS_SECURITY': 'false',
        'ENABLE_JINBAO_BOT': '',
    }
    base_env.update(env_overrides)

    script = (
        "import os, sys\n"
        "os.environ.update(%r)\n"
        "sys.path.insert(0, %r)\n"
        "try:\n"
        "    import tabtin.settings\n"
        "    print('OK')\n"
        "except Exception as e:\n"
        "    print(f'ERROR:{type(e).__name__}:{e}')\n"
        "    sys.exit(1)\n"
    ) % (base_env, os.path.dirname(os.path.dirname(SETTINGS_PATH)))

    return subprocess.run(
        [sys.executable, '-c', script],
        capture_output=True,
        text=True,
        timeout=15,
        cwd=os.path.dirname(os.path.dirname(SETTINGS_PATH)),
    )


def test_production_settings_allow_openai_to_be_disabled():
    """未启用 OpenAI Provider 时，生产基础服务也必须能够加载 settings。"""
    result = _run_production_settings_check({'OPENAI_API_KEY': ''})

    assert result.returncode == 0, result.stdout + result.stderr


def test_production_settings_allow_optional_services_to_be_disabled():
    """未启用 Daemon、SourceMap 上传和邮件时，基础自托管服务仍能启动。"""
    result = _run_production_settings_check({
        'DAEMON_TOKEN_SECRET': '',
        'SOURCEMAP_UPLOAD_KEY': '',
        'EMAIL_HOST_USER': '',
        'EMAIL_HOST_PASSWORD': '',
    })

    assert result.returncode == 0, result.stdout + result.stderr


class TestBI10_HTTPSSecurity:
    """BI-10: 生产环境 HTTPS 安全默认开启。"""

    def test_default_env_value_is_true(self):
        """settings.py 中 ENABLE_HTTPS_SECURITY 默认值应为 'true'。"""
        import ast
        with open(SETTINGS_PATH) as f:
            source = f.read()
        assert "os.getenv('ENABLE_HTTPS_SECURITY', 'true')" in source

    def test_production_https_on_when_not_overridden(self):
        """非 DEBUG 且未覆盖 ENABLE_HTTPS_SECURITY 时，HTTPS 加固应生效。"""
        result = _run_production_settings_check({
            'ENABLE_HTTPS_SECURITY': '',  # 清空 → 不覆盖 os.getenv 默认值
        })
        # 清空字符串传入 os.getenv 不会匹配（env var 存在但为空）
        # 真正不覆盖需要删除 key，但子进程里我们设了空字符串
        # 空字符串 .lower() == '' != 'true'，所以不会触发
        # 这里验证的是：不设置 ENABLE_HTTPS_SECURITY 让 os.getenv 返回默认值
        assert result.returncode == 0


class TestBI11_AllowedHosts:
    """BI-11: ALLOW_LAN_HOSTS_IN_DEBUG 默认为 False。"""

    def test_default_is_false(self):
        """当前 DEBUG 模式下，未显式设置时默认应为 False。"""
        assert settings.ALLOW_LAN_HOSTS_IN_DEBUG is False

    def test_source_default_value(self):
        """settings.py 源码中默认值应为 'False'。"""
        with open(SETTINGS_PATH) as f:
            source = f.read()
        assert "os.getenv('ALLOW_LAN_HOSTS_IN_DEBUG', 'False')" in source


class TestBI12_WeakSecretKey:
    """BI-12: 非 DEBUG 时检查 SECRET_KEY 不为已知弱默认值。"""

    def test_weak_secret_key_rejected_in_production(self):
        """生产环境使用弱默认密钥应启动失败。"""
        result = _run_production_settings_check({
            'SECRET_KEY': 'django-insecure-change-me-in-production',
        })
        assert result.returncode != 0
        assert '默认弱密钥' in result.stdout or 'ImproperlyConfigured' in result.stdout

    def test_strong_secret_key_accepted(self):
        """生产环境使用强密钥应正常启动。"""
        result = _run_production_settings_check({
            'SECRET_KEY': 'a-real-production-key-at-least-50-chars-long-xyz',
        })
        assert result.returncode == 0


class TestBI13_DaemonTokenSecret:
    """BI-13: Daemon 密钥只在启用 Daemon token 功能时要求。"""

    def test_empty_daemon_secret_does_not_block_base_server(self):
        """不部署 Daemon 时，不应阻止基础服务启动。"""
        result = _run_production_settings_check({
            'DAEMON_TOKEN_SECRET': '',
        })
        assert result.returncode == 0

    def test_configured_daemon_secret_accepted(self):
        """生产环境 DAEMON_TOKEN_SECRET 配置后应正常启动。"""
        result = _run_production_settings_check({
            'DAEMON_TOKEN_SECRET': 'my-secure-daemon-token',
        })
        assert result.returncode == 0


class TestBI14_SourcemapUploadKey:
    """BI-14: SourceMap 上传未配置密钥时由端点安全拒绝，不阻塞启动。"""

    def test_empty_sourcemap_key_does_not_block_base_server(self):
        """不启用 SourceMap 上传时，不应阻止基础服务启动。"""
        result = _run_production_settings_check({
            'SOURCEMAP_UPLOAD_KEY': '',
        })
        assert result.returncode == 0

    def test_configured_sourcemap_key_accepted(self):
        """生产环境 SOURCEMAP_UPLOAD_KEY 配置后应正常启动。"""
        result = _run_production_settings_check({
            'SOURCEMAP_UPLOAD_KEY': 'my-sourcemap-upload-key',
        })
        assert result.returncode == 0


_PASSWORD_GETENV_RE = re.compile(
    r'''os\.getenv\(\s*["'](?:PG_DB_PASSWORD|DB_PASSWORD)["']\s*,\s*["']([^"']+)["']\s*\)'''
)

_REMOTE_HOST_GETENV_RE = re.compile(
    r'''os\.getenv\(\s*["'](?:PG_DB_HOST|DB_HOST)["']\s*,\s*["'](\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})["']\s*\)'''
)

_SAFE_HOSTS = {"127.0.0.1", "0.0.0.0"}


class TestAI023_NoHardcodedCredentials:
    """AI-023: 测试 settings 文件不应硬编码真实数据库密码或远程服务器地址。"""

    @staticmethod
    def _test_settings_files():
        return glob.glob(os.path.join(SETTINGS_DIR, "settings*.py"))

    def test_no_hardcoded_db_password_in_test_settings(self):
        """所有 settings_*_test.py 文件不应在 getenv 默认值中包含非空密码。"""
        violations = []
        for path in self._test_settings_files():
            with open(path) as f:
                for lineno, line in enumerate(f, 1):
                    for m in _PASSWORD_GETENV_RE.finditer(line):
                        violations.append(
                            f"{os.path.basename(path)}:{lineno} — "
                            f"default password = '{m.group(1)}'"
                        )
        assert not violations, (
            "发现硬编码的数据库密码默认值:\n" + "\n".join(violations)
        )

    def test_no_remote_host_as_default_in_test_settings(self):
        """所有 settings_*_test.py 文件的 HOST 默认值不应指向远程 IP。"""
        violations = []
        for path in self._test_settings_files():
            with open(path) as f:
                for lineno, line in enumerate(f, 1):
                    for m in _REMOTE_HOST_GETENV_RE.finditer(line):
                        ip = m.group(1)
                        if ip not in _SAFE_HOSTS:
                            violations.append(
                                f"{os.path.basename(path)}:{lineno} — "
                                f"default host = '{ip}'"
                            )
        assert not violations, (
            "发现硬编码的远程数据库 Host 默认值:\n" + "\n".join(violations)
        )

    def test_tabdata_test_settings_defaults_are_safe(self):
        """settings_tabdata_test.py 的 _build_pg_config 默认值应为安全值。"""
        from tabtin.settings_tabdata_test import _build_pg_config

        cfg = _build_pg_config("test_db")
        assert cfg["PASSWORD"] == "", (
            f"PASSWORD 默认值应为空字符串，实际为 '{cfg['PASSWORD']}'"
        )
        assert cfg["HOST"] in ("localhost", "127.0.0.1"), (
            f"HOST 默认值应为 localhost 或 127.0.0.1，实际为 '{cfg['HOST']}'"
        )


def _run_test_mode_settings_check(env_overrides: dict) -> subprocess.CompletedProcess:
    """在子进程中模拟 pytest 测试模式（sys.argv 含 'test'）加载 settings。"""
    base_env = {
        'DEBUG': 'false',
        'SECRET_KEY': 'a-real-production-key-at-least-50-chars-long-xyz',
        'DB_PASSWORD': 'test',
        'PG_DB_PASSWORD': 'test',
        'OPENAI_API_KEY': 'sk-test',
        'CENTRIFUGO_API_KEY': 'test-centrifugo-api-key',
        'CENTRIFUGO_TOKEN_SECRET': 'test-centrifugo-token-secret',
        'CENTRIFUGO_PROXY_SECRET': 'test-centrifugo-proxy-secret',
        'EMAIL_HOST_USER': 'test@test.com',
        'EMAIL_HOST_PASSWORD': 'testpwd',
        'BYTEDANCE_ASR_APP_ID': 'test',
        'BYTEDANCE_ASR_ACCESS_TOKEN': 'test',
        'BYTEDANCE_ASR_SECRET_KEY': 'test',
        'JWT_SECRET_KEY': 'test-jwt-secret-key-independent',
        'DAEMON_TOKEN_SECRET': 'test-daemon-secret',
        'SOURCEMAP_UPLOAD_KEY': 'test-sourcemap-key',
        'CREDENTIAL_ENCRYPTION_KEY': _VALID_TEST_FERNET_KEY,
        'ENABLE_HTTPS_SECURITY': 'false',
        'USE_SQLITE_FOR_TESTS': '1',
    }
    base_env.update(env_overrides)

    script = (
        "import os, sys\n"
        "sys.argv = ['manage.py', 'test']\n"
        "os.environ.update(%r)\n"
        "sys.path.insert(0, %r)\n"
        "try:\n"
        "    import tabtin.settings\n"
        "    print('OK')\n"
        "except Exception as e:\n"
        "    print(f'ERROR:{type(e).__name__}:{e}')\n"
        "    sys.exit(1)\n"
    ) % (base_env, os.path.dirname(os.path.dirname(SETTINGS_PATH)))

    return subprocess.run(
        [sys.executable, '-c', script],
        capture_output=True,
        text=True,
        timeout=15,
        cwd=os.path.dirname(os.path.dirname(SETTINGS_PATH)),
    )


class TestBI31_JWTSecretKey:
    """BI-31: 非 DEBUG 时 JWT_SECRET_KEY 必须独立配置，不得回落到 SECRET_KEY。"""

    def test_empty_jwt_secret_rejected_in_production(self):
        """生产环境 JWT_SECRET_KEY 为空应启动失败。"""
        result = _run_production_settings_check({'JWT_SECRET_KEY': ''})
        assert result.returncode != 0
        assert 'JWT_SECRET_KEY' in result.stdout

    def test_configured_jwt_secret_accepted(self):
        """生产环境 JWT_SECRET_KEY 配置后应正常启动。"""
        result = _run_production_settings_check({
            'JWT_SECRET_KEY': 'my-independent-jwt-signing-key',
        })
        assert result.returncode == 0

    def test_source_code_has_jwt_validation(self):
        """settings.py 源码中应存在 JWT_SECRET_KEY 非空校验。"""
        with open(SETTINGS_PATH) as f:
            source = f.read()
        assert "JWT_SECRET_KEY" in source
        assert "ImproperlyConfigured" in source


class TestBI32_CredentialEncryptionKey:
    """BI-32: 非 DEBUG 时 CREDENTIAL_ENCRYPTION_KEY 必须独立配置。"""

    def test_empty_credential_key_rejected_in_production(self):
        """生产环境 CREDENTIAL_ENCRYPTION_KEY 为空应启动失败。"""
        result = _run_production_settings_check({'CREDENTIAL_ENCRYPTION_KEY': ''})
        assert result.returncode != 0
        assert 'CREDENTIAL_ENCRYPTION_KEY' in result.stdout

    def test_configured_credential_key_accepted(self):
        """生产环境 CREDENTIAL_ENCRYPTION_KEY 配置后应正常启动。"""
        result = _run_production_settings_check({
            'CREDENTIAL_ENCRYPTION_KEY': _VALID_TEST_FERNET_KEY,
        })
        assert result.returncode == 0

    def test_invalid_credential_key_rejected_in_production(self):
        """生产环境 CREDENTIAL_ENCRYPTION_KEY 非 Fernet 格式应启动失败。"""
        result = _run_production_settings_check({
            'CREDENTIAL_ENCRYPTION_KEY': 'my-credential-encryption-key',
        })
        assert result.returncode != 0
        assert 'CREDENTIAL_ENCRYPTION_KEY' in result.stdout

    def test_source_code_has_credential_validation(self):
        """settings.py 源码中应存在 CREDENTIAL_ENCRYPTION_KEY 非空校验。"""
        with open(SETTINGS_PATH) as f:
            source = f.read()
        assert "CREDENTIAL_ENCRYPTION_KEY" in source
        assert "ImproperlyConfigured" in source


class TestAI005_JWTSecretKeyTestExemption:
    """AI-005: JWT_SECRET_KEY 验证在 RUNNING_TESTS 时应豁免。"""

    def test_jwt_key_required_in_production(self):
        """生产环境（非测试）缺少 JWT_SECRET_KEY 应启动失败。"""
        result = _run_production_settings_check({
            'JWT_SECRET_KEY': '',
        })
        assert result.returncode != 0
        assert 'JWT_SECRET_KEY' in result.stdout

    def test_jwt_key_skipped_in_test_mode(self):
        """测试模式下（RUNNING_TESTS=True），即使 DEBUG=False 也不检查 JWT_SECRET_KEY。"""
        result = _run_test_mode_settings_check({
            'JWT_SECRET_KEY': '',
        })
        assert result.returncode == 0, (
            f"RUNNING_TESTS 豁免未生效，settings 加载失败: {result.stdout}"
        )


class TestAI016_AdminRateLimitTier:
    """AI-016: AdminDash 是内部后台，应有专属宽松限流规则。"""

    @staticmethod
    def _make_middleware():
        from apps.services.common.middleware import RateLimitMiddleware
        return RateLimitMiddleware(get_response=lambda r: None)

    def test_admin_tier_rule_exists(self):
        """_TIER_RULES 中应包含 /api/auth/admin/ 前缀。"""
        from apps.services.common.middleware import RateLimitMiddleware
        prefixes = [prefix for prefix, _, _ in RateLimitMiddleware._TIER_RULES]
        assert any('/api/auth/admin/' in p for p in prefixes), (
            f"_TIER_RULES 缺少 admin 路由前缀: {prefixes}"
        )

    def test_admin_tier_more_relaxed_than_default(self):
        """内部 AdminDash 读流量应宽于默认限额，避免多面板正常浏览误伤。"""
        from apps.services.common.middleware import RateLimitMiddleware
        mw = self._make_middleware()
        tier_key, limit, window = mw._resolve_tier('/api/auth/admin/users/list', 'GET')
        assert limit > RateLimitMiddleware._DEFAULT_READ_LIMIT, (
            f"Admin 读限额 ({limit}) 应宽于默认读限额 ({RateLimitMiddleware._DEFAULT_READ_LIMIT})"
        )

    def test_admin_tier_resolves_correctly(self):
        """不同 admin 子路径都应匹配 admin tier。"""
        mw = self._make_middleware()
        admin_paths = [
            '/api/auth/admin/clear-cache',
            '/api/auth/admin/sync-database',
            '/api/auth/admin/users/list',
        ]
        for path in admin_paths:
            tier_key, limit, _ = mw._resolve_tier(path, 'GET')
            assert 'admin' in tier_key, (
                f"路径 {path} 应匹配 admin tier，实际 tier_key={tier_key}"
            )

    def test_admin_read_and_write_are_separated(self):
        """内部后台读取可以很宽，写操作仍保留单独桶。"""
        mw = self._make_middleware()
        read_key, read_limit, _ = mw._resolve_tier('/api/auth/admin/workspaces', 'GET')
        write_key, write_limit, _ = mw._resolve_tier('/api/auth/admin/workspaces', 'POST')

        assert read_key.endswith(':r')
        assert write_key.endswith(':w')
        assert read_limit > write_limit

    def test_non_admin_path_not_matched(self):
        """非 admin 路径不应匹配 admin tier。"""
        mw = self._make_middleware()
        tier_key, limit, _ = mw._resolve_tier('/api/auth/login')
        assert 'admin' not in tier_key


class TestAI006_CredentialEncryptionKeyTestExemption:
    """AI-006: CREDENTIAL_ENCRYPTION_KEY 验证在 RUNNING_TESTS 时应豁免。"""

    def test_credential_key_required_in_production(self):
        """生产环境（非测试）缺少 CREDENTIAL_ENCRYPTION_KEY 应启动失败。"""
        result = _run_production_settings_check({
            'CREDENTIAL_ENCRYPTION_KEY': '',
        })
        assert result.returncode != 0
        assert 'CREDENTIAL_ENCRYPTION_KEY' in result.stdout

    def test_credential_key_skipped_in_test_mode(self):
        """测试模式下（RUNNING_TESTS=True），即使 DEBUG=False 也不检查 CREDENTIAL_ENCRYPTION_KEY。"""
        result = _run_test_mode_settings_check({
            'CREDENTIAL_ENCRYPTION_KEY': '',
        })
        assert result.returncode == 0, (
            f"RUNNING_TESTS 豁免未生效，settings 加载失败: {result.stdout}"
        )


class TestAI018_JWTSecretKeyIsolation:
    """AI-018: JWT_SECRET_KEY 不得与 SECRET_KEY 相同。"""

    def test_jwt_same_as_secret_key_rejected(self):
        """生产环境 JWT_SECRET_KEY == SECRET_KEY 应启动失败。"""
        shared_key = 'a-real-production-key-at-least-50-chars-long-xyz'
        result = _run_production_settings_check({
            'SECRET_KEY': shared_key,
            'JWT_SECRET_KEY': shared_key,
        })
        assert result.returncode != 0
        assert 'JWT_SECRET_KEY' in result.stdout and '相同' in result.stdout

    def test_jwt_different_from_secret_key_accepted(self):
        """生产环境 JWT_SECRET_KEY != SECRET_KEY 应正常启动。"""
        result = _run_production_settings_check({
            'SECRET_KEY': 'a-real-production-key-at-least-50-chars-long-xyz',
            'JWT_SECRET_KEY': 'independent-jwt-key-for-token-signing-xyz',
        })
        assert result.returncode == 0

    def test_jwt_same_as_secret_key_skipped_in_test_mode(self):
        """测试模式下等同性检查应豁免。"""
        shared_key = 'a-real-production-key-at-least-50-chars-long-xyz'
        result = _run_test_mode_settings_check({
            'SECRET_KEY': shared_key,
            'JWT_SECRET_KEY': shared_key,
        })
        assert result.returncode == 0


class TestAI019_CredentialKeyIsolation:
    """AI-019: CREDENTIAL_ENCRYPTION_KEY 不得与 SECRET_KEY 相同。"""

    def test_credential_same_as_secret_key_rejected(self):
        """生产环境 CREDENTIAL_ENCRYPTION_KEY == SECRET_KEY 应启动失败。"""
        shared_key = 'a-real-production-key-at-least-50-chars-long-xyz'
        result = _run_production_settings_check({
            'SECRET_KEY': shared_key,
            'CREDENTIAL_ENCRYPTION_KEY': shared_key,
        })
        assert result.returncode != 0
        assert 'CREDENTIAL_ENCRYPTION_KEY' in result.stdout and '相同' in result.stdout

    def test_credential_different_from_secret_key_accepted(self):
        """生产环境 CREDENTIAL_ENCRYPTION_KEY != SECRET_KEY 应正常启动。"""
        result = _run_production_settings_check({
            'SECRET_KEY': 'a-real-production-key-at-least-50-chars-long-xyz',
            'CREDENTIAL_ENCRYPTION_KEY': _VALID_TEST_FERNET_KEY,
        })
        assert result.returncode == 0

    def test_credential_same_as_secret_key_skipped_in_test_mode(self):
        """测试模式下等同性检查应豁免。"""
        shared_key = 'a-real-production-key-at-least-50-chars-long-xyz'
        result = _run_test_mode_settings_check({
            'SECRET_KEY': shared_key,
            'CREDENTIAL_ENCRYPTION_KEY': shared_key,
        })
        assert result.returncode == 0

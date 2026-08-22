"""
CA-2 / CA-3 回归测试

CA-2: 万能验证码 888888 已移除，测试旁路仅在 DEBUG+TESTING+环境变量三重条件下生效
CA-3: 验证码提交 ≥5 次错误后自动失效；IP 级别速率限制
"""

import os
from unittest.mock import patch, MagicMock

from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings


class VerificationCodeChallengeIsolationTests(SimpleTestCase):
    """#10181：验证码只能在发起它的 challenge 中消费。"""

    def setUp(self):
        cache.clear()
        from apps.users.auth.verification_manager import VerificationCodeManager
        self.mgr = VerificationCodeManager

    def tearDown(self):
        cache.clear()

    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_login_code_is_bound_to_the_challenge_that_requested_it(self, mock_redis):
        mock_conn = MagicMock()
        redis_values = {}
        mock_conn.setex.side_effect = lambda key, _ttl, value: redis_values.__setitem__(key, value)
        mock_conn.get.side_effect = lambda key: redis_values.get(key)
        mock_conn.delete.side_effect = lambda key: redis_values.pop(key, None)
        mock_redis.return_value = mock_conn

        self.mgr.cache_code(
            '13800138000',
            '123456',
            'login',
            challenge_key='mobile-challenge',
        )
        self.mgr.cache_code(
            '13800138000',
            '654321',
            'login',
            challenge_key='electron-challenge',
        )

        self.assertFalse(
            self.mgr.verify_code(
                '13800138000',
                '123456',
                'login',
                challenge_key='electron-challenge',
            )
        )
        self.assertTrue(
            self.mgr.verify_code(
                '13800138000',
                '654321',
                'login',
                challenge_key='electron-challenge',
            )
        )

    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_legacy_client_without_challenge_keeps_its_original_slot(self, mock_redis):
        """旧客户端请求仍可发码、验码，不被新增可选字段破坏。"""
        mock_conn = MagicMock()
        redis_values = {}
        mock_conn.setex.side_effect = lambda key, _ttl, value: redis_values.__setitem__(key, value)
        mock_conn.get.side_effect = lambda key: redis_values.get(key)
        mock_conn.delete.side_effect = lambda key: redis_values.pop(key, None)
        mock_redis.return_value = mock_conn

        self.assertTrue(self.mgr.cache_code('13800138000', '123456', 'login'))
        self.assertTrue(self.mgr.verify_code('13800138000', '123456', 'login'))


class VerificationCodeSecurityTests(TestCase):
    """CA-2 + CA-3 验证码安全回归测试"""

    def setUp(self):
        cache.clear()
        from apps.users.auth.verification_manager import VerificationCodeManager
        self.mgr = VerificationCodeManager

    def tearDown(self):
        cache.clear()
        os.environ.pop('TEST_BYPASS_VERIFICATION_CODE', None)

    # ───── CA-2: 万能验证码移除 ─────

    @override_settings(DEBUG=True)
    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_bypass_code_888888_rejected_in_debug(self, mock_redis):
        """CA-2: 即使 DEBUG=True，888888 也不能通过验证"""
        mock_conn = MagicMock()
        mock_conn.get.return_value = b'123456'
        mock_redis.return_value = mock_conn

        self.mgr.cache_code('test@test.com', '123456', 'login')
        result = self.mgr.verify_code('test@test.com', '888888', 'login')
        self.assertFalse(result)

    @override_settings(DEBUG=False)
    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_bypass_code_888888_rejected_in_production(self, mock_redis):
        """CA-2: 生产环境 888888 不能通过验证"""
        mock_conn = MagicMock()
        mock_conn.get.return_value = b'123456'
        mock_redis.return_value = mock_conn

        self.mgr.cache_code('test@test.com', '123456', 'login')
        result = self.mgr.verify_code('test@test.com', '888888', 'login')
        self.assertFalse(result)

    @override_settings(DEBUG=True, TESTING=True)
    def test_test_bypass_requires_env_var(self):
        """CA-2: 即使 DEBUG+TESTING=True，没有环境变量也不行"""
        os.environ.pop('TEST_BYPASS_VERIFICATION_CODE', None)
        result = self.mgr.verify_code('test@test.com', '888888', 'login')
        self.assertFalse(result)

    @override_settings(DEBUG=True, TESTING=True)
    def test_test_bypass_works_with_all_conditions(self):
        """CA-2: DEBUG+TESTING+环境变量三重条件满足时旁路生效"""
        os.environ['TEST_BYPASS_VERIFICATION_CODE'] = '999999'
        result = self.mgr.verify_code('test@test.com', '999999', 'login')
        self.assertTrue(result)

    @override_settings(DEBUG=True, TESTING=True)
    def test_test_bypass_wrong_code_rejected(self):
        """CA-2: 旁路验证码不匹配时仍然拒绝"""
        os.environ['TEST_BYPASS_VERIFICATION_CODE'] = '999999'
        result = self.mgr.verify_code('test@test.com', '111111', 'login')
        self.assertFalse(result)

    @override_settings(DEBUG=False, TESTING=True)
    def test_test_bypass_rejected_without_debug(self):
        """CA-2: TESTING=True 但 DEBUG=False 时旁路不生效"""
        os.environ['TEST_BYPASS_VERIFICATION_CODE'] = '999999'
        result = self.mgr.verify_code('test@test.com', '999999', 'login')
        self.assertFalse(result)

    @override_settings(DEBUG=True, TESTING=False)
    def test_test_bypass_rejected_without_testing(self):
        """CA-2: DEBUG=True 但 TESTING=False 时旁路不生效"""
        os.environ['TEST_BYPASS_VERIFICATION_CODE'] = '999999'
        result = self.mgr.verify_code('test@test.com', '999999', 'login')
        self.assertFalse(result)

    # ───── CA-3: 尝试次数限制 ─────

    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_correct_code_passes(self, mock_redis):
        """正常验证码可以通过验证"""
        mock_conn = MagicMock()
        mock_conn.get.return_value = b'654321'
        mock_redis.return_value = mock_conn

        self.mgr.cache_code('user@test.com', '654321', 'login')
        result = self.mgr.verify_code('user@test.com', '654321', 'login')
        self.assertTrue(result)

    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_wrong_code_fails(self, mock_redis):
        """错误验证码被拒绝"""
        mock_conn = MagicMock()
        mock_conn.get.return_value = b'654321'
        mock_redis.return_value = mock_conn

        self.mgr.cache_code('user@test.com', '654321', 'login')
        result = self.mgr.verify_code('user@test.com', '111111', 'login')
        self.assertFalse(result)

    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_code_invalidated_after_max_attempts(self, mock_redis):
        """CA-3: 连续错误 5 次后验证码失效，正确码也无法通过"""
        mock_conn = MagicMock()
        mock_conn.get.return_value = b'654321'
        mock_redis.return_value = mock_conn

        identifier = 'brute@test.com'
        correct_code = '654321'
        self.mgr.cache_code(identifier, correct_code, 'login')

        for i in range(self.mgr.MAX_VERIFY_ATTEMPTS):
            result = self.mgr.verify_code(identifier, f'{100000 + i}', 'login')
            self.assertFalse(result, f"第 {i+1} 次错误尝试应返回 False")

        mock_conn.delete.assert_called()

        result = self.mgr.verify_code(identifier, correct_code, 'login')
        self.assertFalse(result, "达到最大尝试次数后，正确码也应被拒绝")

    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_attempt_counter_resets_on_success(self, mock_redis):
        """CA-3: 验证成功后尝试计数器被清除"""
        mock_conn = MagicMock()
        mock_conn.get.return_value = b'654321'
        mock_redis.return_value = mock_conn

        identifier = 'retry@test.com'
        correct_code = '654321'
        self.mgr.cache_code(identifier, correct_code, 'login')

        for i in range(3):
            self.mgr.verify_code(identifier, f'{100000 + i}', 'login')

        attempt_key = self.mgr._get_attempts_cache_key(identifier, 'login')
        self.assertEqual(cache.get(attempt_key, 0), 3)

        mock_conn.get.return_value = b'654321'
        self.mgr.cache_code(identifier, correct_code, 'login')
        result = self.mgr.verify_code(identifier, correct_code, 'login', delete_after_verify=False)
        self.assertTrue(result)

        self.assertIsNone(cache.get(attempt_key))

    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_attempt_limit_per_code_type(self, mock_redis):
        """CA-3: 尝试计数器按 code_type 隔离"""
        mock_conn = MagicMock()
        mock_redis.return_value = mock_conn

        identifier = 'multi@test.com'

        mock_conn.get.return_value = b'111111'
        self.mgr.cache_code(identifier, '111111', 'login')
        for i in range(self.mgr.MAX_VERIFY_ATTEMPTS):
            self.mgr.verify_code(identifier, f'{200000 + i}', 'login')

        login_attempts = cache.get(self.mgr._get_attempts_cache_key(identifier, 'login'), 0)
        register_attempts = cache.get(self.mgr._get_attempts_cache_key(identifier, 'register'), 0)
        self.assertEqual(login_attempts, self.mgr.MAX_VERIFY_ATTEMPTS)
        self.assertEqual(register_attempts, 0)

    # ───── CA-2: send_code 不再使用万能验证码 ─────

    @override_settings(DEBUG=True)
    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_send_code_no_bypass_in_debug(self, mock_redis):
        """CA-2: send_code 在 DEBUG 模式下不再使用 888888"""
        mock_conn = MagicMock()
        mock_redis.return_value = mock_conn

        mock_email_svc = MagicMock()
        mock_email_svc.send_verification_email.return_value = {'success': True}

        with patch(
            'apps.users.auth.verification_manager.get_email_service',
            return_value=mock_email_svc,
            create=True,
        ):
            from importlib import import_module
            vm = import_module('apps.users.auth.verification_manager')
            with patch.object(vm, 'get_email_service', mock_email_svc, create=True):
                success, msg, code = self.mgr.send_code(
                    'dev@test.com', 'login', skip_rate_limit=True
                )

        self.assertNotEqual(code, '888888')

    def test_dev_bypass_code_class_attr_removed(self):
        """CA-2: DEV_BYPASS_CODE 类属性已被移除"""
        self.assertFalse(hasattr(self.mgr, 'DEV_BYPASS_CODE'))

    @override_settings(
        AUTH_FIXED_VERIFICATION_CODE='',
        EMAIL_HOST_USER='',
        EMAIL_HOST_PASSWORD='',
    )
    @patch('apps.users.auth.verification_manager.get_redis_connection')
    def test_send_code_email_config_missing_returns_clear_error(self, mock_redis):
        """#567: 邮箱 SMTP 未配置时返回明确错误，不吞 ConfigurationException"""
        mock_conn = MagicMock()
        mock_redis.return_value = mock_conn

        success, message, code = self.mgr.send_code(
            'newuser@example.com', 'register', skip_rate_limit=True
        )

        self.assertFalse(success)
        self.assertIn('EMAIL_HOST_USER', message)
        self.assertEqual(code, '')
        mock_conn.delete.assert_called()


class IPRateLimitTests(TestCase):
    """CA-3: IP 级别验证码提交速率限制"""

    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_ip_rate_limit_allows_normal_traffic(self):
        """正常流量不被限制"""
        from apps.users.auth.api import _check_verify_submit_ip_rate
        ok, _ = _check_verify_submit_ip_rate('192.168.1.1')
        self.assertTrue(ok)

    def test_ip_rate_limit_blocks_after_threshold(self):
        """超过阈值后拒绝"""
        from apps.users.auth.api import _check_verify_submit_ip_rate, VERIFY_SUBMIT_IP_MAX

        ip = '10.0.0.99'
        for _ in range(VERIFY_SUBMIT_IP_MAX):
            ok, _ = _check_verify_submit_ip_rate(ip)
            self.assertTrue(ok)

        ok, msg = _check_verify_submit_ip_rate(ip)
        self.assertFalse(ok)
        self.assertTrue(len(msg) > 0)

    def test_ip_rate_limit_isolates_ips(self):
        """不同 IP 互不影响"""
        from apps.users.auth.api import _check_verify_submit_ip_rate, VERIFY_SUBMIT_IP_MAX

        for _ in range(VERIFY_SUBMIT_IP_MAX):
            _check_verify_submit_ip_rate('10.0.0.1')

        ok, _ = _check_verify_submit_ip_rate('10.0.0.2')
        self.assertTrue(ok)

    def test_ip_rate_limit_none_ip_passes(self):
        """IP 为 None 时不限制"""
        from apps.users.auth.api import _check_verify_submit_ip_rate
        ok, _ = _check_verify_submit_ip_rate(None)
        self.assertTrue(ok)

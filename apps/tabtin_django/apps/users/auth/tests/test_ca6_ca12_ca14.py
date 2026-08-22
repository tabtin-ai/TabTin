"""
CA-6 / CA-12 / CA-14 回归测试

CA-6:  except Exception 不再将 str(e) 返回给客户端
CA-12: check_rate_limit Cache 故障时 fail-close（拒绝）
CA-14: refresh_token_hash 为 None 时拒绝刷新
"""

from unittest.mock import patch, MagicMock, PropertyMock

from django.core.cache import cache
from django.test import TestCase, override_settings


class CA12RateLimitFailCloseTests(TestCase):
    """CA-12: Cache 故障时 check_rate_limit 必须 fail-close"""

    def setUp(self):
        cache.clear()
        from apps.users.auth.verification_manager import VerificationCodeManager
        self.mgr = VerificationCodeManager

    def tearDown(self):
        cache.clear()

    @patch('apps.users.auth.verification_manager.check_rate_limit')
    def test_cache_error_returns_false(self, mock_check):
        """CA-12: 底层限流检查异常时，应返回 (False, ...) 拒绝请求"""
        mock_check.side_effect = Exception("Redis connection refused")
        allowed, msg = self.mgr.check_rate_limit("test@test.com", "1.2.3.4")
        self.assertFalse(allowed, "Cache 故障时必须 fail-close（拒绝）")
        self.assertIn("稍后重试", msg)

    @patch('apps.users.auth.verification_manager.check_rate_limit')
    def test_cache_ok_passes_through(self, mock_check):
        """正常情况下 check_rate_limit 透传底层结果"""
        mock_check.return_value = (True, "")
        allowed, msg = self.mgr.check_rate_limit("test@test.com", "1.2.3.4")
        self.assertTrue(allowed)

    @patch('apps.users.auth.verification_manager.check_rate_limit')
    def test_cache_ok_rate_limited(self, mock_check):
        """底层限流触发时正确拒绝"""
        mock_check.return_value = (False, "发送过于频繁")
        allowed, msg = self.mgr.check_rate_limit("test@test.com", "1.2.3.4")
        self.assertFalse(allowed)


class CA14RefreshTokenHashNoneTests(TestCase):
    """CA-14: refresh_token_hash 为 None 的 session 应拒绝 token 刷新"""

    def _make_mock_session(self, refresh_token_hash=None, user_id="user-1"):
        session = MagicMock()
        session.refresh_token_hash = refresh_token_hash
        session.session_key = "abcdef1234567890abcdef"
        session.user_id = user_id
        session.expires_at = None
        session.refresh_token_updated_at = None
        return session

    @patch('apps.users.auth.api.UserSession')
    @patch('apps.users.auth.api.SessionManager')
    @patch('apps.users.auth.api.hash_string')
    @patch('apps.users.auth.api.verify_jwt_token')
    @patch('apps.users.auth.api.User')
    @patch('apps.users.auth.api.log_security_event')
    def test_null_hash_rejects_refresh(self, mock_log_event, mock_user_cls,
                                        mock_verify, mock_hash, mock_sm,
                                        mock_user_session):
        """CA-14: session.refresh_token_hash 为 None 时应拒绝刷新并作废 session"""
        from django.test import RequestFactory
        from apps.users.auth.api import refresh_token
        from apps.users.auth.schemas import RefreshTokenSchema

        mock_verify.return_value = {
            'user_id': 'user-1',
            'token_type': 'refresh',
            'sid': 'session-key-123',
            'remember_me': False,
        }

        mock_user = MagicMock()
        mock_user.id = 'user-1'
        mock_user.is_active = True
        mock_user_cls.objects.get.return_value = mock_user

        session = self._make_mock_session(refresh_token_hash=None, user_id='user-1')
        mock_sm.validate_session_for_refresh.return_value = session

        factory = RequestFactory()
        request = factory.post('/api/auth/refresh-token',
                               data={'refresh_token': 'fake-refresh-token'},
                               content_type='application/json')

        data = RefreshTokenSchema(refresh_token='fake-refresh-token')
        status_code, response = refresh_token(request, data)

        self.assertEqual(status_code, 401)
        self.assertFalse(response.success)
        mock_user_session.objects.filter.assert_called_once_with(pk=session.pk)
        mock_user_session.objects.filter.return_value.update.assert_called_once_with(is_active=False)

    @patch('apps.users.auth.api.UserSession')
    @patch('apps.users.auth.api.SessionManager')
    @patch('apps.users.auth.api.hash_string')
    @patch('apps.users.auth.api.verify_jwt_token')
    @patch('apps.users.auth.api.User')
    @patch('apps.users.auth.api.generate_jwt_token')
    @patch('apps.users.auth.api.log_security_event')
    def test_valid_hash_allows_refresh(self, mock_log_event, mock_gen_jwt,
                                        mock_user_cls, mock_verify,
                                        mock_hash, mock_sm, mock_user_session):
        """正常 hash 匹配应允许刷新"""
        from django.test import RequestFactory
        from apps.users.auth.api import refresh_token
        from apps.users.auth.schemas import RefreshTokenSchema

        mock_verify.return_value = {
            'user_id': 'user-1',
            'token_type': 'refresh',
            'sid': 'session-key-123',
            'remember_me': False,
        }

        mock_user = MagicMock()
        mock_user.id = 'user-1'
        mock_user.is_active = True
        mock_user_cls.objects.get.return_value = mock_user

        mock_hash.return_value = 'hash-abc'
        session = self._make_mock_session(refresh_token_hash='hash-abc', user_id='user-1')
        mock_sm.validate_session_for_refresh.return_value = session

        mock_gen_jwt.return_value = 'new-token'
        mock_user_session.objects.filter.return_value.update.return_value = 1

        factory = RequestFactory()
        request = factory.post('/api/auth/refresh-token',
                               data={'refresh_token': 'fake-refresh-token'},
                               content_type='application/json')

        data = RefreshTokenSchema(refresh_token='fake-refresh-token')
        result = refresh_token(request, data)

        if isinstance(result, tuple):
            status_code, response = result
            self.assertNotEqual(status_code, 401,
                                "正常 hash 匹配不应拒绝")
        else:
            pass


class CA6NoExceptionLeakTests(TestCase):
    """CA-6: 异常信息不泄露给客户端的基础验证"""

    def test_api_module_no_str_e_in_error_responses(self):
        """扫描 api.py 确认 except Exception 块不含 detail=str(e)"""
        import inspect
        import apps.users.auth.api as api_mod

        source = inspect.getsource(api_mod)

        import re
        except_blocks = list(re.finditer(
            r'except\s+Exception.*?(?=except\s|def\s|\Z)',
            source,
            re.DOTALL,
        ))

        leaks = []
        for m in except_blocks:
            block = m.group()
            if 'detail=str(e)' in block or 'str(e)' in block:
                if 'format_validation_error' not in block:
                    first_line = block.split('\n')[0].strip()
                    leaks.append(first_line)

        self.assertEqual(leaks, [],
                         f"发现 {len(leaks)} 处 str(e) 泄露到响应: {leaks}")

    def test_no_print_traceback_in_api(self):
        """确认 api.py 不含 print(traceback) 调试代码"""
        import inspect
        import apps.users.auth.api as api_mod

        source = inspect.getsource(api_mod)
        self.assertNotIn('import traceback', source,
                         "api.py 不应包含 import traceback")
        self.assertNotIn('traceback.format_exc', source,
                         "api.py 不应包含 traceback.format_exc")

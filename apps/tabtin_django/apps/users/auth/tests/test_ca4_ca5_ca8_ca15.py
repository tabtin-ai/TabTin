"""
CA-4 / CA-5 / CA-8 / CA-15 回归测试

CA-4:  验证码登录使用独立校验与限流，可作为密码锁定后的恢复通道
CA-5:  password-strength 改为 POST，密码不在 URL 中
CA-8:  forgot-password 对锁定/不存在账号统一返回 success=True
CA-15: verify-email / verify-phone 统一错误响应，不泄露账号存在性
"""

import json
from unittest.mock import patch, MagicMock, PropertyMock
from django.test import TestCase, RequestFactory, override_settings
from django.core.cache import cache
from django.utils import timezone


class CA4VerificationCodeLoginRecoveryTest(TestCase):
    """CA-4: 验证码验证成功后应解除密码登录锁定"""

    def setUp(self):
        cache.clear()
        self.factory = RequestFactory()

    def tearDown(self):
        cache.clear()

    @patch('apps.users.auth.api.auth_routes.log_user_action')
    @patch('apps.users.auth.api.auth_routes._create_auth_session', return_value=('access', 'refresh', 24))
    @patch('apps.users.auth.api.auth_routes._ensure_personal_organization_before_login', return_value=True)
    @patch('apps.users.auth.api.auth_routes.VerificationCodeManager')
    @patch('apps.users.auth.api.auth_routes._check_verify_submit_ip_rate', return_value=(True, ''))
    @patch('apps.users.auth.api.auth_routes.get_client_ip', return_value='127.0.0.1')
    def test_locked_account_can_recover_via_code_login(
        self,
        mock_ip,
        mock_rate,
        mock_vcm,
        mock_ensure_org,
        mock_create_session,
        mock_log_action,
    ):
        """密码锁定不应阻断已经通过独立限流保护的验证码登录"""
        from apps.users.auth.api.auth_routes import login_with_verification_code
        from apps.users.auth.schemas import VerificationCodeLoginSchema

        mock_vcm.verify_code.return_value = True

        from django.contrib.auth import get_user_model
        User = get_user_model()
        user = User.objects.create_user(
            email='locked@test.com',
            username='locked_code_recovery',
            password='CorrectPass1!',
        )
        User.objects.filter(id=user.id).update(
            failed_login_attempts=5,
            last_failed_login=timezone.now(),
        )

        request = self.factory.post(
            '/api/auth/login/verification-code',
            data=json.dumps({'username': 'locked@test.com', 'verification_code': '123456'}),
            content_type='application/json',
        )
        request.META['REMOTE_ADDR'] = '127.0.0.1'
        result = login_with_verification_code(
            request,
            VerificationCodeLoginSchema(
                username='locked@test.com',
                verification_code='123456',
                remember_me=False,
            ),
        )

        self.assertTrue(result['success'])
        user.refresh_from_db()
        self.assertEqual(user.failed_login_attempts, 0)
        self.assertIsNone(user.last_failed_login)


class CA5PasswordStrengthPostTest(TestCase):
    """CA-5: password-strength 端点必须为 POST"""

    def test_password_strength_endpoint_is_post(self):
        """确认 /password-strength 路由方法为 POST"""
        from apps.users.auth.api.password_routes import router

        path_view = router.path_operations.get('/password-strength')
        self.assertIsNotNone(path_view, "未找到 password-strength 路由")
        methods = path_view.operations[0].methods
        self.assertIn('POST', methods, f"password-strength 应该是 POST，实际是 {methods}")
        self.assertNotIn('GET', methods, "password-strength 不应包含 GET 方法")


class CA8ForgotPasswordUniformResponseTest(TestCase):
    """CA-8: forgot-password 对锁定账号统一返回 success=True"""

    def setUp(self):
        cache.clear()
        self.factory = RequestFactory()

    def tearDown(self):
        cache.clear()

    @patch('apps.users.auth.api.password_routes.log_user_action')
    @patch('apps.users.auth.api.password_routes.VerificationCodeManager')
    @patch('apps.users.auth.api.password_routes.is_suspicious_password_reset_activity', return_value=(False, ''))
    @patch('apps.users.auth.api.password_routes.check_password_reset_rate_limit', return_value=(True, ''))
    @patch('apps.users.auth.api.password_routes.validate_password_reset_context', return_value=(True, ''))
    @patch('apps.users.auth.api.password_routes.get_user_agent', return_value='TestAgent')
    @patch('apps.users.auth.api.password_routes.get_client_ip', return_value='127.0.0.1')
    def test_locked_account_returns_success(self, mock_ip, mock_ua, mock_ctx, mock_rate,
                                            mock_suspicious, mock_vcm, mock_log_action):
        """锁定账号返回统一响应，同时真正发送恢复验证码"""
        from apps.users.auth.api.password_routes import forgot_password

        mock_user = MagicMock()
        mock_user.is_active = True
        mock_vcm.send_code.return_value = (True, 'ok', None)

        from django.contrib.auth import get_user_model
        User = get_user_model()

        with patch.object(User.objects, 'get', return_value=mock_user):
            request = self.factory.post(
                '/api/auth/forgot-password',
                content_type='application/json',
            )

            data = MagicMock()
            data.username = 'locked@test.com'

            with patch('apps.users.auth.api.password_routes.log_security_event'):
                result = forgot_password(request, data)

            self.assertTrue(result.success)
            mock_vcm.send_code.assert_called_once_with(
                'locked@test.com',
                'reset_password',
                ip_address='127.0.0.1',
                skip_rate_limit=True,
            )

    @patch('apps.users.auth.api.password_routes.is_suspicious_password_reset_activity', return_value=(False, ''))
    @patch('apps.users.auth.api.password_routes.check_password_reset_rate_limit', return_value=(True, ''))
    @patch('apps.users.auth.api.password_routes.validate_password_reset_context', return_value=(True, ''))
    @patch('apps.users.auth.api.password_routes.get_user_agent', return_value='TestAgent')
    @patch('apps.users.auth.api.password_routes.get_client_ip', return_value='127.0.0.1')
    def test_nonexistent_user_returns_success(self, mock_ip, mock_ua, mock_ctx, mock_rate,
                                              mock_suspicious):
        """不存在的用户返回 success=True，不泄露存在性"""
        from apps.users.auth.api.password_routes import forgot_password
        from django.contrib.auth import get_user_model
        User = get_user_model()

        with patch.object(User.objects, 'get', side_effect=User.DoesNotExist):
            request = self.factory.post(
                '/api/auth/forgot-password',
                content_type='application/json',
            )

            data = MagicMock()
            data.username = 'nobody@test.com'

            result = forgot_password(request, data)

            self.assertTrue(result.success)


class CA15UniformVerificationErrorTest(TestCase):
    """CA-15: verify-email / verify-phone 不泄露账号存在性"""

    def setUp(self):
        cache.clear()
        self.factory = RequestFactory()

    def tearDown(self):
        cache.clear()

    @patch('apps.users.auth.api.verification_routes._check_verify_submit_ip_rate', return_value=(True, ''))
    @patch('apps.users.auth.api.verification_routes.get_client_ip', return_value='127.0.0.1')
    def test_verify_email_nonexistent_user_returns_code_invalid(self, mock_ip, mock_rate):
        """verify-email: 不存在的邮箱返回 verification_code_invalid 而非 user_not_found"""
        from apps.users.auth.api.verification_routes import verify_email
        from django.contrib.auth import get_user_model
        User = get_user_model()

        with patch.object(User.objects, 'get', side_effect=User.DoesNotExist):
            request = self.factory.post('/api/auth/verify-email', content_type='application/json')
            data = MagicMock()
            data.email = 'nobody@test.com'
            data.verification_code = '123456'

            result = verify_email(request, data)

            self.assertFalse(result.success)
            self.assertEqual(result.code, 'VALIDATION_ERROR')
            self.assertNotIn('not_found', result.message.lower() if result.message else '')

    @patch('apps.users.auth.api.verification_routes._check_verify_submit_ip_rate', return_value=(True, ''))
    @patch('apps.users.auth.api.verification_routes.get_client_ip', return_value='127.0.0.1')
    def test_verify_phone_nonexistent_user_returns_code_invalid(self, mock_ip, mock_rate):
        """verify-phone: 不存在的手机号返回 verification_code_invalid 而非 user_not_found"""
        from apps.users.auth.api.verification_routes import verify_phone
        from django.contrib.auth import get_user_model
        User = get_user_model()

        with patch.object(User.objects, 'get', side_effect=User.DoesNotExist):
            request = self.factory.post('/api/auth/verify-phone', content_type='application/json')
            data = MagicMock()
            data.phone = '13800138000'
            data.verification_code = '123456'

            result = verify_phone(request, data)

            self.assertFalse(result.success)
            self.assertEqual(result.code, 'VALIDATION_ERROR')
            self.assertNotIn('not_found', result.message.lower() if result.message else '')

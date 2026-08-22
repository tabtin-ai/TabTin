"""
DE-17 / DE-18 回归测试

DE-17: 签名比较必须使用 hmac.compare_digest（常量时间），防止时序侧信道攻击。
DE-18: Redis 限流必须用原子操作（INCR 先于判断），防止高并发绕过限额。
"""

import hashlib
import hmac
import inspect
import time
import uuid
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase, override_settings

from apps.tabdata.auth_open_api import (
    RATE_LIMIT_WINDOW,
    _check_rate_limit,
)
from apps.tabdata.models_token import _hash_token
from apps.tabdata.tests.test_permissions import _ensure_free_tier
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


# ── DE-17: 签名比较时序安全 ──


class TimingSafeCompareTests(TestCase):
    """DE-17: verify_token 中签名比较必须使用 hmac.compare_digest"""

    def test_verify_token_uses_compare_digest(self):
        """源码中 verify_token 调用了 hmac.compare_digest 而非 == / !="""
        from apps.tabdata.models_token import TableApiToken

        source = inspect.getsource(TableApiToken.verify_token)
        self.assertIn('hmac.compare_digest', source)
        self.assertNotIn('sign_hash !=', source)
        self.assertNotIn('sign_hash ==', source)

    def test_hash_token_deterministic(self):
        """_hash_token 对相同输入产生相同输出"""
        sign = 'abc123'
        self.assertEqual(_hash_token(sign), _hash_token(sign))

    def test_hash_token_different_for_different_input(self):
        """_hash_token 对不同输入产生不同输出"""
        self.assertNotEqual(_hash_token('abc'), _hash_token('def'))

    def test_compare_digest_rejects_wrong_hash(self):
        """hmac.compare_digest 对不匹配的哈希返回 False"""
        correct = _hash_token('correct_sign')
        wrong = _hash_token('wrong_sign')
        self.assertFalse(hmac.compare_digest(correct, wrong))

    def test_compare_digest_accepts_correct_hash(self):
        """hmac.compare_digest 对匹配的哈希返回 True"""
        sign = 'correct_sign'
        h = _hash_token(sign)
        self.assertTrue(hmac.compare_digest(h, _hash_token(sign)))


# ── DE-18: 限流原子性 ──


class AtomicRateLimitTests(TestCase):
    """DE-18: Redis 限流使用原子 INCR 模式，防止竞态条件"""

    databases = {'default', 'postgresql'}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()
        self.user = User.objects.create_user(
            username='de18_user',
            email='de18_user@test.com',
            password='pass123',
        )

    def _make_jwt_request(self):
        request = self.factory.get('/fake')
        request.auth = self.user
        request.api_token = None
        request._api_auth_type = 'jwt'
        request._api_user_id = str(self.user.id)
        return request

    def test_source_uses_cache_incr_not_get_check_set(self):
        """源码使用 cache.add + cache.incr 原子模式，而非 get→check→set"""
        source = inspect.getsource(_check_rate_limit)
        self.assertIn('cache.add(', source)
        self.assertIn('cache.incr(', source)
        self.assertNotIn('cache.get(count_key)', source)

    @patch('apps.tabdata.auth_open_api.RATE_LIMIT_WINDOW', 60)
    def test_first_request_allowed(self):
        """首次请求应被放行"""
        request = self._make_jwt_request()
        error, rate_info = _check_rate_limit(request)
        self.assertIsNone(error)
        self.assertGreater(rate_info['remaining'], 0)

    @patch('apps.tabdata.auth_open_api.RATE_LIMIT_WINDOW', 60)
    @patch('apps.tabdata.auth_open_api.JWT_DEFAULT_RATE_LIMIT', 3)
    def test_exceeding_limit_returns_error(self):
        """超过限额后应返回限流错误"""
        request = self._make_jwt_request()
        for _ in range(3):
            error, _ = _check_rate_limit(request)
            self.assertIsNone(error)

        error, rate_info = _check_rate_limit(request)
        self.assertIsNotNone(error)
        self.assertEqual(rate_info['remaining'], 0)
        self.assertIn('RATE_LIMIT_EXCEEDED', str(error.get('code', '')))

    @patch('apps.tabdata.auth_open_api.RATE_LIMIT_WINDOW', 60)
    @patch('apps.tabdata.auth_open_api.JWT_DEFAULT_RATE_LIMIT', 3)
    def test_rate_info_remaining_decrements(self):
        """每次请求 remaining 应递减"""
        request = self._make_jwt_request()
        prev_remaining = None
        for _ in range(3):
            _, rate_info = _check_rate_limit(request)
            if prev_remaining is not None:
                self.assertLess(rate_info['remaining'], prev_remaining)
            prev_remaining = rate_info['remaining']

    def test_redis_failure_fallback(self):
        """Redis 不可用时应降级到进程内计数器"""
        request = self._make_jwt_request()
        with patch('django.core.cache.cache') as mock_cache:
            mock_cache.add.side_effect = Exception('Redis down')
            error, rate_info = _check_rate_limit(request)
            self.assertIsNone(error)
            self.assertGreater(rate_info['remaining'], 0)

    @patch('apps.tabdata.auth_open_api.RATE_LIMIT_WINDOW', 60)
    def test_api_token_rate_limit_uses_token_limit(self):
        """API Token 认证应使用 token 自身的 rate_limit 字段"""
        mock_token = MagicMock()
        mock_token.rate_limit = 5
        mock_token.id = uuid.uuid4()

        request = self.factory.get('/fake')
        request.auth = self.user
        request.api_token = mock_token

        _, rate_info = _check_rate_limit(request)
        self.assertEqual(rate_info['limit'], 5)

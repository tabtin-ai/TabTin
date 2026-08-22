"""
P0-12 / P0-13 安全修复回归测试

P0-13: 验证码比较使用 hmac.compare_digest（防时序侧信道）
P0-12: is_rate_limited 异常时 fail-closed（返回 True 拒绝请求）

测试策略：单元测试，mock Redis / Django cache 外部依赖。
"""

import hmac
import time
from unittest import TestCase
from unittest.mock import MagicMock, patch


# ═══════════════════════════════════════════════════════════════════════
# P0-13: hmac.compare_digest 验证码比较
# ═══════════════════════════════════════════════════════════════════════


class VerifyCodeHmacCompareTests(TestCase):
    """P0-13: verify_code 使用 hmac.compare_digest 而非 ==。"""

    def test_source_uses_hmac_compare_digest(self):
        """静态检查：verify_code 源码使用 hmac.compare_digest。"""
        import inspect
        from apps.services.common.cache import verify_code

        source = inspect.getsource(verify_code)
        self.assertIn('hmac.compare_digest', source)
        self.assertNotIn("stored_code == input_code", source)
        self.assertNotIn("input_code == stored_code", source)

    @patch('apps.services.common.cache.cache_manager')
    @patch('apps.services.common.cache.get_verification_code')
    def test_correct_code_returns_true(self, mock_get_code, mock_cache):
        """正向：正确验证码 → True。"""
        from apps.services.common.cache import verify_code

        mock_get_code.return_value = {
            'code': '123456',
            'created_at': int(time.time()),
            'expire_at': int(time.time()) + 300,
        }

        self.assertTrue(verify_code('test@test.com', '123456', 'email'))

    @patch('apps.services.common.cache.cache_manager')
    @patch('apps.services.common.cache.get_verification_code')
    def test_wrong_code_returns_false(self, mock_get_code, mock_cache):
        """负向：错误验证码 → False。"""
        from apps.services.common.cache import verify_code

        mock_get_code.return_value = {
            'code': '123456',
            'created_at': int(time.time()),
            'expire_at': int(time.time()) + 300,
        }

        self.assertFalse(verify_code('test@test.com', '654321', 'email'))

    @patch('apps.services.common.cache.get_verification_code')
    def test_no_cached_code_returns_false(self, mock_get_code):
        """负向：无缓存验证码 → False。"""
        from apps.services.common.cache import verify_code

        mock_get_code.return_value = None
        self.assertFalse(verify_code('test@test.com', '123456', 'email'))

    @patch('apps.services.common.cache.get_verification_code')
    def test_exception_returns_false_fail_closed(self, mock_get_code):
        """负向：异常时 fail-closed → False。"""
        from apps.services.common.cache import verify_code

        mock_get_code.side_effect = Exception('Redis down')
        self.assertFalse(verify_code('test@test.com', '123456', 'email'))

    def test_hmac_compare_digest_is_constant_time(self):
        """验证 hmac.compare_digest 对相同和不同输入均正确。"""
        self.assertTrue(hmac.compare_digest('123456', '123456'))
        self.assertFalse(hmac.compare_digest('123456', '123457'))
        self.assertFalse(hmac.compare_digest('123456', '12345'))
        self.assertFalse(hmac.compare_digest('', '123456'))

    @patch('apps.services.common.cache.cache_manager')
    @patch('apps.services.common.cache.get_verification_code')
    def test_integer_code_cast_to_string(self, mock_get_code, mock_cache):
        """边界：存储的 code 为 int 时也正确比较（str 转换）。"""
        from apps.services.common.cache import verify_code

        mock_get_code.return_value = {
            'code': 123456,
            'created_at': int(time.time()),
            'expire_at': int(time.time()) + 300,
        }

        self.assertTrue(verify_code('test@test.com', '123456', 'email'))


# ═══════════════════════════════════════════════════════════════════════
# P0-12: is_rate_limited fail-closed
# ═══════════════════════════════════════════════════════════════════════


class IsRateLimitedFailClosedTests(TestCase):
    """P0-12: Redis + Django cache 均异常时返回 True（fail-closed）。"""

    @patch('apps.services.common.cache.cache_manager')
    @patch('apps.services.common.cache._get_redis_connection')
    def test_all_backends_fail_returns_limited(self, mock_redis_conn, mock_cache):
        """核心：Redis 不可用 + Django cache 异常 → fail-closed (True)。"""
        from apps.services.common.cache import is_rate_limited

        mock_redis_conn.return_value = None
        mock_cache.get.side_effect = Exception('cache down')

        is_limited, count, ttl = is_rate_limited('test', 'key1', 10, 60)

        self.assertTrue(is_limited)
        self.assertEqual(ttl, 60)

    @patch('apps.services.common.cache.cache_manager')
    @patch('apps.services.common.cache._get_redis_connection')
    def test_redis_unavailable_django_cache_works(self, mock_redis_conn, mock_cache):
        """正向：Redis 不可用但 Django cache 正常 → 使用 fallback。"""
        from apps.services.common.cache import is_rate_limited

        mock_redis_conn.return_value = None
        mock_cache.get.return_value = 0
        mock_cache.add.return_value = True
        mock_cache.increment.return_value = 1
        mock_cache._make_key.return_value = 'prefixed_key'

        is_limited, count, ttl = is_rate_limited('test', 'key2', 10, 60)

        self.assertFalse(is_limited)
        self.assertEqual(count, 1)

    @patch('apps.services.common.cache.cache_manager')
    @patch('apps.services.common.cache._get_redis_connection')
    def test_redis_lua_success(self, mock_redis_conn, mock_cache):
        """正向：Redis Lua 脚本正常 → 使用原子路径。"""
        from apps.services.common.cache import is_rate_limited

        mock_conn = MagicMock()
        mock_conn.script_load.return_value = 'sha1'
        mock_conn.evalsha.return_value = [0, 1, 60]
        mock_redis_conn.return_value = mock_conn
        mock_cache._make_key.return_value = 'prefixed_key'

        is_limited, count, ttl = is_rate_limited('test', 'key3', 10, 60)

        self.assertFalse(is_limited)
        self.assertEqual(count, 1)
        self.assertEqual(ttl, 60)

    @patch('apps.services.common.cache.cache_manager')
    @patch('apps.services.common.cache._get_redis_connection')
    def test_redis_lua_returns_limited(self, mock_redis_conn, mock_cache):
        """正向：Redis 返回超限 → True。"""
        from apps.services.common.cache import is_rate_limited

        mock_conn = MagicMock()
        mock_conn.script_load.return_value = 'sha1'
        mock_conn.evalsha.return_value = [1, 11, 45]
        mock_redis_conn.return_value = mock_conn
        mock_cache._make_key.return_value = 'prefixed_key'

        is_limited, count, ttl = is_rate_limited('test', 'key4', 10, 60)

        self.assertTrue(is_limited)
        self.assertEqual(count, 11)

    @patch('apps.services.common.cache.cache_manager')
    @patch('apps.services.common.cache._get_redis_connection')
    def test_django_cache_at_limit_returns_limited(self, mock_redis_conn, mock_cache):
        """正向：Django cache 计数达到限制 → True。"""
        from apps.services.common.cache import is_rate_limited

        mock_redis_conn.return_value = None
        mock_cache.get.return_value = 10
        mock_cache._make_key.return_value = 'prefixed_key'

        is_limited, count, ttl = is_rate_limited('test', 'key5', 10, 60)

        self.assertTrue(is_limited)

    @patch('apps.services.common.cache.cache_manager')
    @patch('apps.services.common.cache._get_redis_connection')
    def test_redis_lua_error_falls_back_to_django_cache(self, mock_redis_conn, mock_cache):
        """容错：Redis Lua 执行出错 → 回退到 Django cache。"""
        from apps.services.common.cache import is_rate_limited
        import apps.services.common.cache as cache_module
        cache_module._lua_sha = 'old_sha'

        mock_conn = MagicMock()
        mock_conn.evalsha.side_effect = Exception('NOSCRIPT')
        mock_redis_conn.return_value = mock_conn
        mock_cache._make_key.return_value = 'prefixed_key'
        mock_cache.get.return_value = 0
        mock_cache.add.return_value = True
        mock_cache.increment.return_value = 1

        is_limited, count, ttl = is_rate_limited('test', 'key6', 10, 60)

        self.assertFalse(is_limited)
        self.assertIsNone(cache_module._lua_sha)

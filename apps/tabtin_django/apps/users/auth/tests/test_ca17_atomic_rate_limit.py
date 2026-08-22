"""
CA-17 回归测试：限流竞态 → Redis INCR 原子操作

修复内容：_atomic_incr_rate_limit 从 cache.add + cache.incr 改为
Redis pipeline INCR + EXPIRE 原子操作，Redis 故障时 fallback 到旧逻辑。
"""

import unittest
from unittest.mock import patch, MagicMock

from django.core.cache import cache

from apps.users.auth.utils import _atomic_incr_rate_limit


class TestCA17AtomicRateLimit(unittest.TestCase):
    """CA-17: _atomic_incr_rate_limit 原子递增限流计数器"""

    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    @patch('apps.users.auth.utils.get_redis_connection')
    def test_normal_path_redis_pipeline_called(self, mock_get_redis):
        """正常路径：Redis INCR pipeline 被调用"""
        mock_conn = MagicMock()
        mock_pipe = MagicMock()
        mock_conn.pipeline.return_value = mock_pipe
        mock_get_redis.return_value = mock_conn

        checks = [
            ('rate_limit:login:identifier:abc:3600', 10, 3600),
            ('rate_limit:login:ip:def:3600', 30, 3600),
        ]

        _atomic_incr_rate_limit(checks)

        mock_get_redis.assert_called_once_with('default')
        mock_conn.pipeline.assert_called_once()
        # 每个 check 调用 incr + expire
        self.assertEqual(mock_pipe.incr.call_count, 2)
        self.assertEqual(mock_pipe.expire.call_count, 2)
        mock_pipe.execute.assert_called_once()

        # 验证 incr 和 expire 的参数
        mock_pipe.incr.assert_any_call('rate_limit:login:identifier:abc:3600')
        mock_pipe.incr.assert_any_call('rate_limit:login:ip:def:3600')
        mock_pipe.expire.assert_any_call('rate_limit:login:identifier:abc:3600', 3600)
        mock_pipe.expire.assert_any_call('rate_limit:login:ip:def:3600', 3600)

    @patch('apps.users.auth.utils.get_redis_connection')
    @patch('apps.users.auth.utils.cache')
    def test_redis_failure_fallback_to_cache_add_incr(self, mock_cache, mock_get_redis):
        """Redis 故障时 fallback 到 cache.add + cache.incr"""
        mock_get_redis.side_effect = Exception('Redis connection refused')

        mock_cache.add.return_value = True  # 首次 add 成功
        mock_cache.incr.side_effect = [None, None]  # incr 不抛异常

        checks = [
            ('rate_limit:login:identifier:abc:3600', 10, 3600),
            ('rate_limit:login:ip:def:3600', 30, 3600),
        ]

        _atomic_incr_rate_limit(checks)

        # 应调用 cache.add 和 cache.incr（每个 check 一次 add + incr）
        self.assertEqual(mock_cache.add.call_count, 2)
        self.assertEqual(mock_cache.incr.call_count, 2)

    @patch('apps.users.auth.utils.get_redis_connection')
    @patch('apps.users.auth.utils.cache')
    def test_redis_failure_fallback_cache_add_exists_then_incr(self, mock_cache, mock_get_redis):
        """Redis 故障时，若 cache.add 返回 False（key 已存在），则直接 incr"""
        mock_get_redis.side_effect = Exception('Redis connection refused')

        # 第一个 key add 成功，第二个 key 已存在 add 返回 False
        mock_cache.add.side_effect = [True, False]
        mock_cache.incr.side_effect = [None, None]

        checks = [
            ('rate_limit:login:identifier:abc:3600', 10, 3600),
            ('rate_limit:login:ip:def:3600', 30, 3600),
        ]

        _atomic_incr_rate_limit(checks)

        self.assertEqual(mock_cache.add.call_count, 2)
        self.assertEqual(mock_cache.incr.call_count, 2)

    @patch('apps.users.auth.utils.get_redis_connection')
    @patch('apps.users.auth.utils.cache')
    def test_redis_failure_fallback_incr_value_error_then_set(self, mock_cache, mock_get_redis):
        """Redis 故障时，incr 抛出 ValueError（key 不存在）则 cache.set 兜底"""
        mock_get_redis.side_effect = Exception('Redis connection refused')

        mock_cache.add.return_value = False  # key 已存在（或 add 失败）
        mock_cache.incr.side_effect = ValueError('key not found')

        checks = [('rate_limit:login:identifier:abc:3600', 10, 3600)]

        _atomic_incr_rate_limit(checks)

        mock_cache.set.assert_called_once_with('rate_limit:login:identifier:abc:3600', 1, 3600)

    @patch('apps.users.auth.utils.get_redis_connection')
    def test_multiple_calls_counter_increments_correctly(self, mock_get_redis):
        """多次调用确保计数器正确递增"""
        mock_conn = MagicMock()
        mock_pipe = MagicMock()
        mock_conn.pipeline.return_value = mock_pipe
        mock_get_redis.return_value = mock_conn

        # 模拟 Redis pipeline 返回递增后的值
        mock_pipe.execute.side_effect = [[1], [2], [3]]

        checks = [('rate_limit:login:identifier:abc:3600', 10, 3600)]

        for _ in range(3):
            _atomic_incr_rate_limit(checks)

        self.assertEqual(mock_pipe.incr.call_count, 3)
        self.assertEqual(mock_pipe.execute.call_count, 3)

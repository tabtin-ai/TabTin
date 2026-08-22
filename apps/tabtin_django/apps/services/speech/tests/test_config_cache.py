from __future__ import annotations

import threading
import time
from unittest.mock import MagicMock

from django.test import SimpleTestCase

from apps.services.speech._config_cache import (
    _store,
    get_cached_config,
    invalidate,
)


class ConfigCacheTest(SimpleTestCase):
    def setUp(self):
        invalidate()

    def tearDown(self):
        invalidate()

    def test_basic_cache_hit(self):
        loader = MagicMock(return_value={"app_id": "123"})
        result1 = get_cached_config("test:key", loader)
        result2 = get_cached_config("test:key", loader)
        self.assertEqual(result1, {"app_id": "123"})
        self.assertEqual(result2, {"app_id": "123"})
        loader.assert_called_once()

    def test_ttl_expiry(self):
        call_count = 0

        def loader():
            nonlocal call_count
            call_count += 1
            return {"v": call_count}

        result1 = get_cached_config("ttl:key", loader, ttl=1)
        self.assertEqual(result1, {"v": 1})

        time.sleep(1.1)
        result2 = get_cached_config("ttl:key", loader, ttl=1)
        self.assertEqual(result2, {"v": 2})
        self.assertEqual(call_count, 2)

    def test_invalidate_single_key(self):
        loader = MagicMock(return_value={"k": "v"})
        get_cached_config("a", loader)
        get_cached_config("b", loader)
        self.assertEqual(loader.call_count, 2)

        invalidate("a")
        get_cached_config("a", loader)
        get_cached_config("b", loader)
        self.assertEqual(loader.call_count, 3)

    def test_invalidate_all(self):
        loader = MagicMock(return_value={"k": "v"})
        get_cached_config("x", loader)
        get_cached_config("y", loader)
        self.assertEqual(loader.call_count, 2)

        invalidate()
        get_cached_config("x", loader)
        get_cached_config("y", loader)
        self.assertEqual(loader.call_count, 4)

    def test_none_result_cached(self):
        """loader 返回 None 也应被缓存，避免反复穿透"""
        loader = MagicMock(return_value=None)
        result1 = get_cached_config("null:key", loader)
        result2 = get_cached_config("null:key", loader)
        self.assertIsNone(result1)
        self.assertIsNone(result2)
        loader.assert_called_once()

    def test_shallow_copy_isolation(self):
        """返回的 dict 是浅拷贝，修改不影响缓存"""
        loader = MagicMock(return_value={"app_id": "original"})
        result = get_cached_config("copy:key", loader)
        result["app_id"] = "modified"

        result2 = get_cached_config("copy:key", loader)
        self.assertEqual(result2["app_id"], "original")

    def test_stampede_protection(self):
        """并发请求不会同时执行 loader（stampede 防护）"""
        call_count = 0
        barrier = threading.Barrier(5, timeout=5)

        def slow_loader():
            nonlocal call_count
            call_count += 1
            time.sleep(0.1)
            return {"v": call_count}

        invalidate()

        threads = []
        results = []
        lock = threading.Lock()

        def worker():
            barrier.wait()
            r = get_cached_config("stampede:key", slow_loader, ttl=10)
            with lock:
                results.append(r)

        for _ in range(5):
            t = threading.Thread(target=worker)
            threads.append(t)
            t.start()

        for t in threads:
            t.join(timeout=10)

        self.assertEqual(call_count, 1, "loader 应只被调用一次（stampede 防护）")
        self.assertEqual(len(results), 5)
        for r in results:
            self.assertEqual(r["v"], 1)

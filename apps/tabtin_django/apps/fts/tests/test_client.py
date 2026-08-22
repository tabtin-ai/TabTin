"""`apps.fts.client` 单元测试。

覆盖：
    - `SEARCH_ENGINE_ENABLED=false` 时 `get_client()` 抛
      `SearchEngineDisabledError`
    - flag 开启时能构造客户端（client 工厂 mock）
    - `get_client()` 单例语义（两次调用返回同一对象）
    - `reset_client()` 正确释放单例
    - 共享 CircuitBreaker 在 `fail_max` 次失败后 open，
      `reset_timeout` 后转 half-open
    - Breaker 单例在多 worker 间基于 Redis 共享状态（用 mock Redis
      验证：两次 `get_breaker()` 共享计数）

全部基于 mock，无需真连 ES / Redis。
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.fts import client as fts_client
from apps.fts.client import (
    SearchEngineDisabledError,
    get_breaker,
    get_client,
    is_engine_enabled,
    reset_client,
)


@override_settings(SEARCH_ENGINE_ENABLED=False)
class ClientFlagOffTests(SimpleTestCase):
    """flag 关闭时必须拒绝访问 ES 客户端（ADR-12）。"""

    def setUp(self) -> None:
        super().setUp()
        reset_client()

    def tearDown(self) -> None:
        reset_client()
        super().tearDown()

    def test_is_engine_enabled_returns_false(self) -> None:
        """推荐入口：前置判断，避免异常控制流（Review A4）。"""
        self.assertFalse(is_engine_enabled())

    def test_get_client_raises_when_disabled(self) -> None:
        with self.assertRaises(SearchEngineDisabledError):
            get_client()


@override_settings(SEARCH_ENGINE_ENABLED=True)
class IsEngineEnabledTests(SimpleTestCase):

    def test_returns_true_when_enabled(self) -> None:
        self.assertTrue(is_engine_enabled())


@override_settings(
    SEARCH_ENGINE_ENABLED=True,
    SEARCH_ES_HOSTS=["http://localhost:9200"],
    SEARCH_ES_HTTP_AUTH=("", ""),
    SEARCH_ES_TIMEOUT=5,
)
class ClientSingletonTests(SimpleTestCase):
    """flag 开启时 client 必须走懒加载单例。"""

    def setUp(self) -> None:
        super().setUp()
        reset_client()

    def tearDown(self) -> None:
        reset_client()
        super().tearDown()

    def test_build_client_called_once(self) -> None:
        fake = MagicMock(name="es-fake")
        with patch.object(fts_client, "_build_client", return_value=fake) as build:
            first = get_client()
            second = get_client()
        self.assertIs(first, second)
        self.assertEqual(build.call_count, 1)

    def test_reset_client_invalidates_singleton(self) -> None:
        fake_a = MagicMock(name="es-a")
        fake_b = MagicMock(name="es-b")
        with patch.object(fts_client, "_build_client", side_effect=[fake_a, fake_b]):
            self.assertIs(get_client(), fake_a)
            reset_client()
            self.assertIs(get_client(), fake_b)


@override_settings(
    SEARCH_ENGINE_ENABLED=True,
    FTS_BREAKER_FAIL_MAX=3,
    FTS_BREAKER_RESET_TIMEOUT=1,
    FTS_BREAKER_REQUIRE_REDIS=False,   # 单测里允许降级到内存
)
class BreakerBehaviourTests(SimpleTestCase):
    """共享 CircuitBreaker 状态机行为（PRD 4.8.A）。"""

    def setUp(self) -> None:
        super().setUp()
        reset_client()
        # 强制降级到进程内存，避免单测依赖 Redis（`_build_redis_storage`
        # 触发 `get_redis_connection`，CI 无 Redis 会挂）。
        # 同时设置 FTS_BREAKER_REQUIRE_REDIS=False 确保 fallback 路径不 raise。
        self._patcher = patch.object(
            fts_client,
            "_build_redis_storage",
            side_effect=RuntimeError("redis disabled in test"),
        )
        self._patcher.start()

    def tearDown(self) -> None:
        self._patcher.stop()
        reset_client()
        super().tearDown()

    def test_breaker_opens_after_fail_max(self) -> None:
        """pybreaker 1.4 行为：达到 fail_max 时当次失败立即转成
        `CircuitBreakerError`（保留原 traceback）。之前的失败仍抛原异常。
        """
        import pybreaker

        breaker = get_breaker()
        self.assertEqual(breaker.fail_max, 3)

        def _always_fail() -> None:
            raise RuntimeError("boom")

        # 前 fail_max - 1 次仍透出业务异常
        for _ in range(breaker.fail_max - 1):
            with self.assertRaises(RuntimeError):
                breaker.call(_always_fail)

        # 达到阈值当次 -> CircuitBreakerError
        with self.assertRaises(pybreaker.CircuitBreakerError):
            breaker.call(_always_fail)

        # 之后再调用也持续被 breaker 拒绝
        with self.assertRaises(pybreaker.CircuitBreakerError):
            breaker.call(_always_fail)

    def test_breaker_recovers_after_reset_timeout(self) -> None:
        import pybreaker

        breaker = get_breaker()

        def _always_fail() -> None:
            raise RuntimeError("boom")

        for _ in range(breaker.fail_max - 1):
            with self.assertRaises(RuntimeError):
                breaker.call(_always_fail)
        # 触发阈值
        with self.assertRaises(pybreaker.CircuitBreakerError):
            breaker.call(_always_fail)

        # open 期间进一步被拒
        with self.assertRaises(pybreaker.CircuitBreakerError):
            breaker.call(_always_fail)

        # 等待 reset_timeout（设置为 1s）后进入 half-open
        time.sleep(1.2)

        calls = []

        def _succeed() -> str:
            calls.append(1)
            return "ok"

        result = breaker.call(_succeed)
        self.assertEqual(result, "ok")
        self.assertEqual(len(calls), 1)


@override_settings(
    SEARCH_ENGINE_ENABLED=True,
    FTS_BREAKER_FAIL_MAX=2,
    FTS_BREAKER_REQUIRE_REDIS=True,
)
class BreakerRequireRedisTests(SimpleTestCase):
    """生产模式下 Redis 不可达必须 raise（Review A3）。"""

    def tearDown(self) -> None:
        reset_client()
        super().tearDown()

    def test_raises_when_redis_unavailable_and_required(self) -> None:
        with patch.object(
            fts_client,
            "_build_redis_storage",
            side_effect=RuntimeError("redis down"),
        ):
            with self.assertRaises(RuntimeError):
                fts_client._build_breaker()


@override_settings(
    SEARCH_ENGINE_ENABLED=True,
    FTS_BREAKER_FAIL_MAX=2,
    FTS_BREAKER_RESET_TIMEOUT=60,
    FTS_BREAKER_NAMESPACE="fts_breaker_test",
)
class BreakerSharedStateTests(SimpleTestCase):
    """验证 breaker 单例在同一 namespace 下共享状态。

    这里直接用 fakeredis 作为 `get_redis_connection` 的替身，
    构造两个 breaker 实例（模拟多 worker）并确认失败计数跨实例累积。
    """

    def setUp(self) -> None:
        super().setUp()
        reset_client()

    def tearDown(self) -> None:
        reset_client()
        super().tearDown()

    def test_breaker_state_shared_across_instances(self) -> None:
        """验证 breaker 在同 namespace 下基于 Redis 共享计数。

        前置依赖：fakeredis（本项目为可选开发依赖，避免 CI 强耦合）。
        未装时 skip。PRD 4.8.A 要求"共享状态"是核心能力，因此
        **强烈建议** 本地开发环境装 fakeredis 后跑 pytest：

            pip install 'fakeredis>=2.20'
        """
        try:
            import fakeredis
        except ImportError:
            self.skipTest("fakeredis 未安装，跳过 Redis 共享状态用例")

        shared_redis = fakeredis.FakeRedis()

        def _fake_get_conn(alias: str = "default", **kw):  # noqa: ANN001, ARG001
            return shared_redis

        # `apps.fts.client` 里是 `from django_redis import get_redis_connection`
        # （模块内部的局部导入），patch 到源头即可生效。
        with patch("django_redis.get_redis_connection", _fake_get_conn):
            from apps.fts.client import _build_breaker

            breaker_a = _build_breaker()

            def _fail() -> None:
                raise RuntimeError("x")

            # 实例 A 先消耗 fail_max - 1 次（1 次失败）
            with self.assertRaises(RuntimeError):
                breaker_a.call(_fail)

            # 实例 B 模拟另一个 worker，同 namespace 下拿到共享计数
            breaker_b = _build_breaker()

            # 第 2 次失败达到阈值，pybreaker 当次转 CircuitBreakerError
            import pybreaker
            with self.assertRaises(pybreaker.CircuitBreakerError):
                breaker_b.call(_fail)

            # 之后两个实例都被拒绝 —— 证明状态已跨实例共享
            with self.assertRaises(pybreaker.CircuitBreakerError):
                breaker_a.call(_fail)

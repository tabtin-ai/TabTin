"""Wave 7.3 (charter v1.8 §6.3 + plan v2.1 §Phase 7) — 触发风暴防护测试。

═══════════════════════════════════════════════════════════════════════
本文件分两层（**Wave 5 反思 16 + 反思 9 双重防线**）：

Layer A — 核心决策纯函数测试（``decide_storm_guard``）
─────────────────────────────────────────────────────
不依赖真 PG/MySQL test DB，用 ``SimpleTestCase + django LocMem cache``
真跑 4 机制核心逻辑：debounce / rate_limit / circuit_breaker / first_trigger。
**默认启用**——是 Wave 7.3 北极星 2 的硬保护。

Layer B — DB 副作用真路径测试（``_trip_circuit_breaker`` + ``_mark_first_triggered``）
──────────────────────────────────────────────────────
守 ``TABTIN_REAL_DB_TEST=1``。**默认 SKIP**（项目客观无 PG/MySQL test DB
基础设施——同 Wave 5 反思 16）。CI 接入 Django test workflow 后必须
``env: TABTIN_REAL_DB_TEST: "1"`` 才能让真 ORM 路径生效。

设计动机（**反思 9 防线**——MagicMock 让死代码"通过测试"）：
  - Wave 5 教训：把"真 ORM 路径"做成"全 mock 路径"等于没测
  - 本期把核心决策抽成纯函数，让 Layer A 真跑核心逻辑（cache + dataclass）
    而无需 ORM；Layer B 只测 _trip_circuit_breaker 把 status 从 active
    转到 paused 的 DB 副作用——这部分实在没 ORM 测不了
  - 对比 Wave 5 ``test_tracker_run_meta_resolution.py``：Wave 5 把所有
    用例都放在 TransactionTestCase 里，dev 环境无真 DB → 全部 SKIP，
    反思 9 防线形同虚设。本文件 Layer A **默认启用**避免重蹈覆辙

═══════════════════════════════════════════════════════════════════════

测试覆盖（plan v2.1 §Phase 7 验收清单 + 北极星 2）：
  Layer A（默认启用）：
    1. **debounce**：N 秒内多次事件合并为 1 次 trigger
    2. **rate_limit**：1 小时内 100 次事件 → 限流到 ≤ 20 次（北极星 2）
    3. **circuit_breaker 决策**：1 分钟内 ≥ 10 次触发 → should_trip_circuit
    4. **first_trigger**：首次触发返回 first_trigger=True
    5. **多租户隔离**：不同 tracker_id 的 storm guard cache key 互不干扰
    6. **fail-open**：cache 故障时 allowed=True（不挡正常流量）

  Layer B（TABTIN_REAL_DB_TEST=1 启用）：
    7. **熔断 DB 副作用**：Tracker.status active → paused + intent_snapshot.last_pause_reason
    8. **首次触发 mark**：intent_snapshot.first_triggered_at
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase, TransactionTestCase, override_settings


# 让 Layer B 真 ORM 用例只有在 TABTIN_REAL_DB_TEST=1 时才被定义
# （未启用时 setup_databases 不会尝试连 PG，避免 dev sqlite 环境阻塞）
_REQUIRES_REAL_DB = os.getenv("TABTIN_REAL_DB_TEST") == "1"


# ─── Layer A：核心决策纯函数测试（默认启用）─────────────────────────


@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "trigger-storm-decide-test",
    }
})
class DecideStormGuardCoreTest(SimpleTestCase):
    """``decide_storm_guard`` 纯函数 — 用真 LocMem cache 跑 4 机制核心逻辑。

    本测试是 Wave 7.3 北极星 2 的**主保护**——默认启用，不走 ORM，避免
    "反思 16 项目客观无 PG/MySQL test DB" 阻塞核心决策测试。
    """

    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    # ── 默认配置 ────────────────────────────────────────────

    def test_default_values_match_plan(self):
        """plan v2.1 §Phase 7 第 631-633 行明确写了默认值，本测试钉死。"""
        from apps.tracker.services.tracker_trigger_service import STORM_GUARD_DEFAULTS

        self.assertEqual(STORM_GUARD_DEFAULTS["debounce_seconds"], 0)
        self.assertEqual(STORM_GUARD_DEFAULTS["rate_limit_per_hour"], 20)
        self.assertEqual(STORM_GUARD_DEFAULTS["circuit_breaker_threshold"], 10)

    def test_decision_dataclass_fields(self):
        """StormGuardDecision 必须有 5 个字段（任一字段被改名都会破坏调用方契约）。"""
        from apps.tracker.services.tracker_trigger_service import StormGuardDecision

        d = StormGuardDecision(allowed=True)
        self.assertTrue(d.allowed)
        self.assertEqual(d.reason, "")
        self.assertFalse(d.should_trip_circuit)
        self.assertFalse(d.circuit_broken)
        self.assertFalse(d.first_trigger)

    # ── debounce ────────────────────────────────────────────

    def test_debounce_blocks_repeat_within_window(self):
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {
            "debounce_seconds": 5,
            # 把 rate / circuit 调高，避免误命中
            "rate_limit_per_hour": 9999,
            "circuit_breaker_threshold": 9999,
        }
        d1 = decide_storm_guard("tracker-debounce-1", cfg)
        self.assertTrue(d1.allowed, f"首次触发应允许，实际 reason={d1.reason!r}")

        d2 = decide_storm_guard("tracker-debounce-1", cfg)
        self.assertFalse(d2.allowed, "5s debounce 内第 2 次应被拒")
        self.assertIn("debounce", d2.reason)

    def test_debounce_zero_does_not_block(self):
        """debounce_seconds=0 关闭——多次连续触发都允许。"""
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {"debounce_seconds": 0,
               "rate_limit_per_hour": 9999, "circuit_breaker_threshold": 9999}
        for i in range(3):
            d = decide_storm_guard("tracker-debounce-zero", cfg)
            self.assertTrue(d.allowed, f"第 {i+1} 次：debounce=0 不应拒绝")

    # ── rate_limit（北极星 2 主路径）────────────────────────

    def test_rate_limit_blocks_above_threshold(self):
        """**北极星 2**：100 次连续事件 → ≤ 20 次允许（plan §Phase 7 验收 #3）。

        这是 Wave 7.3 业务目标的主测试——"100 封邮件批量进入时，事件 Tracker
        触发次数受 rate limit 控制"。
        """
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {
            "rate_limit_per_hour": 20,
            # 把 circuit 调高，避免抢先熔断（让我们能看到 rate 限流效果）
            "circuit_breaker_threshold": 9999,
        }

        allowed_count = 0
        denied_count = 0
        denied_reasons = set()
        for _ in range(100):
            d = decide_storm_guard("tracker-rate-limit", cfg)
            if d.allowed:
                allowed_count += 1
            else:
                denied_count += 1
                denied_reasons.add(d.reason.split("(")[0])

        # plan §Phase 7 验收 #3："100 封邮件批量进入时，触发次数受 rate limit 控制"
        self.assertLessEqual(
            allowed_count, 20,
            f"rate_limit_per_hour=20，允许触发数 {allowed_count} 应 ≤ 20",
        )
        self.assertEqual(
            allowed_count + denied_count, 100,
            "decision 应覆盖每一次调用（无抛异常）",
        )
        self.assertGreater(denied_count, 0, "100 次中必须有被拒")
        self.assertIn("rate_limit", denied_reasons)

    def test_rate_limit_default_is_20(self):
        """trigger_config 不显式配置时使用默认 20。"""
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {"circuit_breaker_threshold": 9999}
        allowed_count = sum(
            1 for _ in range(30)
            if decide_storm_guard("tracker-rate-default", cfg).allowed
        )
        self.assertLessEqual(allowed_count, 20)

    # ── circuit_breaker（北极星 2 第 2 部分：1 分钟内 100 次自动暂停）──

    def test_circuit_breaker_signals_should_trip_after_threshold(self):
        """**北极星 2 第 2 部分**：1 分钟内 ≥ 10 次触发 → should_trip_circuit=True。

        decide_storm_guard 是纯函数，不直接改 DB；返回的 should_trip_circuit
        让上层 apply_storm_guard 调用 _trip_circuit_breaker 完成 DB 副作用。
        Layer B 测 DB 副作用（status active → paused）。
        """
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {
            "circuit_breaker_threshold": 10,
            # 把 rate 调高让 circuit 抢先命中
            "rate_limit_per_hour": 9999,
        }

        tripped_at = None
        for i in range(15):
            d = decide_storm_guard("tracker-circuit-breaker", cfg)
            if d.should_trip_circuit:
                tripped_at = i + 1
                break

        self.assertIsNotNone(tripped_at, "10 次触发内必须命中熔断")
        self.assertLessEqual(tripped_at, 10, f"应在第 ≤10 次熔断，实际 {tripped_at}")

    def test_circuit_breaker_under_threshold_does_not_trip(self):
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {"circuit_breaker_threshold": 10, "rate_limit_per_hour": 9999}
        for i in range(9):  # 仅 9 次（< 10）
            d = decide_storm_guard("tracker-circuit-under", cfg)
            self.assertFalse(d.should_trip_circuit, f"第 {i+1} 次（< 10）不应熔断")
            self.assertTrue(d.allowed, f"第 {i+1} 次应允许")

    # ── first_trigger ────────────────────────────────────────

    def test_first_trigger_returns_true_only_once(self):
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {"rate_limit_per_hour": 9999, "circuit_breaker_threshold": 9999}
        d1 = decide_storm_guard("tracker-first-trigger", cfg)
        d2 = decide_storm_guard("tracker-first-trigger", cfg)
        d3 = decide_storm_guard("tracker-first-trigger", cfg)

        self.assertTrue(d1.allowed)
        self.assertTrue(d1.first_trigger, "首次触发应 first_trigger=True")
        self.assertFalse(d2.first_trigger, "第 2 次不应再标 first_trigger")
        self.assertFalse(d3.first_trigger)

    def test_first_trigger_recorded_even_when_circuit_trips(self):
        """**Wave 7 续作 P1-3 修复防线**：首次触发恰好命中熔断时，first_trigger
        仍必须为 True，让上层能 mark intent_snapshot.first_triggered_at。

        修复前 bug：first_trigger cache.add 在 circuit 检查之后，导致首次触发
        恰好是第 N 次连续触发（rate_limit_per_hour=9999 但
        circuit_breaker_threshold=1，即首次触发就熔断）时，circuit 抢先 return →
        first_trigger 永远不会被记录。

        修复：first_trigger cache.add 提前到所有 4 机制检查最前。
        """
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        # 极端配置：threshold=1，第 1 次触发就被 circuit 拦
        cfg = {
            "circuit_breaker_threshold": 1,
            "rate_limit_per_hour": 9999,
        }
        d = decide_storm_guard("tracker-first-and-circuit", cfg)

        # 关键断言：should_trip_circuit=True（熔断真发生）但 first_trigger=True
        # （首次触发标记真生效）— 二者不互斥
        self.assertTrue(
            d.should_trip_circuit,
            f"threshold=1 时第 1 次触发应当熔断，实际 reason={d.reason}",
        )
        self.assertTrue(
            d.first_trigger,
            "首次触发标记必须独立于 circuit 决策——即使 should_trip_circuit "
            "也要 first_trigger=True，让上层 mark intent_snapshot.first_triggered_at",
        )
        self.assertFalse(d.allowed, "熔断 → allowed=False（保留语义）")

    def test_first_trigger_recorded_even_when_rate_limit_blocks(self):
        """同 P1-3 修复防线：rate_limit 拦截时 first_trigger 仍必须为 True。

        构造方法：使用一个全新 tracker_id（cache 干净），rate_limit_per_hour=1。
        但用一个**已经预占用** rate cache 的 setup —— 我们手动 incr rate cache 让它
        立刻超阈值，但 first_trigger cache 仍空。这样 decide_storm_guard 第一次调
        会走"first_trigger 标记 (新)" + "rate 检查（已超）" 路径。
        """
        from apps.tracker.services.tracker_trigger_service import (
            decide_storm_guard, _storm_guard_keys,
        )

        tracker_id = "tracker-first-and-rate-locked"
        keys = _storm_guard_keys(tracker_id)

        # 预占 rate 计数器：手动设 99（远超 rate_limit_per_hour=1 阈值）
        cache.set(keys["rate"], 99, timeout=3600)

        cfg = {
            "rate_limit_per_hour": 1,
            "circuit_breaker_threshold": 9999,  # 大值避免抢先
        }
        d = decide_storm_guard(tracker_id, cfg)

        self.assertFalse(d.allowed,
                         f"rate cache 预占 99 + threshold=1 应被拦，实际 {d}")
        self.assertIn("rate_limit", d.reason)
        # 关键断言：first_trigger 标记必须独立于 rate 决策
        self.assertTrue(
            d.first_trigger,
            "rate_limit 拦截不应吞掉 first_trigger 标记 (P1-3 修复)",
        )

    def test_first_trigger_recorded_even_when_debounce_blocks(self):
        """同 P1-3 修复防线：debounce 拦截不能吞 first_trigger。

        难点：debounce 需要先有一次"占位"触发后，第 2 次才被拦——但这种情况下
        第 2 次本就不是 first_trigger（first_triggered cache 已被第 1 次 add）。
        所以本测试构造的语义是：第 2 次触发命中 debounce 拦截 + first_trigger=False
        （已记录），与原行为一致；不会出现"debounce 拦了 first_trigger 标记"。

        本测试落地的是反向防线：debounce 拦截行为对 first_trigger 决策无副作用。
        """
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {"debounce_seconds": 60, "rate_limit_per_hour": 9999,
               "circuit_breaker_threshold": 9999}
        d1 = decide_storm_guard("tracker-debounce-first", cfg)
        self.assertTrue(d1.allowed)
        self.assertTrue(d1.first_trigger, "第 1 次首次触发标记 True")

        d2 = decide_storm_guard("tracker-debounce-first", cfg)
        self.assertFalse(d2.allowed, "第 2 次被 debounce 拦")
        self.assertIn("debounce", d2.reason)
        self.assertFalse(
            d2.first_trigger,
            "第 2 次 first_trigger=False（已被首次 add 占用，不是 P1-3 修复关心的"
            "corner case，仅验证现状）",
        )

    # ── 多租户隔离（plan §Phase 7 验收 #6）──

    def test_two_trackers_have_independent_storm_state(self):
        """plan §Phase 7 验收 #6：不同 tracker_id 的 storm guard cache key 互不干扰。

        这是 charter §6.3 多租户隔离的核心防线——
        Organization A 的 Tracker 触发风暴不能影响 Organization B 的 Tracker。
        """
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {"circuit_breaker_threshold": 3, "rate_limit_per_hour": 9999}

        # Tracker A 连续触发到熔断
        for _ in range(5):
            decide_storm_guard("tracker-a-mt", cfg)
        # 这时 Tracker A 的 circuit 计数已超阈值

        # Tracker B 应不受影响——首次触发依然 allowed=True 且 first_trigger
        d_b = decide_storm_guard("tracker-b-mt", cfg)
        self.assertTrue(d_b.allowed, "Tracker B 不应被 A 的风暴影响（多租户隔离）")
        self.assertTrue(d_b.first_trigger, "Tracker B 仍是首次触发")
        self.assertFalse(d_b.should_trip_circuit, "Tracker B 不应熔断")

    # ── fail-open（charter §6.3 平台稳定性优先）──

    def test_resume_clears_storm_cache_purely(self):
        """**Wave 7 续作 P1-1 修复**：resume_tracker 必须清掉 4 个 storm cache key。

        本测试是纯函数 / cache 接口层测试——不真调 TrackerService.resume_tracker
        （需要真 ORM Tracker 对象），而是验证我们清理的是正确的 cache key 集合。
        Layer B（守 TABTIN_REAL_DB_TEST=1）有 ``test_resume_tracker_clears_storm_cache``
        真路径用例，调真 TrackerService.resume_tracker 验证端到端。

        本测试钉死：``_storm_guard_keys()`` 是 cache key 命名的单一来源，
        resume_tracker 必须遍历它的所有 value 调 cache.delete —— 任何 cache
        key 命名约定漂移会被本测试抓到。
        """
        from apps.tracker.services.tracker_trigger_service import (
            decide_storm_guard, _storm_guard_keys,
        )

        # 1) 先把 4 个 storm cache key 都激活（debounce 用 5s，rate/circuit incr，
        #    first_trigger add）
        cfg = {
            "debounce_seconds": 5,
            "rate_limit_per_hour": 20,
            "circuit_breaker_threshold": 10,
        }
        decide_storm_guard("tracker-resume-clear", cfg)

        keys = _storm_guard_keys("tracker-resume-clear")
        # 4 个 key 全部应有值
        for key_name, key in keys.items():
            self.assertIsNotNone(
                cache.get(key),
                f"{key_name} cache key 在 storm guard 后应有值",
            )

        # 2) 模拟 resume_tracker 的清理逻辑（TrackerService.resume_tracker 内部副本）
        for cache_key in keys.values():
            cache.delete(cache_key)

        # 3) 4 个 key 全部应被清空
        for key_name, key in keys.items():
            self.assertIsNone(
                cache.get(key),
                f"resume 后 {key_name} cache key 必须被清空（P1-1 修复）",
            )

        # 4) 清空后再次决策应该等同于"全新 Tracker 第一次触发"——first_trigger=True
        d_after_resume = decide_storm_guard("tracker-resume-clear", cfg)
        self.assertTrue(d_after_resume.allowed, "resume 后第一次触发必须被允许")
        self.assertTrue(
            d_after_resume.first_trigger,
            "resume 后 first_trigger 应回到 True（清理彻底了）",
        )

    def test_cache_exception_in_rate_limit_does_not_block(self):
        from apps.tracker.services.tracker_trigger_service import decide_storm_guard

        cfg = {"rate_limit_per_hour": 5}
        # mock cache.incr 一直抛——rate_limit 路径应静默 fail-open
        with patch(
            "apps.tracker.services.tracker_trigger_service.cache.incr",
            side_effect=Exception("redis down"),
        ):
            d = decide_storm_guard("tracker-fail-open", cfg)
            self.assertTrue(
                d.allowed,
                "cache 故障时 storm guard 应 fail-open（charter §6.3 平台稳定性优先）",
            )


# ─── Layer B：DB 副作用真路径测试（TABTIN_REAL_DB_TEST=1 守护）────


# 用 LocMem cache 替代任何 redis backend，避免污染真 redis 也避免
# storm guard 命中跨测试残留 key
@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "trigger-storm-real-orm-test",
    }
})
class _StormGuardRealOrmTestBase(TransactionTestCase):
    """共享 setUp / fixture / helpers，避免每个用例 N 行重复。"""
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 防止 tabtinspace 的 default organization 自动创建 signal 干扰测试隔离
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        from django.contrib.auth import get_user_model
        post_save.disconnect(create_default_organization, sender=get_user_model())

    @classmethod
    def tearDownClass(cls):
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        from django.contrib.auth import get_user_model
        post_save.connect(create_default_organization, sender=get_user_model())
        super().tearDownClass()

    def setUp(self):
        from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
        ctx = create_test_organization_with_agent(prefix="storm")
        self.user = ctx["user"]
        self.organization = ctx["organization"]
        self.agent = ctx["agent"]
        self.space = ctx["space"]
        cache.clear()

    def tearDown(self):
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization
        cache.clear()
        cleanup_test_organization(self.organization, delete_user=True)

    def _create_tracker(
        self,
        *,
        name="storm-test-tracker",
        trigger_type="table_event",
        trigger_config: dict | None = None,
        intent_snapshot: dict | None = None,
        status="active",
    ):
        from apps.tracker.models import Tracker
        return Tracker.objects.create(
            id=uuid.uuid4(),
            organization_id=self.organization.id,
            space_id=self.space.id if self.space else None,
            agent_id=self.agent.id,
            name=name,
            description="",
            skill_key="test_skill",
            trigger_type=trigger_type,
            trigger_config=trigger_config or {},
            intent_snapshot=intent_snapshot,
            status=status,
            created_by_id=self.user.id,
        )


if _REQUIRES_REAL_DB:

    class CircuitBreakerDbSideEffectTest(_StormGuardRealOrmTestBase):
        """plan §Phase 7 验收 #4：熔断后 Tracker.status active → paused 的 DB 副作用。"""

        def test_trip_circuit_breaker_pauses_tracker_in_db(self):
            from apps.tracker.models import Tracker
            from apps.tracker.services.tracker_trigger_service import _trip_circuit_breaker

            tracker = self._create_tracker(
                trigger_config={"circuit_breaker_threshold": 10},
            )
            self.assertEqual(tracker.status, "active")

            broken = _trip_circuit_breaker(
                tracker,
                threshold=10,
                window_seconds=60,
                event_label="测试事件",
                space_id=str(self.space.id),
            )
            self.assertTrue(broken)

            fresh = Tracker.objects.get(id=tracker.id)
            self.assertEqual(
                fresh.status, "paused",
                "circuit_breaker 必须把 Tracker.status 转 paused（plan §Phase 7 验收 #4）",
            )
            self.assertIsNotNone(fresh.intent_snapshot)
            self.assertIn("last_pause_reason", fresh.intent_snapshot)
            self.assertIn("熔断", fresh.intent_snapshot["last_pause_reason"])
            self.assertIn("last_pause_at", fresh.intent_snapshot)

    class FirstTriggerDbSideEffectTest(_StormGuardRealOrmTestBase):
        """plan §Phase 7 第 634 行：首次触发后 mark intent_snapshot。"""

        def test_mark_first_triggered_writes_intent_snapshot(self):
            from apps.tracker.models import Tracker
            from apps.tracker.services.tracker_trigger_service import _mark_first_triggered

            tracker = self._create_tracker()
            _mark_first_triggered(tracker)

            fresh = Tracker.objects.get(id=tracker.id)
            self.assertIsNotNone(fresh.intent_snapshot)
            self.assertIn("first_triggered_at", fresh.intent_snapshot)
            self.assertIn("T", fresh.intent_snapshot["first_triggered_at"])


    class ResumeTrackerClearsStormCacheTest(_StormGuardRealOrmTestBase):
        """**Wave 7 续作 P1-1 真路径**：TrackerService.resume_tracker 后 storm cache
        全 4 key 真被清。

        语义：用户被熔断 → resume → 60s 内立刻不应再被同样的 circuit 计数
        反复熔断（避免 P1-1 描述的"恶性循环"）。
        """

        def test_resume_tracker_clears_storm_cache(self):
            from apps.tracker.models import Tracker
            from apps.tracker.services.tracker_service import TrackerService
            from apps.tracker.services.tracker_trigger_service import (
                _storm_guard_keys, decide_storm_guard,
            )

            tracker = self._create_tracker(
                trigger_config={"circuit_breaker_threshold": 3, "rate_limit_per_hour": 9999},
                status="paused",  # 被熔断后 resume 前
            )

            # 1) 模拟熔断后的 cache 现场：连续触发 5 次让 circuit / rate /
            #    first_trigger 三个 key 都激活
            for _ in range(5):
                decide_storm_guard(str(tracker.id), tracker.trigger_config)

            keys = _storm_guard_keys(str(tracker.id))
            # circuit / rate / first_trigger 三个必有值
            self.assertIsNotNone(cache.get(keys["circuit"]),
                                 "熔断后 circuit cache 应有计数")
            self.assertIsNotNone(cache.get(keys["rate"]),
                                 "rate cache 应有计数")
            self.assertIsNotNone(cache.get(keys["first_trigger"]),
                                 "first_trigger cache 应有标记")

            # 2) 调用 resume_tracker —— 真路径
            svc = TrackerService(user=self.user)
            svc.resume_tracker(str(tracker.id), user=self.user)

            # 3) 验证 4 个 cache key 全部被清
            for key_name, key in keys.items():
                self.assertIsNone(
                    cache.get(key),
                    f"resume_tracker 后 {key_name} cache key 必须被清空 (P1-1 修复)",
                )

            # 4) Tracker status 已 active
            fresh = Tracker.objects.get(id=tracker.id)
            self.assertEqual(fresh.status, "active",
                             "resume_tracker 应把 status 转为 active")


    class ApplyStormGuardEndToEndTest(_StormGuardRealOrmTestBase):
        """``apply_storm_guard`` 端到端真路径——decide + DB 副作用一起测。

        这是 Wave 7.3 北极星 2 的**真路径加强**：1 分钟 100 次事件 → 既有 rate
        限流又最终熔断 + Tracker.status 真转 paused。
        """

        def test_apply_storm_guard_real_path_circuit_breaker_pauses_tracker(self):
            from apps.tracker.models import Tracker
            from apps.tracker.services.tracker_trigger_service import apply_storm_guard

            tracker = self._create_tracker(
                trigger_config={"circuit_breaker_threshold": 5, "rate_limit_per_hour": 9999},
            )

            for _ in range(8):
                apply_storm_guard(tracker)

            fresh = Tracker.objects.get(id=tracker.id)
            self.assertEqual(fresh.status, "paused")
            self.assertIn("熔断", fresh.intent_snapshot.get("last_pause_reason", ""))

        def test_apply_storm_guard_marks_first_triggered_even_when_circuit_trips(self):
            """**Wave 7 续作 P1-3 修复防线 (apply_storm_guard 端)**：
            首次触发恰好命中熔断时，``_mark_first_triggered`` 必须仍被调用，
            intent_snapshot.first_triggered_at 真写入 DB。

            修复前 bug：``apply_storm_guard`` 在 should_trip_circuit=True 时早 return，
            跳过 _mark_first_triggered，导致 first_triggered_at 永远空。
            """
            from apps.tracker.models import Tracker
            from apps.tracker.services.tracker_trigger_service import apply_storm_guard

            tracker = self._create_tracker(
                # threshold=1：第 1 次就熔断（极端 corner case）
                trigger_config={"circuit_breaker_threshold": 1, "rate_limit_per_hour": 9999},
            )

            decision = apply_storm_guard(tracker)

            # 关键断言：should_trip_circuit AND first_trigger 都为 True
            self.assertTrue(decision.should_trip_circuit, "threshold=1 第 1 次必熔断")
            self.assertTrue(decision.first_trigger, "首次触发标记必须为 True")

            # 关键 DB 断言：intent_snapshot 必须同时含 first_triggered_at 和
            # last_pause_reason —— 即"首次触发就被熔断"的真实数据状态
            fresh = Tracker.objects.get(id=tracker.id)
            self.assertIsNotNone(fresh.intent_snapshot)
            self.assertIn(
                "first_triggered_at", fresh.intent_snapshot,
                "**P1-3 修复关键防线**：首次触发恰好熔断时，first_triggered_at "
                "必须仍被记录到 intent_snapshot",
            )
            self.assertIn("last_pause_reason", fresh.intent_snapshot)
            self.assertEqual(fresh.status, "paused")

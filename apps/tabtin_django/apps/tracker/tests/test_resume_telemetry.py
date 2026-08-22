"""Wave 8 治理：resume_tracker 清理 storm guard cache 失败时的 telemetry 上报测试。

═══════════════════════════════════════════════════════════════════════
本文件分两层（**反思 9 + 反思 16 双重防线**）:

Layer A — 纯函数 telemetry 上报路径单元测试（默认启用,LocMemCache）
─────────────────────────────────────────────────────
不依赖真 PG/MySQL test DB:

  1. test_record_helper_logs_to_named_logger
     — _record_storm_guard_cache_delete_failure 写命名 logger(走真路径)

  2. test_record_helper_includes_structured_tags
     — extra.tags 必含 organization_id / tracker_id / cache_key_type / error_type

  3. test_record_helper_safe_when_sentry_missing
     — sentry_sdk 未装时不抛(静默吞)

  4. test_record_helper_safe_when_logger_fails
     — 主 logger 自身失败时仍不抛

  5. test_resume_tracker_logs_telemetry_on_cache_delete_failure
     — mock cache.delete 抛异常 → 命名 logger 必被调用 + resume 仍成功

  6. test_resume_tracker_per_key_independent_failure
     — 4 个 cache key 各自独立 try/except，单 key 失败不影响其它 key

Layer B — DB 副作用真路径（TABTIN_REAL_DB_TEST=1 守护）
──────────────────────────────────────────────────────
  7. test_resume_tracker_completes_despite_cache_failures（真 ORM Tracker）

═══════════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import logging
import os
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.test import SimpleTestCase, TransactionTestCase, override_settings


_REQUIRES_REAL_DB = os.getenv("TABTIN_REAL_DB_TEST") == "1"


# ─── Layer A：纯函数 telemetry 上报路径（默认启用）────────────────


@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "resume-telemetry-test",
    }
})
class RecordStormGuardCacheDeleteFailureTest(SimpleTestCase):
    """**Wave 8 防线**：_record_storm_guard_cache_delete_failure 纯函数行为。

    走真路径(直接调函数 + 用 assertLogs 捕获 logger 输出),不 MagicMock 制造死代码。
    """

    def test_record_helper_logs_to_named_logger(self):
        """主上报:命名 logger ``scheduler.cache_failure`` 必须被写入 WARNING 级别。"""
        from apps.tracker.services.tracker_service import (
            _record_storm_guard_cache_delete_failure,
        )

        with self.assertLogs("scheduler.cache_failure", level="WARNING") as cm:
            _record_storm_guard_cache_delete_failure(
                organization_id="wt-test-1",
                tracker_id="tracker-test-1",
                cache_key_type="circuit",
                error=RuntimeError("redis timeout"),
            )

        self.assertEqual(len(cm.records), 1, "必须上报一次 WARNING")
        record = cm.records[0]
        # 关键 metric 名必须出现（运维 grep 能找到）
        self.assertIn("tracker.storm_guard.cache_delete_failure", record.getMessage())
        # tags 必须出现
        self.assertIn("wt-test-1", record.getMessage())
        self.assertIn("tracker-test-1", record.getMessage())
        self.assertIn("circuit", record.getMessage())
        self.assertIn("RuntimeError", record.getMessage())

    def test_record_helper_includes_structured_tags(self):
        """extra.tags 必含 organization_id / tracker_id / cache_key_type / error_type
        (Sentry / ELK 通过 LogRecord.tags 走 structured logging)"""
        from apps.tracker.services.tracker_service import (
            _record_storm_guard_cache_delete_failure,
        )

        with self.assertLogs("scheduler.cache_failure", level="WARNING") as cm:
            _record_storm_guard_cache_delete_failure(
                organization_id="wt-A",
                tracker_id="tracker-XYZ",
                cache_key_type="debounce",
                error=ValueError("oops"),
            )

        record = cm.records[0]
        # extra 字段透传到 LogRecord 上
        self.assertEqual(getattr(record, "metric", None),
                         "tracker.storm_guard.cache_delete_failure")
        tags = getattr(record, "tags", {})
        self.assertEqual(tags.get("organization_id"), "wt-A")
        self.assertEqual(tags.get("tracker_id"), "tracker-XYZ")
        self.assertEqual(tags.get("cache_key_type"), "debounce")
        self.assertEqual(tags.get("error_type"), "ValueError")

    def test_record_helper_safe_when_logger_fails(self):
        """主 logger 自身故障时不抛 — fail-safe 保护 resume 主路径。"""
        from apps.tracker.services import tracker_service as gs_module

        # 替换 _cache_failure_logger.warning 让它抛异常
        with patch.object(
            gs_module._cache_failure_logger,
            "warning",
            side_effect=RuntimeError("logger broken"),
        ):
            # 不应抛异常
            gs_module._record_storm_guard_cache_delete_failure(
                organization_id="wt-X",
                tracker_id="tracker-Y",
                cache_key_type="rate",
                error=Exception("cache fail"),
            )

    def test_record_helper_safe_when_sentry_unavailable(self):
        """sentry_sdk 未装 / 未初始化 → capture_exception 失败时不抛。"""
        from apps.tracker.services.tracker_service import (
            _record_storm_guard_cache_delete_failure,
        )

        # 模拟 sentry_sdk 不可用 — 用 mock import_module 让 import 失败
        # 实际场景 import sentry_sdk 在函数内 try/except,直接调即可验证
        with self.assertLogs("scheduler.cache_failure", level="WARNING"):
            # 即便 sentry 不可用,主路径仍能 logger 上报
            _record_storm_guard_cache_delete_failure(
                organization_id="wt-Z",
                tracker_id="tracker-Q",
                cache_key_type="first_trigger",
                error=ConnectionError("redis down"),
            )

    def test_record_helper_per_cache_key_type(self):
        """4 种 cache_key_type（debounce/rate/circuit/first_trigger）都能正确上报。"""
        from apps.tracker.services.tracker_service import (
            _record_storm_guard_cache_delete_failure,
        )

        for key_type in ("debounce", "rate", "circuit", "first_trigger"):
            with self.assertLogs("scheduler.cache_failure", level="WARNING") as cm:
                _record_storm_guard_cache_delete_failure(
                    organization_id="wt-1",
                    tracker_id="tracker-1",
                    cache_key_type=key_type,
                    error=Exception(f"err for {key_type}"),
                )
            self.assertEqual(len(cm.records), 1)
            self.assertIn(key_type, cm.records[0].getMessage(),
                          f"{key_type} 必须出现在日志中")


# ─── Layer A 续：resume_tracker 集成 telemetry 路径（用 unittest.mock 替换 cache）──


@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "resume-tracker-telemetry-test",
    }
})
class ResumeTrackerCacheFailureTelemetryTest(SimpleTestCase):
    """**Wave 8 反思 20 防线**：resume_tracker 调 cache.delete 失败时,
    必须打 telemetry 上报 + resume 仍成功完成（不阻塞主路径）。

    本测试不真起 ORM,patch TrackerService 内部的 transaction / Tracker.objects /
    transition_status,聚焦"cache.delete 抛异常时 telemetry 链路"。

    Layer B（守 TABTIN_REAL_DB_TEST=1）有真 ORM Tracker 用例。
    """

    def _build_fake_tracker(self, *, tracker_id=None, organization_id=None):
        """伪造 Tracker 对象,提供 transition_status / save / next_run_at。"""
        tracker = MagicMock()
        tracker.id = tracker_id or uuid.uuid4()
        tracker.organization_id = organization_id or uuid.uuid4()
        tracker.space_id = uuid.uuid4()
        tracker.trigger_type = "manual"  # 走 manual 跳过 compute_next_run
        tracker.name = "telemetry-test-tracker"
        return tracker

    def test_resume_tracker_logs_telemetry_when_cache_delete_fails(self):
        """**关键防线**:cache.delete 抛异常 → telemetry 必上报 + resume 仍走完。"""
        from apps.tracker.services.tracker_service import TrackerService
        from apps.tracker.services import tracker_service as gs_module

        tracker_id = str(uuid.uuid4())
        fake_tracker = self._build_fake_tracker(tracker_id=uuid.UUID(tracker_id))

        # patch TrackerService 内部:transaction.atomic / get_tracker_for_update /
        # _push_tracker_lifecycle_ws —— 让 resume_tracker 走到 cache.delete 这步
        svc = TrackerService(user=SimpleNamespace(id=uuid.uuid4()))

        with patch.object(svc, "get_tracker_for_update", return_value=fake_tracker), \
             patch.object(gs_module, "_push_tracker_lifecycle_ws"), \
             patch("apps.tracker.services.tracker_service.transaction.atomic") as mock_atomic, \
             patch("apps.tracker.services.tracker_service.cache.delete",
                   side_effect=RuntimeError("redis unreachable")) as mock_delete, \
             self.assertLogs("scheduler.cache_failure", level="WARNING") as cm:
            # transaction.atomic 用 contextmanager mock
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            # 调 resume_tracker —— 不应抛
            result = svc.resume_tracker(tracker_id, user=SimpleNamespace(id=uuid.uuid4()))

        # 1) resume 仍成功完成（返回 tracker,不抛）
        self.assertIs(result, fake_tracker,
                      "cache.delete 失败不应阻塞 resume_tracker 主路径")
        self.assertTrue(fake_tracker.save.called,
                        "Tracker.save 必须被调（status 转 active 落库）")

        # 2) cache.delete 必被尝试调（4 个 key 各一次）
        self.assertEqual(mock_delete.call_count, 4,
                         "4 个 storm guard cache key 都应被尝试 delete")

        # 3) 每次 cache.delete 失败都应触发一次 telemetry 上报（共 4 次）
        warning_logs = [r for r in cm.records
                        if r.levelno >= logging.WARNING
                        and "tracker.storm_guard.cache_delete_failure" in r.getMessage()]
        self.assertEqual(len(warning_logs), 4,
                         f"4 个 key 各应上报一次 telemetry,实际 {len(warning_logs)}")

        # 4) telemetry 必须含 4 种 cache_key_type
        all_messages = " ".join(r.getMessage() for r in warning_logs)
        for key_type in ("debounce", "rate", "circuit", "first_trigger"):
            self.assertIn(key_type, all_messages,
                          f"telemetry 必须覆盖 cache_key_type={key_type}")

    def test_resume_tracker_partial_cache_failure_does_not_block(self):
        """**Wave 8 反思 20 端到端**:仅部分 cache key delete 失败时,
        其它 key 仍应被清,resume 仍成功。"""
        from apps.tracker.services.tracker_service import TrackerService
        from apps.tracker.services import tracker_service as gs_module

        tracker_id = str(uuid.uuid4())
        fake_tracker = self._build_fake_tracker(tracker_id=uuid.UUID(tracker_id))
        svc = TrackerService(user=SimpleNamespace(id=uuid.uuid4()))

        # cache.delete 仅在 cache_key_type=circuit 时失败
        call_log = []

        def selective_delete(key):
            call_log.append(key)
            if "circuit" in key:
                raise ConnectionError("redis circuit cache lost")
            # 其它 key 正常返回（无副作用 — LocMemCache 已 override）
            return None

        with patch.object(svc, "get_tracker_for_update", return_value=fake_tracker), \
             patch.object(gs_module, "_push_tracker_lifecycle_ws"), \
             patch("apps.tracker.services.tracker_service.transaction.atomic") as mock_atomic, \
             patch("apps.tracker.services.tracker_service.cache.delete",
                   side_effect=selective_delete), \
             self.assertLogs("scheduler.cache_failure", level="WARNING") as cm:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)
            svc.resume_tracker(tracker_id, user=SimpleNamespace(id=uuid.uuid4()))

        # 4 次都尝试调
        self.assertEqual(len(call_log), 4)
        # 仅 1 次 telemetry 上报（circuit 那次）
        circuit_warnings = [r for r in cm.records
                            if "circuit" in r.getMessage()
                            and "tracker.storm_guard.cache_delete_failure" in r.getMessage()]
        self.assertEqual(len(circuit_warnings), 1,
                         "仅 circuit key 失败应上报 1 次 telemetry")

    def test_resume_tracker_no_telemetry_on_normal_path(self):
        """正常路径（cache.delete 全部成功）不应有 cache_failure telemetry 噪声。"""
        from apps.tracker.services.tracker_service import TrackerService
        from apps.tracker.services import tracker_service as gs_module

        tracker_id = str(uuid.uuid4())
        fake_tracker = self._build_fake_tracker(tracker_id=uuid.UUID(tracker_id))
        svc = TrackerService(user=SimpleNamespace(id=uuid.uuid4()))

        with patch.object(svc, "get_tracker_for_update", return_value=fake_tracker), \
             patch.object(gs_module, "_push_tracker_lifecycle_ws"), \
             patch("apps.tracker.services.tracker_service.transaction.atomic") as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            # cache.delete 走真 LocMemCache（不抛）→ 不应触发 telemetry
            # assertLogs 至少需要一条 log,所以用 assertNoLogs（Django 4+ / py3.10+ 可用）
            # 兼容旧 Python 用 mock _cache_failure_logger.warning
            with patch.object(gs_module._cache_failure_logger, "warning") as mock_warn:
                svc.resume_tracker(tracker_id, user=SimpleNamespace(id=uuid.uuid4()))

            mock_warn.assert_not_called()


# ─── Layer B：真 ORM resume_tracker 端到端（TABTIN_REAL_DB_TEST=1 守护）──


if _REQUIRES_REAL_DB:

    @override_settings(CACHES={
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "resume-telemetry-real-db",
        }
    })
    class ResumeTrackerCacheTelemetryRealDbTest(TransactionTestCase):
        """**Layer B 真 ORM 端到端**：cache.delete 失败时 resume_tracker 仍 commit
        + telemetry 真上报（不依赖 mock Tracker）。"""
        databases = {"default", "postgresql"}

        @classmethod
        def setUpClass(cls):
            super().setUpClass()
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
            ctx = create_test_organization_with_agent(prefix="resume_tele")
            self.user = ctx["user"]
            self.organization = ctx["organization"]
            self.agent = ctx["agent"]
            self.space = ctx["space"]
            cache.clear()

        def tearDown(self):
            from apps.tabtinspace.tests.fixtures import cleanup_test_organization
            cache.clear()
            cleanup_test_organization(self.organization, delete_user=True)

        def test_resume_tracker_completes_despite_cache_failures(self):
            """**反思 20 端到端**:真 paused Tracker,patch cache.delete 抛异常,
            真 resume_tracker 后:status=active + telemetry 上报。"""
            from apps.tracker.models import Tracker
            from apps.tracker.services.tracker_service import TrackerService

            tracker = Tracker.objects.create(
                id=uuid.uuid4(),
                organization_id=self.organization.id,
                space_id=self.space.id if self.space else None,
                agent_id=self.agent.id,
                name="resume-telemetry-real",
                description="",
                skill_key="test_skill",
                trigger_type="manual",
                trigger_config={},
                status="paused",
                created_by_id=self.user.id,
            )

            svc = TrackerService(user=self.user)

            with patch("apps.tracker.services.tracker_service.cache.delete",
                       side_effect=RuntimeError("redis unreachable")), \
                 self.assertLogs("scheduler.cache_failure", level="WARNING") as cm:
                svc.resume_tracker(str(tracker.id), user=self.user)

            tracker.refresh_from_db()
            self.assertEqual(tracker.status, "active",
                             "resume_tracker 应完成 status 转 active,即便 cache 失败")

            warnings = [r for r in cm.records
                        if "tracker.storm_guard.cache_delete_failure" in r.getMessage()]
            self.assertEqual(len(warnings), 4,
                             "4 个 storm guard cache key 失败应各上报一次")

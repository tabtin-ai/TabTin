"""Tracker WS wire format 契约测试（Module D 新增）。

== 设计动机 ==

Stage 2 + Module C 一刀切改了大量 WS wire format：

- payload 字段 ``goal_id`` → ``tracker_id``（5 处生产点）
- event type ``goal.*`` → ``tracker.*``
- WS topic 单挂 ``tracker.events.{organization_id}``（删 legacy goal.events/agenda.events）
- trigger_context ``source: "goal_completed"`` → ``"tracker_completed"``
- trigger_context ``completed_goal_id`` → ``completed_tracker_id``

但**没有显式契约测试钉死这些字段名 / type 字面量** —— 如果将来谁手抖把
``payload["tracker_id"]`` 改回 ``payload["goal_id"]``，单测全过、grep 全过，
但前端 / iOS / Android 都收不到字段。这是 review v1 揪过的同型故障类（P0-1
WS infra 漏改）。

本测试用 mock ``publish_ws_event`` 捕获 envelope，验证：

1. **payload 字段名**（钉死 ``tracker_id`` / ``run_id`` / ``space_id`` 等）
2. **event type 字面量**（钉死 ``tracker.progress`` / ``tracker.run.completed`` 等）
3. **WS topic**（钉死 ``tracker.events.{organization_id}``）

任一处漂移 → 本测试 fail。
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _make_tracker(organization_id: str = "wt-1", space_id: str = "sp-1") -> MagicMock:
    """模拟一条 Tracker 实例。"""
    tracker = MagicMock()
    tracker.id = uuid.uuid4()
    tracker.organization_id = organization_id
    tracker.space_id = space_id
    tracker.skill_key = "test.skill"
    return tracker


def _make_tracker_run(organization_id: str = "wt-1", space_id: str = "sp-1") -> MagicMock:
    """模拟一条 TrackerRun 实例。"""
    tracker = _make_tracker(organization_id, space_id)
    gr = MagicMock()
    gr.id = uuid.uuid4()
    gr.tracker_id = tracker.id
    gr.tracker = tracker
    gr.status = "running"
    gr.progress = 50
    gr.progress_message = "running step 1"
    gr.duration = None
    gr.error_summary = ""
    gr.context = {}
    return gr


class TrackerWSPayloadFieldNameContractTest(SimpleTestCase):
    """钉死 5 个 notify_* 函数的 envelope payload 字段名。

    Stage 2 把 ``goal_id`` 一刀切到 ``tracker_id``，本测试确保后续不会漂移回去。
    """

    def setUp(self):
        self.captured: list[tuple[str, dict]] = []  # (topic, envelope)

        def _capture(topic, envelope):
            self.captured.append((topic, envelope))
            return True

        self.publish_patcher = patch(
            "apps.tracker.services.tracker_notification.publish_ws_event",
            side_effect=_capture,
        )
        self.publish_patcher.start()

    def tearDown(self):
        self.publish_patcher.stop()

    def _capture_payload(self) -> dict:
        """从 mock 捕获的 envelope 中提取 payload dict（build_envelope 结构稳定）。"""
        self.assertEqual(len(self.captured), 1, "notify_* 必须正好推送 1 次")
        _, envelope = self.captured[0]
        # build_envelope 标准结构：{ "type": ..., "request_id": ..., "payload": {...} }
        self.assertIn("payload", envelope)
        return envelope["payload"]

    def _make_service(self) -> object:
        from apps.tracker.services.tracker_notification import TrackerNotificationService

        gr = _make_tracker_run(organization_id="wt-test", space_id="sp-test")
        return TrackerNotificationService(gr)

    def test_notify_progress_payload_uses_tracker_id(self):
        svc = self._make_service()
        svc.notify_progress()
        payload = self._capture_payload()
        self.assertIn("tracker_id", payload, "notify_progress 必须用 tracker_id")
        self.assertNotIn("goal_id", payload, "notify_progress 不应残留 goal_id")
        self.assertIn("run_id", payload)
        self.assertIn("status", payload)
        self.assertIn("progress", payload)
        self.assertIn("space_id", payload)

    def test_notify_run_completed_payload_uses_tracker_id(self):
        svc = self._make_service()
        svc.notify_run_completed()
        payload = self._capture_payload()
        self.assertIn("tracker_id", payload)
        self.assertNotIn("goal_id", payload)
        self.assertIn("run_id", payload)
        self.assertIn("status", payload)
        self.assertIn("duration", payload)
        self.assertIn("skill_key", payload)
        self.assertIn("artifact_ref", payload)

    def test_notify_run_failed_payload_uses_tracker_id(self):
        svc = self._make_service()
        svc.notify_run_failed()
        payload = self._capture_payload()
        self.assertIn("tracker_id", payload)
        self.assertNotIn("goal_id", payload)
        self.assertIn("run_id", payload)
        self.assertIn("error_summary", payload)
        self.assertIn("recovery_actions", payload)
        self.assertIn("skill_key", payload)

    def test_notify_run_cancelled_payload_distinct_from_failed(self):
        """Module F 修补：cancel_run 走独立 event，与 RUN_FAILED 区分语义。

        - 不含 error_summary（用户主动取消，无错误可言）
        - 不含 recovery_actions（用户已知情，无需恢复建议）
        """
        svc = self._make_service()
        svc.notify_run_cancelled()
        payload = self._capture_payload()
        self.assertIn("tracker_id", payload)
        self.assertIn("run_id", payload)
        self.assertIn("status", payload)
        self.assertIn("duration", payload)
        self.assertNotIn("error_summary", payload,
                         "cancelled 不应携带 error_summary（与 RUN_FAILED 区分）")
        self.assertNotIn("recovery_actions", payload,
                         "cancelled 不应携带 recovery_actions（用户已知情）")

    def test_notify_health_alert_payload_uses_tracker_id(self):
        svc = self._make_service()
        tracker = _make_tracker(organization_id="wt-test", space_id="sp-test")
        svc.notify_health_alert(tracker, alert_type="stuck", details={"hours": 24})
        payload = self._capture_payload()
        self.assertIn("tracker_id", payload, "notify_health_alert 必须用 tracker_id")
        self.assertNotIn("goal_id", payload)
        self.assertIn("alert_type", payload)

    def test_notify_trigger_filtered_payload_uses_tracker_id(self):
        from apps.tracker.services.tracker_notification import notify_trigger_filtered

        notify_trigger_filtered(
            organization_id="wt-test",
            tracker_id="tracker-x",
            event_type="record_created",
            reason="conditions_not_met",
        )
        payload = self._capture_payload()
        self.assertIn("tracker_id", payload)
        self.assertNotIn("goal_id", payload)
        self.assertEqual(payload["tracker_id"], "tracker-x")


class TrackerWSEventTypeContractTest(SimpleTestCase):
    """钉死 envelope event type 字面量。

    Stage 2 决策 1：``goal.*`` → ``tracker.*`` 一刀切。
    """

    def setUp(self):
        self.captured: list[dict] = []

        def _capture(topic, envelope):
            self.captured.append(envelope)
            return True

        self.publish_patcher = patch(
            "apps.tracker.services.tracker_notification.publish_ws_event",
            side_effect=_capture,
        )
        self.publish_patcher.start()

    def tearDown(self):
        self.publish_patcher.stop()

    def _capture_type(self) -> str:
        self.assertEqual(len(self.captured), 1)
        env = self.captured[0]
        self.assertIn("type", env)
        return env["type"]

    def _make_service(self):
        from apps.tracker.services.tracker_notification import TrackerNotificationService

        gr = _make_tracker_run(organization_id="wt-test", space_id="sp-test")
        return TrackerNotificationService(gr)

    def test_progress_event_type_is_tracker_progress(self):
        svc = self._make_service()
        svc.notify_progress()
        self.assertEqual(self._capture_type(), "tracker.progress")

    def test_run_completed_event_type_is_tracker_run_completed(self):
        svc = self._make_service()
        svc.notify_run_completed()
        self.assertEqual(self._capture_type(), "tracker.run.completed")

    def test_run_failed_event_type_is_tracker_run_failed(self):
        svc = self._make_service()
        svc.notify_run_failed()
        self.assertEqual(self._capture_type(), "tracker.run.failed")

    def test_run_cancelled_event_type_is_tracker_run_cancelled(self):
        """Module F 续作：用户主动取消用独立 event type，钉死字面量。

        如果未来谁手抖把 notify_run_cancelled 改回 notify_run_failed →
        本测试 fail，避免 wire 语义错位再次复发。
        """
        svc = self._make_service()
        svc.notify_run_cancelled()
        self.assertEqual(self._capture_type(), "tracker.run.cancelled")

    def test_health_alert_event_type_is_tracker_health_alert(self):
        svc = self._make_service()
        tracker = _make_tracker(organization_id="wt-test", space_id="sp-test")
        svc.notify_health_alert(tracker, alert_type="stuck", details={})
        self.assertEqual(self._capture_type(), "tracker.health_alert")

    def test_trigger_filtered_event_type_is_tracker_trigger_filtered(self):
        from apps.tracker.services.tracker_notification import notify_trigger_filtered

        notify_trigger_filtered(
            organization_id="wt-test",
            tracker_id="tracker-x",
            event_type="record_created",
        )
        self.assertEqual(self._capture_type(), "tracker.trigger.filtered")


class TrackerWSTopicContractTest(SimpleTestCase):
    """钉死 WS topic 是 ``tracker.events.{space_id}``（Module F 决策 3）。

    修复前 topic 是 organization_id，会让同 organization 不同 Space 成员互相收到对方
    Tracker 的 progress_message / error_summary（潜在敏感字段），违反 Space
    默认私有原则。修复后改成 Space 级 topic，订阅端按 SpaceMembership 校验。

    任何手抖把 publish 路径改回 organization_id → 本测试 fail。
    """

    def setUp(self):
        self.captured_topics: list[str] = []

        def _capture(topic, envelope):
            self.captured_topics.append(topic)
            return True

        self.publish_patcher = patch(
            "apps.tracker.services.tracker_notification.publish_ws_event",
            side_effect=_capture,
        )
        self.publish_patcher.start()

    def tearDown(self):
        self.publish_patcher.stop()

    def test_notify_progress_publishes_space_scoped_topic(self):
        from apps.tracker.services.tracker_notification import TrackerNotificationService

        gr = _make_tracker_run(organization_id="wt-abc", space_id="sp-1")
        svc = TrackerNotificationService(gr)
        svc.notify_progress()

        self.assertEqual(
            self.captured_topics,
            ["tracker.events.sp-1"],
            "notify_progress 必须按 space_id 分发，不能用 organization_id"
            "（修复前 bug：跨 Space 数据会泄漏给同 organization 其他成员）",
        )

    def test_notify_run_completed_publishes_space_scoped_topic(self):
        from apps.tracker.services.tracker_notification import TrackerNotificationService

        gr = _make_tracker_run(organization_id="wt-xyz", space_id="sp-completed")
        svc = TrackerNotificationService(gr)
        svc.notify_run_completed()

        self.assertEqual(
            self.captured_topics,
            ["tracker.events.sp-completed"],
        )

    def test_notify_run_cancelled_publishes_space_scoped_topic(self):
        """Module F 决策 3 + RUN_CANCELLED 联合校验。"""
        from apps.tracker.services.tracker_notification import TrackerNotificationService

        gr = _make_tracker_run(organization_id="wt-1", space_id="sp-cancel")
        svc = TrackerNotificationService(gr)
        svc.notify_run_cancelled()

        self.assertEqual(self.captured_topics, ["tracker.events.sp-cancel"])

    def test_notify_trigger_filtered_publishes_space_scoped_topic(self):
        from apps.tracker.services.tracker_notification import notify_trigger_filtered

        notify_trigger_filtered(
            organization_id="wt-trigger",
            tracker_id="tracker-x",
            event_type="record_created",
            space_id="sp-filter",
        )

        self.assertEqual(
            self.captured_topics,
            ["tracker.events.sp-filter"],
            "notify_trigger_filtered 必须按 space_id 分发",
        )

    def test_notify_trigger_filtered_falls_back_to_organization_when_space_id_missing(self):
        """Module F 决策 3 兜底：缺 space_id 时回退到 organization topic（不丢消息，但告警）。

        正常路径下所有 caller 都应传 space_id；此兜底防止 wire 静默丢失，
        如果未来发现告警频繁出现，应去查上游 caller 漏传 space_id 的位置。
        """
        from apps.tracker.services.tracker_notification import notify_trigger_filtered

        notify_trigger_filtered(
            organization_id="wt-fallback",
            tracker_id="tracker-x",
            event_type="record_created",
            space_id=None,
        )

        self.assertEqual(self.captured_topics, ["tracker.events.wt-fallback"])


class TrackerTriggerContextWireFormatContractTest(SimpleTestCase):
    """钉死 cascade trigger 写入 ``TrackerRun.trigger_context`` 的字段名 / source 值。

    Module C 决策：``source='goal_completed'`` → ``'tracker_completed'``，
    ``completed_goal_id`` → ``completed_tracker_id``。Module D migration 0031
    迁了存量数据；本测试钉死代码层不漂移。
    """

    def test_trigger_by_tracker_completed_writes_correct_source_value(self):
        from apps.tracker.services import tracker_trigger_service
        from apps.tracker.services.tracker_trigger_service import StormGuardDecision

        mock_tracker = MagicMock()
        mock_tracker.id = "child-tracker-1"
        mock_tracker.trigger_config = {"tracker_id": "parent-tracker-1"}
        mock_tracker.space_id = None

        mock_qs = MagicMock()
        mock_qs.__iter__ = MagicMock(return_value=iter([mock_tracker]))

        captured_context: dict = {}

        def _capture_start(*args, **kwargs):
            # start_tracker_run(tracker_id=..., trigger_type=..., trigger_context=...)
            ctx = kwargs.get("trigger_context") or (args[2] if len(args) >= 3 else None)
            if ctx is not None:
                captured_context.update(ctx)
            return "run-1"

        # apply_storm_guard 返回 allowed 决策（不触发熔断 + 不 first_trigger）
        allowed_decision = StormGuardDecision(
            allowed=True,
            reason="ok",
            should_trip_circuit=False,
            first_trigger=False,
        )

        # TrackerRun 在函数内 lazy import (line 482)，需要 patch 源头模块
        with patch("apps.tracker.services.tracker_trigger_service.Tracker") as mock_tracker_cls, \
             patch("apps.tracker.models.TrackerRun") as mock_run_cls, \
             patch("apps.tracker.services.tracker_trigger_service.cache") as mock_cache, \
             patch(
                 "apps.tracker.services.tracker_trigger_service.apply_storm_guard",
                 return_value=allowed_decision,
             ), \
             patch(
                 "apps.tracker.services.tracker_trigger_service.start_tracker_run",
                 side_effect=_capture_start,
             ):
            mock_tracker_cls.objects.filter.return_value = mock_qs
            mock_run_cls.objects.filter.return_value.exists.return_value = False
            mock_cache.add.return_value = True

            tracker_trigger_service.trigger_by_tracker_completed(
                completed_tracker_id="parent-tracker-1",
                completed_run_id="run-abc",
            )

        self.assertEqual(
            captured_context.get("source"),
            "tracker_completed",
            "trigger_context.source 必须是 'tracker_completed'（Module C 一刀切），"
            "如果回到 'goal_completed' 说明命名又漂移了",
        )
        self.assertIn(
            "completed_tracker_id",
            captured_context,
            "trigger_context 必须用 completed_tracker_id 字段名",
        )
        self.assertNotIn(
            "completed_goal_id",
            captured_context,
            "trigger_context 不应残留 completed_goal_id 字段名",
        )
        self.assertEqual(captured_context["completed_tracker_id"], "parent-tracker-1")

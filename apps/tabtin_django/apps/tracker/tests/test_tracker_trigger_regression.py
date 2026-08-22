"""TGE-010 / TGE-011 / TGE-013 / TGE-014 回归测试。"""

from __future__ import annotations

import hashlib
from unittest.mock import MagicMock, patch, call

from django.test import SimpleTestCase


def _allowed_decision():
    """tracker_completed 级联测试 fixture：apply_storm_guard 返回 allowed 决策，
    避免它内部 cache.add 多次（first_trigger / debounce / rate / circuit）污染
    本组测试对 ``cascade_dedup_key`` cache.add 的 once 断言。"""
    return MagicMock(allowed=True, first_trigger=False, should_trip_circuit=False)


class TestTGE010CascadeDistributedDedup(SimpleTestCase):
    """TGE-010: tracker_completed 级联必须通过 Redis 分布式去重，防止跨进程重复触发。"""

    @patch(
        "apps.tracker.services.tracker_trigger_service.apply_storm_guard",
        return_value=_allowed_decision(),
    )
    @patch("apps.tracker.models.TrackerRun")
    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run", return_value="run-1")
    @patch("apps.tracker.services.tracker_trigger_service.cache")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    def test_cascade_uses_redis_dedup(self, mock_tracker_cls, mock_cache, mock_start, mock_run_cls, mock_guard):
        """第一次级联触发应成功，第二次应被 Redis 去重拦截。"""
        from apps.tracker.services.tracker_trigger_service import trigger_by_tracker_completed

        mock_tracker = MagicMock()
        mock_tracker.id = "child-tracker-1"
        mock_tracker.trigger_config = {"tracker_id": "parent-tracker-1"}

        mock_qs = MagicMock()
        mock_qs.__iter__ = MagicMock(return_value=iter([mock_tracker]))
        mock_tracker_cls.objects.filter.return_value = mock_qs
        # 数据库幂等检查：trigger_service 内部会跑 TrackerRun.exists()，
        # SimpleTestCase 无 DB，必须 mock 否则 UUID 校验会失败。
        mock_run_cls.objects.filter.return_value.exists.return_value = False

        mock_cache.add.return_value = True

        trigger_by_tracker_completed(
            completed_tracker_id="parent-tracker-1",
            completed_run_id="run-abc",
        )

        mock_cache.add.assert_called_once()
        dedup_key = mock_cache.add.call_args[0][0]
        self.assertTrue(
            dedup_key.startswith("cascade_tracker:run-abc:"),
            f"去重 key 应以 'cascade_tracker:{{completed_run_id}}:' 开头，实际为 {dedup_key}",
        )
        mock_start.assert_called_once()

    @patch(
        "apps.tracker.services.tracker_trigger_service.apply_storm_guard",
        return_value=_allowed_decision(),
    )
    @patch("apps.tracker.models.TrackerRun")
    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run")
    @patch("apps.tracker.services.tracker_trigger_service.cache")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    def test_cascade_dedup_blocks_duplicate(self, mock_tracker_cls, mock_cache, mock_start, mock_run_cls, mock_guard):
        """Redis cache.add 返回 False 时应跳过触发。"""
        from apps.tracker.services.tracker_trigger_service import trigger_by_tracker_completed

        mock_tracker = MagicMock()
        mock_tracker.id = "child-tracker-1"
        mock_tracker.trigger_config = {"tracker_id": "parent-tracker-1"}
        mock_tracker_cls.objects.filter.return_value = [mock_tracker]
        mock_run_cls.objects.filter.return_value.exists.return_value = False

        mock_cache.add.return_value = False

        result = trigger_by_tracker_completed(
            completed_tracker_id="parent-tracker-1",
            completed_run_id="run-abc",
        )

        mock_start.assert_not_called()
        self.assertEqual(result, 0)

    @patch(
        "apps.tracker.services.tracker_trigger_service.apply_storm_guard",
        return_value=_allowed_decision(),
    )
    @patch("apps.tracker.models.TrackerRun")
    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run", side_effect=Exception("boom"))
    @patch("apps.tracker.services.tracker_trigger_service.cache")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    def test_cascade_dedup_released_on_failure(self, mock_tracker_cls, mock_cache, mock_start, mock_run_cls, mock_guard):
        """start_tracker_run 失败时应释放 Redis 去重锁。"""
        from apps.tracker.services.tracker_trigger_service import trigger_by_tracker_completed

        mock_tracker = MagicMock()
        mock_tracker.id = "child-tracker-1"
        mock_tracker.trigger_config = {"tracker_id": "parent-tracker-1"}
        mock_tracker_cls.objects.filter.return_value = [mock_tracker]
        mock_run_cls.objects.filter.return_value.exists.return_value = False
        mock_cache.add.return_value = True

        trigger_by_tracker_completed(
            completed_tracker_id="parent-tracker-1",
            completed_run_id="run-abc",
        )

        mock_cache.delete.assert_called_once()

    def test_cascade_dedup_ttl_constant_exists(self):
        from apps.tracker.services.tracker_trigger_service import _CASCADE_DEDUP_TTL
        self.assertGreaterEqual(_CASCADE_DEDUP_TTL, 300, "TTL 应至少覆盖 5 分钟执行窗口")
        self.assertLessEqual(_CASCADE_DEDUP_TTL, 3600, "TTL 不应超过 1 小时")


class TestTGE011TableEventDeterministicEventId(SimpleTestCase):
    """TGE-011: 表事件 emit 必须使用确定性 event_id，防止双路径去重失效。

    2026-05-28 收编：原 ``apps.tracker.tasks._emit_table_event_to_eventbus`` 随
    ScheduledJob 子系统下线，逻辑搬到 ``apps.tabdata.utils.scheduler_bridge.
    emit_record_event_to_eventbus``（确定性 event_id 算法 ``_stable_event_id`` 不变）。
    """

    @patch("apps.extensions.event_bus.EventBus.emit")
    def test_event_id_is_deterministic(self, mock_emit):
        from apps.tabdata.utils.scheduler_bridge import emit_record_event_to_eventbus

        emit_record_event_to_eventbus(
            table_id="tbl-1",
            space_id="sp-1",
            event_type="created",
            record_id="rec-1",
            organization_id="wt-1",
        )
        self.assertEqual(mock_emit.call_count, 1)
        event = mock_emit.call_args[0][0]

        expected_hash = hashlib.sha256(b"tbl-1:rec-1:created").hexdigest()[:24]
        self.assertEqual(
            event.event_id, expected_hash,
            "event_id 应为 table_id:record_id:event_type 的 SHA256 前 24 位",
        )

    @patch("apps.extensions.event_bus.EventBus.emit")
    def test_same_params_produce_same_event_id(self, mock_emit):
        from apps.tabdata.utils.scheduler_bridge import emit_record_event_to_eventbus

        params = dict(
            table_id="tbl-x", space_id="sp-x",
            event_type="updated", record_id="rec-x", organization_id="wt-x",
        )
        emit_record_event_to_eventbus(**params)
        emit_record_event_to_eventbus(**params)

        id1 = mock_emit.call_args_list[0][0][0].event_id
        id2 = mock_emit.call_args_list[1][0][0].event_id
        self.assertEqual(id1, id2, "相同参数应生成相同 event_id")

    @patch("apps.extensions.event_bus.EventBus.emit")
    def test_different_params_produce_different_event_id(self, mock_emit):
        from apps.tabdata.utils.scheduler_bridge import emit_record_event_to_eventbus

        emit_record_event_to_eventbus(
            table_id="tbl-1", space_id="sp-1",
            event_type="created", record_id="rec-1", organization_id="wt-1",
        )
        emit_record_event_to_eventbus(
            table_id="tbl-1", space_id="sp-1",
            event_type="updated", record_id="rec-1", organization_id="wt-1",
        )

        id1 = mock_emit.call_args_list[0][0][0].event_id
        id2 = mock_emit.call_args_list[1][0][0].event_id
        self.assertNotEqual(id1, id2, "不同事件类型应生成不同 event_id")


class TestTGE013WebhookTriggersAllTrackers(SimpleTestCase):
    """TGE-013: trigger_by_webhook 必须触发同一 path 下的所有 Tracker，而非只取 first()。"""

    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    def test_triggers_all_matching_trackers(self, mock_tracker_cls, mock_start):
        from apps.tracker.services.tracker_trigger_service import trigger_by_webhook

        tracker_a = MagicMock()
        tracker_a.id = "tracker-a"
        tracker_a.trigger_config = {}

        tracker_b = MagicMock()
        tracker_b.id = "tracker-b"
        tracker_b.trigger_config = {}

        mock_tracker_cls.objects.filter.return_value = [tracker_a, tracker_b]

        mock_start.side_effect = ["run-a", "run-b"]

        result = trigger_by_webhook(webhook_path="/hook/test", payload={"key": "val"})

        self.assertEqual(mock_start.call_count, 2, "应触发两个 Tracker")
        called_tracker_ids = {c.kwargs["tracker_id"] for c in mock_start.call_args_list}
        self.assertEqual(called_tracker_ids, {"tracker-a", "tracker-b"})
        self.assertEqual(result, "run-a", "返回第一个成功的 run_id")

    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    def test_signature_failure_skips_that_tracker_only(self, mock_tracker_cls, mock_start):
        """签名校验失败的 Tracker 应被跳过，其他 Tracker 正常触发。"""
        from apps.tracker.services.tracker_trigger_service import trigger_by_webhook

        tracker_with_secret = MagicMock()
        tracker_with_secret.id = "tracker-secret"
        tracker_with_secret.trigger_config = {"secret": "mysecret"}

        tracker_no_secret = MagicMock()
        tracker_no_secret.id = "tracker-open"
        tracker_no_secret.trigger_config = {}

        mock_tracker_cls.objects.filter.return_value = [tracker_with_secret, tracker_no_secret]
        mock_start.return_value = "run-open"

        result = trigger_by_webhook(
            webhook_path="/hook/test",
            payload={},
            signature="wrong-signature",
            raw_body=b"body",
        )

        self.assertEqual(mock_start.call_count, 1)
        self.assertEqual(mock_start.call_args.kwargs["tracker_id"], "tracker-open")


class TestTGE014TableEventRecordId(SimpleTestCase):
    """TGE-014: trigger_by_table_event 的 trigger_context 必须包含独立 record_id 字段。"""

    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run", return_value="run-1")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    @patch("apps.tracker.services.tracker_trigger_service.cache")
    def test_trigger_context_includes_record_id(self, mock_cache, mock_tracker_cls, mock_start):
        from apps.tracker.services.tracker_trigger_service import trigger_by_table_event

        mock_tracker = MagicMock()
        mock_tracker.id = "tracker-tbl-1"
        mock_tracker.trigger_config = {"table_id": "tbl-1"}

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.only.return_value = [mock_tracker]
        mock_tracker_cls.objects.filter.return_value = mock_qs

        mock_cache.add.return_value = True

        trigger_by_table_event(
            organization_id="wt-1",
            space_id="sp-1",
            table_id="tbl-1",
            event_type="tabdata.record.created",
            record_data={"record_id": "rec-42", "name": "test"},
            event_id="evt-1",
        )

        self.assertEqual(mock_start.call_count, 1)
        ctx = mock_start.call_args.kwargs.get("trigger_context") or mock_start.call_args[1].get("trigger_context")
        self.assertIn("record_id", ctx, "trigger_context 必须包含 record_id 字段")
        self.assertEqual(ctx["record_id"], "rec-42")
        self.assertIn("record_data", ctx, "trigger_context 仍应保留 record_data")

    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run", return_value="run-1")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    @patch("apps.tracker.services.tracker_trigger_service.cache")
    def test_record_id_empty_when_no_record_data(self, mock_cache, mock_tracker_cls, mock_start):
        from apps.tracker.services.tracker_trigger_service import trigger_by_table_event

        mock_tracker = MagicMock()
        mock_tracker.id = "tracker-tbl-1"
        mock_tracker.trigger_config = {"table_id": "tbl-1"}

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.only.return_value = [mock_tracker]
        mock_tracker_cls.objects.filter.return_value = mock_qs
        mock_cache.add.return_value = True

        trigger_by_table_event(
            organization_id="wt-1",
            space_id="sp-1",
            table_id="tbl-1",
            event_type="created",
            record_data=None,
            event_id="evt-2",
        )

        ctx = mock_start.call_args.kwargs.get("trigger_context") or mock_start.call_args[1].get("trigger_context")
        self.assertEqual(ctx["record_id"], "", "record_data 为 None 时 record_id 应为空字符串")


class TestModuleFFirstTriggeredSingleCall(SimpleTestCase):
    """Module F 修复：3 个触发路径首次触发时 _mark_first_triggered 只被调用 1 次。

    修复前 bug：apply_storm_guard 内部已经在 first_trigger=True 时调用一次 mark，
    上层 webhook / cascade / table_event caller 又各自在 if decision.first_trigger
    分支再调一次，导致首次触发会跑 2 次 transaction.atomic + select_for_update。
    数据状态正确（mark 内部有 idempotency 早返回），但多打一次 PG 行锁是浪费。

    本测试 mock apply_storm_guard 返回 first_trigger=True，断言 _mark_first_triggered
    只被调用 0 次（来自 caller 层）—— 因为 mock 后 apply_storm_guard 内部副作用也不会
    跑。换言之：caller 层不应该再单独调 _mark_first_triggered。
    """

    def _first_trigger_decision(self):
        return MagicMock(allowed=True, first_trigger=True, should_trip_circuit=False)

    @patch("apps.tracker.services.tracker_trigger_service._mark_first_triggered")
    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run", return_value="run-1")
    @patch("apps.tracker.models.TrackerRun")
    @patch("apps.tracker.services.tracker_trigger_service.cache")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    def test_cascade_caller_does_not_call_mark_first_triggered(
        self, mock_tracker_cls, mock_cache, mock_run_cls, mock_start, mock_mark,
    ):
        from apps.tracker.services.tracker_trigger_service import trigger_by_tracker_completed

        mock_tracker = MagicMock()
        mock_tracker.id = "child-1"
        mock_tracker.trigger_config = {"tracker_id": "parent-1"}
        mock_tracker.space_id = None
        mock_qs = MagicMock()
        mock_qs.__iter__ = MagicMock(return_value=iter([mock_tracker]))
        mock_tracker_cls.objects.filter.return_value = mock_qs
        mock_run_cls.objects.filter.return_value.exists.return_value = False
        mock_cache.add.return_value = True

        with patch(
            "apps.tracker.services.tracker_trigger_service.apply_storm_guard",
            return_value=self._first_trigger_decision(),
        ):
            trigger_by_tracker_completed(
                completed_tracker_id="parent-1",
                completed_run_id="run-abc",
            )

        self.assertEqual(
            mock_mark.call_count, 0,
            "cascade caller 不应该再调用 _mark_first_triggered—— apply_storm_guard 已统一处理",
        )

    @patch("apps.tracker.services.tracker_trigger_service._mark_first_triggered")
    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run", return_value="run-1")
    @patch("apps.tracker.services.tracker_trigger_service.cache")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    def test_webhook_caller_does_not_call_mark_first_triggered(
        self, mock_tracker_cls, mock_cache, mock_start, mock_mark,
    ):
        from apps.tracker.services.tracker_trigger_service import trigger_by_webhook

        mock_tracker = MagicMock()
        mock_tracker.id = "wh-1"
        mock_tracker.space_id = None
        mock_tracker.trigger_config = {"webhook_path": "/hook/x", "webhook_secret": ""}
        mock_qs = MagicMock()
        mock_qs.__iter__ = MagicMock(return_value=iter([mock_tracker]))
        mock_tracker_cls.objects.filter.return_value = mock_qs
        mock_cache.add.return_value = True

        with patch(
            "apps.tracker.services.tracker_trigger_service.apply_storm_guard",
            return_value=self._first_trigger_decision(),
        ):
            trigger_by_webhook(
                webhook_path="/hook/x",
                payload={},
                signature=None,
                raw_body=b"",
            )

        self.assertEqual(
            mock_mark.call_count, 0,
            "webhook caller 不应该再调用 _mark_first_triggered",
        )

    @patch("apps.tracker.services.tracker_trigger_service._mark_first_triggered")
    @patch("apps.tracker.services.tracker_trigger_service.start_tracker_run", return_value="run-1")
    @patch("apps.tracker.services.tracker_trigger_service.Tracker")
    @patch("apps.tracker.services.tracker_trigger_service.cache")
    def test_table_event_caller_does_not_call_mark_first_triggered(
        self, mock_cache, mock_tracker_cls, mock_start, mock_mark,
    ):
        from apps.tracker.services.tracker_trigger_service import trigger_by_table_event

        mock_tracker = MagicMock()
        mock_tracker.id = "tbl-1"
        mock_tracker.trigger_config = {"table_id": "tbl-1"}
        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.only.return_value = [mock_tracker]
        mock_tracker_cls.objects.filter.return_value = mock_qs
        mock_cache.add.return_value = True

        with patch(
            "apps.tracker.services.tracker_trigger_service.apply_storm_guard",
            return_value=self._first_trigger_decision(),
        ):
            trigger_by_table_event(
                organization_id="wt-1",
                space_id="sp-1",
                table_id="tbl-1",
                event_type="tabdata.record.created",
                record_data={"record_id": "r1"},
                event_id="evt-1",
            )

        self.assertEqual(
            mock_mark.call_count, 0,
            "table_event caller 不应该再调用 _mark_first_triggered",
        )

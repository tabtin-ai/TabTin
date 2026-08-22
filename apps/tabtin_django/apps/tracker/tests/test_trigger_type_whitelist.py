"""TS-14：trigger_type 白名单 + interval/at/table_event 必填字段校验。

纯函数 / Service 层校验测试，不连 DB（SimpleTestCase + mock 阻断 ORM）。
目标：非法 trigger_type 或缺字段的脏配置在创建/更新入口被拒，不静默入库。
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.core.exceptions import ValidationError as DjangoValidationError
from django.test import SimpleTestCase

from apps.tracker.tracker_schemas import TrackerCreate
from apps.tracker.services.tracker_service import (
    _validate_trigger_type_and_config,
    TrackerService,
)


class ValidateTriggerTypeAndConfigTest(SimpleTestCase):
    """``_validate_trigger_type_and_config`` 纯函数契约。"""

    def test_unknown_trigger_type_rejected(self):
        with self.assertRaises(DjangoValidationError) as ctx:
            _validate_trigger_type_and_config("bogus", {})
        self.assertIn("trigger_type", str(ctx.exception))

    def test_known_types_without_required_config_pass(self):
        # manual / extension_event / webhook / tracker_completed 不强制 config。
        for tt in ("manual", "cron", "extension_event", "webhook", "tracker_completed"):
            _validate_trigger_type_and_config(tt, {})

    # ── interval ──
    def test_interval_requires_seconds(self):
        with self.assertRaises(DjangoValidationError):
            _validate_trigger_type_and_config("interval", {})

    def test_interval_rejects_non_positive(self):
        with self.assertRaises(DjangoValidationError):
            _validate_trigger_type_and_config("interval", {"interval_seconds": 0})

    def test_interval_accepts_valid(self):
        _validate_trigger_type_and_config("interval", {"interval_seconds": 1800})
        # 兼容旧 key seconds
        _validate_trigger_type_and_config("interval", {"seconds": 60})

    # ── at ──
    def test_at_requires_parseable_datetime(self):
        with self.assertRaises(DjangoValidationError):
            _validate_trigger_type_and_config("at", {})
        with self.assertRaises(DjangoValidationError):
            _validate_trigger_type_and_config("at", {"at": "not-a-date"})

    def test_at_accepts_future_iso(self):
        # ：「定时一次」必须设在未来。用动态未来时间避免测试随日期失效。
        from datetime import timedelta
        from django.utils import timezone
        future = timezone.now() + timedelta(hours=2)
        _validate_trigger_type_and_config("at", {"at": future.isoformat()})
        # 兼容 naive ISO（无时区后缀）——make_aware 兜底
        _validate_trigger_type_and_config("at", {"at": future.replace(microsecond=0).isoformat()})

    def test_at_rejects_past_iso(self):
        """#1583：过去时间的「定时一次」必须被入口层拒绝。

        否则激活后 scan_due_trackers 会立即扫到并执行一次（与「定时未来」语义相反），
        随后 disabled —— 用户本以为不会跑，结果跑了一次。
        """
        from datetime import timedelta
        from django.utils import timezone
        past = timezone.now() - timedelta(hours=2)
        with self.assertRaises(DjangoValidationError) as ctx:
            _validate_trigger_type_and_config("at", {"at": past.isoformat()})
        self.assertIn("未来", str(ctx.exception))

    def test_at_tolerates_small_clock_skew_within_buffer(self):
        """#1583：60s 缓冲内的时间不算过去，避免 CLI/网络抖动与时钟漂移误伤
        「马上要执行」的合法场景。
        """
        from datetime import timedelta
        from django.utils import timezone
        # 30 秒前仍在 60s 缓冲内，应通过
        borderline = timezone.now() - timedelta(seconds=30)
        _validate_trigger_type_and_config("at", {"at": borderline.isoformat()})

    # ── table_event ──
    def test_table_event_requires_table_id(self):
        with self.assertRaises(DjangoValidationError):
            _validate_trigger_type_and_config("table_event", {"events": ["record_created"]})

    def test_table_event_requires_non_empty_events(self):
        with self.assertRaises(DjangoValidationError):
            _validate_trigger_type_and_config("table_event", {"table_id": "tbl-1", "events": []})

    def test_table_event_rejects_invalid_event(self):
        with self.assertRaises(DjangoValidationError):
            _validate_trigger_type_and_config(
                "table_event", {"table_id": "tbl-1", "events": ["bogus"]}
            )

    def test_table_event_accepts_valid(self):
        _validate_trigger_type_and_config(
            "table_event",
            {"table_id": "tbl-1", "events": ["record_created", "record_updated"]},
        )


class CreateTrackerWhitelistTest(SimpleTestCase):
    """Service.create_tracker 入口拒绝非法 trigger_type（在 ORM 之前 fail）。"""

    def _make_payload(self, **overrides):
        base = {
            "name": "测试 Tracker",
            "description": "校验白名单",
            "trigger_type": "manual",
            "trigger_config": {},
            "skill_key": "demo_skill",
            "agent_id": str(uuid.uuid4()),
        }
        base.update(overrides)
        return TrackerCreate(**base)

    def test_create_rejects_unknown_trigger_type(self):
        payload = self._make_payload(trigger_type="bogus")
        svc = TrackerService(user=MagicMock())
        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ):
            with self.assertRaises(DjangoValidationError) as ctx:
                svc.create_tracker("wt-1", "sp-1", payload, MagicMock())
        self.assertIn("trigger_type", str(ctx.exception))

    def test_create_rejects_interval_without_seconds(self):
        payload = self._make_payload(trigger_type="interval", trigger_config={})
        svc = TrackerService(user=MagicMock())
        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ):
            with self.assertRaises(DjangoValidationError):
                svc.create_tracker("wt-1", "sp-1", payload, MagicMock())

    def test_create_rejects_table_event_without_events(self):
        payload = self._make_payload(
            trigger_type="table_event", trigger_config={"table_id": "tbl-1"}
        )
        svc = TrackerService(user=MagicMock())
        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ):
            with self.assertRaises(DjangoValidationError):
                svc.create_tracker("wt-1", "sp-1", payload, MagicMock())

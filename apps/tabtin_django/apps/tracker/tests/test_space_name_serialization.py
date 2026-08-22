"""#3779：列表/详情序列化必须带 space_name，供前端跨 Space 归属展示。"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone as _tz
from types import SimpleNamespace
from unittest import TestCase

from apps.tracker.api.trackers import _serialize_tracker, _serialize_tracker_list


def _tracker(
    *,
    space_name: str | None = "HR Workspace",
    trigger_type: str = "cron",
    trigger_config: dict | None = None,
):
    now = datetime.now(tz=_tz.utc)
    workspace = SimpleNamespace(name=space_name) if space_name is not None else None
    return SimpleNamespace(
        id=uuid.uuid4(),
        name="scan-resume",
        description="",
        status="active",
        workspace_id=uuid.uuid4(),
        workspace=workspace,
        agent_id=None,
        trigger_type=trigger_type,
        trigger_config=trigger_config or {},
        skill_key="demo.skill",
        skill_params={},
        intent_snapshot=None,
        total_runs=1,
        success_runs=1,
        fail_runs=0,
        last_run_at=None,
        next_run_at=None,
        created_at=now,
        updated_at=now,
    )


class SpaceNameSerializationTests(TestCase):
    def test_list_row_includes_space_name(self):
        payload = _serialize_tracker_list(_tracker(space_name="销售 Space"))
        self.assertEqual(payload["space_name"], "销售 Space")
        self.assertIsNotNone(payload["space_id"])

    def test_detail_includes_space_name(self):
        payload = _serialize_tracker(_tracker(space_name="研发 Space"))
        self.assertEqual(payload["space_name"], "研发 Space")

    def test_missing_space_yields_null_space_name(self):
        tracker = _tracker(space_name=None)
        tracker.workspace = None
        self.assertIsNone(_serialize_tracker_list(tracker)["space_name"])
        self.assertIsNone(_serialize_tracker(tracker)["space_name"])

    def test_empty_space_name_yields_null(self):
        self.assertIsNone(_serialize_tracker_list(_tracker(space_name=""))["space_name"])

    def test_list_row_includes_safe_schedule_config(self):
        payload = _serialize_tracker_list(_tracker(trigger_config={
            "expression": " 0 9 * * * ",
            "timezone": "Asia/Shanghai",
            "secret": "must-not-leak",
        }))

        self.assertEqual(payload["schedule_config"], {
            "cron_expression": "0 9 * * *",
            "timezone": "Asia/Shanghai",
        })
        self.assertNotIn("secret", payload["schedule_config"])

    def test_list_row_only_exposes_schedule_fields_for_scheduled_triggers(self):
        webhook = _serialize_tracker_list(_tracker(
            trigger_type="webhook",
            trigger_config={"secret": "must-not-leak", "path": "/daily"},
        ))
        interval = _serialize_tracker_list(_tracker(
            trigger_type="interval",
            trigger_config={"seconds": "7200", "untrusted": "ignored"},
        ))

        self.assertEqual(webhook["schedule_config"], {})
        self.assertEqual(interval["schedule_config"], {"interval_seconds": 7200})

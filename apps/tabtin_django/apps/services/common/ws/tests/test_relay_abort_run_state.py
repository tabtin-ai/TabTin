from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from apps.services.common.ws.handlers.relay_handler import _apply_run_state_events  # noqa: E402
from apps.services.agent_engine.services.session_run_state_service import serialize_run_state  # noqa: E402


def test_abort_lifecycle_error_projects_interrupted_not_failed():
    """用户主动 Stop 的 lifecycle error 不能抢先固化成失败终态。"""
    with patch(
        "apps.services.agent_engine.services.session_run_state_service."
        "SessionRunStateService.transition",
    ) as transition:
        _apply_run_state_events(
            str(uuid.uuid4()),
            [("lifecycle", {
                "phase": "error",
                "run_id": str(uuid.uuid4()),
                "stop_reason": "aborted",
                "error_class": "ABORT",
            })],
            str(uuid.uuid4()),
        )

    assert transition.call_args.kwargs["status"] == "interrupted"


def test_lifecycle_paused_projects_run_state_paused():
    """#7466：runtime 抵达暂停边界后，才把权威 run_state 标成 paused。"""
    with patch(
        "apps.services.agent_engine.services.session_run_state_service."
        "SessionRunStateService.transition",
    ) as transition:
        _apply_run_state_events(
            str(uuid.uuid4()),
            [("lifecycle", {
                "phase": "paused",
                "run_id": str(uuid.uuid4()),
            })],
            str(uuid.uuid4()),
        )

    assert transition.call_args.kwargs["status"] == "paused"
    assert transition.call_args.kwargs["allowed_from"] == frozenset(
        {"running", "paused", "waiting_user"}
    )


def test_legacy_failed_abort_serializes_as_interrupted():
    projection = SimpleNamespace(
        current_run_id=uuid.uuid4(),
        sequence=1,
        revision=1,
        status="failed",
        queue_depth=0,
        started_at=None,
        state_changed_at=datetime.now(timezone.utc),
        ended_at=None,
        stop_reason="aborted",
        error_class="ABORT",
        waiting_interaction_id=None,
    )

    assert serialize_run_state(projection)["status"] == "interrupted"

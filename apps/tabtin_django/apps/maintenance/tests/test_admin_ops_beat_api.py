import os
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
import pytest
from django.utils import timezone
from ninja.errors import HttpError

django.setup()

from apps.maintenance import admin_ops_api as ops
from apps.maintenance.models import OpsTroubleshootQueryLog


def _request():
    request = Mock()
    request.auth.id = "admin-user-1"
    request.auth.is_superuser = True
    request.META = {"REMOTE_ADDR": "127.0.0.1", "HTTP_USER_AGENT": "pytest"}
    return request


def _interval_task(**overrides):
    now = timezone.now()
    task = SimpleNamespace(
        id=1,
        name="billing daily",
        task="apps.services.billing.tasks.daily_billing",
        enabled=True,
        interval_id=1,
        interval=SimpleNamespace(every=1, period="hours"),
        crontab_id=None,
        crontab=None,
        solar_id=None,
        solar=None,
        clocked_id=None,
        clocked=None,
        last_run_at=now - timedelta(hours=5),
        start_time=None,
        date_changed=now - timedelta(days=2),
        total_run_count=10,
        queue="default",
        args='["user@example.com"]',
        kwargs='{"api_key":"sk-real","phone":"13800138000"}',
    )
    for key, value in overrides.items():
        setattr(task, key, value)
    return task


def test_beat_permission_code_is_declared_in_api_and_django_permissions():
    assert ops.P0_PERMISSION_CODES["beat"] == "ops_beat:view"
    assert ("ops_beat:view", "Can view Ops beat tasks") in OpsTroubleshootQueryLog._meta.permissions


def test_p1_readonly_permission_codes_are_declared_in_api_and_django_permissions():
    expected = {
        "llm_trace": ("ops_llm_trace:view", "Can view Ops LLM traces"),
        "oss_status": ("ops_oss_status:view", "Can view Ops OSS status"),
        "sms_status": ("ops_sms_status:view", "Can view Ops SMS status"),
        "dependency_health": ("ops_dependency_health:view", "Can view Ops dependency health"),
        "incident": ("ops_incident:view", "Can view Ops incident placeholders"),
        "cost_sla": ("ops_cost_sla:view", "Can view Ops cost and SLA placeholders"),
    }

    for api_key, permission in expected.items():
        code, _label = permission
        assert ops.P0_PERMISSION_CODES[api_key] == code
        assert permission in OpsTroubleshootQueryLog._meta.permissions


def test_beat_next_run_interval_is_computed_without_db_write():
    task = _interval_task(last_run_at=timezone.now() - timedelta(minutes=10))

    result = ops._next_run_estimate(task)

    assert result["next_run_at"]
    assert result["reason"] is None


def test_beat_list_rejects_unknown_queue_before_query():
    with pytest.raises(HttpError) as exc:
        ops.ops_beat_tasks(_request(), queue="not-allowlisted")

    assert exc.value.status_code == 400
    assert "allowlist" in str(exc.value)


def test_beat_list_is_readonly_and_returns_page():
    task = _interval_task()
    qs = MagicMock()
    qs.filter.return_value = qs
    qs.order_by.return_value = qs
    qs.__getitem__.return_value = [task]

    with patch("django_celery_beat.models.PeriodicTask.objects") as manager, \
         patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._queue_lengths_for", return_value={"status": "ok", "data": {"default": 3}}), \
         patch("apps.maintenance.admin_ops_api._recent_failures_for", return_value={}):
        manager.select_related.return_value = qs
        response = ops.ops_beat_tasks(_request(), ticket_id="OPS-1")

    create.assert_not_called()
    assert response["items"][0]["id"] == "1"
    assert response["items"][0]["queue"] == "default"
    assert response["items"][0]["queue_length"] == 3
    assert response["summary"]["scope"] == "current_page"


def test_beat_detail_masks_args_and_kwargs_and_is_readonly():
    task = _interval_task()
    qs = MagicMock()
    qs.filter.return_value = qs
    qs.first.return_value = task

    with patch("django_celery_beat.models.PeriodicTask.objects") as manager, \
         patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._queue_lengths_for", return_value={"status": "ok", "data": {"default": 0}}), \
         patch("apps.maintenance.admin_ops_api._recent_failures_for", return_value={task.task: []}):
        manager.select_related.return_value = qs
        response = ops.ops_beat_task_detail(_request(), task_id=1, ticket_id="OPS-1")

    create.assert_not_called()
    assert response["task"]["id"] == "1"
    assert response["args_masked"] == ["u***@example.com"]
    assert response["kwargs_masked"]["api_key"] == "[masked]"
    assert response["kwargs_masked"]["phone"] == "138****8000"

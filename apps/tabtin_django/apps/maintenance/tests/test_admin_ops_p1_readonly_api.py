import os
from datetime import timedelta
from unittest.mock import Mock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
import pytest
from django.utils import timezone
from ninja.errors import HttpError

django.setup()

from apps.maintenance import admin_ops_api as ops


def _request():
    request = Mock()
    request.auth.id = "admin-user-1"
    request.auth.is_superuser = True
    request.META = {
        "REMOTE_ADDR": "127.0.0.1",
        "HTTP_USER_AGENT": "pytest",
        "HTTP_X_REQUEST_ID": "req-p1",
    }
    return request


def _queryset():
    qs = Mock()
    qs.filter.return_value = qs
    qs.exclude.return_value = qs
    qs.order_by.return_value.values.return_value = object()
    return qs


def test_limited_time_range_rejects_over_7d_for_llm():
    too_old = (timezone.now() - timedelta(days=8)).isoformat()

    with pytest.raises(HttpError) as exc:
        ops._parse_limited_time_range(too_old, timezone.now().isoformat(), default_hours=24, max_days=7)

    assert exc.value.status_code == 400


def test_llm_sensitive_filter_writes_troubleshoot_log():
    qs = _queryset()
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.services.llm.models.LLMUsageFact.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)):
        response = ops.ops_llm_traces(
            _request(),
            user_id="user-1",
            reason="diagnose llm issue",
            ticket_id="OPS-LLM-1",
        )

    create.assert_called_once()
    assert create.call_args.kwargs["target_user_id"] == "user-1"
    assert response["items"] == []


def test_llm_provider_filter_does_not_write_troubleshoot_log():
    qs = _queryset()
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.services.llm.models.LLMUsageFact.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)):
        ops.ops_llm_traces(_request(), provider="dashscope")

    create.assert_not_called()


def test_llm_traces_query_uses_organization_id_and_keeps_workteam_alias():
    qs = _queryset()
    row = {
        "id": "trace-1",
        "request_id": "req-1",
        "scene_key": "title_generation",
        "capability_domain": "chat",
        "provider_key": "moonshot",
        "model_name": "kimi",
        "organization_id": "org-1",
        "user_id": "user-1",
        "status": "completed",
        "error_code": "",
        "error_category": "",
        "attempt_count": 1,
        "latency_ms": 100,
        "total_tokens": 10,
        "cost_status": "platform_paid",
        "occurred_at": timezone.now(),
    }
    with patch("apps.services.llm.models.LLMUsageFact.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([row], False)):
        response = ops.ops_llm_traces(_request(), provider="moonshot")

    values_args = qs.order_by.return_value.values.call_args.args
    assert "organization_id" in values_args
    assert "workteam_id" not in values_args
    assert response["items"][0]["workteam_id"] == "org-1"


def test_oss_object_filter_writes_troubleshoot_log():
    qs = _queryset()
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.services.oss.models.FileRecord.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)):
        ops.ops_oss_status(
            _request(),
            object_id="object-1",
            reason="diagnose oss object",
            ticket_id="OPS-OSS-1",
        )

    create.assert_called_once()
    assert create.call_args.kwargs["target_entity_type"] == "oss_object"


def test_oss_status_query_uses_organization_id_and_keeps_workteam_alias():
    qs = _queryset()
    row = {
        "id": "file-1",
        "file_name": "report.pdf",
        "file_key": "private/report.pdf",
        "bucket_name": "bucket",
        "status": "completed",
        "upload_user": "user-1",
        "organization_id": "org-1",
        "metadata": {},
        "created_at": timezone.now(),
        "updated_at": timezone.now(),
    }
    with patch("apps.services.oss.models.FileRecord.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([row], False)):
        response = ops.ops_oss_status(_request())

    values_args = qs.order_by.return_value.values.call_args.args
    assert "organization_id" in values_args
    assert "workteam_id" not in values_args
    assert response["items"][0]["workteam_id"] == "org-1"


def test_sms_phone_filter_writes_troubleshoot_log_with_masked_target():
    qs = _queryset()
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.services.sms.models.SmsRecord.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)):
        ops.ops_sms_status(
            _request(),
            phone="13800138000",
            reason="diagnose sms failure",
            ticket_id="OPS-SMS-1",
        )

    create.assert_called_once()
    assert create.call_args.kwargs["target_entity_id"] == "138****8000"


def test_dependency_health_rejects_invalid_window():
    with pytest.raises(HttpError) as exc:
        ops.ops_dependencies_health(_request(), window_minutes=5)

    assert exc.value.status_code == 400


def test_dependency_health_uses_cached_readonly_overview():
    with patch("apps.maintenance.admin_ops_api._cached_overview", return_value={"items": []}) as cached, \
         patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create:
        response = ops.ops_dependencies_health(_request(), window_minutes=15)

    create.assert_not_called()
    assert response == {"items": []}
    assert cached.call_args.args[0] == "ops:overview:dependencies:v1:15:all"

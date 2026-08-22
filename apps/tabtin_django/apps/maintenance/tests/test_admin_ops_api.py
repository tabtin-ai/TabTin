import os
from datetime import timedelta
from unittest.mock import Mock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
import pytest
from django.core.cache import cache
from django.test import override_settings
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
        "HTTP_X_REQUEST_ID": "req-1",
    }
    return request


def test_reason_is_always_required():
    with pytest.raises(HttpError) as exc:
        ops._require_reason_ticket("", "")

    assert exc.value.status_code == 400
    assert "reason" in str(exc.value)


@override_settings(TABTIN_ADMIN_OPS_REQUIRE_TICKET_ID="0")
def test_ticket_can_be_disabled_outside_production():
    with patch.dict(os.environ, {"ENVIRONMENT": "development", "DJANGO_ENV": "", "TABTIN_ENV": ""}, clear=False):
        assert ops._require_reason_ticket("investigate user complaint", "") == (
            "investigate user complaint",
            "",
        )


@override_settings(TABTIN_ADMIN_OPS_REQUIRE_TICKET_ID="0")
def test_ticket_required_in_production_even_if_setting_disabled():
    with patch.dict(os.environ, {"ENVIRONMENT": "production", "DJANGO_ENV": "", "TABTIN_ENV": ""}, clear=False):
        with pytest.raises(HttpError) as exc:
            ops._require_reason_ticket("investigate user complaint", "")

    assert exc.value.status_code == 400
    assert "ticket_id" in str(exc.value)


def test_mask_redacts_common_sensitive_shapes():
    payload = {
        "email": "alice@example.com",
        "phone": "13800138000",
        "api_key": "sk-real-value",
        "nested": {
            "provider_key": "dashscope",
            "url": "https://oss.example.com/a?Expires=1&Signature=secret",
        },
    }

    masked = ops._mask(payload)

    assert masked["email"] == "a***@example.com"
    assert masked["phone"] == "138****8000"
    assert masked["api_key"] == "[masked]"
    assert masked["nested"]["provider_key"] == "[masked]"
    assert masked["nested"]["url"] == "[masked-url]"


def test_sensitive_free_text_is_masked():
    assert ops._mask_text("request failed with api_key=sk-real") == "[masked]"


def test_free_text_masks_embedded_contact_and_signed_url():
    text = (
        "failed for alice@example.com phone 13800138000 url "
        "https://oss.example.com/a?Expires=1&Signature=real"
    )

    masked = ops._mask_text(text)

    assert "alice@example.com" not in masked
    assert "13800138000" not in masked
    assert "Signature=real" not in masked
    assert "a***@example.com" in masked
    assert "138****8000" in masked
    assert "[masked-url]" in masked


def test_nested_mask_blocks_sms_content_and_verification_code_keys():
    payload = {
        "args": [
            {
                "content": "验证码 123456，请勿泄露",
                "verification_code": "123456",
                "sms_code": "654321",
                "error_code": "TEMPLATE_ERROR",
            }
        ]
    }

    masked = ops._mask(payload)

    assert masked["args"][0]["content"] == "[masked]"
    assert masked["args"][0]["verification_code"] == "[masked]"
    assert masked["args"][0]["sms_code"] == "[masked]"
    assert masked["args"][0]["error_code"] == "TEMPLATE_ERROR"


def test_page_size_is_capped_at_100():
    assert ops._page_size(500) == 100

    with pytest.raises(HttpError):
        ops._page_size(0)


def test_time_range_defaults_to_24h_and_rejects_over_30d():
    start, end = ops._parse_time_range(None, None)
    assert timedelta(hours=23, minutes=59) <= end - start <= timedelta(hours=24, seconds=1)

    too_old = (timezone.now() - timedelta(days=31)).isoformat()
    with pytest.raises(HttpError):
        ops._parse_time_range(too_old, timezone.now().isoformat())


def test_search_outbox_rejects_real_requeue_before_db_query():
    request = Mock()
    request.auth.is_superuser = True

    with pytest.raises(HttpError) as exc:
        ops.ops_search_outbox(
            request,
            db="pg",
            status="pending",
            dry_run=False,
            reason="investigate backlog",
            ticket_id="OPS-1",
        )

    assert exc.value.status_code == 403
    assert "dry_run=true" in str(exc.value)


def test_collab_metrics_uses_800ms_timeout():
    response = Mock()
    response.json.return_value = {"ok": True}
    response.raise_for_status.return_value = None

    with patch("apps.maintenance.admin_ops_api.requests.get", return_value=response) as get:
        payload = ops._collab_metrics()

    assert payload["status"] == "ok"
    assert payload["timeout_ms"] == 800
    assert get.call_args.kwargs["timeout"] == 0.8


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "admin-ops-tests"}}
)
def test_celery_worker_snapshot_uses_short_cache():
    cache.clear()
    with patch(
        "apps.maintenance.admin_ops_api._celery_worker_snapshot_uncached",
        return_value={"status": "ok", "worker_count": 3},
    ) as uncached:
        first = ops._celery_worker_snapshot()
        second = ops._celery_worker_snapshot()

    assert first["worker_count"] == 3
    assert second["worker_count"] == 3
    uncached.assert_called_once()


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "admin-ops-tests"}}
)
def test_celery_queue_health_reuses_worker_snapshot_within_request():
    cache.clear()
    request = _request()
    worker_payload = {
        "status": "ok",
        "worker_count": 1,
        "active_task_count": 0,
        "queue_worker_counts": {"default": 1},
        "queue_active_task_counts": {"default": 0},
        "workers": [],
    }
    with patch("apps.maintenance.admin_ops_api.cache.get", return_value=None), \
         patch("apps.maintenance.admin_ops_api.cache.set") as cache_set, \
         patch("apps.maintenance.admin_ops_api._celery_worker_snapshot_uncached", return_value=worker_payload) as uncached, \
         patch("apps.maintenance.admin_ops_api._celery_queue_lengths", return_value={queue: 0 for queue in ops.OPS_KNOWN_CELERY_QUEUES}), \
         patch("apps.maintenance.admin_ops_api._celery_failure_summary", return_value={"failed_sample_count": 0, "top_failed_task_names": [], "failed_concentrated": False}):
        queue_health = ops._celery_queue_health(request)
        worker_snapshot = ops._celery_worker_snapshot(request)

    assert queue_health["key_metrics"]["worker_count"] == 1
    assert worker_snapshot["worker_count"] == 1
    uncached.assert_called_once()
    cache_set.assert_called_once()


def test_celery_queue_health_does_not_copy_global_failures_to_each_queue():
    worker_payload = {
        "status": "ok",
        "worker_count": 1,
        "active_task_count": 0,
        "queue_worker_counts": {"default": 1},
        "queue_active_task_counts": {"default": 0},
        "workers": [],
    }
    global_failures = {
        "failed_sample_count": 99,
        "global_failed_sample_count": 99,
        "failure_attribution": "global_only",
        "top_failed_task_names": [{"task_name": "unknown.task", "count": 99}],
        "top_error_summaries": [{"error": "boom", "count": 99}],
        "queue_failures": {},
        "failed_concentrated": True,
    }
    with patch("apps.maintenance.admin_ops_api._celery_worker_snapshot", return_value=worker_payload), \
         patch("apps.maintenance.admin_ops_api._celery_queue_lengths", return_value={queue: 0 for queue in ops.OPS_KNOWN_CELERY_QUEUES}), \
         patch("apps.maintenance.admin_ops_api._celery_failure_summary", return_value=global_failures):
        payload = ops._celery_queue_health()

    default_queue = next(row for row in payload["queues"] if row["queue_name"] == "default")
    assert default_queue["status"] == "ok"
    assert default_queue["failed_sample_count"] == 0
    assert default_queue["failure_attribution"] == "none"
    assert payload["global_failed_sample_count"] == 99


def test_celery_queue_health_counts_only_mapped_queue_failures():
    worker_payload = {
        "status": "ok",
        "worker_count": 1,
        "active_task_count": 0,
        "queue_worker_counts": {"default": 1},
        "queue_active_task_counts": {"default": 0},
        "workers": [],
    }
    mapped_failures = {
        "failed_sample_count": 2,
        "global_failed_sample_count": 0,
        "failure_attribution": "queue_mapped",
        "top_failed_task_names": [{"task_name": "known.task", "count": 2}],
        "top_error_summaries": [{"error": "boom", "count": 2}],
        "queue_failures": {
            "default": {
                "failed_sample_count": 2,
                "top_failed_task_names": [{"task_name": "known.task", "count": 2}],
                "top_error_summaries": [{"error": "boom", "count": 2}],
                "failure_attribution": "queue_mapped",
                "failure_attribution_source": "Celery task_routes",
                "max_retry_count": 0,
            }
        },
        "failed_concentrated": True,
    }
    with patch("apps.maintenance.admin_ops_api._celery_worker_snapshot", return_value=worker_payload), \
         patch("apps.maintenance.admin_ops_api._celery_queue_lengths", return_value={queue: 0 for queue in ops.OPS_KNOWN_CELERY_QUEUES}), \
         patch("apps.maintenance.admin_ops_api._celery_failure_summary", return_value=mapped_failures):
        payload = ops._celery_queue_health()

    default_queue = next(row for row in payload["queues"] if row["queue_name"] == "default")
    heavy_queue = next(row for row in payload["queues"] if row["queue_name"] == "heavy")
    assert default_queue["status"] == "task_failed"
    assert default_queue["failed_sample_count"] == 2
    assert default_queue["failure_attribution_source"] == "Celery task_routes"
    assert heavy_queue["failed_sample_count"] == 0


def test_celery_queue_health_marks_high_retry_mapped_failures_as_program_error():
    worker_payload = {
        "status": "ok",
        "worker_count": 1,
        "active_task_count": 0,
        "queue_worker_counts": {"default": 1},
        "queue_active_task_counts": {"default": 0},
        "workers": [],
    }
    mapped_failures = {
        "failed_sample_count": 1,
        "global_failed_sample_count": 0,
        "failure_attribution": "queue_mapped",
        "queue_failures": {
            "default": {
                "failed_sample_count": 1,
                "top_failed_task_names": [{"task_name": "known.task", "count": 1}],
                "top_error_summaries": [{"error": "boom", "count": 1}],
                "failure_attribution": "queue_mapped",
                "failure_attribution_source": "Celery task_routes",
                "max_retry_count": 3,
            }
        },
    }
    with patch("apps.maintenance.admin_ops_api._celery_worker_snapshot", return_value=worker_payload), \
         patch("apps.maintenance.admin_ops_api._celery_queue_lengths", return_value={queue: 0 for queue in ops.OPS_KNOWN_CELERY_QUEUES}), \
         patch("apps.maintenance.admin_ops_api._celery_failure_summary", return_value=mapped_failures):
        payload = ops._celery_queue_health()

    default_queue = next(row for row in payload["queues"] if row["queue_name"] == "default")
    assert default_queue["status"] == "program_error"


def test_stability_overview_does_not_write_troubleshoot_log():
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._cached_overview", return_value={"status": "ok"}):
        ops.stability_overview(_request(), reason="check stability", ticket_id="OPS-1")

    create.assert_not_called()


def test_tasks_list_does_not_write_troubleshoot_log():
    qs = Mock()
    qs.filter.return_value = qs
    qs.order_by.return_value.values.return_value = object()
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api.FailedTaskRecord.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)), \
         patch("apps.maintenance.admin_ops_api._safe_part", return_value={"status": "ok", "data": {}}):
        ops.ops_tasks(_request(), reason="check tasks", ticket_id="OPS-1")

    create.assert_not_called()


def test_search_outbox_does_not_write_troubleshoot_log():
    qs = Mock()
    qs.filter.return_value = qs
    qs.order_by.return_value.values.return_value = object()
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api.FtsOutboxPg.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._fts_outbox_groups", return_value=[]), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)):
        ops.ops_search_outbox(
            _request(),
            db="pg",
            status="pending",
            reason="check outbox",
            ticket_id="OPS-1",
        )

    create.assert_not_called()


def test_ws_overview_does_not_write_troubleshoot_log():
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._cached_overview", return_value={"status": "ok"}):
        ops.ws_gateway_overview(_request(), reason="check ws", ticket_id="OPS-1")

    create.assert_not_called()


def test_centrifugo_overview_does_not_write_troubleshoot_log():
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._cached_overview", return_value={"status": "ok"}):
        ops.centrifugo_overview(_request(), reason="check centrifugo", ticket_id="OPS-1")

    create.assert_not_called()


def test_collab_overview_does_not_write_troubleshoot_log():
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._cached_overview", return_value={"status": "ok"}):
        ops.collab_overview(_request(), reason="check collab", ticket_id="OPS-1")

    create.assert_not_called()


def test_user_summary_writes_troubleshoot_log():
    user = Mock()
    user.id = "user-1"
    user.username = "alice"
    user.email = "alice@example.com"
    user.phone = "13800138000"
    user.is_active = True
    user.is_staff = False
    user.date_joined = timezone.now()
    user.last_login = None
    user.get_display_name.return_value = "Alice"

    user_qs = Mock()
    user_qs.only.return_value.first.return_value = user
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api.User.objects.filter", return_value=user_qs):
        ops.user_summary(_request(), "user-1", reason="diagnose user", ticket_id="OPS-1")

    create.assert_called_once()
    assert create.call_args.kwargs["target_user_id"] == "user-1"
    assert create.call_args.kwargs["actor_admin_account_id"] is None


def test_user_timeline_writes_troubleshoot_log():
    qs = Mock()
    qs.filter.return_value = qs
    qs.order_by.return_value.values.return_value = object()
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.users.auth.models.UserActionLog.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)):
        ops.user_timeline(_request(), "user-1", module="auth", reason="diagnose user", ticket_id="OPS-1")

    create.assert_called_once()
    assert create.call_args.kwargs["target_user_id"] == "user-1"


def test_finance_trace_writes_troubleshoot_log():
    order_qs = Mock()
    order_qs.values.return_value.first.return_value = None
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.services.payment.models.PaymentOrder.objects.filter", return_value=order_qs):
        with pytest.raises(HttpError):
            ops.finance_order_trace(_request(), "ORDER-1", reason="trace order", ticket_id="OPS-1")

    create.assert_called_once()
    assert create.call_args.kwargs["target_entity_type"] == "payment_order"
    assert create.call_args.kwargs["target_entity_id"] == "ORDER-1"


def test_audit_events_sensitive_filter_writes_troubleshoot_log():
    qs = Mock()
    qs.filter.return_value = qs
    qs.order_by.return_value.values.return_value = object()
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._audit_source_queryset", return_value=(qs, ("created_at",))), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)):
        ops.audit_events(
            _request(),
            source="ops",
            target_user_id="user-1",
            reason="audit sensitive query",
            ticket_id="OPS-1",
        )

    create.assert_called_once()
    assert create.call_args.kwargs["target_user_id"] == "user-1"


def test_audit_events_without_sensitive_filter_does_not_write_troubleshoot_log():
    qs = Mock()
    qs.order_by.return_value.values.return_value = object()
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._audit_source_queryset", return_value=(qs, ("created_at",))), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)):
        ops.audit_events(
            _request(),
            source="ops",
            reason="audit broad query",
            ticket_id="OPS-1",
        )

    create.assert_not_called()


def test_actor_admin_account_id_is_null_without_admin_account_model():
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create:
        ops._audit_query(
            _request(),
            query_type="ops_user_summary",
            reason="diagnose user",
            ticket_id="OPS-1",
            target_user_id="user-1",
        )

    assert create.call_args.kwargs["actor_user_id"] == "admin-user-1"
    assert create.call_args.kwargs["actor_admin_account_id"] is None

import os
from unittest.mock import Mock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

from apps.maintenance import admin_ops_api as ops


def _request():
    request = Mock()
    request.auth.id = "admin-user-1"
    request.auth.is_superuser = True
    request.META = {"REMOTE_ADDR": "127.0.0.1", "HTTP_USER_AGENT": "pytest"}
    return request


def test_celery_queue_classifies_backlog_without_worker_as_critical_for_default():
    result = ops._classify_celery_queue(
        queue_name="default",
        backlog_count=10,
        worker_count=0,
        active_task_count=0,
        failed_count=0,
        max_retry_count=0,
    )

    assert result["status"] == "critical"
    assert result["exception_classification"] == "worker 不消费"
    assert result["status_reason"] == "backlog_without_worker"


def test_celery_queue_classifies_mapped_failure_as_task_failed():
    result = ops._classify_celery_queue(
        queue_name="heavy",
        backlog_count=0,
        worker_count=1,
        active_task_count=0,
        failed_count=1,
        max_retry_count=0,
    )

    assert result["status"] == "task_failed"
    assert result["exception_classification"] == "任务失败"


def test_fts_group_classifies_old_pending_and_repeated_failures():
    old_pending = ops._classify_fts_group(
        {
            "pending_count": 1,
            "failed_count": 0,
            "oldest_pending_age_seconds": 7200,
            "max_retry_count": 0,
        }
    )
    repeated_failure = ops._classify_fts_group(
        {
            "pending_count": 0,
            "failed_count": 3,
            "oldest_pending_age_seconds": None,
            "max_retry_count": 3,
            "latest_error_masked": "mapping error",
        }
    )

    assert old_pending["status"] == "needs_attention"
    assert old_pending["status_reason"] == "最老 pending 已超过 600 秒"
    assert repeated_failure["status"] == "program_error"
    assert repeated_failure["exception_classification"] == "程序错误"


def test_ws_lookup_endpoint_is_readonly_and_writes_sensitive_audit_log():
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._ws_gateway_metrics", return_value={"status": "unknown"}) as metrics:
        payload = ops.ws_gateway_overview(
            _request(),
            reason="check user reconnect",
            ticket_id="OPS-1",
            user_id="user-1",
        )

    create.assert_called_once()
    metrics.assert_called_once()
    assert payload["status"] == "unknown"


def test_centrifugo_lookup_writes_sensitive_audit_log():
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._centrifugo_metrics", return_value={"status": "ok"}) as metrics:
        payload = ops.centrifugo_overview(
            _request(),
            reason="check channel presence",
            ticket_id="OPS-1",
            channel="personal:user-1",
        )

    create.assert_called_once()
    metrics.assert_called_once_with(channel="personal:user-1", user_id="")
    assert create.call_args.kwargs["target_entity_type"] == "centrifugo_channel"
    assert payload["status"] == "ok"


def test_collab_lookup_writes_sensitive_audit_log_for_user_only_query():
    with patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create, \
         patch("apps.maintenance.admin_ops_api._collab_metrics", return_value={"status": "unknown"}) as metrics:
        payload = ops.collab_overview(
            _request(),
            reason="check user reconnect",
            ticket_id="OPS-1",
            user_id="user-1",
        )

    create.assert_called_once()
    metrics.assert_called_once_with(document_id="", table_id="", slide_id="", user_id="user-1")
    assert create.call_args.kwargs["target_entity_type"] == "collab_user"
    assert create.call_args.kwargs["target_user_id"] == "user-1"
    assert payload["status"] == "unknown"


def test_readonly_lookup_masks_identifiers():
    payload = ops._readonly_lookup_payload(
        "ws_gateway_connection",
        {"user_id": "alice@example.com", "connection_id": "conn-1"},
        status_reason="metrics_only",
    )

    assert payload["status"] == "unknown"
    assert payload["identifiers"]["user_id"] == "a***@example.com"
    assert payload["identifiers"]["connection_id"] == "conn-1"

import os
import inspect
from datetime import timedelta
from unittest.mock import Mock, patch

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
    request.META = {
        "REMOTE_ADDR": "127.0.0.1",
        "HTTP_USER_AGENT": "pytest",
        "HTTP_X_REQUEST_ID": "req-fts",
    }
    return request


def _qs():
    qs = Mock()
    qs.filter.return_value = qs
    qs.exclude.return_value = qs
    qs.order_by.return_value.values.return_value = object()
    return qs


def test_row_status_inference_covers_pending_processed_failed_and_old_pending():
    now = timezone.now()

    assert ops._fts_row_status(
        {
            "processed_at": None,
            "retry_count": 0,
            "last_error": "",
            "created_at": now,
        },
        now=now,
    )["status"] == ops.FtsOutboxStatus.PENDING
    assert ops._fts_row_status({"processed_at": now}, now=now)["status"] == ops.FtsOutboxStatus.PROCESSED
    assert ops._fts_row_status(
        {
            "processed_at": None,
            "retry_count": 3,
            "last_error": "mapping error",
            "created_at": now,
        },
        now=now,
    )["status"] == ops.FtsOutboxStatus.FAILED
    assert ops._fts_row_status(
        {
            "processed_at": None,
            "retry_count": 0,
            "last_error": "",
            "created_at": now - timedelta(seconds=ops.FTS_OLD_PENDING_THRESHOLD_SECONDS + 1),
        },
        now=now,
    )["status"] == ops.FtsOutboxStatus.OLD_PENDING


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"pending_count": 0, "failed_count": 0}, "normal"),
        ({"pending_count": 1, "failed_count": 0, "oldest_pending_age_seconds": 30}, "normal_backlog"),
        (
            {
                "pending_count": 1,
                "failed_count": 0,
                "oldest_pending_age_seconds": ops.FTS_OLD_PENDING_THRESHOLD_SECONDS + 1,
            },
            "needs_attention",
        ),
        ({"pending_count": 0, "failed_count": 2, "latest_error_masked": "mapping error", "max_retry_count": 1}, "program_error"),
        ({"pending_count": 3, "failed_count": 1, "repeated_doc_problem": True}, "data_problem"),
    ],
)
def test_group_status_inference(payload, expected):
    assert ops._fts_group_status(payload)["status"] == expected


def test_rows_api_is_readonly_and_caps_page_size():
    row = {
        "id": 10,
        "index_name": "tabtin-documents",
        "doc_id": "doc-1",
        "action": "upsert",
        "organization_id": "team-1",
        "created_at": timezone.now(),
        "processed_at": None,
        "retry_count": 0,
        "last_error": "",
    }
    qs = _qs()
    with patch("apps.maintenance.admin_ops_api.FtsOutboxPg.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([row], False)) as values_page, \
         patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create:
        response = ops.ops_search_outbox_rows(
            _request(),
            db="postgresql",
            status="pending",
            page_size=500,
        )

    create.assert_not_called()
    assert values_page.call_args.kwargs["page_size"] == 100
    assert response["items"][0]["status"] == "pending"
    assert response["items"][0]["db"] == "postgresql"
    assert response["items"][0]["workteam_id"] == "team-1"


def test_groups_api_is_readonly_for_plain_aggregate():
    with patch("apps.maintenance.admin_ops_api._fts_outbox_groups", return_value=([{"db": "postgresql", "index_name": "idx", "action": "upsert"}], False)), \
         patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create:
        response = ops.ops_search_outbox_groups(_request(), db="all")

    create.assert_not_called()
    assert response["items"][0]["index_name"] == "idx"
    assert response["has_more"] is False


def test_groups_api_audits_workteam_filter():
    with patch("apps.maintenance.admin_ops_api._fts_outbox_groups", return_value=([], False)), \
         patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create:
        ops.ops_search_outbox_groups(
            _request(),
            db="postgresql",
            workteam_id="team-1",
            reason="diagnose search sync",
            ticket_id="OPS-FTS-1",
        )

    create.assert_called_once()
    assert create.call_args.kwargs["query_type"] == "fts_outbox_diagnose"
    assert create.call_args.kwargs["target_entity_type"] == "workteam"
    assert create.call_args.kwargs["target_organization_id"] == "team-1"


def test_rows_api_audits_doc_filter():
    qs = _qs()
    with patch("apps.maintenance.admin_ops_api.FtsOutboxPg.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api._values_page", return_value=([], False)), \
         patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create:
        ops.ops_search_outbox_rows(
            _request(),
            db="postgresql",
            doc_id="doc-1",
            reason="diagnose search sync",
            ticket_id="OPS-FTS-1",
        )

    create.assert_called_once()
    assert create.call_args.kwargs["target_entity_type"] == "doc"
    assert create.call_args.kwargs["target_entity_id"] == "doc-1"


def test_detail_api_is_readonly_and_audits_row_identifiers():
    row = {
        "id": 10,
        "index_name": "tabtin-documents",
        "doc_id": "doc-1",
        "action": "upsert",
        "organization_id": "team-1",
        "created_at": timezone.now(),
        "processed_at": None,
        "retry_count": 3,
        "last_error": "mapping error for alice@example.com token=secret",
    }
    qs = Mock()
    qs.values.return_value.first.return_value = row
    with patch("apps.maintenance.admin_ops_api.FtsOutboxPg.objects.filter", return_value=qs), \
         patch("apps.maintenance.admin_ops_api.OpsTroubleshootQueryLog.objects.create") as create:
        response = ops.ops_search_outbox_row_detail(
            _request(),
            db="postgresql",
            row_id=10,
            reason="diagnose search sync",
            ticket_id="OPS-FTS-1",
        )

    create.assert_called_once()
    assert response["row"]["status"] == "failed"
    assert response["row"]["last_error_masked"] == "[masked]"
    assert response["actions"]["forbidden"] == ["全量 reindex", "批量 requeue", "批量 delete", "mark processed"]


def test_sensitive_detail_requires_reason():
    row = {
        "id": 10,
        "index_name": "tabtin-documents",
        "doc_id": "doc-1",
        "action": "upsert",
        "organization_id": "team-1",
        "created_at": timezone.now(),
        "processed_at": None,
        "retry_count": 0,
        "last_error": "",
    }
    qs = Mock()
    qs.values.return_value.first.return_value = row
    with patch("apps.maintenance.admin_ops_api.FtsOutboxPg.objects.filter", return_value=qs):
        with pytest.raises(HttpError) as exc:
            ops.ops_search_outbox_row_detail(_request(), db="postgresql", row_id=10)

    assert exc.value.status_code == 400
    assert "reason" in str(exc.value)


def test_last_error_masking_does_not_mask_plain_error_code():
    row = {
        "id": 1,
        "db": "postgresql",
        "index_name": "idx",
        "doc_id": "doc",
        "action": "upsert",
        "created_at": timezone.now(),
        "processed_at": None,
        "retry_count": 1,
        "last_error": "MAPPER_PARSING_EXCEPTION",
    }

    assert ops._fts_values_row(row, db="postgresql")["last_error_masked"] == "MAPPER_PARSING_EXCEPTION"


def test_last_error_masking_covers_urls_jwt_bearer_and_verification_code():
    raw = (
        "failed https://internal.example.com/private/a "
        "Bearer abcdefghijklmnopqrstuvwxyz "
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature "
        "验证码 123456"
    )

    masked = ops._fts_mask_error(raw)

    assert "internal.example.com" not in masked
    assert "abcdefghijklmnopqrstuvwxyz" not in masked
    assert "eyJhbGci" not in masked
    assert "123456" not in masked
    assert "[masked-url]" in masked
    assert "[masked-jwt]" in masked
    assert "[masked-code]" in masked


def test_no_new_permission_or_table_shape_for_search_outbox():
    assert ops.P0_PERMISSION_CODES["search_outbox"] == "ops_search_outbox:view"
    assert ("ops_search_outbox:view", "Can view Ops search outbox") in OpsTroubleshootQueryLog._meta.permissions
    field_names = {field.name for field in OpsTroubleshootQueryLog._meta.fields}
    assert "target_entity_id" in field_names
    assert "fts_outbox_id" not in field_names


def test_admin_ops_api_does_not_query_removed_workteam_fields():
    """物理字段已改为 organization_id；workteam_id 只能作为 API 兼容别名。"""
    source = inspect.getsource(ops)

    assert "filter(workteam_id=" not in source
    assert '"workteam_id", "user_id"' not in source
    assert '"workteam_id", "metadata"' not in source
    assert '"workteam_id", "last_error"' not in source
    assert "WORKTEAM_ID_MAX_LEN" not in source

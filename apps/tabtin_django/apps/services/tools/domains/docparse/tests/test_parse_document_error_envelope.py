"""parse_document：失败路径走共享 error_envelope（破坏性，无旧 shape 兼容）。"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from apps.services.tools.domains.docparse.document_read import DocumentReadTool
from apps.services.tools.error_envelope import is_standard_tool_error


def _payload(raw: str) -> dict:
    return json.loads(raw)


def test_parse_document_missing_identity_uses_standard_envelope():
    tool = DocumentReadTool()
    payload = _payload(tool.run(file_id="f1", user_id=None, organization_id=None))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] in {"auth_failed", "runtime_misconfig"}
    assert payload["hint"].strip()
    assert "message" not in payload  # 旧 message 字段不再作为失败主字段


def test_parse_document_file_not_found_uses_standard_envelope():
    tool = DocumentReadTool()
    with patch(
        "apps.services.oss.models.FileRecord.objects.filter",
        return_value=MagicMock(first=MagicMock(return_value=None)),
    ):
        payload = _payload(
            tool.run(file_id="missing-id", user_id="user-1", organization_id=None)
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "resource_not_found"
    assert "file" in payload["hint"].lower() or "file_id" in payload["hint"]


def test_parse_document_parsing_status_uses_document_not_ready():
    tool = DocumentReadTool()
    doc = MagicMock()
    doc.status = "parsing"
    doc.parsed_pages = 2
    doc.total_pages = 10
    # Status enum values used by _check_parse_status
    from apps.services.docparse.models import ParsedDocument

    doc.status = ParsedDocument.Status.PARSING

    fr = MagicMock()
    fr.upload_user = "user-1"
    fr.organization_id = None

    with patch(
        "apps.services.oss.models.FileRecord.objects.filter",
        return_value=MagicMock(first=MagicMock(return_value=fr)),
    ), patch(
        "apps.services.docparse.models.ParsedDocument.objects.filter",
        return_value=MagicMock(first=MagicMock(return_value=doc)),
    ):
        payload = _payload(
            tool.run(file_id="f1", user_id="user-1", organization_id=None)
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "document_not_ready"
    assert payload.get("retryable") is True
    assert payload.get("status") == "parsing"
    assert "retry" in payload["hint"].lower() or "重试" in payload["hint"]


def test_parse_document_failed_status_does_not_log_parser_secret():
    secret = "s3://access:token@bucket/SECRET_PARSE_DSN"
    doc = MagicMock()
    from apps.services.docparse.models import ParsedDocument

    doc.status = ParsedDocument.Status.FAILED
    doc.error_message = secret
    fr = MagicMock(upload_user="user-1", organization_id=None)

    with patch(
        "apps.services.oss.models.FileRecord.objects.filter",
        return_value=MagicMock(first=MagicMock(return_value=fr)),
    ), patch(
        "apps.services.docparse.models.ParsedDocument.objects.filter",
        return_value=MagicMock(first=MagicMock(return_value=doc)),
    ), patch(
        "apps.services.tools.domains.docparse.document_read.logger.warning",
    ) as log_warning:
        payload = _payload(
            DocumentReadTool().run(
                file_id="f1",
                user_id="user-1",
                organization_id=None,
            )
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "upstream_error"
    assert secret not in str(payload)
    assert log_warning.call_count == 1
    assert secret not in str(log_warning.call_args_list)

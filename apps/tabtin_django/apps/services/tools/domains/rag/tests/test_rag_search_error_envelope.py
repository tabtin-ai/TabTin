"""rag_search：失败路径走共享 error_envelope（破坏性，无旧 shape 兼容）。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from apps.services.tools.domains.rag.rag_search import RagSearchTool
from apps.services.tools.error_envelope import is_standard_tool_error


def test_rag_search_empty_query_uses_standard_envelope():
    tool = RagSearchTool()
    payload = tool.run(query="   ", user_id="user-1")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "missing_required_param"
    assert "query" in payload["hint"].lower()
    assert payload.get("retryable") is False
    assert "success" in payload and payload["success"] is False
    # 旧 shape 不得残留为唯一可读字段
    assert set(payload) >= {"success", "error", "error_kind", "hint"}


def test_rag_search_missing_user_id_uses_standard_envelope():
    tool = RagSearchTool()
    payload = tool.run(query="hello", user_id=None)
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert "user" in payload["hint"].lower() or "user_id" in payload["hint"]


def test_rag_search_organization_scope_without_id_uses_standard_envelope():
    tool = RagSearchTool()
    payload = tool.run(
        query="test query",
        scope="organization",
        scope_id=None,
        user_id="user-123",
        organization_id=None,
    )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert "organization_id" in payload["error"].lower()
    assert "organization_id" in payload["hint"]


def test_rag_search_service_exception_is_sanitized():
    secret = "postgresql://user:pass@db/SECRET_DB_DSN"
    service = MagicMock()
    service.search.side_effect = RuntimeError(f"connection failed: {secret}")

    with patch(
        "apps.rag.services.unified_search_service.get_unified_search_service",
        return_value=service,
    ), patch(
        "apps.services.tools.domains.rag.rag_search.logger.error",
    ) as log_error:
        payload = RagSearchTool().run(
            query="hello",
            user_id="user-1",
            organization_id="org-1",
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "upstream_error"
    assert payload["retryable"] is True
    assert secret not in str(payload)
    assert "details" not in payload
    assert log_error.call_count == 1
    assert secret not in str(log_error.call_args_list)


def test_rag_search_context_assembly_exception_is_sanitized():
    secret = "postgresql://user:pass@db/SECRET_DB_DSN"
    service = MagicMock()
    service.search.return_value = {
        "hits": [{"content_type": "document", "content": "safe"}],
    }
    context_service = MagicMock()
    context_service.build_unified_context.side_effect = RuntimeError(secret)

    with patch(
        "apps.rag.services.unified_search_service.get_unified_search_service",
        return_value=service,
    ), patch(
        "apps.rag.services.ContextService",
        return_value=context_service,
    ), patch(
        "apps.services.tools.domains.rag.rag_search.logger.error",
    ) as log_error:
        payload = RagSearchTool().run(
            query="hello",
            user_id="user-1",
            organization_id="org-1",
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "internal_error"
    assert payload["retryable"] is True
    assert secret not in str(payload)
    assert "details" not in payload
    assert log_error.call_count == 1
    assert secret not in str(log_error.call_args_list)


def test_ensure_table_index_exception_returns_sanitized_warning():
    secret = "redis://:password@cache/SECRET_REDIS_DSN"

    with patch(
        "apps.rag.models.TableEmbedding.objects.filter",
        return_value=MagicMock(exists=MagicMock(return_value=False)),
    ), patch(
        "apps.rag.models.RecordEmbedding.objects.filter",
        return_value=MagicMock(exists=MagicMock(return_value=False)),
    ), patch(
        "apps.rag.models.EmbeddingTask.objects.filter",
        return_value=MagicMock(exists=MagicMock(return_value=False)),
    ), patch(
        "django.core.cache.cache.add",
        side_effect=RuntimeError(secret),
    ), patch(
        "apps.services.tools.domains.rag.rag_search.logger.error",
    ) as log_error:
        triggered, warning = RagSearchTool._ensure_table_index("table-1")

    assert triggered is False
    assert warning == "Index availability check failed; search may use stale results."
    assert secret not in warning
    assert log_error.call_count == 1
    assert secret not in str(log_error.call_args_list)

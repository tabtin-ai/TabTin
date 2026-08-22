"""Retirement contract for the former TabCode vector-search endpoints."""

from unittest.mock import MagicMock, patch

from apps.rag.schemas import CodeIndexDeleteRequest, CodeIndexRequest, CodeSyncRequest
from apps.rag.schemas_v2 import UnifiedSearchRequest


def _request():
    request = MagicMock()
    request.auth.id = "user-1"
    return request


def test_code_index_producer_endpoints_return_gone_without_touching_producers():
    from apps.rag.api import submit_code_chunks, sync_code_index

    request = _request()
    index_payload = CodeIndexRequest(
        project_id="project-1",
        organization_id="00000000-0000-0000-0000-000000000001",
        chunks=[{
            "file_path": "src/main.py",
            "start_line": 1,
            "end_line": 1,
            "content": "print('hello')",
            "language": "python",
        }],
    )
    sync_payload = CodeSyncRequest(project_id="project-1", file_hashes={})

    for handler, payload in (
        (submit_code_chunks, index_payload),
        (sync_code_index, sync_payload),
    ):
        status, response = handler(request, payload)
        assert status == 410
        assert response.error == "code_semantic_search_retired"


@patch("apps.rag.services.unified_search_service.UnifiedSearchService.search")
@patch("apps.services.llm.services.embedding.embed_text")
def test_unified_code_search_returns_gone_before_embedding(mock_embed, mock_search):
    from apps.rag.api import unified_search_api

    payload = UnifiedSearchRequest(query="where is auth", content_types=["code"])
    status, response = unified_search_api(_request(), payload)

    assert status == 410
    assert response.error == "code_semantic_search_retired"
    mock_embed.assert_not_called()
    mock_search.assert_not_called()


@patch("apps.rag.api._check_rag_enabled", return_value=None)
@patch("apps.rag.services.unified_search_service.UnifiedSearchService.search")
def test_unified_mixed_search_ignores_retired_code_type(mock_search, _mock_rag_enabled):
    from apps.rag.api import unified_search_api

    mock_search.return_value = {
        "query": "where is auth",
        "hits": [],
        "total": 0,
        "type_counts": {},
        "response_time_ms": 1,
    }
    payload = UnifiedSearchRequest(
        query="where is auth",
        content_types=["document", "code"],
    )

    status, _response = unified_search_api(_request(), payload)

    assert status == 200
    assert mock_search.call_args.kwargs["content_types"] == ["document"]


def test_available_types_excludes_code():
    from apps.rag.services.unified_search_service import UnifiedSearchService

    assert "code" not in UnifiedSearchService().get_available_types()


def test_retired_task_cleans_staging_key_without_writing_embeddings():
    from apps.rag.tasks import index_code_chunks_task

    redis = MagicMock()
    with patch("django_redis.get_redis_connection", return_value=redis):
        result = index_code_chunks_task.run(
            project_id="project-1",
            organization_id="00000000-0000-0000-0000-000000000001",
            chunks_staging_key="rag:chunks_staging:test",
        )

    assert result["retired"] is True
    redis.delete.assert_called_once_with("rag:chunks_staging:test")


@patch("apps.rag.api._get_accessible_organization_ids")
@patch("apps.rag.tasks.delete_code_project_index.delay")
@patch("apps.rag.models.CodeChunkEmbedding")
def test_retained_code_index_delete_remains_available(
    model,
    mock_delay,
    mock_accessible,
):
    from apps.rag.api import delete_code_index

    organization_id = "00000000-0000-0000-0000-000000000001"
    mock_accessible.return_value = {organization_id}
    mock_delay.return_value.id = "delete-task-1"
    model.objects.filter.return_value.only.return_value.first.return_value.organization_id = (
        organization_id
    )
    payload = CodeIndexDeleteRequest(
        project_id="project-1",
        organization_id=organization_id,
        file_paths=["src/main.py"],
    )

    status, response = delete_code_index(_request(), payload)

    assert status == 200
    assert response.data == {"task_id": "delete-task-1"}
    mock_delay.assert_called_once_with(
        project_id="project-1",
        organization_id=organization_id,
        file_paths=["src/main.py"],
    )


@patch("apps.rag.api._get_accessible_organization_ids")
@patch("apps.rag.tasks.delete_code_project_index.delay")
@patch("apps.rag.models.CodeChunkEmbedding")
def test_retained_code_index_delete_rejects_mismatched_organization(
    model,
    mock_delay,
    mock_accessible,
):
    from apps.rag.api import delete_code_index

    requested_organization_id = "00000000-0000-0000-0000-000000000001"
    model.objects.filter.return_value.only.return_value.first.return_value.organization_id = (
        "00000000-0000-0000-0000-000000000002"
    )
    mock_accessible.return_value = {requested_organization_id}
    payload = CodeIndexDeleteRequest(
        project_id="project-1",
        organization_id=requested_organization_id,
    )

    status, response = delete_code_index(_request(), payload)

    assert status == 403
    assert response.error == "forbidden"
    mock_delay.assert_not_called()


def test_retained_code_index_delete_task_removes_vectors_in_batches():
    from apps.rag.tasks import delete_code_project_index

    queryset = MagicMock()
    organization_queryset = MagicMock()
    page = MagicMock()
    page.__getitem__.side_effect = [["chunk-1", "chunk-2"], []]
    organization_queryset.values_list.return_value = page
    queryset.filter.return_value = organization_queryset
    delete_queryset = MagicMock()

    with patch("apps.rag.models.CodeChunkEmbedding") as model, \
         patch("apps.rag.tasks._acquire_target_lock", return_value="lock-token") as acquire, \
        patch("apps.rag.tasks._release_target_lock") as release:
        model.objects.filter.side_effect = [queryset, delete_queryset]
        result = delete_code_project_index.run(
            project_id="project-1",
            organization_id="organization-1",
        )

    assert result == {"deleted": 2, "project_id": "project-1"}
    acquire.assert_called_once_with("code", "project-1", ttl=600)
    model.objects.filter.assert_any_call(project_id="project-1")
    queryset.filter.assert_called_once_with(organization_id="organization-1")
    model.objects.filter.assert_any_call(id__in=["chunk-1", "chunk-2"])
    delete_queryset.delete.assert_called_once_with()
    release.assert_called_once_with("code", "project-1", "lock-token")


def test_stale_delete_task_without_organization_remains_compatible():
    from apps.rag.tasks import delete_code_project_index

    queryset = MagicMock()
    page = MagicMock()
    page.__getitem__.side_effect = [["chunk-1"], []]
    queryset.values_list.return_value = page
    delete_queryset = MagicMock()

    with patch("apps.rag.models.CodeChunkEmbedding") as model, \
         patch("apps.rag.tasks._acquire_target_lock", return_value="lock-token"), \
         patch("apps.rag.tasks._release_target_lock"):
        model.objects.filter.side_effect = [queryset, delete_queryset]
        result = delete_code_project_index.run(project_id="project-1")

    assert result == {"deleted": 1, "project_id": "project-1"}
    queryset.filter.assert_not_called()
    delete_queryset.delete.assert_called_once_with()

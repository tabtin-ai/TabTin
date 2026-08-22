import uuid
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch


class RagIndexRoutingDisabledTests(TestCase):
    def test_table_index_returns_skipped(self):
        from apps.rag.services.index_service import IndexService
        from apps.services.llm.scenes.exceptions import SceneRoutingDisabled

        table = SimpleNamespace(
            id="table-1",
            name="Table",
            description="",
            organization_id="org-1",
            owner_id="user-1",
            space_id="space-1",
        )
        service = object.__new__(IndexService)
        service.embedding_service = MagicMock()
        service._build_table_text = MagicMock(return_value="table content")
        service._calculate_hash = MagicMock(return_value="hash")
        service._scene_embed = MagicMock(
            side_effect=SceneRoutingDisabled(scene_key="rag_index_table"),
        )

        with (
            patch("apps.tabdata.models.Table.objects.get", return_value=table),
            patch("apps.rag.models.TableEmbedding.objects.filter") as filter_mock,
        ):
            filter_mock.return_value.first.return_value = None
            result = service.index_table("table-1")

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "scene_routing_disabled")

    def test_document_batch_counts_disabled_route_as_skipped(self):
        from apps.services.llm.scenes.exceptions import SceneRoutingDisabled
        from apps.tabdoc.services.document_embedding_service import (
            DocumentEmbeddingService,
        )

        docs = [SimpleNamespace(
            id="doc-1",
            title="Doc",
            description_plaintext="content",
            description_json=None,
            organization_id="org-1",
            space_id="space-1",
            status="active",
            trashed_at=None,
            created_by_id="user-1",
        )]
        doc_qs = MagicMock()
        doc_qs.only.return_value = docs
        embedding_objects = MagicMock()
        embedding_objects.filter.return_value.first.return_value = None
        service = MagicMock()
        service.embed_texts.side_effect = SceneRoutingDisabled(
            scene_key="rag_index_document",
        )

        with (
            patch("apps.tabdoc.models.Document.objects.filter", return_value=doc_qs),
            patch("apps.rag.models.DocumentEmbedding.objects", embedding_objects),
            patch(
                "apps.rag.services.embedding_service.get_embedding_service",
                return_value=service,
            ),
            patch("apps.rag.utils.calculate_content_hash", return_value="hash"),
        ):
            result = DocumentEmbeddingService.index_documents_batch(["doc-1"])

        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["failed"], 0)

    def test_legacy_embedding_service_preserves_disabled_route(self):
        from apps.rag.services.embedding_service import EmbeddingService
        from apps.services.llm.scenes.exceptions import SceneRoutingDisabled

        service = EmbeddingService()
        disabled = SceneRoutingDisabled(scene_key="rag_search_query")

        with patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
            side_effect=disabled,
        ):
            with self.assertRaises(SceneRoutingDisabled):
                service._ensure_resolved()

    def test_table_task_cancels_skipped_index_without_retry(self):
        from apps.rag.tasks import index_table_task

        task_record = MagicMock()
        table_id = str(uuid.uuid4())

        with (
            patch("apps.rag.tasks._acquire_target_lock", return_value="lock"),
            patch("apps.rag.tasks._release_target_lock"),
            patch("apps.rag.tasks._resolve_table_organization", return_value=uuid.uuid4()),
            patch(
                "apps.rag.models.EmbeddingTask.objects.update_or_create",
                return_value=(task_record, True),
            ),
            patch(
                "apps.rag.services.IndexService.index_table",
                return_value={
                    "status": "skipped",
                    "reason": "scene_routing_disabled",
                },
            ),
            patch.object(index_table_task, "retry") as retry,
        ):
            result = index_table_task.__wrapped__(table_id)

        self.assertTrue(result["skipped"])
        self.assertEqual(task_record.status, "cancelled")
        task_record.mark_failed.assert_not_called()
        retry.assert_not_called()

    def test_record_task_cancels_skipped_index_without_retry(self):
        from apps.rag.tasks import embed_record_task

        task_record = MagicMock()
        record_id = str(uuid.uuid4())

        with (
            patch("apps.rag.tasks._acquire_record_lock", return_value="lock"),
            patch("apps.rag.tasks._release_record_lock"),
            patch("apps.rag.tasks._resolve_record_organization", return_value=uuid.uuid4()),
            patch(
                "apps.rag.models.EmbeddingTask.objects.update_or_create",
                return_value=(task_record, True),
            ),
            patch("apps.tabdata.models.TableRecord.objects.filter") as record_filter,
            patch(
                "apps.rag.services.IndexService.index_record",
                return_value={
                    "status": "skipped",
                    "reason": "scene_routing_disabled",
                },
            ),
            patch.object(embed_record_task, "retry") as retry,
        ):
            record_filter.return_value.exists.return_value = True
            result = embed_record_task.__wrapped__(record_id)

        self.assertTrue(result["skipped"])
        self.assertEqual(task_record.status, "cancelled")
        task_record.mark_failed.assert_not_called()
        retry.assert_not_called()

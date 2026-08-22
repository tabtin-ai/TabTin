from __future__ import annotations

from django.conf import settings
from django.test import SimpleTestCase, override_settings

from tabtin.runtime.validators import resolve_route_queue


class RagRouteToRagIndexingTests(SimpleTestCase):
    @override_settings(RAG_DEDICATED_QUEUE_ENABLED=True)
    def test_rag_routes_to_rag_indexing_when_flag_on(self):
        for task_name in [
            "rag.index_table_task",
            "rag.index_table_records_task",
            "rag.embed_record_task",
            "rag.flush_record_batch",
            "rag.incremental_index_all",
            "rag.reindex_failed_tasks",
        ]:
            with self.subTest(task_name=task_name):
                queue = resolve_route_queue(task_name, settings.CELERY_TASK_ROUTES)
                self.assertEqual(queue, "rag_indexing")


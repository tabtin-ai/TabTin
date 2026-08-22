from __future__ import annotations

from django.conf import settings
from django.test import SimpleTestCase

from tabtin.runtime.validators import resolve_route_queue


class CeleryRoutesMatchRegistryTests(SimpleTestCase):
    def test_realtime_task_not_on_default(self):
        queue = resolve_route_queue("channel_gateway.deliver_one_outbox", settings.CELERY_TASK_ROUTES)
        self.assertEqual(queue, "realtime_delivery")

    def test_wallet_short_name_tasks_route_to_critical(self):
        queue = resolve_route_queue(
            "wallet.reconcile_wallet_balances",
            settings.CELERY_TASK_ROUTES,
        )
        self.assertEqual(queue, "critical")

    def test_channel_gateway_inbound_tasks_route_to_realtime_delivery(self):
        for task_name in [
            "channel_gateway.process_inbound",
            "channel_gateway.flush_debounce",
        ]:
            with self.subTest(task_name=task_name):
                queue = resolve_route_queue(task_name, settings.CELERY_TASK_ROUTES)
                self.assertEqual(queue, "realtime_delivery")

    def test_channel_gateway_wildcard_route_is_not_allowed(self):
        self.assertNotIn("channel_gateway.*", settings.CELERY_TASK_ROUTES)

    def test_rag_task_not_on_heavy(self):
        queue = resolve_route_queue("rag.index_table_task", settings.CELERY_TASK_ROUTES)
        self.assertEqual(queue, "rag_indexing")

    def test_tabdata_compute_not_on_heavy(self):
        queue = resolve_route_queue("tabdata.compute_one_outbox", settings.CELERY_TASK_ROUTES)
        self.assertEqual(queue, "tabdata_compute")

    def test_doc_merge_not_on_heavy(self):
        queue = resolve_route_queue("tabdoc.merge_doc_for_document", settings.CELERY_TASK_ROUTES)
        self.assertEqual(queue, "doc_merge")

    def test_fts_keeps_search_indexing(self):
        queue = resolve_route_queue("apps.fts.tasks.flush_outbox_task", settings.CELERY_TASK_ROUTES)
        self.assertEqual(queue, "search_indexing")

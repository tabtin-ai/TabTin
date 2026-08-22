from __future__ import annotations

from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings

from apps.tabdoc.services.document_service import _schedule_doc_merge_debounce


class TabDocDebounceMergeTests(SimpleTestCase):
    @override_settings(TABDOC_DEBOUNCE_MERGE_ENABLED=False)
    def test_flag_off_does_not_enqueue_debounce_merge(self):
        with patch("apps.tabdoc.tasks.merge_doc_for_document.apply_async") as apply_async:
            _schedule_doc_merge_debounce("doc-1")

        apply_async.assert_not_called()

    @override_settings(TABDOC_DEBOUNCE_MERGE_ENABLED=True)
    def test_flag_on_debounces_and_enqueues_doc_merge(self):
        cache = Mock()
        cache.add.return_value = True
        with patch("apps.tabdoc.services.document_service.cache", cache, create=True), \
             patch("django.core.cache.cache", cache), \
             patch("apps.tabdoc.tasks.merge_doc_for_document.apply_async") as apply_async:
            _schedule_doc_merge_debounce("doc-1")

        cache.add.assert_called_once()
        apply_async.assert_called_once()
        self.assertEqual(apply_async.call_args.kwargs["queue"], "doc_merge")


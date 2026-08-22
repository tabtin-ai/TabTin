from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch

from apps.tabdoc.tasks import _downsample_range, cleanup_expired_history


class TabDocHistoryCleanupTaskTests(TestCase):
    @patch("apps.tabdoc.tasks._downsample_range", return_value=0)
    @patch("apps.tabdoc.models.DocHistory")
    def test_cleanup_expired_history_protects_referenced_snapshots(
        self,
        doc_history_mock,
        downsample_mock,
    ):
        manager = MagicMock()
        doc_history_mock.objects = manager

        expired_qs = MagicMock()
        expired_qs.exclude.return_value = expired_qs
        expired_qs.count.return_value = 1

        referenced_qs = MagicMock()
        referenced_qs.values_list.return_value = ["snapshot-a"]

        manager.filter.side_effect = [expired_qs, referenced_qs]

        cleanup_expired_history()

        expired_qs.exclude.assert_called_once_with(id__in={"snapshot-a"})
        self.assertEqual(downsample_mock.call_count, 2)

    @patch("apps.tabdoc.models.DocHistory")
    def test_downsample_keeps_latest_by_created_at_then_id(self, doc_history_mock):
        manager = MagicMock()
        doc_history_mock.objects = manager

        qs = MagicMock()
        base_ref_qs = MagicMock()
        base_ref_qs.values_list.return_value = ["snapshot-a"]
        manager.filter.side_effect = [qs, base_ref_qs]

        qs.exists.return_value = True
        groups = [{"document_id": "doc-1", "bucket": "bucket-1"}]
        qs.annotate.return_value.values.return_value.annotate.return_value.filter.return_value = groups

        bucket_qs = MagicMock()
        qs.filter.return_value.annotate.return_value.filter.return_value = bucket_qs

        order_qs = MagicMock()
        values_qs = MagicMock()
        bucket_qs.order_by.return_value = order_qs
        order_qs.values_list.return_value = values_qs
        values_qs.first.return_value = "keep-id"

        pre_ref_delete = MagicMock()
        final_delete = MagicMock()
        bucket_qs.exclude.return_value = pre_ref_delete
        pre_ref_delete.exclude.return_value = final_delete
        final_delete.count.return_value = 1

        deleted = _downsample_range(start=object(), end=object(), truncate_to="day")

        bucket_qs.order_by.assert_called_once_with("-created_at", "-id")
        pre_ref_delete.exclude.assert_called_once_with(id__in=["snapshot-a"])
        final_delete.delete.assert_called_once()
        self.assertEqual(deleted, 1)

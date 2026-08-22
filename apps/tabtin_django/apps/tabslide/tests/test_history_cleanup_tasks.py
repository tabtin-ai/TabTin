from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch

from apps.tabslide.tasks import _downsample_range, cleanup_slide_history


class TabSlideHistoryCleanupTaskTests(TestCase):
    @patch("apps.tabslide.tasks._get_unmigrated_slide_history_ids", return_value=set())
    @patch("apps.tabslide.tasks._downsample_range", return_value=0)
    @patch("apps.tabslide.models.SlideHistory")
    def test_cleanup_protects_referenced_snapshot_from_expired_delete(
        self,
        slide_history_mock,
        downsample_mock,
        unmigrated_mock,
    ):
        manager = MagicMock()
        slide_history_mock.objects.using.return_value = manager

        expired_qs = MagicMock()
        expired_qs.exclude.return_value = expired_qs
        expired_qs.count.return_value = 1

        protected_qs = MagicMock()
        protected_qs.values_list.return_value = ["snapshot-a"]

        referenced_qs = MagicMock()
        referenced_qs.values_list.return_value = ["snapshot-a", "snapshot-b"]

        manager.filter.side_effect = [expired_qs, protected_qs, referenced_qs]

        cleanup_slide_history()

        expired_qs.exclude.assert_any_call(id__in={"snapshot-a"})
        self.assertEqual(downsample_mock.call_count, 3)
        for c in downsample_mock.call_args_list:
            self.assertEqual(
                c.kwargs.get("protected_snapshot_ids"),
                {"snapshot-a", "snapshot-b"},
            )

    @patch("apps.tabslide.models.SlideHistory")
    def test_downsample_keeps_latest_by_created_at_then_id(self, slide_history_mock):
        manager = MagicMock()
        slide_history_mock.objects.using.return_value = manager

        qs = MagicMock()
        manager.filter.return_value = qs
        qs.exists.return_value = True

        groups = [{"project_id": "project-1", "bucket": "bucket-1"}]
        qs.annotate.return_value.values.return_value.annotate.return_value.filter.return_value = groups

        bucket_qs = MagicMock()
        qs.filter.return_value.annotate.return_value.filter.return_value = bucket_qs

        order_qs = MagicMock()
        values_qs = MagicMock()
        bucket_qs.order_by.return_value = order_qs
        order_qs.values_list.return_value = values_qs
        values_qs.first.return_value = "keep-id"

        exclude_keep = MagicMock()
        exclude_protected = MagicMock()
        exclude_snapshot = MagicMock()
        bucket_qs.exclude.return_value = exclude_keep
        exclude_keep.exclude.return_value = exclude_protected
        exclude_protected.exclude.return_value = exclude_snapshot
        exclude_snapshot.count.return_value = 2

        deleted = _downsample_range(
            start=object(),
            end=object(),
            truncate_to="hour",
            protected_snapshot_ids={"snapshot-x"},
        )

        bucket_qs.order_by.assert_called_once_with("-created_at", "-id")
        exclude_keep.exclude.assert_called_once_with(id__in={"snapshot-x"})
        exclude_protected.exclude.assert_called_once_with(is_snapshot=True)
        exclude_snapshot.delete.assert_called_once()
        self.assertEqual(deleted, 2)

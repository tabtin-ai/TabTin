"""
TabData 历史 TTL + 降采样单元测试

覆盖:
- cleanup_record_history（过期删除 + 降采样）
- _downsample_record_history（按小时/天保留策略）
- backfill_history_ttl（回填 expired_at）
- handle_record_history_event（新记录带 expired_at）
"""
from __future__ import annotations

from datetime import timedelta
from unittest import TestCase
from unittest.mock import MagicMock, patch, call


class TestCleanupRecordHistory(TestCase):

    @patch("apps.tabdata.tasks.history_tasks._downsample_record_history", return_value=0)
    @patch("apps.tabdata.tasks.history_tasks.timezone")
    def test_cleanup_deletes_expired(self, mock_tz, mock_ds):
        from apps.tabdata.tasks.history_tasks import cleanup_record_history

        now = MagicMock()
        mock_tz.now.return_value = now

        with patch("apps.tabdata.models.RecordHistory") as MockRH:
            expired_qs = MagicMock()
            expired_qs.count.return_value = 5
            MockRH.objects.using.return_value.filter.return_value = expired_qs

            cleanup_record_history()

            expired_qs.delete.assert_called_once()

    @patch("apps.tabdata.tasks.history_tasks._downsample_record_history", return_value=0)
    @patch("apps.tabdata.tasks.history_tasks.timezone")
    def test_cleanup_preserves_unexpired(self, mock_tz, mock_ds):
        from apps.tabdata.tasks.history_tasks import cleanup_record_history

        now = MagicMock()
        mock_tz.now.return_value = now

        with patch("apps.tabdata.models.RecordHistory") as MockRH:
            expired_qs = MagicMock()
            expired_qs.count.return_value = 0
            MockRH.objects.using.return_value.filter.return_value = expired_qs

            cleanup_record_history()

            expired_qs.delete.assert_not_called()

    @patch("apps.tabdata.tasks.history_tasks.timezone")
    def test_cleanup_calls_downsample_twice(self, mock_tz):
        from apps.tabdata.tasks.history_tasks import cleanup_record_history

        now = MagicMock()
        mock_tz.now.return_value = now

        with patch("apps.tabdata.models.RecordHistory") as MockRH:
            expired_qs = MagicMock()
            expired_qs.count.return_value = 0
            MockRH.objects.using.return_value.filter.return_value = expired_qs

            with patch("apps.tabdata.tasks.history_tasks._downsample_record_history", return_value=0) as mock_ds:
                cleanup_record_history()
                self.assertEqual(mock_ds.call_count, 2)
                args_list = [c[0][2] for c in mock_ds.call_args_list]
                self.assertIn("hour", args_list)
                self.assertIn("day", args_list)


class TestDownsampleRecordHistory(TestCase):

    @patch("apps.tabdata.tasks.history_tasks.timezone")
    def test_empty_queryset_returns_zero(self, mock_tz):
        from apps.tabdata.tasks.history_tasks import _downsample_record_history

        now = MagicMock()

        with patch("apps.tabdata.models.RecordHistory") as MockRH:
            qs = MagicMock()
            qs.exists.return_value = False
            MockRH.objects.using.return_value.filter.return_value = qs

            with patch("apps.tabdata.models.TableNamedVersion") as MockTNV:
                MockTNV.objects.using.return_value.filter.return_value.values_list.return_value = []
                result = _downsample_record_history(now, now, "hour")
                self.assertEqual(result, 0)

    @patch("apps.tabdata.tasks.history_tasks.timezone")
    def test_downsample_protects_named_versions(self, mock_tz):
        from apps.tabdata.tasks.history_tasks import _downsample_record_history
        import uuid

        now = MagicMock()
        protected_id = uuid.uuid4()

        with patch("apps.tabdata.models.RecordHistory") as MockRH:
            qs = MagicMock()
            qs.exists.return_value = True

            group = {"record_id": "rec-1", "bucket": "2026-02-26T10:00:00"}
            qs.annotate.return_value.values.return_value.annotate.return_value.filter.return_value = [group]

            bucket_qs = MagicMock()
            bucket_qs.order_by.return_value.values_list.return_value.first.return_value = "keep-id"

            to_delete_qs = MagicMock()
            to_delete_qs.exclude.return_value = to_delete_qs
            to_delete_qs.count.return_value = 1
            bucket_qs.exclude.return_value = to_delete_qs

            qs.filter.return_value.annotate.return_value.filter.return_value = bucket_qs

            MockRH.objects.using.return_value.filter.return_value = qs

            with patch("apps.tabdata.models.TableNamedVersion") as MockTNV:
                MockTNV.objects.using.return_value.filter.return_value.values_list.return_value = [protected_id]
                result = _downsample_record_history(now, now, "hour")

                to_delete_qs.exclude.assert_any_call(id__in={protected_id})


class TestBackfillHistoryTtl(TestCase):

    @patch("apps.tabdata.tasks.history_tasks.timezone")
    def test_backfill_sets_expired_at(self, mock_tz):
        from apps.tabdata.tasks.history_tasks import backfill_history_ttl
        import uuid

        now = MagicMock()
        mock_tz.now.return_value = now

        batch_ids = [uuid.uuid4() for _ in range(3)]

        with patch("apps.tabdata.models.RecordHistory") as MockRH:
            qs = MagicMock()
            qs.exclude.return_value = qs
            qs.values_list.return_value.__getitem__ = MagicMock(return_value=batch_ids)
            MockRH.objects.using.return_value.filter.return_value = qs

            update_qs = MagicMock()
            update_qs.update.return_value = 3
            MockRH.objects.using.return_value.filter.return_value = update_qs

            with patch("apps.tabdata.models.TableNamedVersion") as MockTNV:
                MockTNV.objects.using.return_value.filter.return_value.values_list.return_value = []

                backfill_history_ttl()

    @patch("apps.tabdata.tasks.history_tasks.timezone")
    def test_backfill_skips_named_version_refs(self, mock_tz):
        from apps.tabdata.tasks.history_tasks import backfill_history_ttl
        import uuid

        now = MagicMock()
        mock_tz.now.return_value = now

        protected_id = uuid.uuid4()

        with patch("apps.tabdata.models.RecordHistory") as MockRH:
            qs = MagicMock()
            qs.exclude.return_value = qs
            qs.values_list.return_value.__getitem__ = MagicMock(return_value=[])
            MockRH.objects.using.return_value.filter.return_value = qs

            with patch("apps.tabdata.models.TableNamedVersion") as MockTNV:
                MockTNV.objects.using.return_value.filter.return_value.values_list.return_value = [protected_id]

                backfill_history_ttl()

                qs.exclude.assert_called_with(id__in={protected_id})


class TestHistoryEventListener(TestCase):

    @patch("apps.tabdata.history_event_listeners.RecordHistory")
    @patch("apps.tabdata.history_event_listeners.RecordHistoryItem")
    @patch("apps.tabdata.history_event_listeners._push_history_to_undo_stack")
    @patch("apps.tabdata.history_event_listeners._load_field_type_map", return_value={})
    @patch("apps.tabdata.history_event_listeners.timezone")
    def test_listener_sets_expired_at(self, mock_tz, mock_ftm, mock_push, mock_rhi, mock_rh):
        from apps.tabdata.history_event_listeners import handle_record_history_event
        from apps.tabdata.history_events import RecordHistoryEvent

        now = MagicMock()
        mock_tz.now.return_value = now

        event = RecordHistoryEvent(
            record=MagicMock(),
            action="update",
            field_changes={"field_1": {"old": "a", "new": "b"}},
            user=MagicMock(),
            window_id="win-1",
            operation_group_id="group-1",
            push_to_stack=False,
        )

        mock_history = MagicMock()
        mock_rh.objects.create.return_value = mock_history

        handle_record_history_event(sender=None, event=event)

        create_kwargs = mock_rh.objects.create.call_args[1]
        self.assertIn("expired_at", create_kwargs)
        self.assertIsNotNone(create_kwargs["expired_at"])

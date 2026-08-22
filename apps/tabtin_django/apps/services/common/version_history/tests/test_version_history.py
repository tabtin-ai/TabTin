"""
version_history 工具库单元测试

覆盖：constants / VersionHistoryMixin / HistoryServiceBase / schemas
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone as dt_tz
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch


class TestConstants(TestCase):

    def test_ttl_values(self):
        from apps.services.common.version_history.constants import (
            HISTORY_TTL_FREE,
            HISTORY_TTL_PRO,
            HISTORY_TTL_TEAM,
        )
        self.assertEqual(HISTORY_TTL_FREE, 7 * 24 * 3600)
        self.assertEqual(HISTORY_TTL_PRO, 30 * 24 * 3600)
        self.assertEqual(HISTORY_TTL_TEAM, 90 * 24 * 3600)

    def test_snapshot_constants(self):
        from apps.services.common.version_history.constants import (
            HISTORY_MIN_INTERVAL,
            HISTORY_SNAPSHOT_INTERVAL,
            HISTORY_SNAPSHOT_MAX_AGE,
        )
        self.assertEqual(HISTORY_MIN_INTERVAL, 5)
        self.assertEqual(HISTORY_SNAPSHOT_INTERVAL, 10)
        self.assertEqual(HISTORY_SNAPSHOT_MAX_AGE, 30 * 60)

    def test_ttl_tiers_keys(self):
        from apps.services.common.version_history.constants import TTL_TIERS
        self.assertIn("free", TTL_TIERS)
        self.assertIn("pro", TTL_TIERS)
        self.assertIn("team", TTL_TIERS)
        self.assertEqual(TTL_TIERS["free"], timedelta(seconds=7 * 24 * 3600))


class TestVersionHistoryMixin(TestCase):

    def test_mixin_fields_exist(self):
        from apps.services.common.version_history.mixins import VersionHistoryMixin
        field_names = {f.name for f in VersionHistoryMixin._meta.get_fields()}
        expected = {
            "id", "blob", "blob_size",
            "is_snapshot", "base_history",
            "editor_type", "editor_id",
            "expired_at", "is_named", "name", "pinned",
            "created_at",
        }
        for name in expected:
            self.assertIn(name, field_names, f"Missing field: {name}")

    def test_mixin_is_abstract(self):
        from apps.services.common.version_history.mixins import VersionHistoryMixin
        self.assertTrue(VersionHistoryMixin._meta.abstract)


class TestSerializeHistoryItem(TestCase):

    def _make_history(self, **overrides):
        defaults = {
            "id": uuid.uuid4(),
            "is_snapshot": True,
            "is_named": False,
            "name": "",
            "pinned": False,
            "editor_type": "user",
            "editor_id": "user-123",
            "blob_size": 1024,
            "created_at": datetime(2026, 2, 26, 10, 0, 0, tzinfo=dt_tz.utc),
            "expired_at": datetime(2026, 3, 5, 10, 0, 0, tzinfo=dt_tz.utc),
        }
        defaults.update(overrides)
        return SimpleNamespace(**defaults)

    def test_serialize_basic(self):
        from apps.services.common.version_history.schemas import serialize_history_item
        h = self._make_history()
        result = serialize_history_item(h, module="tabdoc")
        self.assertEqual(result["module"], "tabdoc")
        self.assertTrue(result["is_snapshot"])
        self.assertEqual(result["editor_type"], "user")
        self.assertEqual(result["blob_size"], 1024)
        self.assertIn("created_at", result)
        self.assertIn("expired_at", result)

    def test_serialize_named_version(self):
        from apps.services.common.version_history.schemas import serialize_history_item
        h = self._make_history(is_named=True, name="v1.0 release")
        result = serialize_history_item(h, module="tabslide")
        self.assertTrue(result["is_named"])
        self.assertEqual(result["name"], "v1.0 release")

    def test_serialize_extra_fields(self):
        from apps.services.common.version_history.schemas import serialize_history_item
        h = self._make_history(page_count=5, shape_count=120)
        result = serialize_history_item(h, module="tabslide")
        self.assertIn("extra", result)
        self.assertEqual(result["extra"]["page_count"], 5)
        self.assertEqual(result["extra"]["shape_count"], 120)

    def test_serialize_list(self):
        from apps.services.common.version_history.schemas import serialize_history_list
        items = [self._make_history(), self._make_history()]
        result = serialize_history_list(items, module="tabdata")
        self.assertEqual(len(result), 2)
        self.assertTrue(all(r["module"] == "tabdata" for r in result))

    def test_serialize_none_expired_at(self):
        from apps.services.common.version_history.schemas import serialize_history_item
        h = self._make_history(expired_at=None)
        result = serialize_history_item(h, module="tabdoc")
        self.assertIsNone(result["expired_at"])

    def test_serialize_blob_size_from_blob(self):
        from apps.services.common.version_history.schemas import serialize_history_item
        h = self._make_history(blob_size=0, blob=b"x" * 42)
        result = serialize_history_item(h, module="tabdoc")
        self.assertEqual(result["blob_size"], 42)


class TestHistoryServiceBase(TestCase):

    def _make_service(self):
        from apps.services.common.version_history.service import HistoryServiceBase
        return HistoryServiceBase()

    def test_should_create_snapshot_when_forced(self):
        svc = self._make_service()
        qs = MagicMock()
        self.assertTrue(svc.should_create_snapshot(qs, force=True))

    def test_should_create_snapshot_when_no_history(self):
        svc = self._make_service()
        qs = MagicMock()
        qs.using.return_value.filter.return_value.order_by.return_value.first.return_value = None
        self.assertTrue(svc.should_create_snapshot(qs))

    @patch("apps.services.common.version_history.service.timezone")
    def test_should_create_snapshot_after_interval(self, mock_tz):
        now = datetime(2026, 2, 26, 12, 0, 0, tzinfo=dt_tz.utc)
        mock_tz.now.return_value = now

        svc = self._make_service()
        qs = MagicMock()
        chain = qs.using.return_value.filter.return_value.order_by.return_value

        last_snapshot = SimpleNamespace(created_at=now - timedelta(minutes=10))
        chain.first.return_value = last_snapshot

        count_chain = qs.using.return_value.filter.return_value
        count_chain.count.return_value = 10  # >= HISTORY_SNAPSHOT_INTERVAL

        self.assertTrue(svc.should_create_snapshot(qs))

    @patch("apps.services.common.version_history.service.timezone")
    def test_should_not_create_snapshot_below_threshold(self, mock_tz):
        now = datetime(2026, 2, 26, 12, 0, 0, tzinfo=dt_tz.utc)
        mock_tz.now.return_value = now

        svc = self._make_service()
        qs = MagicMock()
        chain = qs.using.return_value.filter.return_value.order_by.return_value

        last_snapshot = SimpleNamespace(created_at=now - timedelta(minutes=5))
        chain.first.return_value = last_snapshot

        count_chain = qs.using.return_value.filter.return_value
        count_chain.count.return_value = 3

        self.assertFalse(svc.should_create_snapshot(qs))

    @patch("apps.services.common.version_history.service.timezone")
    def test_is_too_recent(self, mock_tz):
        now = datetime(2026, 2, 26, 12, 0, 0, tzinfo=dt_tz.utc)
        mock_tz.now.return_value = now

        svc = self._make_service()
        qs = MagicMock()
        chain = qs.using.return_value.order_by.return_value

        chain.first.return_value = SimpleNamespace(created_at=now - timedelta(seconds=2))
        self.assertTrue(svc.is_too_recent(qs))

        chain.first.return_value = SimpleNamespace(created_at=now - timedelta(seconds=10))
        self.assertFalse(svc.is_too_recent(qs))

    def test_is_too_recent_no_history(self):
        svc = self._make_service()
        qs = MagicMock()
        qs.using.return_value.order_by.return_value.first.return_value = None
        self.assertFalse(svc.is_too_recent(qs))

    def test_find_resource_field(self):
        from apps.services.common.version_history.service import HistoryServiceBase
        from django.db import models

        class FakeDocument(models.Model):
            class Meta:
                app_label = "test_fake"

        class FakeHistory(models.Model):
            document = models.ForeignKey(FakeDocument, on_delete=models.CASCADE)
            base_history = models.ForeignKey("self", on_delete=models.SET_NULL, null=True)

            class Meta:
                app_label = "test_fake"

        result = HistoryServiceBase._find_resource_field(FakeHistory)
        self.assertEqual(result, "document_id")

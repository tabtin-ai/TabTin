from django.test import SimpleTestCase

from apps.tabdata.services.view_version_sync import (
    encode_monotonic_version_token,
    has_changes_since_version,
    requires_full_reload_since_version,
)
from apps.tabdata.services.record_service import RecordService


class DeleteVersionWatermarkTests(SimpleTestCase):
    def test_stale_monotonic_token_requires_full_reload(self):
        state = {'latest_delete_version': 8}

        self.assertTrue(requires_full_reload_since_version(
            since_version=encode_monotonic_version_token(7),
            version_state=state,
        ))
        self.assertFalse(requires_full_reload_since_version(
            since_version=encode_monotonic_version_token(8),
            version_state=state,
        ))

    def test_legacy_timestamp_requires_one_reload_after_delete(self):
        self.assertTrue(requires_full_reload_since_version(
            since_version=1_700_000_000_000,
            version_state={'latest_delete_version': 1},
        ))

    def test_zero_token_remains_a_full_bootstrap_after_delete(self):
        state = {
            'latest_delete_version': 8,
            'latest_record_version': 8,
            'latest_updated_ms': 0,
        }
        self.assertTrue(has_changes_since_version(
            since_version=0,
            version_state=state,
        ))
        self.assertFalse(requires_full_reload_since_version(
            since_version=0,
            version_state=state,
        ))
        service = object.__new__(RecordService)
        self.assertTrue(service._has_changes_since_version(
            since_version=0,
            version_state=state,
        ))
        self.assertFalse(service._requires_full_reload_since_version(
            since_version=0,
            version_state=state,
        ))

    def test_table_without_delete_keeps_incremental_merge(self):
        self.assertFalse(requires_full_reload_since_version(
            since_version=encode_monotonic_version_token(3),
            version_state={'latest_delete_version': 0},
        ))

"""预览契约常量稳定性（ / 方案 B）。

数值变更须同步 Electron
``apps/tabtin-electron/src/shared/session-share-preview-contract.ts``。
"""

from datetime import timedelta

from django.test import SimpleTestCase

from apps.chat.conversation.services.workspace_file.constants import (
    MAX_MATERIALIZE_BYTES,
    PREVIEW_KIND_BINARY,
    PREVIEW_KIND_IMAGE,
    PREVIEW_KIND_PDF,
    PREVIEW_KIND_TEXT,
    SIGNED_URL_TTL_SECONDS,
    SNAPSHOT_TTL,
)
from apps.chat.conversation.services.workspace_file.preview import guess_preview_kind


class WorkspaceFileConstantsTests(SimpleTestCase):
    def test_materialize_limit_is_50mb(self):
        self.assertEqual(MAX_MATERIALIZE_BYTES, 50 * 1024 * 1024)

    def test_signed_url_ttl_is_15_minutes(self):
        self.assertEqual(SIGNED_URL_TTL_SECONDS, 15 * 60)

    def test_snapshot_ttl_is_30_minutes(self):
        self.assertEqual(SNAPSHOT_TTL, timedelta(minutes=30))

    def test_guess_preview_kind_routing(self):
        self.assertEqual(guess_preview_kind("a.md"), PREVIEW_KIND_TEXT)
        self.assertEqual(guess_preview_kind("a.png"), PREVIEW_KIND_IMAGE)
        self.assertEqual(guess_preview_kind("a.pdf"), PREVIEW_KIND_PDF)
        self.assertEqual(guess_preview_kind("a.bin"), PREVIEW_KIND_BINARY)

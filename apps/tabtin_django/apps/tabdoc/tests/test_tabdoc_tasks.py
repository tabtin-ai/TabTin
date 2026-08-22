from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import unittest

from apps.tabdoc.tasks import create_document_version


class TabdocTaskTests(unittest.TestCase):
    def test_create_document_version_persists_document_version_number(self):
        document = SimpleNamespace(
            id="doc-1",
            organization_id="organization-1",
            description_binary=b"",
            description_markdown="<p>hello</p>",
            description_json={"type": "doc", "content": []},
            description_plaintext="hello",
            updated_at=datetime(2026, 2, 13, 0, 0, tzinfo=timezone.utc),
            latest_version=7,
        )
        filter_qs = MagicMock()
        filter_qs.count.return_value = 1

        with patch("apps.tabdoc.models.Document.objects.get", return_value=document):
            with patch("apps.tabdoc.models.DocumentVersion.objects.create") as create_mock:
                with patch("apps.tabdoc.models.DocumentVersion.objects.filter", return_value=filter_qs):
                    create_document_version.run("doc-1", "user-1")

        create_mock.assert_called_once_with(
            document=document,
            organization_id=document.organization_id,
            description_binary=document.description_binary,
            description_markdown=document.description_markdown,
            description_json=document.description_json,
            description_plaintext=document.description_plaintext,
            version=7,
            last_saved_at=document.updated_at,
            created_by_id="user-1",
        )


if __name__ == "__main__":
    unittest.main()

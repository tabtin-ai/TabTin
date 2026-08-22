"""document_media_resolver 单测。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.llm.wire_adapter.document_media_resolver import (
    DocumentBytes,
    DocumentResolveError,
    resolve_document_bytes,
)
from apps.services.llm.wire_adapter.image_fetcher import ImageFetchError


class DocumentMediaResolverTests(SimpleTestCase):

    def test_data_url_pdf(self):
        # "%PDF" base64
        url = "data:application/pdf;base64,JVBERg=="
        doc = resolve_document_bytes(url, fallback_filename="x.bin")
        self.assertEqual(doc.content, b"%PDF")
        self.assertTrue(doc.filename.endswith(".pdf"))
        self.assertEqual(doc.mime_type, "application/pdf")

    def test_remote_allowlisted_url(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = b"%PDF-1.4 remote"
        mock_resp.headers = {"content-type": "application/pdf"}
        mock_resp.url = "https://cdn.example.com/a.pdf"

        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.get.return_value = mock_resp

        with patch(
            "apps.services.llm.wire_adapter.document_media_resolver._validate_fetch_url",
        ), patch(
            "apps.services.llm.wire_adapter.document_media_resolver.httpx.Client",
            return_value=mock_client,
        ):
            doc = resolve_document_bytes(
                "https://cdn.example.com/a.pdf",
                fallback_filename="fallback.bin",
            )

        self.assertEqual(doc.content, b"%PDF-1.4 remote")
        self.assertEqual(doc.filename, "a.pdf")
        self.assertEqual(doc.mime_type, "application/pdf")

    def test_remote_forbidden_url_maps_unsupported(self):
        with patch(
            "apps.services.llm.wire_adapter.document_media_resolver._validate_fetch_url",
            side_effect=ImageFetchError(
                reason="forbidden_url",
                host="evil.example",
                detail="not allowlisted",
            ),
        ):
            with self.assertRaises(DocumentResolveError) as cm:
                resolve_document_bytes("https://evil.example/a.pdf")
        self.assertEqual(cm.exception.reason, "unsupported_url")

    def test_local_oss_keeps_original_attachment_filename(self):
        url = (
            "http://127.0.0.1:6060/api/services/oss/local-object"
            "?object_key=chat%2Fattachments%2F19e41ff7.pdf"
        )
        expected = DocumentBytes(
            content=b"%PDF-1.7",
            filename="How-Anthropic.pdf",
            mime_type="application/pdf",
        )
        with patch(
            "apps.services.llm.wire_adapter.document_media_resolver._is_trusted_local_oss_url",
            return_value=True,
        ), patch(
            "apps.services.llm.wire_adapter.document_media_resolver._local_oss_provider_enabled",
            return_value=True,
        ), patch(
            "apps.services.llm.wire_adapter.document_media_resolver._read_local_oss_document",
            return_value=expected,
        ) as read_mock:
            result = resolve_document_bytes(
                url,
                fallback_filename="How-Anthropic.pdf",
            )

        self.assertEqual(result.filename, "How-Anthropic.pdf")
        self.assertEqual(
            read_mock.call_args.kwargs["fallback_filename"],
            "How-Anthropic.pdf",
        )

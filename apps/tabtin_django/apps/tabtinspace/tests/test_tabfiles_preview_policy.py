"""TabFiles 预览护栏：preview_max_bytes 范围、MIME 安全判定。"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.http import JsonResponse
from django.test import SimpleTestCase


def _body(resp):
    if isinstance(resp, JsonResponse):
        return json.loads(resp.content)
    if isinstance(resp, tuple):
        return resp[1] if len(resp) > 1 else resp[0]
    return resp


class TabFilesPreviewPolicyTests(SimpleTestCase):
    def _item(self, *, mime_type: str, title: str = "f.bin"):
        return SimpleNamespace(
            resource_id=str(uuid4()),
            metadata={"file_name": title, "mime_type": mime_type},
            title=title,
        )

    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_rejects_non_positive_preview_max_bytes(self, mock_svc):
        from apps.tabtinspace.routers.tabfiles import _resolve_file_download_response

        resp = _body(_resolve_file_download_response(self._item(mime_type="application/pdf"), 0))
        self.assertEqual(resp["code"], "VALIDATION_ERROR")
        mock_svc.get_file_size.assert_not_called()

        resp_neg = _body(
            _resolve_file_download_response(self._item(mime_type="application/pdf"), -1)
        )
        self.assertEqual(resp_neg["code"], "VALIDATION_ERROR")

    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_rejects_preview_max_bytes_above_cap(self, mock_svc):
        from apps.tabtinspace.routers.tabfiles import (
            _PREVIEW_MAX_BYTES_LIMIT,
            _resolve_file_download_response,
        )

        resp = _body(
            _resolve_file_download_response(
                self._item(mime_type="application/pdf"),
                _PREVIEW_MAX_BYTES_LIMIT + 1,
            )
        )
        self.assertEqual(resp["code"], "VALIDATION_ERROR")
        mock_svc.get_file_size.assert_not_called()

    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_unsafe_mime_not_preview_eligible(self, mock_svc):
        from apps.tabtinspace.routers.tabfiles import _resolve_file_download_response

        mock_svc.get_file_size.return_value = 1024
        for mime in (
            "text/html",
            "application/javascript",
            "application/x-msdownload",
            "application/zip",
            "application/octet-stream",
            "image/svg+xml",
            "",
        ):
            resp = _body(
                _resolve_file_download_response(
                    self._item(mime_type=mime),
                    preview_max_bytes=10_000_000,
                )
            )
            self.assertFalse(resp["data"]["preview_eligible"], mime)
            self.assertFalse(resp["data"]["mime_preview_safe"], mime)
            self.assertEqual(resp["data"]["url"], "")
        mock_svc.get_download_url.assert_not_called()

    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_generic_mime_does_not_make_html_previewable(self, mock_svc):
        from apps.tabtinspace.routers.tabfiles import _resolve_file_download_response

        mock_svc.get_file_size.return_value = 345
        resp = _body(
            _resolve_file_download_response(
                self._item(mime_type="application/octet-stream", title="unsafe.html"),
                preview_max_bytes=1024,
            )
        )

        self.assertFalse(resp["data"]["preview_eligible"])
        self.assertFalse(resp["data"]["mime_preview_safe"])
        self.assertEqual(resp["data"]["mime_type"], "application/octet-stream")
        self.assertEqual(resp["data"]["url"], "")
        mock_svc.get_download_url.assert_not_called()

    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_svg_download_only_not_inline_preview(self, mock_svc):
        """SVG 可执行脚本：预览拒签 URL；普通下载仍可 as_attachment。"""
        from apps.tabtinspace.routers.tabfiles import _resolve_file_download_response

        mock_svc.get_file_size.return_value = 512
        mock_svc.get_download_url.return_value = "https://oss.example/svg-dl"
        preview = _body(
            _resolve_file_download_response(
                self._item(mime_type="image/svg+xml", title="x.svg"),
                preview_max_bytes=10_000_000,
            )
        )
        self.assertFalse(preview["data"]["mime_preview_safe"])
        self.assertFalse(preview["data"]["preview_eligible"])
        self.assertEqual(preview["data"]["url"], "")

        download = _body(
            _resolve_file_download_response(
                self._item(mime_type="image/svg+xml", title="x.svg"),
                preview_max_bytes=None,
            )
        )
        self.assertFalse(download["data"]["mime_preview_safe"])
        self.assertTrue(download["data"]["preview_eligible"])
        self.assertEqual(download["data"]["url"], "https://oss.example/svg-dl")
        self.assertTrue(mock_svc.get_download_url.call_args.kwargs.get("as_attachment", True))

    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_safe_mime_within_size_gets_url(self, mock_svc):
        from apps.tabtinspace.routers.tabfiles import _resolve_file_download_response

        mock_svc.get_file_size.return_value = 2048
        mock_svc.get_download_url.return_value = "https://oss.example/signed"
        resp = _body(
            _resolve_file_download_response(
                self._item(mime_type="image/png", title="a.png"),
                preview_max_bytes=10_000_000,
            )
        )
        self.assertTrue(resp["data"]["preview_eligible"])
        self.assertTrue(resp["data"]["mime_preview_safe"])
        self.assertEqual(resp["data"]["url"], "https://oss.example/signed")
        mock_svc.get_download_url.assert_called_once()
        self.assertEqual(
            mock_svc.get_download_url.call_args.kwargs.get("as_attachment"),
            False,
        )

    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_previewable_uploaded_data_mimes_get_url(self, mock_svc):
        from apps.tabtinspace.routers.tabfiles import _resolve_file_download_response

        mock_svc.get_file_size.return_value = 7721
        mock_svc.get_download_url.return_value = "https://oss.example/signed-data"

        for mime, title in (
            (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "scores.xlsx",
            ),
            ("application/json", "rows.json"),
        ):
            with self.subTest(mime=mime):
                resp = _body(
                    _resolve_file_download_response(
                        self._item(mime_type=mime, title=title),
                        preview_max_bytes=10_000_000,
                    )
                )
                self.assertTrue(resp["data"]["preview_eligible"])
                self.assertTrue(resp["data"]["mime_preview_safe"])
                self.assertEqual(resp["data"]["url"], "https://oss.example/signed-data")

    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_safe_mime_over_size_blocks_url(self, mock_svc):
        from apps.tabtinspace.routers.tabfiles import _resolve_file_download_response

        mock_svc.get_file_size.return_value = 50_000
        resp = _body(
            _resolve_file_download_response(
                self._item(mime_type="application/pdf"),
                preview_max_bytes=1024,
            )
        )
        self.assertFalse(resp["data"]["preview_eligible"])
        self.assertTrue(resp["data"]["mime_preview_safe"])
        self.assertEqual(resp["data"]["url"], "")
        mock_svc.get_download_url.assert_not_called()

    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_download_without_preview_flag_still_works_for_unsafe_mime(self, mock_svc):
        from apps.tabtinspace.routers.tabfiles import _resolve_file_download_response

        mock_svc.get_file_size.return_value = 100
        mock_svc.get_download_url.return_value = "https://oss.example/dl"
        resp = _body(
            _resolve_file_download_response(
                self._item(mime_type="application/zip"),
                preview_max_bytes=None,
            )
        )
        self.assertTrue(resp["data"]["preview_eligible"])
        self.assertFalse(resp["data"]["mime_preview_safe"])
        self.assertEqual(resp["data"]["url"], "https://oss.example/dl")
        _, kwargs = mock_svc.get_download_url.call_args
        self.assertTrue(kwargs.get("as_attachment", True))

"""
TabDoc 增量 diff 单元测试

覆盖:
- _decompress_history_blob（zlib 解压 + 兼容旧数据）
- _resolve_history_content（全量恢复 / diff 链合并 / 链断裂显式报错）
"""
from __future__ import annotations

import base64
import json
import uuid
import zlib
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch


class TestDecompressHistoryBlob(TestCase):

    def test_decompress_zlib_blob(self):
        from apps.tabdoc.services.document_service import _decompress_history_blob
        raw = b"Hello, Y.js binary!"
        compressed = zlib.compress(raw)
        self.assertEqual(_decompress_history_blob(compressed), raw)

    def test_decompress_raw_blob_compat(self):
        from apps.tabdoc.services.document_service import _decompress_history_blob
        raw = b"\x00\x01\x02\x03raw-yjs-data"
        self.assertEqual(_decompress_history_blob(raw), raw)

    def test_decompress_empty_blob(self):
        from apps.tabdoc.services.document_service import _decompress_history_blob
        self.assertEqual(_decompress_history_blob(b""), b"")

    def test_decompress_none_blob(self):
        from apps.tabdoc.services.document_service import _decompress_history_blob
        self.assertEqual(_decompress_history_blob(None), b"")


class TestResolveHistoryContent(TestCase):

    def _get_service(self):
        from apps.tabdoc.services.document_service import DocumentService
        svc = DocumentService.__new__(DocumentService)
        svc.user = None
        svc.db_alias = "postgresql"
        return svc

    def test_resolve_snapshot(self):
        svc = self._get_service()
        raw = b"\x01\x02\x03yjs-binary"
        compressed = zlib.compress(raw)
        history = SimpleNamespace(
            id=uuid.uuid4(),
            blob=compressed,
            is_snapshot=True,
            base_history_id=None,
        )
        result = svc._resolve_history_content(history)
        self.assertEqual(result["format"], "yjs_binary")
        self.assertEqual(result["binary"], raw)

    def test_resolve_json_snapshot(self):
        svc = self._get_service()
        content = {
            "format": "json_snapshot",
            "description_json": {"type": "doc"},
            "description_markdown": "<p>test</p>",
            "description_plaintext": "test",
        }
        blob = zlib.compress(json.dumps(content).encode())
        history = SimpleNamespace(
            id=uuid.uuid4(),
            blob=blob,
            is_snapshot=True,
            base_history_id=None,
        )
        result = svc._resolve_history_content(history)
        self.assertEqual(result["format"], "json_snapshot")
        self.assertEqual(result["description_markdown"], "<p>test</p>")

    def test_resolve_empty_blob(self):
        svc = self._get_service()
        history = SimpleNamespace(
            id=uuid.uuid4(),
            blob=b"",
            is_snapshot=True,
            base_history_id=None,
        )
        result = svc._resolve_history_content(history)
        self.assertEqual(result["format"], "json_snapshot")
        self.assertEqual(result["description_json"], {})

    @patch("apps.tabdoc.services.document_service.call_live_api")
    @patch("apps.tabdoc.services.document_service.DocHistory")
    def test_resolve_diff_chain(self, mock_history_cls, mock_call_api):
        svc = self._get_service()

        base_raw = b"\x01base-yjs"
        diff_raw = b"\x02diff-yjs"
        merged_raw = b"\x03merged-yjs"

        base_id = uuid.uuid4()
        base_history = SimpleNamespace(
            id=base_id,
            blob=zlib.compress(base_raw),
            is_snapshot=True,
            base_history_id=None,
            base_history=None,
        )

        diff_history = SimpleNamespace(
            id=uuid.uuid4(),
            blob=zlib.compress(diff_raw),
            is_snapshot=False,
            base_history_id=base_id,
            base_history=base_history,
        )

        mock_history_cls.objects.get.return_value = base_history

        mock_call_api.return_value = {
            "merged_b64": base64.b64encode(merged_raw).decode(),
        }

        result = svc._resolve_history_content(diff_history)
        self.assertEqual(result["format"], "yjs_binary")
        self.assertEqual(result["binary"], merged_raw)

        mock_call_api.assert_called_once()
        call_args = mock_call_api.call_args[0]
        self.assertEqual(call_args[0], "/yjs/apply-diff")

    @patch("apps.tabdoc.services.document_service.DocHistory")
    def test_resolve_broken_chain_raises(self, mock_history_cls):
        svc = self._get_service()

        diff_raw = b"\x02diff-yjs"
        missing_id = uuid.uuid4()
        diff_history = SimpleNamespace(
            id=uuid.uuid4(),
            blob=zlib.compress(diff_raw),
            is_snapshot=False,
            base_history_id=missing_id,
            base_history=SimpleNamespace(id=missing_id),
        )

        mock_history_cls.DoesNotExist = type("DoesNotExist", (Exception,), {})
        mock_history_cls.objects.get.side_effect = mock_history_cls.DoesNotExist("not found")

        with self.assertRaisesRegex(ValueError, "增量链已损坏"):
            svc._resolve_history_content(diff_history)

    def test_resolve_diff_no_base_history(self):
        svc = self._get_service()
        raw = b"\x01\x02\x03diff-no-base"
        history = SimpleNamespace(
            id=uuid.uuid4(),
            blob=zlib.compress(raw),
            is_snapshot=False,
            base_history_id=None,
            base_history=None,
        )
        with self.assertRaisesRegex(ValueError, "缺少基线快照"):
            svc._resolve_history_content(history)

    @patch("apps.tabdoc.services.document_service.call_live_api")
    @patch("apps.tabdoc.services.document_service.DocHistory")
    def test_resolve_diff_merge_failure_raises(self, mock_history_cls, mock_call_api):
        svc = self._get_service()

        base_raw = b"\x01base-yjs"
        diff_raw = b"\x02diff-yjs"
        base_id = uuid.uuid4()
        base_history = SimpleNamespace(
            id=base_id,
            blob=zlib.compress(base_raw),
            is_snapshot=True,
            base_history_id=None,
            base_history=None,
        )
        diff_history = SimpleNamespace(
            id=uuid.uuid4(),
            blob=zlib.compress(diff_raw),
            is_snapshot=False,
            base_history_id=base_id,
            base_history=base_history,
        )

        mock_history_cls.objects.get.return_value = base_history
        mock_call_api.side_effect = RuntimeError("collab-live unavailable")

        with self.assertRaisesRegex(ValueError, "增量合并失败"):
            svc._resolve_history_content(diff_history)

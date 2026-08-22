"""
DV-001 / DV-003 / DV-004 回归测试

DV-001: compute_diff 失败时 VersionHistoryService 应创建 fallback 全量快照，而非静默跳过
DV-004: compute_diff 应使用 max_retries=0 避免阻塞 Celery Worker
DV-003: binary restore 时 description_json 转换失败应清空字段，不保留旧值
"""
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import base64  # noqa: E402
import uuid  # noqa: E402
import zlib  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from unittest import TestCase  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402

from apps.collab.adapters.docs import DocsCollabAdapter  # noqa: E402


class TestDV001ComputeDiffFailurePropagation(TestCase):
    """DV-001: compute_diff API 失败时应抛异常，不再静默返回 None。"""

    def setUp(self):
        self.adapter = DocsCollabAdapter()
        self.base_data = b"\x01\x02\x03old-yjs" + b"\x00" * 100
        self.current_data = b"\x04\x05\x06new-yjs" + b"\x00" * 100

    @patch("apps.services.common.live_api.call_live_api")
    def test_compute_diff_success_returns_compressed_diff(self, mock_api):
        diff_bytes = b"small-diff"
        mock_api.return_value = {
            "diff_b64": base64.b64encode(diff_bytes).decode(),
        }
        result = self.adapter.compute_diff(self.base_data, self.current_data)
        self.assertIsNotNone(result)
        self.assertEqual(zlib.decompress(result), diff_bytes)

    @patch("apps.services.common.live_api.call_live_api")
    def test_compute_diff_no_change_returns_none(self, mock_api):
        mock_api.return_value = {"diff_b64": ""}
        result = self.adapter.compute_diff(self.base_data, self.current_data)
        self.assertIsNone(result)

    @patch("apps.services.common.live_api.call_live_api")
    def test_compute_diff_api_failure_raises_instead_of_none(self, mock_api):
        """DV-001 核心：API 异常不再被吞掉，而是向上抛出。"""
        mock_api.side_effect = RuntimeError("collab-live 服务不可用")
        with self.assertRaises(RuntimeError):
            self.adapter.compute_diff(self.base_data, self.current_data)

    def test_compute_diff_non_binary_returns_none(self):
        result = self.adapter.compute_diff({"json": True}, self.current_data)
        self.assertIsNone(result)

    @patch("apps.services.common.live_api.call_live_api")
    def test_compute_diff_passes_max_retries_0(self, mock_api):
        """DV-004: 验证 max_retries=0 和 timeout=5 被传递给 call_live_api。"""
        mock_api.return_value = {"diff_b64": ""}
        self.adapter.compute_diff(self.base_data, self.current_data)
        mock_api.assert_called_once()
        _, kwargs = mock_api.call_args
        self.assertEqual(kwargs.get("max_retries"), 0)
        self.assertEqual(kwargs.get("timeout"), 5)


class TestDV001ServiceFallbackSnapshot(TestCase):
    """DV-001: VersionHistoryService 在 compute_diff 抛异常时应创建 fallback 全量快照。"""

    _UNSET = object()

    def _make_service_and_call(
        self,
        diff_side_effect=None,
        diff_return=_UNSET,
        base_deserialize=_UNSET,
    ):
        from apps.collab.service import VersionHistoryService

        adapter = MagicMock()
        adapter.resource_type = "docs"
        adapter.get_content_stats.return_value = {}

        if diff_side_effect:
            adapter.compute_diff.side_effect = diff_side_effect
        elif diff_return is not self._UNSET:
            adapter.compute_diff.return_value = diff_return

        snapshot_blob = zlib.compress(b"snapshot-data")
        adapter.serialize_snapshot.return_value = snapshot_blob
        if base_deserialize is not self._UNSET:
            adapter.deserialize_snapshot.return_value = base_deserialize
        else:
            adapter.deserialize_snapshot.return_value = b"base-binary"

        svc = VersionHistoryService(adapter)

        mock_base_snapshot = MagicMock()
        mock_base_snapshot.id = uuid.uuid4()
        mock_base_snapshot.is_snapshot = True
        mock_base_snapshot.blob = snapshot_blob

        with patch.object(svc, "is_too_recent", return_value=False), \
             patch.object(svc, "should_create_snapshot", return_value=False), \
             patch.object(svc, "find_last_snapshot", return_value=mock_base_snapshot), \
             patch.object(svc, "_compute_ttl", return_value=None), \
             patch("apps.collab.service.VersionHistory") as MockVH, \
             patch("django.core.cache.cache") as mock_cache:

            mock_cache.add.return_value = True
            mock_vh_instance = MagicMock()
            mock_vh_instance.blob_size = len(snapshot_blob)
            MockVH.return_value = mock_vh_instance

            resource_id = uuid.uuid4()
            result = svc.create_history(
                resource_id=resource_id,
                data=b"current-binary",
                editor_info={"editor_type": "agent", "editor_id": "test"},
            )
            return result, MockVH, mock_vh_instance

    def test_compute_diff_exception_creates_fallback_snapshot(self):
        """compute_diff 抛异常 → service 创建全量快照而非跳过。"""
        result, MockVH, mock_vh = self._make_service_and_call(
            diff_side_effect=RuntimeError("collab-live down")
        )
        self.assertIsNotNone(result)
        vh_kwargs = MockVH.call_args.kwargs
        self.assertTrue(vh_kwargs["is_snapshot"])
        self.assertIsNone(vh_kwargs["base_history"])

    def test_compute_diff_none_without_exception_skips(self):
        """compute_diff 返回 None（无异常）→ 视为无变化，跳过创建。"""
        result, MockVH, mock_vh = self._make_service_and_call(
            diff_return=None
        )
        self.assertIsNone(result)

    def test_json_base_binary_current_creates_fallback_snapshot(self):
        """#3568: json 基线 + binary 当前 → 降级写全量快照，不跳过。"""
        result, MockVH, mock_vh = self._make_service_and_call(
            diff_return=None,
            base_deserialize={"type": "doc", "content": [{"type": "paragraph"}]},
        )
        self.assertIsNotNone(result)
        vh_kwargs = MockVH.call_args.kwargs
        self.assertTrue(vh_kwargs["is_snapshot"])
        self.assertIsNone(vh_kwargs["base_history"])


class TestDV003RestoreBinaryFormatsFailure(TestCase):
    """DV-003: binary restore 时 formats 转换失败应清空 description_json 等字段。"""

    def _make_resource(self):
        ns = SimpleNamespace(
            id=uuid.uuid4(),
            organization_id=uuid.uuid4(),
            description_binary=b"old-binary",
            description_json={"type": "doc", "content": [{"type": "paragraph"}]},
            description_markdown="# Old Content",
            description_plaintext="Old Content",
            status="active",
            trashed_at=None,
            latest_version=5,
        )
        ns.refresh_from_db = lambda **kwargs: None
        return ns

    @patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot")
    @patch("apps.tabdoc.services.document_service.DocumentService.assert_document_content_editable")
    def test_binary_restore_without_prepared_clears_text_fields(
        self, mock_assert, mock_normalize
    ):
        """没有 prepared 数据时，description_json/markdown/plaintext 应保留旧值（CSC-005 防窗口期空内容）。"""
        adapter = DocsCollabAdapter()
        resource = self._make_resource()
        new_binary = b"new-yjs-binary"

        mock_filter = MagicMock()
        with patch("apps.tabdoc.models.Document.objects") as mock_objects, \
             patch("django.db.transaction.atomic"), \
             patch("django.db.transaction.on_commit"):
            mock_objects.using.return_value.filter.return_value = mock_filter

            adapter.restore(resource, new_binary, prepared=None)

            update_kwargs = mock_filter.update.call_args.kwargs
            self.assertEqual(update_kwargs["description_binary"], new_binary)
            self.assertEqual(update_kwargs["description_json"], resource.description_json)
            self.assertEqual(update_kwargs["description_markdown"], resource.description_markdown)
            self.assertEqual(update_kwargs["description_plaintext"], resource.description_plaintext)

    @patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
           side_effect=Exception("normalize failed"))
    @patch("apps.tabdoc.services.document_service.DocumentService.assert_document_content_editable")
    def test_binary_restore_prepared_failure_clears_text_fields(
        self, mock_assert, mock_normalize
    ):
        """prepared 数据处理失败时，description_json/markdown/plaintext 应保留旧值（CSC-005 防窗口期空内容）。"""
        adapter = DocsCollabAdapter()
        resource = self._make_resource()
        new_binary = b"new-yjs-binary"

        mock_filter = MagicMock()
        with patch("apps.tabdoc.models.Document.objects") as mock_objects, \
             patch("django.db.transaction.atomic"), \
             patch("django.db.transaction.on_commit"):
            mock_objects.using.return_value.filter.return_value = mock_filter

            adapter.restore(
                resource, new_binary,
                prepared={"json": {"bad": True}, "markdown": "bad", "plaintext": "bad"},
            )

            update_kwargs = mock_filter.update.call_args.kwargs
            self.assertEqual(update_kwargs["description_binary"], new_binary)
            self.assertEqual(update_kwargs["description_json"], resource.description_json)
            self.assertEqual(update_kwargs["description_markdown"], resource.description_markdown)
            self.assertEqual(update_kwargs["description_plaintext"], resource.description_plaintext)

    @patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot")
    @patch("apps.tabdoc.services.document_service.DocumentService.assert_document_content_editable")
    def test_binary_restore_prepared_success_uses_converted_fields(
        self, mock_assert, mock_normalize
    ):
        """prepared 数据处理成功时，应正常写入转换后的字段。"""
        converted_json = {"type": "doc", "content": []}
        converted_md = "# Restored"
        mock_normalize.return_value = (converted_json, converted_md)

        adapter = DocsCollabAdapter()
        resource = self._make_resource()
        new_binary = b"new-yjs-binary"

        mock_filter = MagicMock()
        with patch("apps.tabdoc.models.Document.objects") as mock_objects, \
             patch("django.db.transaction.atomic"), \
             patch("django.db.transaction.on_commit"):
            mock_objects.using.return_value.filter.return_value = mock_filter

            adapter.restore(
                resource, new_binary,
                prepared={"json": converted_json, "markdown": converted_md, "plaintext": "Restored"},
            )

            update_kwargs = mock_filter.update.call_args.kwargs
            self.assertEqual(update_kwargs["description_binary"], new_binary)
            self.assertEqual(update_kwargs["description_json"], converted_json)
            self.assertEqual(update_kwargs["description_markdown"], converted_md)
            self.assertEqual(update_kwargs["description_plaintext"], "Restored")

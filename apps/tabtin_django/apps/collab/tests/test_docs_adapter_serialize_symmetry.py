"""
DocsCollabAdapter 对称性与 restore 流程测试

覆盖:
- DT-001: serialize_snapshot / deserialize_snapshot 对称性（bytes / dict / string）
- DT-002: compute_diff / apply_diff 对称性（mock call_live_api）
- DT-003: restore 流程验证（bytes 恢复、JSON snapshot 恢复、prepared 分支）
- DT-004: get_content_stats / get_version_data 边界情况
"""
import base64
from contextlib import nullcontext
import json
import os
import uuid
import zlib
from contextlib import nullcontext
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.collab.adapters.docs import DocsCollabAdapter  # noqa: E402


# ══════════════════════════════════════════════════════════
# DT-001: serialize / deserialize 对称性
# ══════════════════════════════════════════════════════════


class TestSerializeDeserializeSymmetry:
    """DT-001: 多种数据类型经 serialize → deserialize 后应与原始数据一致。"""

    def setup_method(self):
        self.adapter = DocsCollabAdapter()

    def _roundtrip(self, data):
        blob = self.adapter.serialize_snapshot(data)
        assert isinstance(blob, bytes)
        restored = self.adapter.deserialize_snapshot(blob)
        return restored

    # ── bytes (Y.js binary) 往返 ──

    def test_bytes_roundtrip(self):
        """Y.js binary bytes 经 zlib 压缩往返后不变。"""
        data = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 100
        restored = self._roundtrip(data)
        assert isinstance(restored, bytes)
        assert restored == data

    def test_empty_bytes_roundtrip(self):
        data = b""
        restored = self._roundtrip(data)
        assert isinstance(restored, bytes)
        assert restored == data

    def test_large_binary_roundtrip(self):
        data = os.urandom(64 * 1024)
        restored = self._roundtrip(data)
        assert isinstance(restored, bytes)
        assert restored == data

    # ── dict (JSON snapshot) 往返 ──

    def test_json_snapshot_roundtrip(self):
        """json_snapshot 格式的 dict 往返后保持 dict。"""
        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc", "content": [{"type": "paragraph"}]},
            "description_markdown": "# Hello World",
            "description_plaintext": "Hello World",
        }
        restored = self._roundtrip(data)
        assert isinstance(restored, dict)
        assert restored == data

    def test_binary_snapshot_wrapper_unwraps_to_yjs_bytes(self):
        """binary_snapshot wrapper 是历史兼容格式，反序列化后必须回到原始 Y.js bytes。"""
        raw_binary = b"\x01\x02tabdoc-yjs-update"
        data = {
            "format": "binary_snapshot",
            "title": "Wrapped",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }

        restored = self._roundtrip(data)

        assert isinstance(restored, bytes)
        assert restored == raw_binary

    def test_json_snapshot_nested_content(self):
        data = {
            "format": "json_snapshot",
            "description_json": {
                "type": "doc",
                "content": [
                    {
                        "type": "heading",
                        "attrs": {"level": 1},
                        "content": [{"type": "text", "text": "标题"}],
                    },
                    {
                        "type": "paragraph",
                        "content": [
                            {"type": "text", "text": "正文内容 "},
                            {"type": "text", "marks": [{"type": "bold"}], "text": "加粗"},
                        ],
                    },
                ],
            },
            "description_markdown": "# 标题\n\n正文内容 **加粗**",
        }
        restored = self._roundtrip(data)
        assert restored == data

    def test_dict_without_json_snapshot_format(self):
        """不带 format=json_snapshot 的 dict 经 JSON→zlib 编码后反序列化为 bytes（非 dict）。"""
        data = {"title": "test", "content": "hello"}
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert isinstance(restored, bytes)
        parsed = json.loads(restored.decode("utf-8"))
        assert parsed == data

    # ── string fallback ──

    def test_string_data_roundtrip(self):
        """非 bytes/dict 的 str 数据经 str() 编码后往返。"""
        data = "some plain text content"
        restored = self._roundtrip(data)
        assert isinstance(restored, (bytes, str))
        if isinstance(restored, bytes):
            assert restored.decode("utf-8") == data
        else:
            assert restored == data

    # ── unicode ──

    def test_unicode_json_snapshot_roundtrip(self):
        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc", "content": []},
            "description_markdown": "中文测试 🎨 日本語 한국어 café",
        }
        restored = self._roundtrip(data)
        assert restored == data

    # ── memoryview ──

    def test_memoryview_input(self):
        """memoryview 输入应等价于 bytes。"""
        raw = b"\xde\xad\xbe\xef" * 50
        mv = memoryview(raw)
        blob = self.adapter.serialize_snapshot(mv)
        restored = self.adapter.deserialize_snapshot(blob)
        assert isinstance(restored, bytes)
        assert restored == raw

    # ── 损坏数据容错 ──

    def test_corrupted_blob_returns_none(self):
        assert self.adapter.deserialize_snapshot(b"not-valid-zlib") is None

    def test_empty_blob_returns_none(self):
        assert self.adapter.deserialize_snapshot(b"") is None

    # ── 压缩验证 ──

    def test_output_is_zlib_compressed(self):
        data = b"\x01\x02\x03" * 500
        blob = self.adapter.serialize_snapshot(data)
        decompressed = zlib.decompress(blob)
        assert decompressed == data

    def test_json_output_is_zlib_compressed(self):
        data = {
            "format": "json_snapshot",
            "description_json": {},
            "description_markdown": "test",
        }
        blob = self.adapter.serialize_snapshot(data)
        decompressed = zlib.decompress(blob)
        parsed = json.loads(decompressed.decode("utf-8"))
        assert parsed == data

    # ── 幂等性 ──

    def test_double_roundtrip_idempotent_bytes(self):
        data = b"\x01\x02\x03\x04\x05"
        r1 = self._roundtrip(data)
        r2 = self._roundtrip(r1)
        assert r1 == r2

    def test_double_roundtrip_idempotent_json(self):
        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc"},
            "description_markdown": "hello",
        }
        r1 = self._roundtrip(data)
        r2 = self._roundtrip(r1)
        assert r1 == r2


# ══════════════════════════════════════════════════════════
# DT-002: compute_diff / apply_diff 对称性
# ══════════════════════════════════════════════════════════


class TestComputeApplyDiffSymmetry:
    """DT-002: compute_diff → apply_diff 对称性（mock Y.js diff API）。"""

    def setup_method(self):
        self.adapter = DocsCollabAdapter()

    def test_non_bytes_input_returns_none(self):
        """compute_diff 在任一输入非 bytes 时返回 None。"""
        assert self.adapter.compute_diff("string", b"\x01") is None
        assert self.adapter.compute_diff(b"\x01", {"key": "val"}) is None
        assert self.adapter.compute_diff(None, None) is None
        assert self.adapter.compute_diff(42, b"\x01") is None

    def test_apply_diff_non_bytes_base_raises(self):
        """apply_diff 在 base_data 非 bytes 时抛 RuntimeError。"""
        with pytest.raises(RuntimeError, match="binary base_data"):
            self.adapter.apply_diff("not-bytes", b"\x01")

    @patch("apps.services.common.live_api.call_live_api")
    def test_basic_diff_roundtrip(self, mock_live_api):
        """compute_diff → apply_diff 往返：mock 的 diff/merge 结果一致。"""
        base_data = b"\x01\x02\x03\x04"
        current_data = b"\x01\x02\x03\x04\x05\x06\x07\x08"

        diff_raw = b"\x05\x06\x07\x08"
        diff_b64 = base64.b64encode(diff_raw).decode()

        mock_live_api.side_effect = lambda endpoint, payload, **kwargs: {
            "/yjs/compute-diff": {"diff_b64": diff_b64},
            "/yjs/apply-diff": {"merged_b64": base64.b64encode(current_data).decode()},
        }.get(endpoint, {})

        diff_blob = self.adapter.compute_diff(base_data, current_data)
        assert diff_blob is not None

        result = self.adapter.apply_diff(base_data, diff_blob)
        assert result == current_data

    @patch("apps.services.common.live_api.call_live_api")
    def test_diff_too_large_returns_none(self, mock_live_api):
        """diff 大于原数据 80% 时返回 None（强制全量快照）。"""
        base_data = b"\x01\x02\x03\x04\x05"
        current_data = b"\x01\x02\x03\x04\x05\x06"

        large_diff = base64.b64encode(current_data).decode()
        mock_live_api.return_value = {"diff_b64": large_diff}

        result = self.adapter.compute_diff(base_data, current_data)
        assert result is None

    @patch("apps.services.common.live_api.call_live_api")
    def test_empty_diff_returns_none(self, mock_live_api):
        """diff_b64 为空时返回 None。"""
        mock_live_api.return_value = {"diff_b64": ""}
        result = self.adapter.compute_diff(b"\x01", b"\x02")
        assert result is None

    @patch("apps.services.common.live_api.call_live_api")
    def test_apply_diff_empty_merged_returns_base(self, mock_live_api):
        """apply_diff 返回空 merged_b64 时应抛错，避免静默恢复到错误版本。"""
        mock_live_api.return_value = {"merged_b64": ""}
        base = b"\x01\x02\x03"
        diff_blob = zlib.compress(b"\x04\x05")
        with pytest.raises(RuntimeError, match="empty merged_b64"):
            self.adapter.apply_diff(base, diff_blob)

    @patch("apps.services.common.live_api.call_live_api")
    def test_apply_diff_api_failure_raises(self, mock_live_api):
        """apply_diff 的 API 调用失败时应抛 RuntimeError。"""
        mock_live_api.side_effect = ConnectionError("API unreachable")
        diff_blob = zlib.compress(b"\x04\x05")
        with pytest.raises(RuntimeError, match="Failed to apply Y.js diff"):
            self.adapter.apply_diff(b"\x01", diff_blob)

    @patch("apps.services.common.live_api.call_live_api")
    def test_compute_diff_passes_correct_params(self, mock_live_api):
        """验证 compute_diff 传给 API 的参数格式正确。"""
        base = b"\xaa\xbb"
        current = b"\xcc\xdd\xee"

        mock_live_api.return_value = {"diff_b64": ""}

        self.adapter.compute_diff(base, current)

        mock_live_api.assert_called_once()
        call_args = mock_live_api.call_args
        assert call_args[0][0] == "/yjs/compute-diff"
        payload = call_args[0][1]
        assert payload["old_binary_b64"] == base64.b64encode(base).decode()
        assert payload["new_binary_b64"] == base64.b64encode(current).decode()

    @patch("apps.services.common.live_api.call_live_api")
    def test_diff_blob_is_zlib_compressed(self, mock_live_api):
        """compute_diff 返回的 diff_blob 是 zlib 压缩的。"""
        base = b"\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a"
        current = b"\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0b"
        diff_raw = b"\x0b"
        mock_live_api.return_value = {"diff_b64": base64.b64encode(diff_raw).decode()}

        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        decompressed = zlib.decompress(diff_blob)
        assert decompressed == diff_raw


# ══════════════════════════════════════════════════════════
# DT-003: restore 流程验证
# ══════════════════════════════════════════════════════════


class TestRestoreFlow:
    """DT-003: restore 流程覆盖 bytes 恢复、JSON snapshot 恢复、prepare_restore。"""

    def setup_method(self):
        self.adapter = DocsCollabAdapter()

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_binary_with_prepared(self, mock_doc_model, mock_svc_cls):
        """bytes + prepared 恢复：使用 prepared 中的格式化数据。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        mock_qs = MagicMock()
        mock_manager = mock_doc_model.objects.using.return_value
        mock_manager.select_for_update.return_value.filter.return_value.first.return_value = resource
        mock_manager.filter.return_value = mock_qs
        mock_qs.update.return_value = 1

        data = b"\x01\x02\x03\x04"
        prepared = {
            "json": {"type": "doc", "content": [{"type": "paragraph"}]},
            "markdown": "# Restored",
            "plaintext": "Restored",
        }

        with patch("django.db.transaction.atomic", return_value=nullcontext()):
            with patch("django.db.transaction.on_commit"):
                with patch(
                    "apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                    side_effect=lambda j, m: (j, m),
                ):
                    self.adapter.restore(resource, data, prepared=prepared)

        mock_qs.update.assert_called_once()
        update_kwargs = mock_qs.update.call_args[1]

        assert update_kwargs["description_binary"] == data
        assert update_kwargs["description_json"] == prepared["json"]
        assert update_kwargs["description_markdown"] == prepared["markdown"]
        assert update_kwargs["description_plaintext"] == prepared["plaintext"]

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_binary_snapshot_wrapper_with_prepared(self, mock_doc_model, mock_svc_cls):
        """restore 读到 binary_snapshot wrapper 时，当前文档只能写回内部原始 binary。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        raw_binary = b"\x01\x02restored-yjs"
        wrapped = json.dumps({
            "format": "binary_snapshot",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }).encode("utf-8")
        prepared = {
            "json": {"type": "doc", "content": []},
            "markdown": "# Restored",
            "plaintext": "Restored",
        }

        with patch("django.db.transaction.atomic", side_effect=lambda using=None: nullcontext()):
            with patch("django.db.transaction.on_commit"):
                with patch(
                    "apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                    side_effect=lambda j, m: (j, m),
                ):
                    self.adapter.restore(resource, wrapped, prepared=prepared)

        update_kwargs = mock_qs.update.call_args[1]
        assert update_kwargs["description_binary"] == raw_binary

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_json_snapshot(self, mock_doc_model, mock_svc_cls):
        """json_snapshot dict 恢复：清空 binary，写入 JSON/MD。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc", "content": []},
            "description_markdown": "# Snapshot",
            "description_plaintext": "Snapshot",
        }

        captured = []

        def fake_on_commit(fn, using=None):
            captured.append(fn)

        with patch("django.db.transaction.atomic", return_value=nullcontext()):
            with patch("django.db.transaction.on_commit", side_effect=fake_on_commit):
                with patch(
                    "apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                    side_effect=lambda j, m: (j, m),
                ):
                    self.adapter.restore(resource, data)

        update_kwargs = mock_qs.update.call_args[1]
        assert update_kwargs["description_binary"] is None
        assert update_kwargs["description_json"] == data["description_json"]
        assert update_kwargs["description_markdown"] == data["description_markdown"]

        callback_names = [getattr(fn, "__name__", "") for fn in captured]
        assert "_deferred_push_binary" in callback_names, "json_snapshot 恢复应注册 on_commit 推送 binary"

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_json_snapshot_restores_title_when_present(self, mock_doc_model, mock_svc_cls):
        """TD-13: json_snapshot 含 title 时，restore 应同步恢复 Document.title 与 ContextItem。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        data = {
            "format": "json_snapshot",
            "title": "恢复前标题",
            "description_json": {"type": "doc", "content": []},
            "description_markdown": "# Snapshot",
            "description_plaintext": "Snapshot",
        }
        user = MagicMock()
        fresh_resource = MagicMock()
        mock_doc_model.objects.using.return_value.get.return_value = fresh_resource
        captured = []

        def fake_on_commit(fn, using=None):
            captured.append(fn)

        with patch("django.db.transaction.atomic", return_value=nullcontext()):
            with patch("django.db.transaction.on_commit", side_effect=fake_on_commit):
                with patch(
                    "apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                    side_effect=lambda j, m: (j, m),
                ):
                    with patch(
                        "apps.tabtinspace.services.resource_bridge.ResourceBridge.on_update",
                    ) as bridge_update:
                        self.adapter.restore(resource, data, user=user)
                        bridge_update.assert_not_called()
                        update_kwargs = mock_qs.update.call_args[1]
                        assert update_kwargs["title"] == data["title"]
                        callback_names = [getattr(fn, "__name__", "") for fn in captured]
                        assert "_deferred_resource_update" in callback_names, (
                            "title restore 应在事务提交后同步 ContextItem"
                        )
                        for callback in captured:
                            if getattr(callback, "__name__", "") == "_deferred_resource_update":
                                callback()
                                break
                        bridge_update.assert_called_once_with(fresh_resource, user=user)

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_json_snapshot_without_title_preserves_current_title(self, mock_doc_model, mock_svc_cls):
        """TD-13: 旧 json_snapshot 缺 title 时，不应把当前标题写空或覆盖。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc", "content": []},
            "description_markdown": "# Legacy Snapshot",
            "description_plaintext": "Legacy Snapshot",
        }

        captured = []

        def fake_on_commit(fn, using=None):
            captured.append(fn)

        with patch("django.db.transaction.atomic", return_value=nullcontext()):
            with patch("django.db.transaction.on_commit", side_effect=fake_on_commit):
                with patch(
                    "apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                    side_effect=lambda j, m: (j, m),
                ):
                    with patch(
                        "apps.tabtinspace.services.resource_bridge.ResourceBridge.on_update",
                    ) as bridge_update:
                        self.adapter.restore(resource, data)

        update_kwargs = mock_qs.update.call_args[1]
        assert "title" not in update_kwargs
        callback_names = [getattr(fn, "__name__", "") for fn in captured]
        assert "_deferred_resource_update" not in callback_names
        bridge_update.assert_not_called()

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_binary_restores_title_from_version_metadata(self, mock_doc_model, mock_svc_cls):
        """TD-16: binary baseline 正文保持 raw bytes，标题从 VH metadata 恢复。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.description_json = {"old": True}
        resource.description_markdown = "# Old"
        resource.description_plaintext = "Old"
        resource._version_history_restore_metadata = {
            "tabdoc_title": "恢复前 binary 标题",
        }

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs
        fresh_resource = MagicMock()
        mock_doc_model.objects.using.return_value.get.return_value = fresh_resource

        binary_data = b"\x01\x02"
        user = MagicMock()
        captured = []

        def fake_on_commit(fn, using=None):
            captured.append(fn)

        with patch("django.db.transaction.atomic", return_value=nullcontext()):
            with patch("django.db.transaction.on_commit", side_effect=fake_on_commit):
                with patch(
                    "apps.tabtinspace.services.resource_bridge.ResourceBridge.on_update",
                ) as bridge_update:
                    self.adapter.restore(resource, binary_data, prepared=None, user=user)
                    bridge_update.assert_not_called()

                    update_kwargs = mock_qs.update.call_args[1]
                    assert update_kwargs["title"] == "恢复前 binary 标题"
                    assert update_kwargs["description_binary"] == binary_data
                    callback_names = [getattr(fn, "__name__", "") for fn in captured]
                    assert "_deferred_resource_update" in callback_names
                    assert "_deferred_convert_and_push" in callback_names

                    for callback in captured:
                        if getattr(callback, "__name__", "") == "_deferred_resource_update":
                            callback()
                            break
                    bridge_update.assert_called_once_with(fresh_resource, user=user)

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_binary_snapshot_restores_title_when_present(self, mock_doc_model, mock_svc_cls):
        """兼容存量 binary_snapshot envelope：解出 binary，并恢复旧 envelope 里的标题。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.description_json = {"old": True}
        resource.description_markdown = "# Old"
        resource.description_plaintext = "Old"

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs
        fresh_resource = MagicMock()
        mock_doc_model.objects.using.return_value.get.return_value = fresh_resource

        binary_data = b"\x01\x02"
        data = {
            "format": "binary_snapshot",
            "title": "恢复前 binary 标题",
            "binary_b64": base64.b64encode(binary_data).decode(),
        }
        user = MagicMock()
        captured = []

        def fake_on_commit(fn, using=None):
            captured.append(fn)

        with patch("django.db.transaction.atomic", return_value=nullcontext()):
            with patch("django.db.transaction.on_commit", side_effect=fake_on_commit):
                with patch(
                    "apps.tabtinspace.services.resource_bridge.ResourceBridge.on_update",
                ) as bridge_update:
                    self.adapter.restore(resource, data, prepared=None, user=user)
                    bridge_update.assert_not_called()

                    update_kwargs = mock_qs.update.call_args[1]
                    assert update_kwargs["title"] == data["title"]
                    assert update_kwargs["description_binary"] == binary_data
                    callback_names = [getattr(fn, "__name__", "") for fn in captured]
                    assert "_deferred_resource_update" in callback_names
                    assert "_deferred_convert_and_push" in callback_names

                    for callback in captured:
                        if getattr(callback, "__name__", "") == "_deferred_resource_update":
                            callback()
                            break
                    bridge_update.assert_called_once_with(fresh_resource, user=user)

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_binary_no_prepared_registers_on_commit(self, mock_doc_model, mock_svc_cls):
        """bytes + no prepared：应注册 on_commit 回调做延迟转换。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.description_json = {"old": True}
        resource.description_markdown = "# Old"
        resource.description_plaintext = "Old"

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        captured = []

        def fake_on_commit(fn, using=None):
            captured.append(fn)

        with patch("django.db.transaction.atomic", return_value=nullcontext()):
            with patch("django.db.transaction.on_commit", side_effect=fake_on_commit):
                with patch("apps.tabtinspace.services.resource_bridge.ResourceBridge.on_update") as bridge_update:
                    self.adapter.restore(resource, b"\x01\x02", prepared=None)

        callback_names = [getattr(fn, "__name__", "") for fn in captured]
        assert "_deferred_convert_and_push" in callback_names, "no prepared 时应注册 on_commit 转换推送"
        assert "_deferred_resource_update" not in callback_names
        bridge_update.assert_not_called()

    @patch("apps.services.common.live_api.call_live_api")
    def test_prepare_restore_calls_convert_api(self, mock_live_api):
        """prepare_restore 对 bytes 数据调用 /convert/binary-to-formats。"""
        mock_live_api.return_value = {
            "json": {"type": "doc"},
            "markdown": "# Test",
            "plaintext": "Test",
        }

        resource = MagicMock()
        data = b"\x01\x02\x03"
        result = self.adapter.prepare_restore(resource, data)

        assert result is not None
        assert result["markdown"] == "# Test"
        mock_live_api.assert_called_once_with(
            "/convert/binary-to-formats",
            {"binary_b64": base64.b64encode(data).decode()},
        )

    def test_prepare_restore_non_bytes_returns_none(self):
        """prepare_restore 对非 bytes 数据直接返回 None。"""
        resource = MagicMock()
        assert self.adapter.prepare_restore(resource, {"format": "json_snapshot"}) is None
        assert self.adapter.prepare_restore(resource, "string") is None

    @patch("apps.services.common.live_api.call_live_api")
    def test_prepare_restore_api_failure_returns_none(self, mock_live_api):
        """prepare_restore API 失败时返回 None（不抛异常）。"""
        mock_live_api.side_effect = ConnectionError("unreachable")
        resource = MagicMock()
        result = self.adapter.prepare_restore(resource, b"\x01")
        assert result is None

    @patch("apps.services.common.live_api.call_live_api")
    def test_prepare_restore_binary_snapshot_envelope(self, mock_live_api):
        """: binary_snapshot envelope dict 应解包后调用 convert API。"""
        inner_binary = b"\xde\xad\xbe\xef"
        envelope = {
            "format": "binary_snapshot",
            "binary_b64": base64.b64encode(inner_binary).decode(),
            "title": "Restored Title",
        }
        mock_live_api.return_value = {
            "json": {"type": "doc"},
            "markdown": "# Restored",
            "plaintext": "Restored",
        }

        resource = MagicMock()
        result = self.adapter.prepare_restore(resource, envelope)

        assert result is not None
        mock_live_api.assert_called_once_with(
            "/convert/binary-to-formats",
            {"binary_b64": base64.b64encode(inner_binary).decode()},
        )


# ══════════════════════════════════════════════════════════
# DT-004: get_content_stats / get_version_data 边界
# ══════════════════════════════════════════════════════════


class TestContentStatsAndVersionData:
    """DT-004: 元数据方法的边界行为。"""

    def setup_method(self):
        self.adapter = DocsCollabAdapter()

    def test_get_content_stats_bytes(self):
        stats = self.adapter.get_content_stats(b"\x01\x02\x03")
        assert stats == {"binary_size": 3}

    def test_get_content_stats_dict(self):
        stats = self.adapter.get_content_stats({"format": "json_snapshot"})
        assert stats == {"format": "json_snapshot"}

    def test_get_content_stats_other(self):
        stats = self.adapter.get_content_stats("string")
        assert stats == {}

    def test_get_content_stats_none(self):
        stats = self.adapter.get_content_stats(None)
        assert stats == {}

    def test_get_version_data_with_binary(self):
        resource = MagicMock()
        resource.description_binary = b"\x01\x02\x03"
        result = self.adapter.get_version_data(resource)
        assert isinstance(result, bytes)
        assert result == b"\x01\x02\x03"

    def test_build_snapshot_unwraps_binary_snapshot_wrapper(self):
        raw_binary = b"\x01\x02snapshot-yjs"
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.latest_version = 7
        resource.description_binary = json.dumps({
            "format": "binary_snapshot",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }).encode("utf-8")
        resource.description_markdown = "# stale"

        snapshot = self.adapter.build_snapshot(resource)

        assert snapshot["has_binary"] is True
        assert snapshot["binary_b64"] == base64.b64encode(raw_binary).decode()

    def test_get_version_data_unwraps_binary_snapshot_wrapper(self):
        raw_binary = b"\x01\x02version-yjs"
        resource = MagicMock()
        resource.description_binary = json.dumps({
            "format": "binary_snapshot",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }).encode("utf-8")

        result = self.adapter.get_version_data(resource)

        assert isinstance(result, bytes)
        assert result == raw_binary

    def test_get_version_data_no_binary_with_json(self):
        resource = MagicMock()
        resource.description_binary = None
        resource.title = "Snapshot Title"
        resource.description_json = {"type": "doc", "content": []}
        resource.description_markdown = "# Test"
        resource.description_plaintext = "Test"

        with patch(
            "apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
            side_effect=lambda j, m: (j, m),
        ):
            result = self.adapter.get_version_data(resource)

        assert isinstance(result, dict)
        assert result["format"] == "json_snapshot"
        assert result["title"] == "Snapshot Title"

    def test_get_version_data_nothing_returns_empty_bytes(self):
        resource = MagicMock()
        resource.description_binary = None
        resource.description_json = None
        resource.description_markdown = None
        result = self.adapter.get_version_data(resource)
        assert result == b""

"""
CSC-005 回归测试

restore_to_version 的 on_commit 延迟推送窗口：
当 prepared 为 None（collab-live 不可用）时，事务提交到 on_commit 执行之间，
description_json/markdown 不应被清空，应保留旧值，防止用户打开文档时读取到空内容。
"""
import base64
import inspect
import os
import uuid
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


class TestDocsRestorePreservesOldJsonWhenPreparedIsNone:
    """
    CSC-005: DocsCollabAdapter.restore() 在 prepared=None 时应保留旧 JSON/MD，
    而非清空，防止 on_commit 执行前的窗口期内用户读取到空内容。
    """

    def test_restore_source_does_not_clear_json_when_no_prepared(self):
        """源码不应在 not formats_applied 分支中写入空 {} 或空字符串。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        source = inspect.getsource(DocsCollabAdapter.restore)
        # 修复后不应出现直接赋空值的代码
        assert '"description_json": {}' not in source, (
            "restore must not clear description_json to {} when prepared is None (CSC-005)"
        )
        assert '"description_markdown": ""' not in source, (
            "restore must not clear description_markdown to '' when prepared is None (CSC-005)"
        )

    def test_restore_source_preserves_old_values_when_no_prepared(self):
        """源码应在 not formats_applied 分支中使用 resource.description_json/markdown。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        source = inspect.getsource(DocsCollabAdapter.restore)
        assert "resource.description_json" in source, (
            "restore must use resource.description_json as fallback when prepared is None (CSC-005)"
        )
        assert "resource.description_markdown" in source, (
            "restore must use resource.description_markdown as fallback when prepared is None (CSC-005)"
        )

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_binary_no_prepared_keeps_old_json(self, mock_doc_model, mock_svc_cls):
        """
        bytes 恢复且 prepared=None 时，update 调用中 description_json/markdown
        应等于 resource 上的旧值，而非空值。
        """
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.description_json = {"type": "doc", "content": [{"type": "paragraph"}]}
        resource.description_markdown = "# Old Content"
        resource.description_plaintext = "Old Content"

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        data = b"\x01\x02\x03\x04"

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        captured_on_commit = []

        def fake_on_commit(fn, using=None):
            captured_on_commit.append(fn)

        with patch("django.db.transaction.on_commit", side_effect=fake_on_commit):
            adapter.restore(resource, data, prepared=None)

        mock_qs.update.assert_called_once()
        update_kwargs = mock_qs.update.call_args[1]

        assert update_kwargs.get("description_binary") == data, (
            "description_binary must be updated to new data"
        )
        assert update_kwargs.get("description_json") == resource.description_json, (
            "description_json must be preserved as old value, not cleared (CSC-005)"
        )
        assert update_kwargs.get("description_markdown") == resource.description_markdown, (
            "description_markdown must be preserved as old value, not cleared (CSC-005)"
        )
        assert update_kwargs.get("description_plaintext") == resource.description_plaintext, (
            "description_plaintext must be preserved as old value, not cleared (CSC-005)"
        )

        # on_commit 回调应被注册（用于后续转换）
        assert len(captured_on_commit) == 1, (
            "restore must register exactly one on_commit callback for deferred conversion"
        )

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_binary_no_prepared_empty_resource_fields(self, mock_doc_model, mock_svc_cls):
        """
        resource 上旧值为空时，fallback 应为 {} 和 ""（通过 or 运算符）。
        """
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.description_json = None
        resource.description_markdown = None
        resource.description_plaintext = None

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        data = b"\x05\x06\x07"

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        with patch("django.db.transaction.on_commit"):
            adapter.restore(resource, data, prepared=None)

        update_kwargs = mock_qs.update.call_args[1]
        assert update_kwargs.get("description_json") == {}, (
            "description_json fallback for None resource field should be {}"
        )
        assert update_kwargs.get("description_markdown") == "", (
            "description_markdown fallback for None resource field should be ''"
        )

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_binary_with_prepared_still_uses_prepared(self, mock_doc_model, mock_svc_cls):
        """
        prepared 有值时，应使用 prepared 的值（正常路径不受 CSC-005 修复影响）。
        """
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.description_json = {"type": "doc", "content": []}
        resource.description_markdown = "# Old"

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        data = b"\x01\x02\x03"
        prepared = {
            "json": {"type": "doc", "content": [{"type": "heading"}]},
            "markdown": "# New Heading",
            "plaintext": "New Heading",
        }

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        captured_on_commit = []

        def fake_on_commit(fn, using=None):
            captured_on_commit.append(fn)

        with patch("django.db.transaction.on_commit", side_effect=fake_on_commit):
            with patch(
                "apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                side_effect=lambda j, m: (j, m),
            ):
                adapter.restore(resource, data, prepared=prepared)

        update_kwargs = mock_qs.update.call_args[1]
        assert update_kwargs.get("description_json") == prepared["json"], (
            "When prepared is provided, description_json must use prepared value"
        )
        assert update_kwargs.get("description_markdown") == prepared["markdown"], (
            "When prepared is provided, description_markdown must use prepared value"
        )
        # prepared 有值时不应注册 on_commit（无需延迟转换）
        assert len(captured_on_commit) == 0, (
            "When prepared is provided, no on_commit should be registered for conversion"
        )


class TestDocsRestoreOnCommitPushesCollab:
    """
    on_commit 回调在转换成功后应通过 apply-ops 的 xml.fragment.replace 推送到 collab-live，
    使内存 Y.Doc 与 DB 一致。
    """

    def test_restore_source_on_commit_includes_apply_ops_replace(self):
        """源码中 on_commit 回调应包含 xml.fragment.replace apply-ops 调用。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        source = inspect.getsource(DocsCollabAdapter.restore)
        assert "xml.fragment.replace" in source, (
            "on_commit callback must push xml.fragment.replace via apply-ops"
        )

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_on_commit_callback_calls_replace_content(self, mock_doc_model, mock_svc_cls):
        """
        on_commit 回调执行时，在转换成功后应调用 apply_docs_ops。
        """
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.description_json = {}
        resource.description_markdown = ""
        resource.description_plaintext = ""

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        data = b"\xde\xad\xbe\xef"

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        captured_callback = []

        def fake_on_commit(fn, using=None):
            captured_callback.append(fn)

        with patch("django.db.transaction.on_commit", side_effect=fake_on_commit):
            adapter.restore(resource, data, prepared=None)

        assert len(captured_callback) == 1

        # 执行 on_commit 回调，验证它调用了 apply_docs_ops
        mock_convert_result = {
            "json": {"type": "doc", "content": []},
            "markdown": "# Restored",
            "plaintext": "Restored",
        }

        push_calls = []

        def fake_call_live_api(endpoint, payload, **kwargs):
            push_calls.append((endpoint, payload))
            if endpoint == "/convert/binary-to-formats":
                return mock_convert_result
            return {}

        with patch("apps.services.common.live_api.call_live_api", side_effect=fake_call_live_api):
            with patch("apps.collab.apply_ops.CollabApplyOpsService.apply_docs_ops") as mock_apply_docs_ops:
                mock_apply_docs_ops.return_value = {"status": "ok"}
                with patch(
                    "apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                    side_effect=lambda j, m: (j, m),
                ):
                    captured_callback[0]()

        endpoints_called = [ep for ep, _ in push_calls]
        assert "/convert/binary-to-formats" in endpoints_called, (
            "on_commit must call /convert/binary-to-formats"
        )
        assert "/convert/markdown-to-update" not in endpoints_called, (
            "on_commit must not use lossy markdown-to-update for collab sync ()"
        )
        mock_apply_docs_ops.assert_called_once()
        apply_kwargs = mock_apply_docs_ops.call_args.kwargs
        assert apply_kwargs["document_id"] == str(resource.id)
        assert apply_kwargs["ops"][0]["op"] == "xml.fragment.replace"
        assert apply_kwargs["ops"][0]["fragment"] == "default"
        assert apply_kwargs["ops"][0]["update_b64"] == base64.b64encode(data).decode(), (
            "on_commit must push raw VH binary, not markdown-derived update ()"
        )

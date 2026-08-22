"""TD-4 Phase 4b（路线 A）：消除 H-1 与 onStore 双写 VersionHistory。

契约：
- save_content（H-1）DB-first 后**同步**写一条权威 VH（json_snapshot）。
- 该内容随后经 push → collab-live → onStore(collab_persist) 回流时，collab_persist
  检测到「本次变更已被 save_content 写过」即跳过写 VH/CL（仍保留 binary 落盘）。
- 结果：同一次 save_content 触发的变更只产 1 条 VH（非 2 条）、ChangeLog 不重复，
  且保留下来的归因（agent / run_id）正确。
- 不误伤：纯人手 onStore（无 save_content 同步）、Agent Y-first（push_from_agent
  不打标记）、并发的他人编辑均照常写 VH。

机制：Redis 短键 `collab:vh_synced:docs:{doc_id}` + collab:create_history_lock 共享串行化。
"""
from __future__ import annotations

import os
import uuid
from contextlib import contextmanager, nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from django.core.cache import cache  # noqa: E402
from django.test import override_settings  # noqa: E402


@contextmanager
def _noop_atomic(*args, **kwargs):
    yield


def _make_body(*, editor_type="agent", editor_id="agent-1", agent_run_id="run-x", op_id=None):
    body = MagicMock()
    body.op_id = op_id or f"op-{uuid.uuid4()}"
    body.changes = {"update_blob_b64": "deadbeef"}
    body.editor_type = editor_type
    body.editor_id = editor_id
    body.editor_name = ""
    body.agent_run_id = agent_run_id
    return body


# ════════════════════════════════════════════════════════════════════
# _consume_vh_synced_marker：同源校验 + 一次性消费
# ════════════════════════════════════════════════════════════════════


class TestConsumeVhSyncedMarker:
    def setup_method(self):
        cache.clear()

    def test_matching_agent_marker_consumed_once(self):
        """同源 agent（run 一致）→ 命中、跳过 VH；标记被一次性消费，二次不再命中。"""
        from apps.collab.api import mark_vh_synced, _consume_vh_synced_marker

        rid = uuid.uuid4()
        mark_vh_synced("docs", str(rid), editor_type="agent", editor_id="agent-1", agent_run_id="run-x")
        body = _make_body(editor_type="agent", editor_id="agent-1", agent_run_id="run-x")

        assert _consume_vh_synced_marker("docs", rid, body) is True
        # 一次性消费：标记已删，第二次（如重复 onStore）不再误跳过
        assert _consume_vh_synced_marker("docs", rid, body) is False

    def test_no_marker_means_write_vh(self):
        """无标记（纯人手 / Y-first onStore）→ 不跳过，照常写 VH。"""
        from apps.collab.api import _consume_vh_synced_marker

        rid = uuid.uuid4()
        body = _make_body(editor_type="user", editor_id="user-1", agent_run_id="")
        assert _consume_vh_synced_marker("docs", rid, body) is False

    def test_agent_marker_does_not_skip_concurrent_human(self):
        """标记是 agent 写的，但并发到达的是人手 onStore（editor_type=user）→ 不误伤。"""
        from apps.collab.api import mark_vh_synced, _consume_vh_synced_marker

        rid = uuid.uuid4()
        mark_vh_synced("docs", str(rid), editor_type="agent", editor_id="agent-1", agent_run_id="run-x")
        human_body = _make_body(editor_type="user", editor_id="user-9", agent_run_id="")

        assert _consume_vh_synced_marker("docs", rid, human_body) is False
        # 人手 onStore 未消费标记；真正的 agent onStore 仍能命中跳过
        agent_body = _make_body(editor_type="agent", editor_id="agent-1", agent_run_id="run-x")
        assert _consume_vh_synced_marker("docs", rid, agent_body) is True

    def test_different_agent_run_not_skipped(self):
        """两次都有 run_id 但不一致 → 视为不同变更，不跳过。"""
        from apps.collab.api import mark_vh_synced, _consume_vh_synced_marker

        rid = uuid.uuid4()
        mark_vh_synced("docs", str(rid), editor_type="agent", editor_id="agent-1", agent_run_id="run-x")
        body = _make_body(editor_type="agent", editor_id="agent-1", agent_run_id="run-y")
        assert _consume_vh_synced_marker("docs", rid, body) is False

    def test_user_path_matches_editor_id(self):
        """user 路径按 editor_id 同源校验：同 id 命中，异 id 不误伤。"""
        from apps.collab.api import mark_vh_synced, _consume_vh_synced_marker

        rid = uuid.uuid4()
        mark_vh_synced("docs", str(rid), editor_type="user", editor_id="user-1", agent_run_id="")
        assert _consume_vh_synced_marker("docs", rid, _make_body(editor_type="user", editor_id="user-2", agent_run_id="")) is False
        assert _consume_vh_synced_marker("docs", rid, _make_body(editor_type="user", editor_id="user-1", agent_run_id="")) is True

    def test_non_docs_never_skips(self):
        """仅 docs 参与去重；slide / table 等不受影响（它们走各自 post_save 范式）。"""
        from apps.collab.api import mark_vh_synced, _consume_vh_synced_marker

        rid = uuid.uuid4()
        # 即便误打了 slide 标记，consume 也按 resource_type 短路返回 False
        mark_vh_synced("slide", str(rid), editor_type="agent", editor_id="a", agent_run_id="run-x")
        body = _make_body(editor_type="agent", editor_id="a", agent_run_id="run-x")
        assert _consume_vh_synced_marker("slide", rid, body) is False


# ════════════════════════════════════════════════════════════════════
# save_content（H-1）写 VH 后打标记，且归因正确
# ════════════════════════════════════════════════════════════════════


def _make_service():
    from apps.tabdoc.services.document_service import DocumentService

    service = DocumentService(user=MagicMock(id="user-1"))
    service.check_document_permission = MagicMock(return_value=True)
    return service


def _make_document(*, markdown="旧正文", doc_id="doc-td4b"):
    from django.utils import timezone

    return SimpleNamespace(
        id=doc_id,
        latest_version=2,
        title="标题",
        description_markdown=markdown,
        updated_at=timezone.now(),
        status="active",
        refresh_from_db=MagicMock(),
        updated_by=None,
    )


def _run_save_content(service, document, *, new_markdown="新正文"):
    update_qs = MagicMock()
    update_qs.filter.return_value = update_qs
    update_qs.update.return_value = 1

    with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
        with patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs):
            with patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
                with patch.object(service, "_update_search_vector"):
                    with patch.object(service, "push_and_update_binary", MagicMock()):
                        # 关键：_create_fallback_version_history 仍 mock（代表 H-1 已写 VH），
                        # 但 _mark_vh_synced_for_onstore 不 mock —— 让它真的去打标记。
                        with patch.object(service, "_create_fallback_version_history", MagicMock()):
                            with patch("apps.collab.api._invalidate_or_force_close", MagicMock()):
                                service.save_content(
                                    document,
                                    base_version=2,
                                    content_pm_json={"type": "doc", "content": [{"type": "paragraph"}]},
                                    content_markdown=new_markdown,
                                    content_plaintext=new_markdown,
                                )


class TestSaveContentSetsMarker:
    def setup_method(self):
        cache.clear()
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()

    def teardown_method(self):
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_agent_save_content_sets_marker_with_agent_attribution(self):
        from apps.services.common.platform_context import set_current_run_id
        from apps.collab.api import _vh_synced_marker_key

        set_current_run_id("run-abc")
        service = _make_service()
        document = _make_document(doc_id="doc-mark-agent")
        _run_save_content(service, document)

        marker = cache.get(_vh_synced_marker_key("docs", "doc-mark-agent"))
        assert isinstance(marker, dict), "save_content 内容变更后应打 vh_synced 标记"
        assert marker["editor_type"] == "agent", "标记归因应为 agent"
        assert marker["agent_run_id"] == "run-abc", "标记应带正确的 agent_run_id"

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_unchanged_content_sets_no_marker(self):
        service = _make_service()
        document = _make_document(markdown="同正文", doc_id="doc-mark-noop")
        _run_save_content(service, document, new_markdown="同正文")

        from apps.collab.api import _vh_synced_marker_key
        assert cache.get(_vh_synced_marker_key("docs", "doc-mark-noop")) is None, (
            "正文未变不写 VH，也不应打标记"
        )

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_no_marker_when_sync_vh_returns_none(self):
        """H-1 未实际写出 VH 时不能打标记，否则 onStore 会被误去重而漏写版本。"""
        from apps.collab.api import _vh_synced_marker_key

        service = _make_service()
        document = _make_document(doc_id="doc-mark-vh-none")
        update_qs = MagicMock()
        update_qs.filter.return_value = update_qs
        update_qs.update.return_value = 1

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs):
                with patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
                    with patch.object(service, "_update_search_vector"):
                        with patch.object(service, "_create_fallback_version_history", return_value=None):
                            with patch.object(service, "push_and_update_binary", MagicMock()):
                                with patch("apps.collab.api._invalidate_or_force_close", MagicMock()):
                                    service.save_content(
                                        document,
                                        base_version=2,
                                        content_pm_json={"type": "doc", "content": [{"type": "paragraph"}]},
                                        content_markdown="新正文",
                                        content_plaintext="新正文",
                                    )

        assert cache.get(_vh_synced_marker_key("docs", "doc-mark-vh-none")) is None

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=False)
    def test_flag_off_sets_no_marker(self):
        service = _make_service()
        document = _make_document(doc_id="doc-mark-flagoff")
        _run_save_content(service, document)

        from apps.collab.api import _vh_synced_marker_key
        assert cache.get(_vh_synced_marker_key("docs", "doc-mark-flagoff")) is None, (
            "flag 关闭（旧行为）时 H-1 不同步写 VH，也不应打标记"
        )


# ════════════════════════════════════════════════════════════════════
# collab_persist(onStore)：命中标记 → 跳过 VH（+1 非 +2）；无标记 → 照常写
# ════════════════════════════════════════════════════════════════════


class TestCollabPersistDedup:
    def setup_method(self):
        cache.clear()

    def _make_request(self):
        return MagicMock(headers={})

    def _adapter(self):
        adapter = MagicMock()
        # 每次返回新 dict，避免跨 persist 调用共享同一实例（真实代码每次也是新 result）
        adapter.persist_changes.side_effect = lambda *a, **k: {}  # 非 skipped：binary 已落盘
        adapter.get_resource.return_value = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_version_data.return_value = b"y-binary-bytes"
        adapter.check_permission.return_value = True
        return adapter

    @patch("apps.collab.api._resolve_agent_owner", return_value=MagicMock())
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction.atomic", side_effect=lambda *a, **kw: _noop_atomic())
    def test_persist_skips_vh_when_synced_marker_present(
        self, _atomic, MockVHS, mock_get_adapter, _owner
    ):
        """同一次 agent 变更：save_content 已写 VH + 打标记 → onStore 跳过写 VH（去重）。"""
        from apps.collab.api import collab_persist, mark_vh_synced

        adapter = self._adapter()
        rid = adapter.get_resource.return_value.id
        mock_get_adapter.return_value = adapter

        # 模拟 save_content 已写过 VH 并打标记
        mark_vh_synced("docs", str(rid), editor_type="agent", editor_id="agent-1", agent_run_id="run-x")

        body = _make_body(editor_type="agent", editor_id="agent-1", agent_run_id="run-x")
        result = collab_persist(self._make_request(), "docs", rid, body)

        assert result["status"] == "ok"
        assert result["data"].get("version_history_skipped_synced") is True
        MockVHS.return_value._do_create_history.assert_not_called()

    @patch("apps.collab.api._resolve_agent_owner", return_value=MagicMock())
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction.atomic", side_effect=lambda *a, **kw: _noop_atomic())
    def test_persist_writes_vh_when_no_marker(
        self, _atomic, MockVHS, mock_get_adapter, _owner
    ):
        """无标记（如 Agent Y-first push_from_agent，没走 save_content 同步）→ onStore 照常写 VH，不被误伤。"""
        from apps.collab.api import collab_persist

        adapter = self._adapter()
        rid = adapter.get_resource.return_value.id
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.return_value = MagicMock(id=uuid.uuid4())
        MockVHS.return_value = mock_svc

        body = _make_body(editor_type="agent", editor_id="agent-1", agent_run_id="run-x")

        with patch("apps.collab.models.ChangeLog") as MockCL:
            MockCL.objects.using.return_value.filter.return_value.order_by.return_value.first.return_value = None
            result = collab_persist(self._make_request(), "docs", rid, body)

        assert result["status"] == "ok"
        assert "version_history_skipped_synced" not in result["data"]
        mock_svc._do_create_history.assert_called_once()
        MockCL.objects.using.return_value.create.assert_called_once()

    @patch("apps.collab.api._resolve_agent_owner", return_value=MagicMock())
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction.atomic", side_effect=lambda *a, **kw: _noop_atomic())
    def test_persist_marker_consumed_so_repeat_onstore_writes(
        self, _atomic, MockVHS, mock_get_adapter, _owner
    ):
        """标记是一次性的：首条 onStore 去重后被消费，后续同 doc 的 onStore 不再被误跳过。"""
        from apps.collab.api import collab_persist, mark_vh_synced

        adapter = self._adapter()
        rid = adapter.get_resource.return_value.id
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.return_value = MagicMock(id=uuid.uuid4())
        MockVHS.return_value = mock_svc

        mark_vh_synced("docs", str(rid), editor_type="agent", editor_id="agent-1", agent_run_id="run-x")

        body1 = _make_body(editor_type="agent", editor_id="agent-1", agent_run_id="run-x")
        r1 = collab_persist(self._make_request(), "docs", rid, body1)
        assert r1["data"].get("version_history_skipped_synced") is True
        mock_svc._do_create_history.assert_not_called()

        # 后续一条真正的新变更（标记已被消费）→ 应正常写 VH
        body2 = _make_body(editor_type="agent", editor_id="agent-1", agent_run_id="run-x")
        with patch("apps.collab.models.ChangeLog") as MockCL:
            MockCL.objects.using.return_value.filter.return_value.order_by.return_value.first.return_value = None
            r2 = collab_persist(self._make_request(), "docs", rid, body2)
        assert "version_history_skipped_synced" not in r2["data"]
        mock_svc._do_create_history.assert_called_once()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

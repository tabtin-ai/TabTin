"""TD-4 Phase 4e-2：治理 latest_version 双跳。

问题：save_content（DB-first）先 latest_version +1，随后内容经 push → collab-live
→ onStore(save_from_hocuspocus) 回流时又 +1，一次保存版本号跳两档（v17→v18→v19）。

契约：
- save_content 内容变更后打一个 `collab:ver_synced:docs:{id}` 短键（带同源归因 + 目标版本号），
  与 VH 同步 flag 解耦（双跳是版本号自身问题，flag 关也会双跳）。
- save_from_hocuspocus(onStore) 落库前同源校验 + 一次性消费该标记，命中则**跳过版本 +1**
  （binary / 格式字段仍正常落库），使一次 save_content 只 +1、版本号单调连续不跳号。
- 不误伤：纯人手 / Agent Y-first 的 onStore 无标记，照常 +1；并发的他人编辑 editor 不匹配也不跳。
- 标记一次性消费：去重后即删，后续无关 onStore 不再被误判。

机制独立于 4b 的 vh_synced：版本 +1 发生在 persist_changes 内的 save_from_hocuspocus，
时序早于 collab_persist 里 4b 的 vh 标记消费点，故另用独立 key / 独立消费点，互不干扰。
"""
from __future__ import annotations

import os
import uuid
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from django.core.cache import cache  # noqa: E402
from django.test import override_settings  # noqa: E402


# ════════════════════════════════════════════════════════════════════
# _consume_version_synced_marker：同源校验 + 一次性消费
# ════════════════════════════════════════════════════════════════════


class TestConsumeVersionSyncedMarker:
    def setup_method(self):
        cache.clear()

    def test_matching_agent_marker_consumed_once(self):
        """同源 agent（run 一致）→ 命中、跳过 +1；标记一次性消费，二次不再命中。"""
        from apps.collab.api import mark_version_synced, _consume_version_synced_marker

        rid = uuid.uuid4()
        mark_version_synced("docs", str(rid), editor_type="agent", editor_id="agent-1", agent_run_id="run-x", version=18)

        assert _consume_version_synced_marker(
            "docs", rid, editor_type="agent", editor_id="agent-1", agent_run_id="run-x"
        ) is True
        # 一次性消费：重复 onStore 不再被误跳过
        assert _consume_version_synced_marker(
            "docs", rid, editor_type="agent", editor_id="agent-1", agent_run_id="run-x"
        ) is False

    def test_no_marker_means_bump(self):
        """无标记（纯人手 / Y-first onStore）→ 不跳过，照常 +1。"""
        from apps.collab.api import _consume_version_synced_marker

        rid = uuid.uuid4()
        assert _consume_version_synced_marker(
            "docs", rid, editor_type="user", editor_id="user-1", agent_run_id=""
        ) is False

    def test_agent_marker_does_not_skip_concurrent_human(self):
        """标记是 agent 写的，但并发到达的是人手 onStore → 不误伤；真正 agent onStore 仍命中。"""
        from apps.collab.api import mark_version_synced, _consume_version_synced_marker

        rid = uuid.uuid4()
        mark_version_synced("docs", str(rid), editor_type="agent", editor_id="agent-1", agent_run_id="run-x", version=18)

        assert _consume_version_synced_marker(
            "docs", rid, editor_type="user", editor_id="user-9", agent_run_id=""
        ) is False
        assert _consume_version_synced_marker(
            "docs", rid, editor_type="agent", editor_id="agent-1", agent_run_id="run-x"
        ) is True

    def test_different_agent_run_not_skipped(self):
        """两次都有 run_id 但不一致 → 视为不同变更，不跳过。"""
        from apps.collab.api import mark_version_synced, _consume_version_synced_marker

        rid = uuid.uuid4()
        mark_version_synced("docs", str(rid), editor_type="agent", editor_id="agent-1", agent_run_id="run-x", version=18)
        assert _consume_version_synced_marker(
            "docs", rid, editor_type="agent", editor_id="agent-1", agent_run_id="run-y"
        ) is False

    def test_user_path_matches_editor_id(self):
        """user 路径按 editor_id 同源校验：同 id 命中，异 id 不误伤。"""
        from apps.collab.api import mark_version_synced, _consume_version_synced_marker

        rid = uuid.uuid4()
        mark_version_synced("docs", str(rid), editor_type="user", editor_id="user-1", agent_run_id="", version=18)
        assert _consume_version_synced_marker(
            "docs", rid, editor_type="user", editor_id="user-2", agent_run_id=""
        ) is False
        assert _consume_version_synced_marker(
            "docs", rid, editor_type="user", editor_id="user-1", agent_run_id=""
        ) is True

    def test_non_docs_never_skips(self):
        """仅 docs 参与版本去重；slide / table 等不受影响。"""
        from apps.collab.api import mark_version_synced, _consume_version_synced_marker

        rid = uuid.uuid4()
        mark_version_synced("slide", str(rid), editor_type="agent", editor_id="a", agent_run_id="run-x", version=18)
        assert _consume_version_synced_marker(
            "slide", rid, editor_type="agent", editor_id="a", agent_run_id="run-x"
        ) is False

    def test_version_marker_independent_of_vh_marker(self):
        """ver_synced 与 vh_synced 是两套独立 key：消费一个不影响另一个。

        防回归 4b：onStore 在 save_from_hocuspocus 内消费 ver_synced 后，collab_persist
        仍能在更晚的消费点拿到 vh_synced 去重，二者互不干扰。
        """
        from apps.collab.api import (
            mark_version_synced, _consume_version_synced_marker,
            mark_vh_synced, _consume_vh_synced_marker,
        )

        rid = uuid.uuid4()
        mark_version_synced("docs", str(rid), editor_type="agent", editor_id="a", agent_run_id="run-x", version=18)
        mark_vh_synced("docs", str(rid), editor_type="agent", editor_id="a", agent_run_id="run-x")

        # 先消费版本标记（onStore save_from_hocuspocus 内）
        assert _consume_version_synced_marker(
            "docs", rid, editor_type="agent", editor_id="a", agent_run_id="run-x"
        ) is True
        # vh 标记仍在，collab_persist 后续仍能去重 VH
        body = SimpleNamespace(editor_type="agent", editor_id="a", agent_run_id="run-x")
        assert _consume_vh_synced_marker("docs", rid, body) is True


# ════════════════════════════════════════════════════════════════════
# save_content：内容变更后打版本去重标记（与 VH flag 解耦）
# ════════════════════════════════════════════════════════════════════


def _make_service():
    from apps.tabdoc.services.document_service import DocumentService

    service = DocumentService(user=MagicMock(id="user-1"))
    service.check_document_permission = MagicMock(return_value=True)
    return service


def _make_document(*, markdown="旧正文", doc_id="doc-td4e2", latest_version=2):
    from django.utils import timezone

    return SimpleNamespace(
        id=doc_id,
        latest_version=latest_version,
        title="标题",
        description_markdown=markdown,
        description_binary=None,
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
                        # _create_fallback_version_history mock（代表 H-1 已写 VH），
                        # 但 _mark_version_synced_for_onstore 不 mock —— 让它真的打版本标记。
                        with patch.object(service, "_create_fallback_version_history", MagicMock()):
                            with patch("apps.collab.api._invalidate_or_force_close", MagicMock()):
                                service.save_content(
                                    document,
                                    base_version=document.latest_version,
                                    content_pm_json={"type": "doc", "content": [{"type": "paragraph"}]},
                                    content_markdown=new_markdown,
                                    content_plaintext=new_markdown,
                                )


class TestSaveContentSetsVersionMarker:
    def setup_method(self):
        cache.clear()
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()

    def teardown_method(self):
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_agent_save_content_sets_version_marker(self):
        from apps.services.common.platform_context import set_current_run_id
        from apps.collab.api import _ver_synced_marker_key

        set_current_run_id("run-abc")
        service = _make_service()
        document = _make_document(doc_id="doc-ver-agent", latest_version=17)
        _run_save_content(service, document)

        assert document.latest_version == 18, "save_content 应把 latest_version +1（v17→v18）"
        marker = cache.get(_ver_synced_marker_key("docs", "doc-ver-agent"))
        assert isinstance(marker, dict), "save_content 内容变更后应打 ver_synced 标记"
        assert marker["editor_type"] == "agent"
        assert marker["agent_run_id"] == "run-abc"
        assert marker["version"] == 18, "标记应记录 DB-first +1 后的目标版本号"

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=False)
    def test_version_marker_set_even_when_vh_flag_off(self):
        """关键差异点：版本双跳与 VH 同步 flag 无关，flag 关也要打版本标记。"""
        from apps.collab.api import _ver_synced_marker_key, _vh_synced_marker_key

        service = _make_service()
        document = _make_document(doc_id="doc-ver-flagoff", latest_version=5)
        _run_save_content(service, document)

        assert cache.get(_ver_synced_marker_key("docs", "doc-ver-flagoff")) is not None, (
            "flag 关闭时仍会版本双跳，故仍须打 ver_synced 标记"
        )
        # 对照：4b 的 vh 标记 flag 关时不打（旧行为）
        assert cache.get(_vh_synced_marker_key("docs", "doc-ver-flagoff")) is None

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_unchanged_content_sets_no_version_marker(self):
        from apps.collab.api import _ver_synced_marker_key

        service = _make_service()
        document = _make_document(markdown="同正文", doc_id="doc-ver-noop")
        _run_save_content(service, document, new_markdown="同正文")

        assert cache.get(_ver_synced_marker_key("docs", "doc-ver-noop")) is None, (
            "正文未变不推 push、不会触发 onStore +1，也不应打版本标记"
        )


# ════════════════════════════════════════════════════════════════════
# save_from_hocuspocus(onStore)：命中标记 → 跳过 +1；无标记 → 照常 +1
# ════════════════════════════════════════════════════════════════════


def _run_save_from_hocuspocus(service, document, *, editor_type="user", editor_id="",
                              update_blob=b"new-binary"):
    """以 mock 的 ORM 驱动 save_from_hocuspocus，捕获写回的 update_fields。"""
    description_json = {"type": "doc", "content": [{"type": "paragraph"}]}

    locked_doc = SimpleNamespace(latest_version=document.latest_version)
    captured: dict = {}

    objs = MagicMock()
    objs.select_for_update.return_value.get.return_value = locked_doc

    def _update(**fields):
        captured.update(fields)
        return 1

    objs.filter.return_value.update.side_effect = _update

    Document_mock = MagicMock()
    Document_mock.objects.using.return_value = objs

    DocUpdate_mock = MagicMock()
    DocUpdate_mock.objects.create.return_value = SimpleNamespace(id="docupd-1")

    # 绕过权限：onStore 权限块会按 editor_id 查 User 并校验权限，单测无 DB，
    # patch get_user_model（返回 mock 用户，避免 UUID 校验）+ check_document_permission。
    user_model_mock = MagicMock()
    user_model_mock.objects.get.return_value = MagicMock()

    from apps.tabdoc.services.document_service import DocumentService

    with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
        with patch("apps.tabdoc.services.document_service.router.db_for_write", return_value="postgresql"):
            with patch("apps.tabdoc.services.document_service.Document", Document_mock):
                with patch("apps.tabdoc.services.document_service.DocUpdate", DocUpdate_mock):
                    with patch("django.contrib.auth.get_user_model", return_value=user_model_mock):
                        with patch.object(DocumentService, "check_document_permission", return_value=True):
                            with patch.object(service, "assert_document_collab_writable", MagicMock()):
                                with patch("apps.tabdoc.services.markdown_exchange.pm_json_to_markdown", return_value="# md"):
                                    service.save_from_hocuspocus(
                                        document,
                                        update_blob=update_blob,
                                        editor_type=editor_type,
                                        editor_id=editor_id,
                                        description_json=description_json,
                                    )
    return captured


class TestSaveFromHocuspocusSkipsBump:
    def setup_method(self):
        cache.clear()
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()

    def teardown_method(self):
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()

    def _service(self):
        from apps.tabdoc.services.document_service import DocumentService
        return DocumentService(user=None)

    def test_onstore_skips_bump_when_marker_present(self):
        """命中同源版本标记 → onStore 不 +1，版本号保持 save_content 已 +1 后的值。"""
        from apps.collab.api import mark_version_synced, _ver_synced_marker_key

        service = self._service()
        document = _make_document(doc_id="doc-bump-skip", latest_version=18)
        mark_version_synced("docs", "doc-bump-skip", editor_type="user", editor_id="", agent_run_id="", version=18)

        captured = _run_save_from_hocuspocus(service, document, editor_type="user", editor_id="")

        assert captured["latest_version"] == 18, "命中标记应跳过 +1，版本号保持 18（不双跳到 19）"
        assert captured["description_binary"] == b"new-binary", "跳过 +1 时 binary 仍正常落库"
        # 标记一次性消费
        assert cache.get(_ver_synced_marker_key("docs", "doc-bump-skip")) is None

    def test_pure_human_onstore_still_bumps(self):
        """纯人手 onStore（无 save_content 标记）→ 仍 +1，不被误伤。"""
        service = self._service()
        document = _make_document(doc_id="doc-bump-human", latest_version=18)

        captured = _run_save_from_hocuspocus(service, document, editor_type="user", editor_id="")

        assert captured["latest_version"] == 19, "无标记的纯人手 onStore 应照常 +1（v18→v19）"

    def test_marker_consumed_so_repeat_onstore_bumps(self):
        """标记一次性：首条 onStore 去重后被消费，后续同 doc 的 onStore 恢复正常 +1。"""
        from apps.collab.api import mark_version_synced

        service = self._service()
        document = _make_document(doc_id="doc-bump-once", latest_version=18)
        mark_version_synced("docs", "doc-bump-once", editor_type="user", editor_id="", agent_run_id="", version=18)

        c1 = _run_save_from_hocuspocus(service, document, editor_type="user", editor_id="", update_blob=b"blob-1")
        assert c1["latest_version"] == 18, "首条 onStore 命中标记，跳过 +1"

        document.latest_version = 18  # save_content 之后 onStore 未推进
        c2 = _run_save_from_hocuspocus(service, document, editor_type="user", editor_id="", update_blob=b"blob-2")
        assert c2["latest_version"] == 19, "标记已消费，后续真实协作 onStore 恢复 +1"

    def test_different_origin_onstore_not_skipped(self):
        """标记由 user-A 打，但 onStore 是 user-B → 不同源，不跳过（不误伤并发他人）。"""
        from apps.tabdoc.services.document_service import DocumentService
        from apps.collab.api import mark_version_synced

        service = DocumentService(user=None)
        document = _make_document(doc_id="doc-bump-other", latest_version=18)
        mark_version_synced("docs", "doc-bump-other", editor_type="user", editor_id="user-A", agent_run_id="", version=18)

        captured = _run_save_from_hocuspocus(service, document, editor_type="user", editor_id="user-B")
        assert captured["latest_version"] == 19, "不同源 onStore 应照常 +1"


# ════════════════════════════════════════════════════════════════════
# 端到端：一次 save_content + 回流 onStore 合计只 +1、版本号连续
# ════════════════════════════════════════════════════════════════════


class TestEndToEndSingleBump:
    def setup_method(self):
        cache.clear()
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()

    def teardown_method(self):
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_agent_save_then_onstore_nets_single_bump(self):
        """v17 → save_content(+1)→v18 → 回流 onStore(命中标记，不+1)→v18：合计只 +1、连续。"""
        from apps.services.common.platform_context import set_current_run_id

        set_current_run_id("run-abc")
        service = _make_service()
        document = _make_document(doc_id="doc-e2e", latest_version=17)

        # 1) save_content：DB-first +1，并打版本去重标记
        _run_save_content(service, document)
        assert document.latest_version == 18

        # 2) 模拟内容经 push → collab-live → onStore 回流到 save_from_hocuspocus
        onstore_service = service  # 同一 run 上下文（run_id 仍在 ContextVar）
        captured = _run_save_from_hocuspocus(
            onstore_service, document, editor_type="agent", editor_id="user-1",
        )

        assert captured["latest_version"] == 18, (
            "onStore 命中标记跳过 +1，最终版本号停在 18 —— 一次保存只 +1，不再 v17→v18→v19 双跳"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

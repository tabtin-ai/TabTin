"""TD-1 (ISSUE-H)：save_content 统一「内容变更 → 版本历史」契约。

H-1：内容变更后**同步**写 VersionHistory + ChangeLog，不再寄希望于 push/onStore
     的副产品；flag 关闭时回退旧行为（仅 push 失败兜底）。
H-2：CLI/Agent 经 REST 改文档时，run 上下文经中间件还原到 ContextVar，
     editor_type 归因为 agent。
"""
from __future__ import annotations

import os
import json
import unittest
import zlib
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django

django.setup()

from django.test import override_settings  # noqa: E402


def _make_service():
    from apps.tabdoc.services.document_service import DocumentService

    service = DocumentService(user=MagicMock(id="user-1"))
    service.check_document_permission = MagicMock(return_value=True)
    return service


def _make_document(*, markdown="旧正文", doc_id="doc-td1"):
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


def _run_save_content(
    service, document, *, push_side_effect=None, new_markdown="新正文",
    content_pm_json=None,
):
    if content_pm_json is None:
        content_pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": new_markdown}],
                }
            ],
        }
    update_qs = MagicMock()
    update_qs.filter.return_value = update_qs
    update_qs.update.return_value = 1

    push_mock = MagicMock(side_effect=push_side_effect)
    fallback_mock = MagicMock()

    with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
        with patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs):
            with patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
                with patch.object(service, "_update_search_vector"):
                    with patch.object(service, "push_and_update_binary", push_mock):
                        with patch.object(service, "_create_fallback_version_history", fallback_mock):
                            with patch("apps.collab.api._invalidate_or_force_close", MagicMock()):
                                service.save_content(
                                    document,
                                    base_version=2,
                                    content_pm_json=content_pm_json,
                                    content_markdown=new_markdown,
                                    content_plaintext=new_markdown,
                                )
    return push_mock, fallback_mock


class TestH1SyncVersionHistory(unittest.TestCase):
    def test_malformed_and_deep_blocks_do_not_block_safe_sibling_save(self):
        service = _make_service()
        document = _make_document()
        deep_node = {"type": "text", "text": "深层内容"}
        for _ in range(1_200):
            deep_node = {"type": "futureContainer", "content": [deep_node]}
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "futureBlock", "content": 7},
                {"type": "paragraph", "content": 7},
                deep_node,
                {
                    "type": "heading",
                    "attrs": {"level": "future"},
                    "content": [{"type": "text", "text": "只读标题"}],
                },
                {
                    "type": "orderedList",
                    "attrs": ["future-list-attrs"],
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "只读列表项"}],
                                }
                            ],
                        }
                    ],
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "安全正文"}],
                },
            ],
        }

        _run_save_content(
            service,
            document,
            content_pm_json=pm_json,
            new_markdown="不可信客户端投影",
        )

        self.assertIn("只读标题", document.description_markdown)
        self.assertIn("只读列表项", document.description_markdown)
        self.assertIn("安全正文", document.description_markdown)
        self.assertEqual(
            document.description_plaintext,
            "只读标题\n只读列表项\n安全正文",
        )

    def test_pm_json_rebuilds_markdown_and_plaintext_instead_of_trusting_client_projection(self):
        service = _make_service()
        document = _make_document()
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "加粗正文",
                            "marks": [{"type": "bold"}],
                        }
                    ],
                },
                {
                    "type": "blockquote",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "只读引用文字"}],
                        }
                    ],
                },
                {
                    "type": "orderedList",
                    "attrs": {"start": 3},
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "列表文字"}],
                                }
                            ],
                        }
                    ],
                },
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl-secret", "title": "项目任务表"},
                },
            ],
        }

        _run_save_content(
            service,
            document,
            content_pm_json=pm_json,
            new_markdown="残缺客户端投影",
        )

        self.assertIn("**加粗正文**", document.description_markdown)
        self.assertIn("> 只读引用文字", document.description_markdown)
        self.assertIn("3. 列表文字", document.description_markdown)
        self.assertEqual(
            document.description_plaintext,
            "加粗正文\n只读引用文字\n列表文字\n项目任务表",
        )
        self.assertNotIn("残缺客户端", document.description_markdown)
        self.assertNotIn("残缺客户端", document.description_plaintext)
        self.assertNotIn("tbl-secret", document.description_plaintext)

    def test_private_image_forces_canonical_markdown_even_when_pm_is_already_stable(self):
        service = _make_service()
        document = _make_document()
        pm_json = {
            "type": "doc",
            "content": [{
                "type": "image",
                "attrs": {"fileId": "file-1", "src": "", "alt": "private"},
            }],
        }
        with patch(
            "apps.tabdoc.services.image_asset_service.ImageAssetService.normalize_pm_json_for_storage",
            return_value=pm_json,
        ), patch(
            "apps.tabdoc.services.image_asset_service.ImageAssetService.pm_json_contains_file_assets",
            return_value=True,
        ), patch(
            "apps.tabdoc.services.markdown_exchange.pm_json_to_markdown",
            return_value="![private](tabtin-file://asset/file-1)",
        ) as render_markdown:
            _run_save_content(
                service,
                document,
                new_markdown="",
                content_pm_json=pm_json,
            )

        render_markdown.assert_called_once_with(pm_json)
        self.assertEqual(
            document.description_markdown,
            "![private](tabtin-file://asset/file-1)",
        )

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_sync_vh_written_when_push_succeeds(self):
        """flag 开 + push 成功：内容变更也必须同步写一条 VH（不再依赖 onStore）。"""
        service = _make_service()
        document = _make_document()
        push_mock, fallback_mock = _run_save_content(service, document)
        fallback_mock.assert_called_once()
        push_mock.assert_called_once()

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_sync_vh_written_once_when_push_fails(self):
        """flag 开 + push 抛错：VH 已同步写入，不重复补写。"""
        service = _make_service()
        document = _make_document()
        _push, fallback_mock = _run_save_content(
            service, document, push_side_effect=RuntimeError("collab-live down")
        )
        fallback_mock.assert_called_once()

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_no_vh_when_content_unchanged(self):
        """正文未变：不写无意义历史。"""
        service = _make_service()
        document = _make_document(markdown="同正文")
        _push, fallback_mock = _run_save_content(service, document, new_markdown="同正文")
        fallback_mock.assert_not_called()

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=False)
    def test_flag_off_keeps_legacy_behavior_push_ok(self):
        """flag 关 + push 成功：回到旧行为，不主动写 VH。"""
        service = _make_service()
        document = _make_document()
        _push, fallback_mock = _run_save_content(service, document)
        fallback_mock.assert_not_called()

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=False)
    def test_flag_off_fallback_on_push_failure(self):
        """flag 关 + push 抛错：旧的兜底路径仍补一条 VH。"""
        service = _make_service()
        document = _make_document()
        _push, fallback_mock = _run_save_content(
            service, document, push_side_effect=RuntimeError("collab-live down")
        )
        fallback_mock.assert_called_once()

    def test_fallback_version_history_snapshot_includes_title(self):
        """TD-13: save_content 写出的权威 json_snapshot 必须包含当前标题。"""
        from apps.tabdoc.services.document_service import DocumentService

        document = _make_document()
        document.title = "Agent 修改后的标题"
        document.description_plaintext = "新正文"
        pm_json = {"type": "doc", "content": [{"type": "paragraph"}]}

        with patch.object(
            DocumentService,
            "_resolve_history_attribution",
            return_value=("run-td13", "session-td13"),
        ), patch.object(DocumentService, "_record_content_history") as record_mock:
            DocumentService._create_fallback_version_history(
                document,
                pm_json,
                editor_type="agent",
                editor_id="agent-1",
            )

        record_mock.assert_called_once()
        snapshot_data = record_mock.call_args.kwargs["snapshot_data"]
        self.assertEqual(snapshot_data["format"], "json_snapshot")
        self.assertEqual(snapshot_data["title"], "Agent 修改后的标题")
        self.assertEqual(snapshot_data["description_json"], pm_json)
        self.assertTrue(record_mock.call_args.kwargs["skip_throttle"])


class TestPmJsonBackfill(unittest.TestCase):
    """CLI `doc save-content --markdown` 只给 markdown、pm_json 为空时，
    save_content 应补转换 markdown→pm_json，否则 push_and_update_binary 早退、
    TD-2 整篇替换推不到协作编辑器。"""

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_empty_pm_json_backfilled_so_push_receives_content(self):
        service = _make_service()
        document = _make_document()
        # 模拟 CLI：content_pm_json 为空 {}，只给 markdown
        push_mock, _fallback = _run_save_content(
            service, document, content_pm_json={}, new_markdown="只剩西瓜",
        )
        push_mock.assert_called_once()
        pushed_pm_json = push_mock.call_args.args[1]
        self.assertTrue(
            pushed_pm_json.get("content"),
            "空 pm_json 应被补成带 content 的 PM JSON，push_and_update_binary 才不会早退",
        )

    @override_settings(TABDOC_SYNC_VH_ON_SAVE_CONTENT=True)
    def test_existing_pm_json_not_overwritten(self):
        service = _make_service()
        document = _make_document()
        explicit = {"type": "doc", "content": [{"type": "heading"}]}
        push_mock, _fallback = _run_save_content(
            service, document, content_pm_json=explicit, new_markdown="正文",
        )
        # 调用方已给 pm_json（带 content）时不应被 markdown 覆盖；服务端仍可
        # 为顶层块补持久 ID，这是 canonical normalization，不是内容替换。
        pushed_pm_json = push_mock.call_args.args[1]
        self.assertEqual(pushed_pm_json["type"], "doc")
        self.assertEqual(len(pushed_pm_json["content"]), 1)
        self.assertEqual(pushed_pm_json["content"][0]["type"], "heading")
        self.assertIn("blockId", pushed_pm_json["content"][0]["attrs"])


class TestCreateDocumentPmJsonBackfill(unittest.TestCase):
    """CLI `doc create --markdown` 只给 markdown 时，也必须初始化正文结构。

    这是 `save_content` markdown-only backfill 的同类入口：如果 create 路径不补
    PM JSON，`description_markdown` 虽有内容，但协作编辑器依赖的 Y.js binary 会因
    空 pm_json 跳过初始化，打开正文区表现为空。
    """

    _WT = "11111111-1111-4111-8111-111111111111"
    _SP = "22222222-2222-4222-8222-222222222222"

    def _make_service(self):
        from apps.tabdoc.services.document_service import DocumentService

        service = DocumentService(user=MagicMock(id="user-1"))
        service.check_space_permission = MagicMock(return_value=True)
        service._ensure_space_context = MagicMock()
        service._update_search_vector = MagicMock()
        service._safe_user_for_fk = MagicMock(return_value=None)
        service._get_editor_id = MagicMock(return_value="editor-xyz")
        service.user = None
        return service

    def test_markdown_only_create_backfills_pm_json_for_initial_body(self):
        service = self._make_service()
        created_doc = SimpleNamespace(
            id="33333333-3333-4333-8333-333333333333",
            organization_id=self._WT,
        )

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()), \
             patch("apps.tabdoc.services.document_service.transaction.on_commit", side_effect=lambda fn, using=None: fn()), \
             patch("apps.tabdoc.services.document_service.Document.objects.create", return_value=created_doc) as create_mock, \
             patch("apps.tabdoc.services.document_service.ResourceBridge.on_create"), \
             patch("threading.Thread") as thread_cls, \
             patch("apps.collab.service.VersionHistoryService.create_history") as ch_mock:
            service.create_document(
                organization_id=self._WT,
                space_id=self._SP,
                parent_id=None,
                title="番茄炒蛋",
                initial_content_pm_json={},
                initial_content_markdown="# 番茄炒蛋\n\n1. 打蛋\n2. 炒番茄",
                initial_content_plaintext="",
            )

        create_kwargs = create_mock.call_args.kwargs
        pm_json = create_kwargs["description_json"]
        self.assertTrue(
            pm_json.get("content"),
            "create --markdown 应补出带 content 的 PM JSON，避免正文编辑区空白",
        )
        self.assertEqual(create_kwargs["description_markdown"], "# 番茄炒蛋\n\n1. 打蛋\n2. 炒番茄")
        self.assertEqual(create_kwargs["description_plaintext"], "番茄炒蛋 1. 打蛋 2. 炒番茄")

        snapshot_data = ch_mock.call_args.kwargs["data"]
        self.assertEqual(snapshot_data["description_json"], pm_json)
        thread_kwargs = thread_cls.call_args.kwargs
        self.assertEqual(thread_kwargs["args"][1], pm_json)

    def test_existing_create_pm_json_not_overwritten(self):
        service = self._make_service()
        created_doc = SimpleNamespace(
            id="44444444-4444-4444-8444-444444444444",
            organization_id=self._WT,
        )
        explicit = {"type": "doc", "content": [{"type": "heading", "attrs": {"level": 2}}]}

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()), \
             patch("apps.tabdoc.services.document_service.transaction.on_commit", side_effect=lambda fn, using=None: fn()), \
             patch("apps.tabdoc.services.document_service.Document.objects.create", return_value=created_doc) as create_mock, \
             patch("apps.tabdoc.services.document_service.ResourceBridge.on_create"), \
             patch("threading.Thread"), \
             patch("apps.collab.service.VersionHistoryService.create_history"):
            service.create_document(
                organization_id=self._WT,
                space_id=self._SP,
                parent_id=None,
                title="已有结构",
                initial_content_pm_json=explicit,
                initial_content_markdown="# 不应覆盖",
                initial_content_plaintext="不应覆盖",
            )

        self.assertEqual(create_mock.call_args.kwargs["description_json"], explicit)

    def test_create_markdown_conversion_error_blocks_create(self):
        for side_effect in (
            ValueError("markdown too large"),
            RuntimeError("converter unavailable"),
        ):
            service = self._make_service()
            with self.subTest(side_effect=type(side_effect).__name__):
                with patch(
                    "apps.tabdoc.services.document_service.markdown_to_pm_json",
                    side_effect=side_effect,
                ), patch(
                    "apps.tabdoc.services.document_service.Document.objects.create",
                ) as create_mock:
                    with self.assertRaises(ValueError):
                        service.create_document(
                            organization_id=self._WT,
                            space_id=self._SP,
                            parent_id=None,
                            title="非法 Markdown",
                            initial_content_pm_json={},
                            initial_content_markdown="# 太大",
                            initial_content_plaintext="",
                        )

                create_mock.assert_not_called()

    def test_create_markdown_empty_conversion_result_blocks_create(self):
        for converted in (None, {}, {"type": "doc", "content": []}):
            service = self._make_service()
            with self.subTest(converted=converted):
                with patch(
                    "apps.tabdoc.services.document_service.markdown_to_pm_json",
                    return_value=converted,
                ), patch(
                    "apps.tabdoc.services.document_service.Document.objects.create",
                ) as create_mock:
                    with self.assertRaises(ValueError):
                        service.create_document(
                            organization_id=self._WT,
                            space_id=self._SP,
                            parent_id=None,
                            title="空转换结果",
                            initial_content_pm_json={},
                            initial_content_markdown="# 有内容",
                            initial_content_plaintext="",
                        )

                create_mock.assert_not_called()


class TestTD13VersionHistorySnapshotParsing(unittest.TestCase):
    def test_resolve_vh_content_preserves_json_snapshot_title(self):
        """TD-13: restore_history 旧路径解析 VH 时不能丢掉 title 等快照字段。"""
        from apps.tabdoc.services.document_service import DocumentService

        snapshot = {
            "format": "json_snapshot",
            "title": "历史标题",
            "description_json": {"type": "doc", "content": []},
            "description_markdown": "# 历史标题",
            "description_plaintext": "历史标题",
        }
        vh = SimpleNamespace(
            blob=zlib.compress(json.dumps(snapshot, ensure_ascii=False).encode("utf-8")),
        )

        resolved = DocumentService(user=None)._resolve_vh_content(vh)

        self.assertEqual(resolved, snapshot)


class TestH2EditorTypeAttribution(unittest.TestCase):
    def test_editor_type_defaults_user(self):
        service = _make_service()
        from apps.services.common.platform_context import reset_all_context

        reset_all_context()
        self.assertEqual(service._get_editor_type(), "user")

    def test_editor_type_agent_when_run_context_present(self):
        service = _make_service()
        from apps.services.common.platform_context import (
            reset_all_context,
            set_current_run_id,
        )

        reset_all_context()
        set_current_run_id("run-abc")
        try:
            self.assertEqual(service._get_editor_type(), "agent")
        finally:
            reset_all_context()

    def test_explicit_override_wins(self):
        from apps.tabdoc.services.document_service import DocumentService
        from apps.services.common.platform_context import (
            reset_all_context,
            set_current_run_id,
        )

        service = DocumentService(user=MagicMock(id="u"), editor_type="system")
        reset_all_context()
        set_current_run_id("run-abc")
        try:
            self.assertEqual(service._get_editor_type(), "system")
        finally:
            reset_all_context()


class TestAgentRunContextMiddleware(unittest.TestCase):
    def _make_request(self, headers):
        meta = {f"HTTP_{k.upper().replace('-', '_')}": v for k, v in headers.items()}
        return SimpleNamespace(headers=headers, META=meta)

    def test_headers_restore_context_and_reset(self):
        from apps.services.common.middleware import AgentRunContextMiddleware
        from apps.services.common.platform_context import (
            get_current_run_id,
            get_current_session_id,
            reset_all_context,
        )

        reset_all_context()
        mw = AgentRunContextMiddleware(lambda r: r)
        request = self._make_request({
            "X-Tabtin-Agent-Run-Id": "run-xyz",
            "X-Tabtin-Session-Id": "sess-xyz",
        })
        mw.process_request(request)
        self.assertEqual(get_current_run_id(), "run-xyz")
        self.assertEqual(get_current_session_id(), "sess-xyz")

        mw.process_response(request, SimpleNamespace())
        self.assertIsNone(get_current_run_id())
        self.assertIsNone(get_current_session_id())

    def test_no_headers_is_noop(self):
        from apps.services.common.middleware import AgentRunContextMiddleware
        from apps.services.common.platform_context import (
            get_current_run_id,
            reset_all_context,
        )

        reset_all_context()
        mw = AgentRunContextMiddleware(lambda r: r)
        request = self._make_request({})
        mw.process_request(request)
        self.assertIsNone(get_current_run_id())


class TestCreateDocumentInitialVHAttribution(unittest.TestCase):
    """回归：create_document 写初始版本时的 editor_type 归因。

    历史 bug：create_document 内联从 ``apps.services.agent_engine.services.execution_context``
    导入 ``get_current_run_id``（该模块根本没有这个符号），import 永久抛 ImportError 被
    ``except (ImportError, Exception)`` 吞掉 → ``_agent_run_id_for_vh`` 恒为 ""，于是初始 VH
    的 editor_type 永远是 "user"。表现为：Agent 建的文档，版本历史第一条被标成「由你手动编辑」。

    修复：改用 ``self._get_editor_type()``（正确的 platform_context import + 尊重 override）。
    本测试直接驱动真实 create_document → 初始 VH 路径，断言 create_history 收到的 editor_type。
    """

    _WT = "11111111-1111-4111-8111-111111111111"
    _SP = "22222222-2222-4222-8222-222222222222"

    def _capture_initial_editor_type(self, *, run_id=None, override=None):
        from apps.tabdoc.services.document_service import DocumentService
        from apps.services.common.platform_context import (
            reset_all_context,
            set_current_run_id,
        )

        kwargs = {"user": MagicMock(id="user-1")}
        if override is not None:
            kwargs["editor_type"] = override
        service = DocumentService(**kwargs)
        service.check_organization_permission = MagicMock(return_value=True)
        service._ensure_space_context = MagicMock()
        service._update_search_vector = MagicMock()
        service._safe_user_for_fk = MagicMock(return_value=None)
        service._get_editor_id = MagicMock(return_value="editor-xyz")
        # 跳过 DocumentPermission.objects.create 分支（构造期 user 为真即可触发）
        service.user = None

        created_doc = SimpleNamespace(id="33333333-3333-4333-8333-333333333333", organization_id=self._WT)

        reset_all_context()
        if run_id:
            set_current_run_id(run_id)
        try:
            with patch("apps.tabtinspace.models.Organization.objects.using") as organization_using, \
                 patch("apps.services.billing.services.entitlement_limits_service.EntitlementLimitsService.check_document_limit"), \
                 patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()), \
                 patch("apps.tabdoc.services.document_service.transaction.on_commit", side_effect=lambda fn, using=None: fn()), \
                 patch("apps.tabdoc.services.document_service.Document.objects.create", return_value=created_doc), \
                 patch("apps.tabdoc.services.document_service.ResourceBridge.on_create"), \
                 patch.object(DocumentService, "_init_description_binary"), \
                 patch("threading.Thread"), \
                 patch("apps.collab.service.VersionHistoryService.create_history") as ch_mock, \
                 patch("apps.collab.models.ChangeLog.objects.using"):
                organization_using.return_value.select_for_update.return_value.get.return_value = MagicMock()
                service.create_document(
                    organization_id=self._WT,
                    space_id=self._SP,
                    parent_id=None,
                    title="标题",
                    initial_content_pm_json={},
                    initial_content_markdown="正文",
                    initial_content_plaintext="正文",
                )
        finally:
            reset_all_context()

        ch_mock.assert_called_once()
        editor_info = ch_mock.call_args.kwargs["editor_info"]
        return editor_info["editor_type"]

    def test_initial_vh_attributed_agent_under_run_context(self):
        """run 上下文存在（Agent 经 REST 建文档）→ 初始版本必须是 agent。

        这是核心回归断言：bug 修复前这里恒为 'user'。
        """
        self.assertEqual(
            self._capture_initial_editor_type(run_id="run-abc"),
            "agent",
        )

    def test_initial_vh_attributed_user_without_run_context(self):
        """无 run 上下文（真人建文档）→ 初始版本是 user。"""
        self.assertEqual(
            self._capture_initial_editor_type(run_id=None),
            "user",
        )

    def test_agent_create_records_create_changelog_with_run_context(self):
        """Agent 新建文档必须写 create ChangeLog，供按本轮撤销时移入回收站。"""
        from apps.services.common.platform_context import (
            reset_all_context,
            set_current_run_id,
            set_current_session_id,
        )
        from apps.tabdoc.services.document_service import DocumentService

        service = DocumentService(user=MagicMock(id="user-1"))
        service.check_organization_permission = MagicMock(return_value=True)
        service._ensure_space_context = MagicMock()
        service._update_search_vector = MagicMock()
        service._safe_user_for_fk = MagicMock(return_value=None)
        service._get_editor_id = MagicMock(return_value="editor-xyz")
        service.user = None

        created_doc = SimpleNamespace(
            id="33333333-3333-4333-8333-333333333333",
            organization_id=self._WT,
        )
        initial_vh = MagicMock(id="55555555-5555-4555-8555-555555555555")
        changelog_manager = MagicMock()

        reset_all_context()
        set_current_run_id("run-create-doc")
        set_current_session_id("session-create-doc")
        try:
            with patch("apps.tabtinspace.models.Organization.objects.using") as organization_using, \
                 patch("apps.services.billing.services.entitlement_limits_service.EntitlementLimitsService.check_document_limit"), \
                 patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()), \
                 patch("apps.tabdoc.services.document_service.transaction.on_commit", side_effect=lambda fn, using=None: fn()), \
                 patch("apps.tabdoc.services.document_service.Document.objects.create", return_value=created_doc), \
                 patch("apps.tabdoc.services.document_service.ResourceBridge.on_create"), \
                 patch.object(DocumentService, "_init_description_binary"), \
                 patch("threading.Thread"), \
                 patch("apps.collab.service.VersionHistoryService.create_history", return_value=initial_vh), \
                 patch("apps.collab.models.ChangeLog.objects.using", return_value=changelog_manager):
                organization_using.return_value.select_for_update.return_value.get.return_value = MagicMock()
                service.create_document(
                    organization_id=self._WT,
                    space_id=self._SP,
                    parent_id=None,
                    title="Agent 创建的文档",
                    initial_content_pm_json={},
                    initial_content_markdown="正文",
                    initial_content_plaintext="正文",
                )
        finally:
            reset_all_context()

        changelog_manager.create.assert_called_once_with(
            resource_type="docs",
            resource_id=created_doc.id,
            change_type="create",
            summary="Agent 创建文档",
            changes={"title": "Agent 创建的文档"},
            editor_type="agent",
            editor_id="editor-xyz",
            agent_run_id="run-create-doc",
            session_id="session-create-doc",
            version_history=initial_vh,
        )

    def test_initial_vh_respects_editor_type_override(self):
        """显式 override（如 system 服务建文档）优先于 run 上下文。"""
        self.assertEqual(
            self._capture_initial_editor_type(run_id="run-abc", override="system"),
            "system",
        )


if __name__ == "__main__":
    unittest.main()

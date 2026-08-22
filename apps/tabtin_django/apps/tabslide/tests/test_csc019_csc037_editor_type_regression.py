"""
回归测试 — CSC-019 / CSC-037 editor_type 枚举统一

CSC-019: DB-first 路径（post_save._write_unified_version_best_effort）传入 "human" 时
         应规范化为 collab 框架统一枚举 "user"，避免前端历史面板分类错误。

CSC-037: migrate_histories.py 中 docs/design 迁移时，editor_type 为空字符串时
         应 fallback 为 "user"（与 slide 迁移路径保持一致）。
"""
from __future__ import annotations

import json
import zlib
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch, call


# ──────────────────────────────────────────────────────────────
# CSC-019: _write_unified_version_best_effort editor_type 规范化
# ──────────────────────────────────────────────────────────────

class TestCSC019EditorTypeNormalization(TestCase):
    """DB-first 路径传入 "human" 时，写入 VersionHistory 的 editor_type 应为 "user"。"""

    def _call_write_unified(self, editor_type: str, captured: list):
        """调用 _write_unified_version_best_effort 并捕获 create_history 的 editor_info 参数。"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = SimpleNamespace(id="proj-1", organization_id="wt-1")

        mock_vh = MagicMock()
        mock_vh.id = "vh-1"

        mock_svc = MagicMock()
        mock_adapter = MagicMock()
        mock_adapter.get_version_data.return_value = {"version": 1}

        def fake_create_history(resource_id, version_data, editor_info, **kwargs):
            captured.append(editor_info.copy())
            return mock_vh

        mock_svc.create_history.side_effect = fake_create_history

        mock_changelog_cls = MagicMock()
        mock_changelog_cls.objects.using.return_value.create.return_value = MagicMock()

        # SlideCollabAdapter / VersionHistoryService / ChangeLog 均在函数内部 import，
        # 需要 patch 它们在各自模块中的路径。
        with patch("apps.collab.adapters.slide.SlideCollabAdapter", return_value=mock_adapter), \
             patch("apps.collab.service.VersionHistoryService", return_value=mock_svc), \
             patch("apps.collab.models.ChangeLog", mock_changelog_cls):
            # 通过 patch 模块级引用，确保函数内 import 时拿到 mock
            import apps.collab.adapters.slide as slide_adapter_mod
            import apps.collab.service as svc_mod
            import apps.collab.models as collab_models_mod

            orig_adapter = slide_adapter_mod.SlideCollabAdapter
            orig_svc = svc_mod.VersionHistoryService
            orig_cl = collab_models_mod.ChangeLog
            try:
                slide_adapter_mod.SlideCollabAdapter = lambda: mock_adapter
                svc_mod.VersionHistoryService = lambda adapter: mock_svc
                collab_models_mod.ChangeLog = mock_changelog_cls
                _write_unified_version_best_effort(
                    project,
                    editor_type=editor_type,
                    editor_id="user-123",
                    change_type="save_pages",
                )
            finally:
                slide_adapter_mod.SlideCollabAdapter = orig_adapter
                svc_mod.VersionHistoryService = orig_svc
                collab_models_mod.ChangeLog = orig_cl

    def test_human_normalized_to_user(self):
        """editor_type='human' 应被规范化为 'user' 后传入 create_history。"""
        captured = []
        self._call_write_unified("human", captured)
        self.assertTrue(len(captured) > 0, "create_history 应被调用")
        self.assertEqual(
            captured[0]["editor_type"], "user",
            "editor_type='human' 应规范化为 'user'",
        )

    def test_user_unchanged(self):
        """editor_type='user' 应保持不变。"""
        captured = []
        self._call_write_unified("user", captured)
        self.assertTrue(len(captured) > 0, "create_history 应被调用")
        self.assertEqual(captured[0]["editor_type"], "user")

    def test_agent_unchanged(self):
        """editor_type='agent' 应保持不变。"""
        captured = []
        self._call_write_unified("agent", captured)
        self.assertTrue(len(captured) > 0, "create_history 应被调用")
        self.assertEqual(captured[0]["editor_type"], "agent")

    def test_post_save_docstring_uses_user_not_human(self):
        """post_save.py 的 run_post_save_hooks docstring 不应再出现 'human' 作为枚举值。"""
        import inspect
        from apps.tabslide.post_save import run_post_save_hooks
        doc = inspect.getdoc(run_post_save_hooks) or ""
        self.assertNotIn(
            '"human"', doc,
            "run_post_save_hooks docstring 应使用 'user' 而非 'human'",
        )


# ──────────────────────────────────────────────────────────────
# CSC-037: migrate_histories.py docs/design editor_type fallback
# ──────────────────────────────────────────────────────────────

class TestCSC037MigrateEditorTypeFallback(TestCase):
    """迁移时 editor_type 为空字符串应 fallback 为 "user"。"""

    def _make_doc_history(self, editor_type: str):
        return SimpleNamespace(
            id=1,
            document_id="doc-1",
            organization_id="wt-1",
            blob=b"",
            is_snapshot=True,
            editor_type=editor_type,
            editor_id="user-1",
            expired_at=None,
            is_named=False,
            name="",
            pinned=False,
            created_at=None,
        )

    def _make_unused_design_history(self, editor_type: str):
        return SimpleNamespace(
            id=1,
            file_id="design-1",
            blob=b"",
            blob_size=0,
            is_snapshot=True,
            editor_type=editor_type,
            editor_id="user-1",
            expired_at=None,
            is_named=False,
            name="",
            pinned=False,
            revn=1,
            page_count=0,
            shape_count=0,
            created_at=None,
        )

    def test_docs_empty_editor_type_fallback_to_user(self):
        """migrate_docs_histories: editor_type='' 应写入 'user'。"""
        from apps.collab.management.commands.migrate_histories import migrate_docs_histories

        h = self._make_doc_history("")
        created_kwargs = {}

        def fake_create(**kwargs):
            created_kwargs.update(kwargs)
            return MagicMock(id="vh-1")

        mock_qs = MagicMock()
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([h])

        mock_vh_qs = MagicMock()
        mock_vh_qs.filter.return_value.exists.return_value = False
        mock_vh_qs.create.side_effect = fake_create

        with patch("apps.collab.management.commands.migrate_histories.VersionHistory") as mock_vh_cls, \
             patch("apps.tabdoc.models.DocHistory") as mock_dh_cls:
            mock_dh_cls.objects.using.return_value.order_by.return_value = mock_qs
            mock_vh_cls.objects.using.return_value = mock_vh_qs

            migrate_docs_histories(dry_run=False)

        self.assertEqual(
            created_kwargs.get("editor_type"), "user",
            "editor_type='' 迁移后应为 'user'，实际为: " + repr(created_kwargs.get("editor_type")),
        )

    def test_docs_non_empty_editor_type_preserved(self):
        """migrate_docs_histories: editor_type='agent' 应保持不变。"""
        from apps.collab.management.commands.migrate_histories import migrate_docs_histories

        h = self._make_doc_history("agent")
        created_kwargs = {}

        def fake_create(**kwargs):
            created_kwargs.update(kwargs)
            return MagicMock(id="vh-1")

        mock_qs = MagicMock()
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([h])

        mock_vh_qs = MagicMock()
        mock_vh_qs.filter.return_value.exists.return_value = False
        mock_vh_qs.create.side_effect = fake_create

        with patch("apps.collab.management.commands.migrate_histories.VersionHistory") as mock_vh_cls, \
             patch("apps.tabdoc.models.DocHistory") as mock_dh_cls:
            mock_dh_cls.objects.using.return_value.order_by.return_value = mock_qs
            mock_vh_cls.objects.using.return_value = mock_vh_qs

            migrate_docs_histories(dry_run=False)

        self.assertEqual(created_kwargs.get("editor_type"), "agent")

    def test_slide_empty_editor_type_already_handled(self):
        """migrate_slide_histories: editor_type='' 已正确 fallback 为 'user'（回归验证）。"""
        from apps.collab.management.commands.migrate_histories import migrate_slide_histories

        h = SimpleNamespace(
            id=1,
            project_id="slide-1",
            organization_id="wt-1",
            blob=b"",
            is_snapshot=True,
            editor_type="",
            editor_id="user-1",
            expired_at=None,
            is_named=False,
            name="",
            pinned=False,
            version=1,
            page_count=3,
            base_history_id=None,
            created_at=None,
        )
        created_kwargs = {}

        def fake_create(**kwargs):
            created_kwargs.update(kwargs)
            return MagicMock(id="vh-1")

        mock_qs = MagicMock()
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([h])

        mock_vh_qs = MagicMock()
        mock_vh_qs.filter.return_value.first.return_value = None
        mock_vh_qs.create.side_effect = fake_create

        with patch("apps.collab.management.commands.migrate_histories.VersionHistory") as mock_vh_cls, \
             patch("apps.tabslide.models.SlideHistory") as mock_sh_cls, \
             patch("apps.collab.management.commands.migrate_histories.cache") as mock_cache:
            mock_sh_cls.objects.using.return_value.order_by.return_value = mock_qs
            mock_vh_cls.objects.using.return_value = mock_vh_qs
            mock_cache.add.return_value = True

            migrate_slide_histories(dry_run=False)

        self.assertEqual(
            created_kwargs.get("editor_type"), "user",
            "slide 迁移 editor_type='' 应为 'user'",
        )

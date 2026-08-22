"""
回归测试 — TSV-009 ~ TSV-014 版本历史修复

TSV-009: create_history_snapshot 并发锁
TSV-010: 降采样不误删 is_snapshot 锚点
TSV-011: collab restore 不触发额外 SlideHistory 写入
TSV-012: restore_pages_from_snapshot editor_type 参数化
TSV-013: get_version_data 包含 theme/font_meta，compute_diff/apply_diff 支持 theme/font_meta
TSV-014: cleanup_slide_history 保护未迁移记录
"""
from __future__ import annotations

import inspect
import json
import zlib
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, call, patch


# ──────────────────────────────────────────────────────────────
# TSV-009: create_history_snapshot 并发锁
# ──────────────────────────────────────────────────────────────

class TestTSV009ConcurrencyLock(TestCase):
    """create_history_snapshot 必须通过 cache 锁序列化同一 project 的写入。"""

    @patch("apps.tabslide.services.slide_service.cache")
    def test_lock_acquired_then_released(self, cache_mock):
        """正常流程：获取锁 → 执行 → 释放锁"""
        from apps.tabslide.services.slide_service import SlideService

        cache_mock.add.return_value = True

        svc = SlideService.__new__(SlideService)
        svc.user = None
        project = SimpleNamespace(id="proj-009")

        with patch.object(svc, "_do_create_history_snapshot", return_value=None) as do_mock:
            svc.create_history_snapshot(project)

        cache_mock.add.assert_called_once_with(
            "tabslide:create_history_lock:proj-009", 1, SlideService.SLIDE_HISTORY_LOCK_TTL,
        )
        do_mock.assert_called_once()
        cache_mock.delete.assert_called_once_with("tabslide:create_history_lock:proj-009")

    @patch("apps.tabslide.services.slide_service.cache")
    def test_lock_contention_returns_none(self, cache_mock):
        """并发冲突：cache.add 返回 False → 返回 None，不执行写入"""
        from apps.tabslide.services.slide_service import SlideService

        cache_mock.add.return_value = False

        svc = SlideService.__new__(SlideService)
        svc.user = None
        project = SimpleNamespace(id="proj-009")

        with patch.object(svc, "_do_create_history_snapshot") as do_mock:
            result = svc.create_history_snapshot(project)

        self.assertIsNone(result)
        do_mock.assert_not_called()
        cache_mock.delete.assert_not_called()

    @patch("apps.tabslide.services.slide_service.cache")
    def test_lock_released_on_exception(self, cache_mock):
        """异常时锁也必须释放（finally 保护）"""
        from apps.tabslide.services.slide_service import SlideService

        cache_mock.add.return_value = True

        svc = SlideService.__new__(SlideService)
        svc.user = None
        project = SimpleNamespace(id="proj-009")

        with patch.object(svc, "_do_create_history_snapshot", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                svc.create_history_snapshot(project)

        cache_mock.delete.assert_called_once_with("tabslide:create_history_lock:proj-009")


# ──────────────────────────────────────────────────────────────
# TSV-010: 降采样保护 is_snapshot 锚点
# ──────────────────────────────────────────────────────────────

class TestTSV010SnapshotAnchorProtection(TestCase):
    """_downsample_range 不应删除 is_snapshot=True 的锚点记录。"""

    @patch("apps.tabslide.models.SlideHistory")
    def test_downsample_excludes_is_snapshot_true(self, slide_history_mock):
        """降采样 to_delete 必须调用 .exclude(is_snapshot=True)"""
        from apps.tabslide.tasks import _downsample_range

        manager = MagicMock()
        slide_history_mock.objects.using.return_value = manager

        qs = MagicMock()
        manager.filter.return_value = qs
        qs.exists.return_value = True

        groups = [{"project_id": "project-1", "bucket": "bucket-1"}]
        qs.annotate.return_value.values.return_value.annotate.return_value.filter.return_value = groups

        bucket_qs = MagicMock()
        qs.filter.return_value.annotate.return_value.filter.return_value = bucket_qs

        order_qs = MagicMock()
        values_qs = MagicMock()
        bucket_qs.order_by.return_value = order_qs
        order_qs.values_list.return_value = values_qs
        values_qs.first.return_value = "keep-id"

        exclude_keep = MagicMock()
        exclude_protected = MagicMock()
        exclude_snapshot = MagicMock()
        bucket_qs.exclude.return_value = exclude_keep
        exclude_keep.exclude.return_value = exclude_protected
        exclude_protected.exclude.return_value = exclude_snapshot
        exclude_snapshot.count.return_value = 1

        _downsample_range(
            start=object(), end=object(), truncate_to="hour",
            protected_snapshot_ids={"snap-1"},
        )

        exclude_protected.exclude.assert_called_once_with(is_snapshot=True)


# ──────────────────────────────────────────────────────────────
# TSV-011 + TSV-012: collab adapter restore 参数传递
# ──────────────────────────────────────────────────────────────

class TestTSV011RestoreNoExtraHistory(TestCase):
    """SlideCollabAdapter.restore 必须传入 create_history=False。"""

    @patch("apps.tabslide.services.slide_service.SlideService")
    def test_restore_passes_create_history_false(self, svc_cls_mock):
        from apps.collab.adapters.slide import SlideCollabAdapter

        svc_instance = MagicMock()
        svc_cls_mock.return_value = svc_instance

        adapter = SlideCollabAdapter()
        resource = SimpleNamespace(id="proj-011", theme=None, font_meta=None)
        pages = [{"page_id": "p1", "elements": []}]

        adapter.restore(resource, pages)

        svc_instance.restore_pages_from_snapshot.assert_called_once()
        _, kwargs = svc_instance.restore_pages_from_snapshot.call_args
        self.assertFalse(kwargs["create_history"])


class TestTSV012EditorTypeParameterized(TestCase):
    """SlideCollabAdapter.restore 必须传入 editor_type='system'，不再硬编码 'human'。"""

    @patch("apps.tabslide.services.slide_service.SlideService")
    def test_restore_passes_editor_type_system(self, svc_cls_mock):
        from apps.collab.adapters.slide import SlideCollabAdapter

        svc_instance = MagicMock()
        svc_cls_mock.return_value = svc_instance

        adapter = SlideCollabAdapter()
        resource = SimpleNamespace(id="proj-012", theme=None, font_meta=None)
        pages = [{"page_id": "p1", "elements": []}]

        adapter.restore(resource, pages)

        _, kwargs = svc_instance.restore_pages_from_snapshot.call_args
        self.assertEqual(kwargs["editor_type"], "system")


class TestTSV012RestorePagesAcceptsEditorType(TestCase):
    """restore_pages_from_snapshot 的 editor_type 参数被正确传递到 _editor_info。"""

    def test_agent_editor_type_propagates(self):
        from apps.tabslide.services.slide_service import SlideService

        svc = SlideService.__new__(SlideService)
        svc.user = SimpleNamespace(id="u-agent")

        with patch.object(svc, "_cas_save_pages", return_value=10), \
             patch("apps.tabslide.post_save.run_post_save_hooks") as hooks_mock, \
             patch.object(svc, "_push_pages_to_ydoc"):
            svc.restore_pages_from_snapshot(
                SimpleNamespace(id="p-1"),
                pages=[{"page_id": "p1"}],
                editor_type="agent",
            )

        _, kwargs = hooks_mock.call_args
        self.assertEqual(kwargs["editor_type"], "agent")


# ──────────────────────────────────────────────────────────────
# TSV-013: get_version_data 包含 theme / font_meta
# ──────────────────────────────────────────────────────────────

class TestTSV013VersionDataContainsMetadata(TestCase):
    """get_version_data 返回的 dict 必须包含 pages、theme、font_meta。"""

    def test_get_version_data_returns_dict_with_theme_and_font_meta(self):
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        resource = SimpleNamespace(
            id="proj-013",
            theme={"primary": "#ff0000"},
            font_meta={"embedded_fonts": []},
        )

        with patch.object(adapter, "get_pages_data", return_value=[{"page_id": "p1"}]):
            result = adapter.get_version_data(resource)

        self.assertIsInstance(result, dict)
        self.assertIn("pages", result)
        self.assertIn("theme", result)
        self.assertIn("font_meta", result)
        self.assertEqual(result["theme"], {"primary": "#ff0000"})
        self.assertEqual(result["font_meta"], {"embedded_fonts": []})
        self.assertEqual(result["pages"], [{"page_id": "p1"}])

    def test_restore_with_dict_data_applies_extra_fields(self):
        """restore 收到 dict 格式数据时，theme 和 font_meta 作为 extra_fields 传递。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        resource = SimpleNamespace(id="proj-013b")

        with patch("apps.tabslide.services.slide_service.SlideService") as svc_cls:
            svc_instance = MagicMock()
            svc_cls.return_value = svc_instance

            data = {
                "pages": [{"page_id": "p1"}],
                "theme": {"primary": "#00ff00"},
                "font_meta": {"embedded_fonts": [{"name": "Arial"}]},
            }
            adapter.restore(resource, data)

            _, kwargs = svc_instance.restore_pages_from_snapshot.call_args
            self.assertEqual(
                kwargs["extra_fields"],
                {"theme": {"primary": "#00ff00"}, "font_meta": {"embedded_fonts": [{"name": "Arial"}]}},
            )


class TestTSV013ComputeDiffThemeFontMeta(TestCase):
    """compute_diff 必须检测并记录 theme/font_meta 变更。"""

    def test_compute_diff_detects_theme_change(self):
        """仅 theme 变更时，compute_diff 返回包含 theme 的 diff"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        base = {"pages": [{"id": "p1", "elements": []}], "theme": {"primary": "#000"}}
        current = {"pages": [{"id": "p1", "elements": []}], "theme": {"primary": "#fff"}}

        diff_blob = adapter.compute_diff(base, current)
        self.assertIsNotNone(diff_blob)

        diff = json.loads(zlib.decompress(diff_blob).decode("utf-8"))
        self.assertEqual(diff["theme"], {"primary": "#fff"})

    def test_compute_diff_detects_font_meta_change(self):
        """仅 font_meta 变更时，compute_diff 返回包含 font_meta 的 diff"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        base = {"pages": [{"id": "p1", "elements": []}], "font_meta": None}
        current = {"pages": [{"id": "p1", "elements": []}], "font_meta": {"embedded_fonts": [{"name": "A"}]}}

        diff_blob = adapter.compute_diff(base, current)
        self.assertIsNotNone(diff_blob)

        diff = json.loads(zlib.decompress(diff_blob).decode("utf-8"))
        self.assertEqual(diff["font_meta"], {"embedded_fonts": [{"name": "A"}]})

    def test_compute_diff_returns_none_when_all_same(self):
        """pages/theme/font_meta 全部相同时返回 None"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        data = {"pages": [{"id": "p1", "elements": []}], "theme": {"a": 1}, "font_meta": {"b": 2}}

        self.assertIsNone(adapter.compute_diff(data, data))

    def test_apply_diff_restores_theme(self):
        """apply_diff 将 diff 中的 theme 正确应用到结果上"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        base = {"pages": [{"id": "p1", "elements": []}], "theme": {"primary": "#000"}}

        diff_data = {"added": [], "removed": [], "changed": [], "order": ["p1"], "theme": {"primary": "#fff"}}
        diff_blob = zlib.compress(json.dumps(diff_data).encode("utf-8"))

        result = adapter.apply_diff(base, diff_blob)
        self.assertIsNotNone(result)
        self.assertEqual(result["theme"], {"primary": "#fff"})

    def test_apply_diff_preserves_theme_when_not_in_diff(self):
        """diff 中无 theme 时，保留 base 的 theme"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        base = {"pages": [{"id": "p1", "elements": []}], "theme": {"primary": "#000"}}

        diff_data = {"added": [], "removed": [], "changed": [], "order": ["p1"]}
        diff_blob = zlib.compress(json.dumps(diff_data).encode("utf-8"))

        result = adapter.apply_diff(base, diff_blob)
        self.assertIsNotNone(result)
        self.assertEqual(result["theme"], {"primary": "#000"})

    def test_apply_diff_restores_font_meta(self):
        """apply_diff 将 diff 中的 font_meta 正确应用到结果上"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        base = {"pages": [{"id": "p1", "elements": []}], "font_meta": None}

        diff_data = {
            "added": [], "removed": [], "changed": [], "order": ["p1"],
            "font_meta": {"embedded_fonts": [{"name": "Arial"}]},
        }
        diff_blob = zlib.compress(json.dumps(diff_data).encode("utf-8"))

        result = adapter.apply_diff(base, diff_blob)
        self.assertIsNotNone(result)
        self.assertEqual(result["font_meta"], {"embedded_fonts": [{"name": "Arial"}]})

    def test_compute_then_apply_roundtrip_with_theme(self):
        """compute_diff → apply_diff 的完整往返：theme 变更能正确恢复"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        base = {
            "pages": [{"id": "p1", "elements": [{"type": "text", "content": "hello"}]}],
            "theme": {"primary": "#000", "bg": "white"},
            "font_meta": {"embedded_fonts": []},
        }
        current = {
            "pages": [{"id": "p1", "elements": [{"type": "text", "content": "hello"}]}],
            "theme": {"primary": "#ff0000", "bg": "dark"},
            "font_meta": {"embedded_fonts": [{"name": "Noto"}]},
        }

        diff_blob = adapter.compute_diff(base, current)
        self.assertIsNotNone(diff_blob)

        restored = adapter.apply_diff(base, diff_blob)
        self.assertEqual(restored["theme"], current["theme"])
        self.assertEqual(restored["font_meta"], current["font_meta"])
        self.assertEqual(len(restored["pages"]), 1)


# ──────────────────────────────────────────────────────────────
# TSV-009 补充: SLIDE_HISTORY_LOCK_TTL 常量检查
# ──────────────────────────────────────────────────────────────

class TestTSV009LockTTLConstant(TestCase):
    """SLIDE_HISTORY_LOCK_TTL 必须存在且合理。"""

    def test_lock_ttl_exists_and_is_positive(self):
        from apps.tabslide.services.slide_service import SlideService

        self.assertTrue(hasattr(SlideService, "SLIDE_HISTORY_LOCK_TTL"))
        self.assertGreater(SlideService.SLIDE_HISTORY_LOCK_TTL, 0)


# ──────────────────────────────────────────────────────────────
# TSV-012 补充: restore_pages_from_snapshot 签名检查
# ──────────────────────────────────────────────────────────────

class TestTSV012SignatureCheck(TestCase):
    """restore_pages_from_snapshot 必须声明 editor_type 参数，默认值 'user'。"""

    def test_signature_has_editor_type_param(self):
        from apps.tabslide.services.slide_service import SlideService

        sig = inspect.signature(SlideService.restore_pages_from_snapshot)
        self.assertIn("editor_type", sig.parameters)
        self.assertEqual(sig.parameters["editor_type"].default, "user")

    def test_signature_has_create_history_param(self):
        from apps.tabslide.services.slide_service import SlideService

        sig = inspect.signature(SlideService.restore_pages_from_snapshot)
        self.assertIn("create_history", sig.parameters)
        self.assertTrue(sig.parameters["create_history"].default)


# ──────────────────────────────────────────────────────────────
# TSV-014 补充: collab cleanup_expired_versions 协调注释
# ──────────────────────────────────────────────────────────────

class TestTSV014CollabCleanupCoordination(TestCase):
    """cleanup_expired_versions 的 docstring 必须包含 TSV-014 协调说明。"""

    def test_cleanup_expired_versions_docstring_mentions_tsv014(self):
        from apps.collab.tasks import cleanup_expired_versions

        docstring = cleanup_expired_versions.__doc__ or ""
        self.assertIn("TSV-014", docstring)


# ──────────────────────────────────────────────────────────────
# TSV-014: 双系统清理协调 — 保护未迁移记录
# ──────────────────────────────────────────────────────────────

class TestTSV014UnmigratedRecordProtection(TestCase):
    """cleanup_slide_history 不应删除尚未迁移到 VersionHistory 的记录。"""

    def test_get_unmigrated_returns_ids_not_in_version_history(self):
        """_get_unmigrated_slide_history_ids 应返回 VersionHistory 中无对应记录的 ID"""
        from apps.tabslide.tasks import _get_unmigrated_slide_history_ids

        expired_qs = MagicMock()
        expired_qs.values_list.return_value.__getitem__ = lambda self, key: [
            "id-1", "id-2", "id-3",
        ]

        with patch("apps.collab.models.VersionHistory") as vh_mock:
            vh_manager = MagicMock()
            vh_mock.objects.using.return_value = vh_manager

            filter_qs = MagicMock()
            vh_manager.filter.return_value = filter_qs
            filter_qs.values_list.return_value = ["id-1"]

            result = _get_unmigrated_slide_history_ids(expired_qs)

        self.assertIn("id-2", result)
        self.assertIn("id-3", result)
        self.assertNotIn("id-1", result)

    def test_get_unmigrated_empty_input_returns_empty(self):
        """空输入 → 空结果"""
        from apps.tabslide.tasks import _get_unmigrated_slide_history_ids

        expired_qs = MagicMock()
        expired_qs.values_list.return_value.__getitem__ = lambda self, key: []

        result = _get_unmigrated_slide_history_ids(expired_qs)
        self.assertEqual(result, set())

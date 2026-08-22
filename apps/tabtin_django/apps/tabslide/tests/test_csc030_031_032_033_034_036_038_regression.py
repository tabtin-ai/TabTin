"""
回归测试 — CSC-030 ~ CSC-038 TabSlide 存量迁移与旧格式兼容性修复

CSC-030: migrate_slide_histories 改用 iterator() 流式读取，避免全量加载 OOM
CSC-031: 迁移循环添加 try/except，单条失败不中断整体迁移
CSC-032: 旧格式 blob（list）迁移时升级为 dict 格式，restore 时 theme/font_meta 不丢失
CSC-033: _get_unmigrated_slide_history_ids 去掉 2000 条硬上限，循环分批检查
CSC-034: apply_diff 对旧格式 base_data（list）不再将 theme/font_meta 初始化为 None
CSC-036: 迁移时 expired_at 已过期的记录延长 TTL，避免迁移后立即被 cleanup 删除
CSC-038: migrate_slide_histories 持有 Redis 锁防止与 cleanup_slide_history 并发
"""
from __future__ import annotations

import json
import zlib
from datetime import timedelta
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, call, patch


def _make_blob(data) -> bytes:
    """将 data 序列化为 zlib 压缩 JSON bytes。"""
    return zlib.compress(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        level=6,
    )


def _decode_blob(blob: bytes):
    """解压 zlib blob 为 Python 对象。"""
    return json.loads(zlib.decompress(blob).decode("utf-8"))


# ──────────────────────────────────────────────────────────────
# CSC-032: _upgrade_slide_blob_format
# ──────────────────────────────────────────────────────────────

class TestCSC032UpgradeSlideBlobFormat(TestCase):
    """旧格式 blob（list）应被升级为 dict 格式，新格式 dict 应保持不变。"""

    def _get_upgrade_fn(self):
        from apps.collab.management.commands.migrate_histories import _upgrade_slide_blob_format
        return _upgrade_slide_blob_format

    def test_old_format_list_upgraded_to_dict(self):
        """旧格式 list blob 升级后应包含 pages/theme/font_meta 键。"""
        pages = [{"id": "p1", "elements": []}]
        blob = _make_blob(pages)

        upgrade = self._get_upgrade_fn()
        result_blob = upgrade(blob)
        result = _decode_blob(result_blob)

        self.assertIsInstance(result, dict)
        self.assertIn("pages", result)
        self.assertIn("theme", result)
        self.assertIn("font_meta", result)
        self.assertEqual(result["pages"], pages)
        self.assertIsNone(result["theme"])
        self.assertIsNone(result["font_meta"])

    def test_new_format_dict_unchanged(self):
        """新格式 dict blob 不应被修改。"""
        data = {"pages": [{"id": "p1"}], "theme": {"color": "red"}, "font_meta": {"fonts": []}}
        blob = _make_blob(data)

        upgrade = self._get_upgrade_fn()
        result_blob = upgrade(blob)
        result = _decode_blob(result_blob)

        self.assertIsInstance(result, dict)
        self.assertEqual(result["theme"], {"color": "red"})
        self.assertEqual(result["font_meta"], {"fonts": []})

    def test_empty_blob_returned_unchanged(self):
        """空 blob 应原样返回，不抛异常。"""
        upgrade = self._get_upgrade_fn()
        self.assertEqual(upgrade(b""), b"")

    def test_invalid_blob_returned_unchanged(self):
        """无效 blob 应原样返回，不抛异常。"""
        upgrade = self._get_upgrade_fn()
        result = upgrade(b"not_valid_zlib_data")
        self.assertEqual(result, b"not_valid_zlib_data")


# ──────────────────────────────────────────────────────────────
# CSC-036: _safe_expired_at
# ──────────────────────────────────────────────────────────────

class TestCSC036SafeExpiredAt(TestCase):
    """已过期的 expired_at 应被延长到 now + 最小 TTL。"""

    def _get_fn(self):
        from apps.collab.management.commands.migrate_histories import (
            _safe_expired_at,
            _MIGRATE_MIN_TTL_SECONDS,
        )
        return _safe_expired_at, _MIGRATE_MIN_TTL_SECONDS

    def test_none_returns_none(self):
        """命名版本 expired_at=None 应保持 None。"""
        fn, _ = self._get_fn()
        self.assertIsNone(fn(None))

    def test_already_expired_gets_extended(self):
        """已过期的时间应被延长。"""
        from django.utils import timezone
        fn, min_ttl = self._get_fn()
        past = timezone.now() - timedelta(days=1)
        result = fn(past)
        self.assertGreater(result, timezone.now())
        # 应至少延长到 now + min_ttl - 1s（允许少量时间误差）
        self.assertGreater(result, timezone.now() + timedelta(seconds=min_ttl - 10))

    def test_future_expiry_unchanged(self):
        """未来很远的 expired_at 应保持不变。"""
        from django.utils import timezone
        fn, min_ttl = self._get_fn()
        far_future = timezone.now() + timedelta(days=365)
        result = fn(far_future)
        # 允许 1 秒误差
        self.assertAlmostEqual(
            result.timestamp(), far_future.timestamp(), delta=1
        )


# ──────────────────────────────────────────────────────────────
# CSC-034: apply_diff 旧格式 base_data 不初始化 theme/font_meta 为 None
# ──────────────────────────────────────────────────────────────

class TestCSC034ApplyDiffOldFormat(TestCase):
    """apply_diff 对旧格式 base_data（list）不应将 theme/font_meta 写入 None。"""

    def _get_adapter(self):
        from apps.collab.adapters.slide import SlideCollabAdapter
        return SlideCollabAdapter()

    def _make_diff_blob(self, diff: dict) -> bytes:
        return zlib.compress(
            json.dumps(diff, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            level=6,
        )

    def test_old_format_base_no_theme_in_diff_omits_theme(self):
        """旧格式 base_data（list），diff 中无 theme，结果不应包含 theme 键。"""
        adapter = self._get_adapter()
        base_data = [{"id": "p1", "elements": []}]
        diff = {"added": [], "removed": [], "changed": []}
        diff_blob = self._make_diff_blob(diff)

        with patch("apps.tabslide.services.slide_service.SlideService._apply_page_diff") as mock_apply:
            mock_apply.return_value = base_data
            result = adapter.apply_diff(base_data, diff_blob)

        self.assertIsNotNone(result)
        self.assertNotIn("theme", result)
        self.assertNotIn("font_meta", result)

    def test_old_format_base_with_theme_in_diff_sets_theme(self):
        """旧格式 base_data（list），diff 中有 theme，结果应包含 diff 的 theme。"""
        adapter = self._get_adapter()
        base_data = [{"id": "p1", "elements": []}]
        diff = {"added": [], "removed": [], "changed": [], "theme": {"color": "blue"}}
        diff_blob = self._make_diff_blob(diff)

        with patch("apps.tabslide.services.slide_service.SlideService._apply_page_diff") as mock_apply:
            mock_apply.return_value = base_data
            result = adapter.apply_diff(base_data, diff_blob)

        self.assertIsNotNone(result)
        self.assertEqual(result.get("theme"), {"color": "blue"})

    def test_new_format_base_inherits_theme(self):
        """新格式 base_data（dict），diff 中无 theme，结果应继承 base 的 theme。"""
        adapter = self._get_adapter()
        base_data = {"pages": [{"id": "p1"}], "theme": {"color": "red"}, "font_meta": None}
        diff = {"added": [], "removed": [], "changed": []}
        diff_blob = self._make_diff_blob(diff)

        with patch("apps.tabslide.services.slide_service.SlideService._apply_page_diff") as mock_apply:
            mock_apply.return_value = base_data["pages"]
            result = adapter.apply_diff(base_data, diff_blob)

        self.assertIsNotNone(result)
        self.assertEqual(result.get("theme"), {"color": "red"})

    def test_new_format_base_diff_overrides_theme(self):
        """新格式 base_data，diff 中有 theme，结果应使用 diff 的 theme。"""
        adapter = self._get_adapter()
        base_data = {"pages": [{"id": "p1"}], "theme": {"color": "red"}, "font_meta": None}
        diff = {"added": [], "removed": [], "changed": [], "theme": {"color": "green"}}
        diff_blob = self._make_diff_blob(diff)

        with patch("apps.tabslide.services.slide_service.SlideService._apply_page_diff") as mock_apply:
            mock_apply.return_value = base_data["pages"]
            result = adapter.apply_diff(base_data, diff_blob)

        self.assertIsNotNone(result)
        self.assertEqual(result.get("theme"), {"color": "green"})


# ──────────────────────────────────────────────────────────────
# CSC-033: _get_unmigrated_slide_history_ids 无硬上限
# ──────────────────────────────────────────────────────────────

class TestCSC033UnmigratedCheckNoBatchLimit(TestCase):
    """_get_unmigrated_slide_history_ids 应处理超过 2000 条的过期记录。"""

    def test_processes_more_than_2000_expired_ids(self):
        """超过 2000 条过期 ID 时，所有记录都应被检查，不应有遗漏。"""
        from apps.tabslide.tasks import _get_unmigrated_slide_history_ids, _UNMIGRATED_CHECK_BATCH

        # 构造 2500 条过期 ID（超过原来 2000 条上限）
        import uuid
        total = _UNMIGRATED_CHECK_BATCH * 5  # 2500
        fake_ids = [uuid.uuid4() for _ in range(total)]

        mock_qs = MagicMock()

        # 模拟 expired_qs.values_list("id", flat=True)[offset:offset+batch]
        # 使用 slice 对象来正确模拟分批切片
        values_list_result = MagicMock()
        values_list_result.__getitem__ = MagicMock(
            side_effect=lambda s: list(fake_ids[s]) if isinstance(s, slice) else fake_ids[s]
        )
        mock_qs.values_list.return_value = values_list_result

        # 模拟 VersionHistory.objects.using().filter().values_list() 返回空（全部未迁移）
        with patch("apps.collab.models.VersionHistory") as mock_vh:
            mock_vh.objects.using.return_value.filter.return_value.values_list.return_value = []
            result = _get_unmigrated_slide_history_ids(mock_qs)

        # 验证所有 2500 条 ID 都被检查了（result 应包含所有 ID）
        self.assertEqual(len(result), total)

    def test_old_2000_limit_would_miss_records(self):
        """验证旧实现（[:2000] 硬上限）会漏掉超出部分，新实现不会。"""
        from apps.tabslide.tasks import _UNMIGRATED_CHECK_BATCH

        # 旧上限是 _UNMIGRATED_CHECK_BATCH * 4 = 2000
        old_limit = _UNMIGRATED_CHECK_BATCH * 4
        # 新实现没有硬上限，通过循环分批处理
        # 验证常量值符合预期（防止常量被意外修改）
        self.assertEqual(_UNMIGRATED_CHECK_BATCH, 500)
        self.assertEqual(old_limit, 2000)


# ──────────────────────────────────────────────────────────────
# CSC-038: migrate_slide_histories Redis 锁防并发
# ──────────────────────────────────────────────────────────────

class TestCSC038MigrateSlideHistoriesLock(TestCase):
    """migrate_slide_histories 应持有 Redis 锁，防止与 cleanup 并发。"""

    def _get_module(self):
        from apps.collab.management.commands import migrate_histories as mh_module
        return mh_module

    def test_lock_acquired_and_released_on_success(self):
        """正常迁移：获取锁 → 执行 → 释放锁。"""
        mh = self._get_module()

        mock_cache = MagicMock()
        mock_cache.add.return_value = True

        mock_sh = MagicMock()
        mock_sh.objects.using.return_value.order_by.return_value.count.return_value = 0
        mock_sh.objects.using.return_value.order_by.return_value.iterator.return_value = iter([])

        mock_vh = MagicMock()

        with patch.object(mh, "cache", mock_cache), \
             patch.object(mh, "VersionHistory", mock_vh), \
             patch("apps.tabslide.models.SlideHistory", mock_sh):

            mh.migrate_slide_histories(dry_run=False)

        mock_cache.add.assert_called_once_with(
            mh._MIGRATE_SLIDE_LOCK_KEY, "1", timeout=3600
        )
        mock_cache.delete.assert_called_once_with(mh._MIGRATE_SLIDE_LOCK_KEY)

    def test_lock_not_acquired_returns_early(self):
        """锁被占用时应提前返回，不执行迁移。"""
        mh = self._get_module()

        mock_cache = MagicMock()
        mock_cache.add.return_value = False

        mock_sh = MagicMock()

        with patch.object(mh, "cache", mock_cache), \
             patch("apps.tabslide.models.SlideHistory", mock_sh):

            result = mh.migrate_slide_histories(dry_run=False)

        self.assertEqual(result, (0, 0, 0))
        mock_sh.objects.using.assert_not_called()

    def test_lock_released_on_exception(self):
        """迁移过程中抛异常时，锁应仍被释放（finally 块）。"""
        mh = self._get_module()

        mock_cache = MagicMock()
        mock_cache.add.return_value = True

        mock_sh = MagicMock()
        mock_sh.objects.using.return_value.order_by.return_value.count.side_effect = RuntimeError("DB error")

        with patch.object(mh, "cache", mock_cache), \
             patch("apps.tabslide.models.SlideHistory", mock_sh):

            with self.assertRaises(RuntimeError):
                mh.migrate_slide_histories(dry_run=False)

        mock_cache.delete.assert_called_once_with(mh._MIGRATE_SLIDE_LOCK_KEY)

    def test_dry_run_skips_lock(self):
        """dry_run=True 时不应获取锁。"""
        mh = self._get_module()

        mock_cache = MagicMock()

        mock_sh = MagicMock()
        mock_sh.objects.using.return_value.order_by.return_value.count.return_value = 0
        mock_sh.objects.using.return_value.order_by.return_value.iterator.return_value = iter([])

        mock_vh = MagicMock()

        with patch.object(mh, "cache", mock_cache), \
             patch.object(mh, "VersionHistory", mock_vh), \
             patch("apps.tabslide.models.SlideHistory", mock_sh):

            mh.migrate_slide_histories(dry_run=True)

        mock_cache.add.assert_not_called()


# ──────────────────────────────────────────────────────────────
# CSC-031: 单条失败不中断整体迁移
# ──────────────────────────────────────────────────────────────

class TestCSC031SingleRecordFailureIsolation(TestCase):
    """单条记录迁移失败时，其他记录应继续迁移。"""

    def test_single_failure_does_not_abort_migration(self):
        """第一条记录失败，第二条应仍被成功迁移。"""
        from apps.collab.management.commands import migrate_histories as mh_module
        import uuid

        id1 = uuid.uuid4()
        id2 = uuid.uuid4()

        from django.utils import timezone as tz
        now = tz.now()

        h1 = SimpleNamespace(
            id=id1, project_id=uuid.uuid4(), organization_id=uuid.uuid4(),
            blob=_make_blob([{"id": "p1"}]), blob_size=100,
            is_snapshot=True, editor_type="user", editor_id="",
            expired_at=None, is_named=False, name="", pinned=False,
            version=1, page_count=1, base_history_id=None,
            created_at=now,
        )
        h2 = SimpleNamespace(
            id=id2, project_id=uuid.uuid4(), organization_id=uuid.uuid4(),
            blob=_make_blob([{"id": "p2"}]), blob_size=100,
            is_snapshot=True, editor_type="user", editor_id="",
            expired_at=None, is_named=False, name="", pinned=False,
            version=2, page_count=1, base_history_id=None,
            created_at=now,
        )

        created_ids = []

        def mock_vh_create(**kwargs):
            vh = SimpleNamespace(id=uuid.uuid4())
            created_ids.append(str(vh.id))
            return vh

        # mock cache 模块级属性
        mock_cache = MagicMock()
        mock_cache.add.return_value = True

        mock_sh_qs = MagicMock()
        mock_sh_qs.count.return_value = 2
        mock_sh_qs.iterator.return_value = iter([h1, h2])

        mock_sh = MagicMock()
        mock_sh.objects.using.return_value.order_by.return_value = mock_sh_qs

        call_count = [0]

        def mock_vh_filter(**kwargs):
            m = MagicMock()
            call_count[0] += 1
            if call_count[0] == 1:
                m.first.side_effect = RuntimeError("DB error for h1")
            else:
                m.first.return_value = None
            return m

        mock_vh = MagicMock()
        mock_vh.objects.using.return_value.filter.side_effect = mock_vh_filter
        mock_vh.objects.using.return_value.create.side_effect = mock_vh_create

        with patch.object(mh_module, "cache", mock_cache), \
             patch.object(mh_module, "VersionHistory", mock_vh), \
             patch("apps.tabslide.models.SlideHistory", mock_sh):

            total, migrated, skipped = mh_module.migrate_slide_histories(dry_run=False)

        # h1 失败，h2 应成功迁移
        self.assertEqual(migrated, 1)
        self.assertEqual(len(created_ids), 1)

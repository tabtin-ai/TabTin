"""
回归测试 — TSV-015 / TSV-016 / CSC-035 SlideHistory 定时补偿迁移

TSV-015: migrate_histories 无自动调度
TSV-016: collab-live 离线时 SlideHistory 永远不同步到 VersionHistory
CSC-035: migrate_histories 无自动调度（同 TSV-015）

修复：
- migrate_slide_histories_batch() 支持 batch_size 增量迁移
- collab.migrate_slide_histories_incremental Celery Beat 任务（每小时 500 条）
- 全量迁移完成后任务自动停止（done=True）
- 与 cleanup_slide_history 通过 Redis 锁互斥
"""
from __future__ import annotations

import json
import zlib
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, call, patch


# ──────────────────────────────────────────────────────────────
# 辅助：构造压缩 blob
# ──────────────────────────────────────────────────────────────

def _make_blob(data) -> bytes:
    return zlib.compress(json.dumps(data, ensure_ascii=False).encode("utf-8"), level=6)


# ──────────────────────────────────────────────────────────────
# TSV-015/CSC-035: COLLAB_BEAT_SCHEDULE 包含迁移任务
# ──────────────────────────────────────────────────────────────

class TestTSV015BeatScheduleRegistered(TestCase):
    """COLLAB_BEAT_SCHEDULE 必须包含 migrate_slide_histories_incremental 任务。"""

    def test_migrate_task_in_beat_schedule(self):
        from apps.collab.tasks import COLLAB_BEAT_SCHEDULE

        self.assertIn(
            "collab-migrate-slide-histories",
            COLLAB_BEAT_SCHEDULE,
            "COLLAB_BEAT_SCHEDULE 缺少 collab-migrate-slide-histories 任务",
        )
        entry = COLLAB_BEAT_SCHEDULE["collab-migrate-slide-histories"]
        self.assertEqual(entry["task"], "collab.migrate_slide_histories_incremental")
        self.assertEqual(entry["schedule"], 3600.0, "迁移任务应每小时执行一次")

    def test_migrate_task_celery_registered(self):
        """migrate_slide_histories_incremental 必须是可导入的 Celery 任务。"""
        from apps.collab.tasks import migrate_slide_histories_incremental

        self.assertTrue(
            callable(migrate_slide_histories_incremental),
            "migrate_slide_histories_incremental 必须是可调用的 Celery 任务",
        )
        self.assertEqual(
            migrate_slide_histories_incremental.name,
            "collab.migrate_slide_histories_incremental",
        )


# ──────────────────────────────────────────────────────────────
# TSV-016: migrate_slide_histories_batch 增量迁移逻辑
# ──────────────────────────────────────────────────────────────

class TestTSV016MigrateSlideHistoriesBatch(TestCase):
    """migrate_slide_histories_batch 必须正确处理增量迁移。"""

    def _make_slide_history(self, id_, project_id="proj-1", blob=None, base_history_id=None):
        h = SimpleNamespace(
            id=id_,
            project_id=project_id,
            organization_id="wt-1",
            blob=blob or _make_blob([{"id": "page-1"}]),
            is_snapshot=True,
            editor_type="user",
            editor_id="user-1",
            expired_at=None,
            is_named=False,
            name="",
            pinned=False,
            version=1,
            page_count=1,
            base_history_id=base_history_id,
            created_at=None,
        )
        return h

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_batch_migrates_up_to_batch_size(self, vh_cls):
        """batch_size=2 时最多迁移 2 条记录。"""
        from apps.collab.management.commands.migrate_histories import migrate_slide_histories_batch

        h1 = self._make_slide_history(1)
        h2 = self._make_slide_history(2)
        h3 = self._make_slide_history(3)

        mock_qs = MagicMock()
        mock_qs.count.return_value = 3
        mock_qs.iterator.return_value = iter([h1, h2, h3])

        created_vh = SimpleNamespace(id="vh-new")
        vh_cls.objects.using.return_value.filter.return_value.first.return_value = None
        vh_cls.objects.using.return_value.create.return_value = created_vh
        # remaining count query
        vh_cls.objects.using.return_value.exclude.return_value.count.return_value = 1

        with patch("apps.tabslide.models.SlideHistory") as sh_cls:
            sh_cls.objects.using.return_value.order_by.return_value = mock_qs

            result = migrate_slide_histories_batch(batch_size=2)

        self.assertEqual(result["migrated"], 2)
        self.assertFalse(result["done"], "还有未迁移记录，done 应为 False")

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_batch_done_when_all_migrated(self, vh_cls):
        """所有记录均已迁移时返回 done=True。"""
        from apps.collab.management.commands.migrate_histories import migrate_slide_histories_batch

        mock_qs = MagicMock()
        mock_qs.count.return_value = 0
        mock_qs.iterator.return_value = iter([])

        with patch("apps.tabslide.models.SlideHistory") as sh_cls:
            sh_cls.objects.using.return_value.order_by.return_value = mock_qs

            result = migrate_slide_histories_batch(batch_size=500)

        self.assertTrue(result["done"])
        self.assertEqual(result["migrated"], 0)

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_batch_skips_already_migrated(self, vh_cls):
        """已迁移的记录（metadata.legacy_id 已存在）应跳过，不重复写入。"""
        from apps.collab.management.commands.migrate_histories import migrate_slide_histories_batch

        h1 = self._make_slide_history(1)

        mock_qs = MagicMock()
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([h1])

        existing_vh = SimpleNamespace(id="vh-existing")
        vh_cls.objects.using.return_value.filter.return_value.first.return_value = existing_vh
        vh_cls.objects.using.return_value.exclude.return_value.count.return_value = 0

        with patch("apps.tabslide.models.SlideHistory") as sh_cls:
            sh_cls.objects.using.return_value.order_by.return_value = mock_qs

            result = migrate_slide_histories_batch(batch_size=500)

        self.assertEqual(result["migrated"], 0, "已迁移记录不应重复写入")
        vh_cls.objects.using.return_value.create.assert_not_called()

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_batch_continues_on_single_failure(self, vh_cls):
        """单条记录迁移失败不应中断整体迁移，failed 计数正确。"""
        from apps.collab.management.commands.migrate_histories import migrate_slide_histories_batch

        h1 = self._make_slide_history(1)
        h2 = self._make_slide_history(2)

        mock_qs = MagicMock()
        mock_qs.count.return_value = 2
        mock_qs.iterator.return_value = iter([h1, h2])

        call_count = [0]

        def create_side_effect(**kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                raise Exception("DB error")
            return SimpleNamespace(id="vh-2")

        vh_cls.objects.using.return_value.filter.return_value.first.return_value = None
        vh_cls.objects.using.return_value.create.side_effect = create_side_effect
        vh_cls.objects.using.return_value.exclude.return_value.count.return_value = 0

        with patch("apps.tabslide.models.SlideHistory") as sh_cls:
            sh_cls.objects.using.return_value.order_by.return_value = mock_qs

            result = migrate_slide_histories_batch(batch_size=500)

        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["migrated"], 1)

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_batch_upgrades_old_format_blob(self, vh_cls):
        """旧格式 list blob 应被升级为 dict 格式后写入 VersionHistory。"""
        from apps.collab.management.commands.migrate_histories import migrate_slide_histories_batch

        old_blob = _make_blob([{"id": "page-1"}, {"id": "page-2"}])
        h1 = self._make_slide_history(1, blob=old_blob)

        mock_qs = MagicMock()
        mock_qs.count.return_value = 1
        mock_qs.iterator.return_value = iter([h1])

        created_blobs = []

        def capture_create(**kwargs):
            created_blobs.append(kwargs.get("blob", b""))
            return SimpleNamespace(id="vh-1")

        vh_cls.objects.using.return_value.filter.return_value.first.return_value = None
        vh_cls.objects.using.return_value.create.side_effect = capture_create
        vh_cls.objects.using.return_value.exclude.return_value.count.return_value = 0

        with patch("apps.tabslide.models.SlideHistory") as sh_cls:
            sh_cls.objects.using.return_value.order_by.return_value = mock_qs

            migrate_slide_histories_batch(batch_size=500)

        self.assertEqual(len(created_blobs), 1)
        upgraded_data = json.loads(zlib.decompress(created_blobs[0]).decode("utf-8"))
        self.assertIsInstance(upgraded_data, dict, "旧格式 list blob 应被升级为 dict")
        self.assertIn("pages", upgraded_data)
        self.assertIn("theme", upgraded_data)
        self.assertIn("font_meta", upgraded_data)


# ──────────────────────────────────────────────────────────────
# Celery 任务：migrate_slide_histories_incremental
# ──────────────────────────────────────────────────────────────

class TestMigrateSlideHistoriesIncrementalTask(TestCase):
    """migrate_slide_histories_incremental Celery 任务行为验证。"""

    @patch("apps.collab.tasks.cache")
    def test_task_skips_when_lock_held(self, cache_mock):
        """Redis 锁被占用时任务应跳过，不调用 migrate_slide_histories_batch。"""
        from apps.collab.tasks import migrate_slide_histories_incremental

        cache_mock.add.return_value = False

        with patch(
            "apps.collab.management.commands.migrate_histories.migrate_slide_histories_batch"
        ) as batch_mock:
            result = migrate_slide_histories_incremental()

        batch_mock.assert_not_called()
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "lock_held")

    @patch("apps.collab.tasks.cache")
    def test_task_calls_batch_and_releases_lock(self, cache_mock):
        """正常流程：获取锁 → 调用 batch → 释放锁。"""
        from apps.collab.tasks import migrate_slide_histories_incremental, _MIGRATE_SLIDE_BATCH_SIZE
        from apps.collab.management.commands.migrate_histories import (
            _MIGRATE_SLIDE_LOCK_KEY,
            _MIGRATE_SLIDE_LOCK_TIMEOUT,
        )

        cache_mock.add.return_value = True

        batch_result = {"done": False, "migrated": 3, "failed": 0, "remaining": 10}

        with patch(
            "apps.collab.management.commands.migrate_histories.migrate_slide_histories_batch",
            return_value=batch_result,
        ) as batch_mock:
            result = migrate_slide_histories_incremental()

        batch_mock.assert_called_once_with(batch_size=_MIGRATE_SLIDE_BATCH_SIZE)
        cache_mock.delete.assert_called_once_with(_MIGRATE_SLIDE_LOCK_KEY)
        self.assertEqual(result["migrated"], 3)

    @patch("apps.collab.tasks.cache")
    def test_task_releases_lock_on_exception(self, cache_mock):
        """batch 抛出异常时，锁必须被释放。"""
        from apps.collab.tasks import migrate_slide_histories_incremental
        from apps.collab.management.commands.migrate_histories import _MIGRATE_SLIDE_LOCK_KEY

        cache_mock.add.return_value = True

        with patch(
            "apps.collab.management.commands.migrate_histories.migrate_slide_histories_batch",
            side_effect=RuntimeError("unexpected"),
        ):
            with self.assertRaises(RuntimeError):
                migrate_slide_histories_incremental()

        cache_mock.delete.assert_called_once_with(_MIGRATE_SLIDE_LOCK_KEY)

    @patch("apps.collab.tasks.cache")
    def test_task_done_when_no_remaining(self, cache_mock):
        """全量迁移完成后 done=True，任务幂等安全。"""
        from apps.collab.tasks import migrate_slide_histories_incremental

        cache_mock.add.return_value = True

        batch_result = {"done": True, "migrated": 0, "failed": 0, "remaining": 0}

        with patch(
            "apps.collab.management.commands.migrate_histories.migrate_slide_histories_batch",
            return_value=batch_result,
        ):
            result = migrate_slide_histories_incremental()

        self.assertTrue(result["done"])

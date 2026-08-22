"""
MC-01 回归测试：DocHistory → VersionHistory 增量迁移

覆盖 8 条关键路径：
1. snapshot 直接迁移 — blob 原样复制 + 字段映射正确
2. 增量 diff resolve — collab-live 可用时解析为全量快照
3. 增量 diff fallback — collab-live 不可用时保留 diff + base_history 回填
4. 幂等去重 — 重复运行不创建重复记录
5. CSC-036 _safe_expired_at — 过期时间延长保护
6. CSC-037 editor_type 规范化 — 空字符串→"user"
7. Redis 锁互斥 — Celery Beat 任务与 management command 不并发
8. Celery Beat 任务注册 — 确认 schedule 配置
"""
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import base64  # noqa: E402
import uuid  # noqa: E402
import zlib  # noqa: E402
from datetime import timedelta  # noqa: E402
from unittest.mock import MagicMock, call, patch  # noqa: E402

import pytest  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.collab.management.commands.migrate_histories import (  # noqa: E402
    DB,
    _MIGRATE_DOC_LOCK_KEY,
    _MIGRATE_DOC_LOCK_TIMEOUT,
    _MIGRATE_MIN_TTL_SECONDS,
    _backfill_base_history_from_pairs,
    _migrate_single_doc_history,
    _safe_expired_at,
    _try_resolve_doc_diff,
    migrate_doc_histories_batch,
    migrate_docs_histories,
)


def _make_mock_doc_history(
    *,
    history_id=None,
    document_id=None,
    organization_id=None,
    is_snapshot=True,
    base_history_id=None,
    editor_type="user",
    editor_id="user-001",
    expired_at=None,
    is_named=False,
    name="",
    pinned=False,
    blob_data=b"test data",
):
    """构造 mock DocHistory 对象。"""
    h = MagicMock()
    h.id = history_id or uuid.uuid4()
    h.document_id = document_id or uuid.uuid4()
    h.organization_id = organization_id or uuid.uuid4()
    h.is_snapshot = is_snapshot
    h.base_history_id = base_history_id
    h.base_history = MagicMock(id=base_history_id) if base_history_id else None
    h.editor_type = editor_type
    h.editor_id = editor_id
    h.expired_at = expired_at
    h.is_named = is_named
    h.name = name
    h.pinned = pinned
    h.blob = zlib.compress(blob_data)
    h.created_at = timezone.now()
    return h


# ═══════════════════════════════════════════════════════════
# 1. _safe_expired_at（CSC-036）
# ═══════════════════════════════════════════════════════════


class TestSafeExpiredAt:

    def test_none_passthrough(self):
        """expired_at=None 应原样返回 None（命名版本）。"""
        assert _safe_expired_at(None) is None

    def test_past_expired_at_extended(self):
        """已过期的 expired_at 应延长到 now + 7天。"""
        past = timezone.now() - timedelta(days=10)
        result = _safe_expired_at(past)
        min_expected = timezone.now() + timedelta(seconds=_MIGRATE_MIN_TTL_SECONDS - 60)
        assert result >= min_expected

    def test_near_future_expired_at_extended(self):
        """即将过期（< 7天）的 expired_at 也应延长。"""
        near_future = timezone.now() + timedelta(days=3)
        result = _safe_expired_at(near_future)
        min_expected = timezone.now() + timedelta(seconds=_MIGRATE_MIN_TTL_SECONDS - 60)
        assert result >= min_expected

    def test_far_future_preserved(self):
        """远未来（> 7天）的 expired_at 应保持不变。"""
        far_future = timezone.now() + timedelta(days=30)
        result = _safe_expired_at(far_future)
        assert abs((result - far_future).total_seconds()) < 2


# ═══════════════════════════════════════════════════════════
# 2. _try_resolve_doc_diff
# ═══════════════════════════════════════════════════════════


class TestTryResolveDocDiff:

    def test_no_base_history_returns_unresolved(self):
        """没有 base_history_id 的 diff 应返回 unresolved。"""
        h = _make_mock_doc_history(is_snapshot=False, base_history_id=None)
        blob, resolved = _try_resolve_doc_diff(h, {})
        assert resolved is False

    def test_base_not_in_cache_returns_unresolved(self):
        """base_history 不在缓存中应返回 unresolved。"""
        base_id = uuid.uuid4()
        h = _make_mock_doc_history(is_snapshot=False, base_history_id=base_id)
        blob, resolved = _try_resolve_doc_diff(h, {})
        assert resolved is False

    @patch("apps.services.common.live_api.call_live_api")
    def test_successful_resolve(self, mock_api):
        """collab-live 可用时应成功 resolve。"""
        base_id = uuid.uuid4()
        base_data = b"base yjs binary"
        diff_data = b"diff data"
        merged_data = b"merged binary"

        base_h = _make_mock_doc_history(
            history_id=base_id, is_snapshot=True, blob_data=base_data,
        )
        diff_h = _make_mock_doc_history(
            is_snapshot=False, base_history_id=base_id, blob_data=diff_data,
        )

        mock_api.return_value = {
            "merged_b64": base64.b64encode(merged_data).decode(),
        }

        blob, resolved = _try_resolve_doc_diff(diff_h, {str(base_id): base_h})

        assert resolved is True
        decompressed = zlib.decompress(blob)
        assert decompressed == merged_data
        mock_api.assert_called_once()

    @patch(
        "apps.services.common.live_api.call_live_api",
        side_effect=Exception("collab-live unavailable"),
    )
    def test_api_failure_returns_unresolved(self, mock_api):
        """collab-live 不可用时应 fallback 返回原始 blob。"""
        base_id = uuid.uuid4()
        base_h = _make_mock_doc_history(
            history_id=base_id, is_snapshot=True, blob_data=b"base",
        )
        diff_h = _make_mock_doc_history(
            is_snapshot=False, base_history_id=base_id, blob_data=b"diff",
        )

        blob, resolved = _try_resolve_doc_diff(diff_h, {str(base_id): base_h})

        assert resolved is False
        assert blob == bytes(diff_h.blob)

    def test_json_snapshot_base_returns_unresolved(self):
        """base 是 JSON snapshot 格式时，无法 apply binary diff，应返回 unresolved。"""
        import json

        base_id = uuid.uuid4()
        json_data = json.dumps({
            "format": "json_snapshot",
            "description_json": {},
        }).encode("utf-8")
        base_h = _make_mock_doc_history(
            history_id=base_id, is_snapshot=True, blob_data=json_data,
        )
        diff_h = _make_mock_doc_history(
            is_snapshot=False, base_history_id=base_id, blob_data=b"diff",
        )

        blob, resolved = _try_resolve_doc_diff(diff_h, {str(base_id): base_h})
        assert resolved is False


# ═══════════════════════════════════════════════════════════
# 3. _migrate_single_doc_history
# ═══════════════════════════════════════════════════════════


class TestMigrateSingleDocHistory:

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_snapshot_migration_fields(self, MockVH):
        """全量快照迁移时字段映射应正确。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs
        mock_qs.first.return_value = None

        created_vh = MagicMock()
        created_vh.id = uuid.uuid4()
        mock_qs.create.return_value = created_vh

        doc_id = uuid.uuid4()
        wt_id = uuid.uuid4()
        h = _make_mock_doc_history(
            document_id=doc_id,
            organization_id=wt_id,
            is_snapshot=True,
            editor_type="agent",
            editor_id="agent-42",
            is_named=True,
            name="v1.0",
            pinned=True,
            blob_data=b"snapshot data",
        )

        legacy_to_new = {}
        histories_with_base = []
        result = _migrate_single_doc_history(h, legacy_to_new, histories_with_base)

        assert result == "migrated"
        assert str(h.id) in legacy_to_new

        create_kwargs = mock_qs.create.call_args[1]
        assert create_kwargs["resource_type"] == "docs"
        assert create_kwargs["resource_id"] == doc_id
        assert create_kwargs["organization_id"] == wt_id
        assert create_kwargs["is_snapshot"] is True
        assert create_kwargs["editor_type"] == "agent"
        assert create_kwargs["editor_id"] == "agent-42"
        assert create_kwargs["editor_name"] == ""
        assert create_kwargs["is_named"] is True
        assert create_kwargs["name"] == "v1.0"
        assert create_kwargs["pinned"] is True
        assert create_kwargs["metadata"]["legacy_id"] == str(h.id)
        assert create_kwargs["metadata"]["legacy_model"] == "DocHistory"

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_empty_editor_type_normalized(self, MockVH):
        """CSC-037: 空 editor_type 应规范化为 "user"。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs
        mock_qs.first.return_value = None

        created_vh = MagicMock()
        created_vh.id = uuid.uuid4()
        mock_qs.create.return_value = created_vh

        h = _make_mock_doc_history(editor_type="")

        legacy_to_new = {}
        histories_with_base = []
        _migrate_single_doc_history(h, legacy_to_new, histories_with_base)

        create_kwargs = mock_qs.create.call_args[1]
        assert create_kwargs["editor_type"] == "user"

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_skip_existing(self, MockVH):
        """已迁移记录应跳过。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs

        existing_vh = MagicMock()
        existing_vh.id = uuid.uuid4()
        mock_qs.first.return_value = existing_vh

        h = _make_mock_doc_history()
        legacy_to_new = {}
        histories_with_base = []

        result = _migrate_single_doc_history(h, legacy_to_new, histories_with_base)

        assert result == "skipped"
        assert str(h.id) in legacy_to_new
        mock_qs.create.assert_not_called()

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_diff_with_base_adds_to_backfill(self, MockVH):
        """未 resolve 的 diff 应记录到 histories_with_base。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs
        mock_qs.first.return_value = None

        created_vh = MagicMock()
        created_vh.id = uuid.uuid4()
        mock_qs.create.return_value = created_vh

        base_id = uuid.uuid4()
        h = _make_mock_doc_history(
            is_snapshot=False, base_history_id=base_id, blob_data=b"diff",
        )

        legacy_to_new = {}
        histories_with_base = []
        _migrate_single_doc_history(h, legacy_to_new, histories_with_base, None)

        assert len(histories_with_base) == 1
        assert histories_with_base[0] == (str(h.id), str(base_id))

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    @patch("apps.services.common.live_api.call_live_api")
    def test_resolved_diff_not_in_backfill(self, mock_api, MockVH):
        """成功 resolve 的 diff 不应加入 backfill 列表。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs
        mock_qs.first.return_value = None

        created_vh = MagicMock()
        created_vh.id = uuid.uuid4()
        mock_qs.create.return_value = created_vh

        mock_api.return_value = {
            "merged_b64": base64.b64encode(b"merged").decode(),
        }

        base_id = uuid.uuid4()
        base_h = _make_mock_doc_history(
            history_id=base_id, is_snapshot=True, blob_data=b"base",
        )
        diff_h = _make_mock_doc_history(
            is_snapshot=False, base_history_id=base_id, blob_data=b"diff",
        )

        legacy_to_new = {}
        histories_with_base = []
        all_by_id = {str(base_id): base_h}

        result = _migrate_single_doc_history(
            diff_h, legacy_to_new, histories_with_base, all_by_id,
        )

        assert result == "migrated"
        assert len(histories_with_base) == 0

        create_kwargs = mock_qs.create.call_args[1]
        assert create_kwargs["is_snapshot"] is True
        assert create_kwargs["metadata"]["resolved_from_diff"] is True

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_exception_returns_failed(self, MockVH):
        """ORM 异常应返回 "failed" 而非中断。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs
        mock_qs.first.return_value = None
        mock_qs.create.side_effect = Exception("DB error")

        h = _make_mock_doc_history()
        legacy_to_new = {}
        histories_with_base = []

        result = _migrate_single_doc_history(h, legacy_to_new, histories_with_base)
        assert result == "failed"


# ═══════════════════════════════════════════════════════════
# 4. migrate_doc_histories_batch
# ═══════════════════════════════════════════════════════════


class TestMigrateDocHistoriesBatch:

    @patch("apps.tabdoc.models.DocHistory")
    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_empty_table_returns_done(self, MockVH, MockDH):
        """空表应返回 done=True。"""
        mock_dh_qs = MagicMock()
        MockDH.objects.using.return_value = mock_dh_qs
        mock_dh_qs.order_by.return_value = mock_dh_qs
        mock_dh_qs.count.return_value = 0

        result = migrate_doc_histories_batch(batch_size=10)

        assert result["done"] is True
        assert result["migrated"] == 0
        assert result["failed"] == 0

    @patch("apps.collab.management.commands.migrate_histories._backfill_base_history_from_pairs")
    @patch("apps.collab.management.commands.migrate_histories._migrate_single_doc_history")
    @patch("apps.tabdoc.models.DocHistory")
    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_batch_size_limits_processing(self, MockVH, MockDH, mock_migrate, mock_backfill):
        """batch_size 应限制单次处理量。"""
        histories = [_make_mock_doc_history() for _ in range(5)]

        mock_dh_qs = MagicMock()
        MockDH.objects.using.return_value = mock_dh_qs
        mock_dh_qs.order_by.return_value = mock_dh_qs
        mock_dh_qs.count.return_value = 5
        mock_dh_qs.filter.return_value = mock_dh_qs
        mock_dh_qs.values_list.return_value = mock_dh_qs
        mock_dh_qs.__getitem__ = MagicMock(return_value=[])
        mock_dh_qs.iterator.return_value = iter(histories)

        mock_vh_qs = MagicMock()
        MockVH.objects.using.return_value = mock_vh_qs
        mock_vh_qs.filter.return_value = mock_vh_qs
        mock_vh_qs.first.return_value = None

        mock_migrate.return_value = "migrated"

        result = migrate_doc_histories_batch(batch_size=3)

        assert mock_migrate.call_count == 3
        assert result["migrated"] == 3
        assert result["done"] is False


# ═══════════════════════════════════════════════════════════
# 5. migrate_docs_histories（全量迁移 + 锁）
# ═══════════════════════════════════════════════════════════


class TestMigrateDocsHistoriesFull:

    @patch("apps.collab.management.commands.migrate_histories.cache")
    def test_lock_prevents_concurrent(self, mock_cache):
        """Redis 锁被持有时全量迁移应跳过并返回 (0, 0, 0)。"""
        mock_cache.add.return_value = False

        total, migrated, skipped = migrate_docs_histories(dry_run=False)

        assert total == 0
        assert migrated == 0
        assert skipped == 0

    @patch("apps.collab.management.commands.migrate_histories.cache")
    @patch("apps.tabdoc.models.DocHistory")
    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_lock_released_after_migration(self, MockVH, MockDH, mock_cache):
        """迁移完成后锁应被释放。"""
        mock_cache.add.return_value = True

        mock_dh_qs = MagicMock()
        MockDH.objects.using.return_value = mock_dh_qs
        mock_dh_qs.order_by.return_value = mock_dh_qs
        mock_dh_qs.count.return_value = 0
        mock_dh_qs.filter.return_value = mock_dh_qs
        mock_dh_qs.values_list.return_value = []
        mock_dh_qs.iterator.return_value = iter([])

        migrate_docs_histories(dry_run=False)

        mock_cache.delete.assert_called_with(_MIGRATE_DOC_LOCK_KEY)

    @patch("apps.tabdoc.models.DocHistory")
    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_dry_run_no_write(self, MockVH, MockDH):
        """dry_run 模式不应写入数据。"""
        h = _make_mock_doc_history()

        mock_dh_qs = MagicMock()
        MockDH.objects.using.return_value = mock_dh_qs
        mock_dh_qs.order_by.return_value = mock_dh_qs
        mock_dh_qs.count.return_value = 1
        mock_dh_qs.filter.return_value = mock_dh_qs
        mock_dh_qs.values_list.return_value = []
        mock_dh_qs.iterator.return_value = iter([h])

        mock_vh_qs = MagicMock()
        MockVH.objects.using.return_value = mock_vh_qs
        mock_vh_qs.filter.return_value = mock_vh_qs
        mock_vh_qs.exists.return_value = False

        total, migrated, skipped = migrate_docs_histories(dry_run=True)

        assert total == 1
        assert migrated == 1
        mock_vh_qs.create.assert_not_called()


# ═══════════════════════════════════════════════════════════
# 6. base_history 回填
# ═══════════════════════════════════════════════════════════


class TestBaseHistoryBackfill:

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_backfill_updates_base_history(self, MockVH):
        """回填应将 legacy base_id 映射到 new VH id。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs

        base_legacy_id = str(uuid.uuid4())
        diff_legacy_id = str(uuid.uuid4())
        base_new_id = str(uuid.uuid4())
        diff_new_id = str(uuid.uuid4())

        legacy_to_new = {
            base_legacy_id: base_new_id,
            diff_legacy_id: diff_new_id,
        }
        histories_with_base = [(diff_legacy_id, base_legacy_id)]

        _backfill_base_history_from_pairs("docs", histories_with_base, legacy_to_new)

        mock_qs.filter.assert_called_with(id=diff_new_id)
        mock_qs.update.assert_called_once_with(base_history_id=base_new_id)

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_backfill_skips_unmapped_ids(self, MockVH):
        """legacy_to_new 中找不到的 ID 应跳过。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs

        histories_with_base = [("unmapped-diff", "unmapped-base")]
        _backfill_base_history_from_pairs("docs", histories_with_base, {})

        mock_qs.update.assert_not_called()


# ═══════════════════════════════════════════════════════════
# 7. Celery Beat 任务注册
# ═══════════════════════════════════════════════════════════


class TestMC01BeatSchedule:

    def test_doc_migration_in_beat_schedule(self):
        """DocHistory 迁移任务应注册在 Celery Beat Schedule 中。"""
        from apps.collab.tasks import COLLAB_BEAT_SCHEDULE

        assert "collab-migrate-doc-histories" in COLLAB_BEAT_SCHEDULE
        entry = COLLAB_BEAT_SCHEDULE["collab-migrate-doc-histories"]
        assert entry["task"] == "collab.migrate_doc_histories_incremental"
        assert entry["schedule"] == 3600.0
        assert "expires" in entry["options"]

    def test_task_name_matches_schedule(self):
        """任务函数的 name 应与 schedule 中的 task 一致。"""
        from apps.collab.tasks import migrate_doc_histories_incremental

        assert migrate_doc_histories_incremental.name == "collab.migrate_doc_histories_incremental"


# ═══════════════════════════════════════════════════════════
# 8. Celery 任务锁互斥
# ═══════════════════════════════════════════════════════════


class TestMC01CeleryTaskLock:

    @patch("apps.collab.tasks.cache")
    def test_task_skips_when_lock_held(self, mock_cache):
        """迁移锁被持有时任务应跳过。"""
        mock_cache.add.return_value = False

        from apps.collab.tasks import migrate_doc_histories_incremental

        result = migrate_doc_histories_incremental()

        assert result == {"status": "skipped", "reason": "lock_held"}

    @patch("apps.collab.tasks.cache")
    @patch("apps.collab.management.commands.migrate_histories.migrate_doc_histories_batch")
    def test_task_releases_lock_on_success(self, mock_batch, mock_cache):
        """任务完成后应释放锁。"""
        mock_cache.add.return_value = True
        mock_batch.return_value = {"done": True, "migrated": 0, "failed": 0, "remaining": 0}

        from apps.collab.tasks import migrate_doc_histories_incremental

        migrate_doc_histories_incremental()

        mock_cache.delete.assert_called()

    @patch("apps.collab.tasks.cache")
    @patch("apps.collab.management.commands.migrate_histories.migrate_doc_histories_batch")
    def test_task_releases_lock_on_exception(self, mock_batch, mock_cache):
        """任务异常时也应释放锁。"""
        mock_cache.add.return_value = True
        mock_batch.side_effect = Exception("unexpected error")

        from apps.collab.tasks import migrate_doc_histories_incremental

        with pytest.raises(Exception, match="unexpected error"):
            migrate_doc_histories_incremental()

        mock_cache.delete.assert_called()


# ═══════════════════════════════════════════════════════════
# 9. expired_at 在迁移中的应用
# ═══════════════════════════════════════════════════════════


class TestMC01ExpiredAtInMigration:

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_past_expired_at_gets_extended(self, MockVH):
        """迁移时已过期的 expired_at 应被 _safe_expired_at 延长。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs
        mock_qs.first.return_value = None

        created_vh = MagicMock()
        created_vh.id = uuid.uuid4()
        mock_qs.create.return_value = created_vh

        past = timezone.now() - timedelta(days=5)
        h = _make_mock_doc_history(expired_at=past)

        legacy_to_new = {}
        histories_with_base = []
        _migrate_single_doc_history(h, legacy_to_new, histories_with_base)

        create_kwargs = mock_qs.create.call_args[1]
        min_expected = timezone.now() + timedelta(seconds=_MIGRATE_MIN_TTL_SECONDS - 120)
        assert create_kwargs["expired_at"] >= min_expected

    @patch("apps.collab.management.commands.migrate_histories.VersionHistory")
    def test_none_expired_at_preserved(self, MockVH):
        """命名版本 expired_at=None 应保持 None。"""
        mock_qs = MagicMock()
        MockVH.objects.using.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs
        mock_qs.first.return_value = None

        created_vh = MagicMock()
        created_vh.id = uuid.uuid4()
        mock_qs.create.return_value = created_vh

        h = _make_mock_doc_history(expired_at=None, is_named=True)

        legacy_to_new = {}
        histories_with_base = []
        _migrate_single_doc_history(h, legacy_to_new, histories_with_base)

        create_kwargs = mock_qs.create.call_args[1]
        assert create_kwargs["expired_at"] is None

"""TS-6 + TS-15 回归测试：删除 Tracker 改为软删（归档），保留审计历史。

修复前 bug（TS-6 / TS-15）：
- ``TrackerService.delete_tracker`` 调 ``tracker.delete()`` 物理硬删，
  ``TrackerRun.tracker`` 外键 CASCADE → 所有 TrackerRun 运行历史被物理删除，
  与 models.py「运行历史是审计资产，独立保留」注释自相矛盾。

修复后：
- delete_tracker 设 ``status='archived'`` + ``archived_at``，**不**物理删除，
  TrackerRun 全部保留。
- 仍取消活跃 Run（pending/running → cancelled）、清空 next_run_at。
- WS 生命周期事件仍发 ``deleted``（前端无感）。
- 已归档再删是幂等空操作。
- list_trackers 默认排除 archived。
- 永久物理删除走管理员级 ``purge_tracker``（不接 UI）。

沿用仓库既有 service 测试风格（SimpleTestCase + mock，不连 DB）。
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _mock_user(user_id: str = "user-abc"):
    user = MagicMock()
    user.id = user_id
    return user


def _make_service():
    from apps.tracker.services.tracker_service import TrackerService
    return TrackerService(user=_mock_user())


class DeleteTrackerSoftDeleteTest(SimpleTestCase):
    """delete_tracker 软删语义。"""

    def test_delete_sets_archived_and_does_not_physically_delete(self):
        """核心：删除 → status=archived + archived_at，绝不调 tracker.delete()。"""
        svc = _make_service()
        tracker = MagicMock()
        tracker.status = "active"
        tracker.id = uuid.uuid4()

        with patch("apps.tracker.services.tracker_service.Tracker") as MockTracker, \
             patch("apps.tracker.services.tracker_service.TrackerRun") as MockRun, \
             patch("apps.tracker.services.tracker_service._push_tracker_lifecycle_ws") as mock_ws, \
             patch.object(svc, "_ensure_permission"):
            MockTracker.objects.get.return_value = tracker
            MockRun.objects.filter.return_value = []  # 无活跃 Run

            svc.delete_tracker(str(tracker.id), user=svc.user)

            # 绝不物理删除
            tracker.delete.assert_not_called()
            # 设归档状态
            self.assertEqual(tracker.status, "archived")
            self.assertIsNotNone(tracker.archived_at)
            # next_run_at 清空，归档后不再被调度
            self.assertIsNone(tracker.next_run_at)
            # save 只更新归档相关字段
            tracker.save.assert_called_once()
            _, kwargs = tracker.save.call_args
            self.assertIn("status", kwargs.get("update_fields", []))
            self.assertIn("archived_at", kwargs.get("update_fields", []))
            # WS 仍发 deleted（前端无感）
            mock_ws.assert_called_once()
            args, _ = mock_ws.call_args
            self.assertIs(args[0], tracker)
            self.assertEqual(args[1], "deleted")

    def test_delete_uses_id_not_name_when_same_name_exists(self):
        """同名 Tracker 只能归档传入 id 的那一条，绝不能按 name 批量删除。"""
        svc = _make_service()
        target_id = uuid.uuid4()
        target = MagicMock(name="target_tracker")
        target.id = target_id
        target.name = "同名自动化任务"
        target.status = "active"

        same_name_other = MagicMock(name="same_name_other_tracker")
        same_name_other.id = uuid.uuid4()
        same_name_other.name = "同名自动化任务"
        same_name_other.status = "active"

        with patch("apps.tracker.services.tracker_service.Tracker") as MockTracker, \
             patch("apps.tracker.services.tracker_service.TrackerRun") as MockRun, \
             patch("apps.tracker.services.tracker_service._push_tracker_lifecycle_ws") as mock_ws, \
             patch.object(svc, "_ensure_permission"):
            MockTracker.objects.get.return_value = target
            MockRun.objects.filter.return_value = []

            svc.delete_tracker(str(target_id), user=svc.user)

            MockTracker.objects.get.assert_called_once_with(id=str(target_id))
            self.assertEqual(target.status, "archived")
            target.save.assert_called_once()
            same_name_other.save.assert_not_called()
            same_name_other.delete.assert_not_called()
            mock_ws.assert_called_once()
            self.assertIs(mock_ws.call_args.args[0], target)

    def test_delete_cancels_active_runs(self):
        """删除时活跃 Run（pending/running）→ cancelled。"""
        svc = _make_service()
        tracker = MagicMock()
        tracker.status = "active"
        tracker.id = uuid.uuid4()

        run = MagicMock()
        run.id = uuid.uuid4()
        list_qs = [run]          # 第一次 filter：取活跃 Run
        update_qs = MagicMock()  # 第二次 filter：行级条件 update

        with patch("apps.tracker.services.tracker_service.Tracker") as MockTracker, \
             patch("apps.tracker.services.tracker_service.TrackerRun") as MockRun, \
             patch("apps.tracker.services.tracker_service._push_tracker_lifecycle_ws"), \
             patch("apps.tracker.services.tracker_executor._release_tracker_run_runtime_claim") as mock_release, \
             patch.object(svc, "_ensure_permission"):
            MockTracker.objects.get.return_value = tracker
            MockRun.objects.filter.side_effect = [list_qs, update_qs]

            svc.delete_tracker(str(tracker.id), user=svc.user)

            # 活跃 Run 被取消
            update_qs.update.assert_called_once()
            _, kwargs = update_qs.update.call_args
            self.assertEqual(kwargs.get("status"), "cancelled")
            # runtime claim 被释放
            mock_release.assert_called_once()
            # 仍然归档，不物理删除
            self.assertEqual(tracker.status, "archived")
            tracker.delete.assert_not_called()

    def test_delete_is_idempotent_when_already_archived(self):
        """已归档的 Tracker 再删是空操作：不改时间戳、不推 WS、不物理删除。"""
        svc = _make_service()
        tracker = MagicMock()
        tracker.status = "archived"
        tracker.id = uuid.uuid4()

        with patch("apps.tracker.services.tracker_service.Tracker") as MockTracker, \
             patch("apps.tracker.services.tracker_service.TrackerRun") as MockRun, \
             patch("apps.tracker.services.tracker_service._push_tracker_lifecycle_ws") as mock_ws, \
             patch.object(svc, "_ensure_permission"):
            MockTracker.objects.get.return_value = tracker

            svc.delete_tracker(str(tracker.id), user=svc.user)

            tracker.save.assert_not_called()
            tracker.delete.assert_not_called()
            mock_ws.assert_not_called()
            MockRun.objects.filter.assert_not_called()


class PurgeTrackerTest(SimpleTestCase):
    """purge_tracker：管理员级永久物理删除（不接 UI）。"""

    def test_purge_physically_deletes(self):
        svc = _make_service()
        tracker = MagicMock()
        tracker.status = "active"
        tracker.id = uuid.uuid4()

        with patch("apps.tracker.services.tracker_service.Tracker") as MockTracker, \
             patch("apps.tracker.services.tracker_service.TrackerRun") as MockRun, \
             patch("apps.tracker.services.tracker_service._push_tracker_lifecycle_ws") as mock_ws, \
             patch.object(svc, "_ensure_permission"):
            MockTracker.objects.get.return_value = tracker
            MockRun.objects.filter.return_value = []

            svc.purge_tracker(str(tracker.id), user=svc.user)

            tracker.delete.assert_called_once()
            mock_ws.assert_called_once()
            args, _ = mock_ws.call_args
            self.assertEqual(args[1], "deleted")


class ListTrackersExcludeArchivedTest(SimpleTestCase):
    """list_trackers 默认排除 archived。"""

    ORGANIZATION_ID = str(uuid.uuid4())
    SPACE_A = str(uuid.uuid4())

    def test_with_space_id_excludes_archived(self):
        svc = _make_service()
        with patch.object(svc, "check_organization_permission", return_value=True), \
             patch.object(svc, "check_space_permission", return_value=True), \
             patch("apps.tracker.services.tracker_service.Tracker") as MockTracker:
            qs_base = MagicMock(name="qs_base")
            qs_excluded = MagicMock(name="qs_excluded")
            qs_final = MagicMock(name="qs_final")
            MockTracker.objects.filter.return_value = qs_base
            qs_base.exclude.return_value = qs_excluded
            qs_excluded.filter.return_value = qs_final

            result = svc.list_trackers(self.ORGANIZATION_ID, self.SPACE_A)

            # 必须 exclude archived
            qs_base.exclude.assert_called_once_with(status="archived")
            # 再按 space_id 过滤
            qs_excluded.filter.assert_called_once_with(space_id=self.SPACE_A)
            self.assertIs(result, qs_final)

    def test_without_space_id_excludes_archived(self):
        svc = _make_service()
        accessible = {uuid.UUID(self.SPACE_A)}
        with patch.object(svc, "check_organization_permission", return_value=True), \
             patch(
                 "apps.tabtinspace.services.accessible_space_resolver.get_accessible_space_ids",
                 return_value=accessible,
             ), \
             patch("apps.tracker.services.tracker_service.Tracker") as MockTracker:
            qs_base = MagicMock(name="qs_base")
            qs_excluded = MagicMock(name="qs_excluded")
            qs_final = MagicMock(name="qs_final")
            MockTracker.objects.filter.return_value = qs_base
            qs_base.exclude.return_value = qs_excluded
            qs_excluded.filter.return_value = qs_final

            result = svc.list_trackers(self.ORGANIZATION_ID)

            qs_base.exclude.assert_called_once_with(status="archived")
            qs_excluded.filter.assert_called_once_with(space_id__in=accessible)
            self.assertIs(result, qs_final)

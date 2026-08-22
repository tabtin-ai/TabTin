"""Module F 决策 3 回归测试：list_trackers 遵守 Space 边界。

修复前 bug：
- ``TrackerService.list_trackers(organization_id)`` 不传 space_id 时只校验
  organization viewer 权限，直接返回该 organization 下所有 Tracker。
- 后果：HR Space 创建的"扫描候选人简历评分" Tracker 会被销售 Space 的 editor
  在自己的 Tracker 列表里看到（同 organization 不同 Space）。

修复后：
- 不传 space_id 时调 ``AccessibleSpaceResolver.resolve()`` 取并集
  （SpaceMembership / Agent SpaceMembership 两条路径），
  只返回这些 Space 下的 Tracker。
- 传 space_id 时仍按单 Space 权限校验（保留原行为）。
- 用户在该 organization 没有任何可访问 Space → 返回空 queryset。

本测试钉死这个边界，防止未来回退。
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _mock_user(user_id: str = "user-abc"):
    user = MagicMock()
    user.id = user_id
    return user


class ListTrackersSpaceScopeTest(SimpleTestCase):
    """Module F 决策 3：list_trackers 必须按可访问 Space 边界过滤。"""

    ORGANIZATION_ID = str(uuid.uuid4())
    SPACE_A = str(uuid.uuid4())  # 用户可访问
    SPACE_B = str(uuid.uuid4())  # 用户可访问
    SPACE_C = str(uuid.uuid4())  # 用户不可访问（HR 等同 organization 不同 Space）

    def _make_service(self):
        from apps.tracker.services.tracker_service import TrackerService
        return TrackerService(user=_mock_user())

    def test_with_space_id_uses_single_space_permission(self):
        """传 space_id 时走单 Space 权限校验（保留原行为）。"""
        svc = self._make_service()
        with patch.object(svc, "check_organization_permission", return_value=True), \
             patch.object(svc, "check_space_permission", return_value=True) as mock_space_perm, \
             patch("apps.tracker.services.tracker_service.Tracker") as mock_tracker_cls:
            mock_qs = MagicMock()
            mock_excluded = MagicMock()
            mock_filtered = MagicMock()
            mock_tracker_cls.objects.filter.return_value = mock_qs
            # TS-6（软删）：list 先 exclude archived，再按 space 过滤。
            mock_qs.exclude.return_value = mock_excluded
            mock_excluded.filter.return_value = mock_filtered

            result = svc.list_trackers(self.ORGANIZATION_ID, self.SPACE_A)

            # 必须校验该 Space 的 viewer 权限
            mock_space_perm.assert_called_once_with(self.SPACE_A, "viewer")
            # 必须先排除 archived（TS-6 软删）
            mock_qs.exclude.assert_called_once_with(status="archived")
            # 必须按 space_id 过滤
            mock_excluded.filter.assert_called_once_with(space_id=self.SPACE_A)
            self.assertIs(result, mock_filtered)

    def test_without_space_id_filters_by_accessible_resolver(self):
        """不传 space_id 时按 AccessibleSpaceResolver 过滤。"""
        svc = self._make_service()
        accessible = {uuid.UUID(self.SPACE_A), uuid.UUID(self.SPACE_B)}

        with patch.object(svc, "check_organization_permission", return_value=True), \
             patch(
                 "apps.tabtinspace.services.accessible_space_resolver.get_accessible_space_ids",
                 return_value=accessible,
             ) as mock_resolver, \
             patch("apps.tracker.services.tracker_service.Tracker") as mock_tracker_cls:
            mock_qs = MagicMock()
            mock_excluded = MagicMock()
            mock_filtered = MagicMock()
            mock_tracker_cls.objects.filter.return_value = mock_qs
            # TS-6（软删）：list 先 exclude archived，再按 accessible space 过滤。
            mock_qs.exclude.return_value = mock_excluded
            mock_excluded.filter.return_value = mock_filtered

            result = svc.list_trackers(self.ORGANIZATION_ID)

            # 必须按用户 id + organization 查询 accessible Space
            mock_resolver.assert_called_once()
            args, kwargs = mock_resolver.call_args
            self.assertEqual(args[0], "user-abc")
            self.assertEqual(str(args[1]), self.ORGANIZATION_ID)
            # 必须先排除 archived（TS-6 软删）
            mock_qs.exclude.assert_called_once_with(status="archived")
            # 必须用 space_id__in=accessible 过滤
            mock_excluded.filter.assert_called_once_with(space_id__in=accessible)
            self.assertIs(result, mock_filtered)

    def test_without_space_id_returns_none_when_no_accessible_space(self):
        """用户在该 organization 没有任何可访问 Space → 返回 Tracker.none()。

        修复前的 bug 表现：直接返回 Tracker.objects.filter(organization_id=...)
        会暴露全 organization Tracker 给 organization viewer 但 Space membership 为空的用户。
        """
        svc = self._make_service()
        with patch.object(svc, "check_organization_permission", return_value=True), \
             patch(
                 "apps.tabtinspace.services.accessible_space_resolver.get_accessible_space_ids",
                 return_value=set(),
             ), \
             patch("apps.tracker.services.tracker_service.Tracker") as mock_tracker_cls:
            sentinel = MagicMock(name="empty-qs")
            mock_tracker_cls.objects.none.return_value = sentinel

            result = svc.list_trackers(self.ORGANIZATION_ID)

            mock_tracker_cls.objects.none.assert_called_once()
            self.assertIs(
                result, sentinel,
                "无可访问 Space 时必须返回 Tracker.objects.none()，不能落到 organization 全量",
            )

    def test_without_space_id_returns_none_when_resolver_returns_none(self):
        """resolver 返回 None（user_id 为空等异常路径）→ 同样返回空 queryset。"""
        svc = self._make_service()
        with patch.object(svc, "check_organization_permission", return_value=True), \
             patch(
                 "apps.tabtinspace.services.accessible_space_resolver.get_accessible_space_ids",
                 return_value=None,
             ), \
             patch("apps.tracker.services.tracker_service.Tracker") as mock_tracker_cls:
            sentinel = MagicMock(name="empty-qs")
            mock_tracker_cls.objects.none.return_value = sentinel

            result = svc.list_trackers(self.ORGANIZATION_ID)

            mock_tracker_cls.objects.none.assert_called_once()
            self.assertIs(result, sentinel)

    def test_organization_viewer_permission_denied_raises(self):
        """organization 都没 viewer 权限 → PermissionError，不要走到 Space 解析。"""
        svc = self._make_service()
        with patch.object(svc, "check_organization_permission", return_value=False):
            with self.assertRaises(PermissionError):
                svc.list_trackers(self.ORGANIZATION_ID)

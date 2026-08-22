"""list_spaces 稳定排序回归。

侧栏 Workspace 顺序不应随 last_activity_at 漂移；点文件/改资源会 touch
活跃时间，若 list API 仍按活跃度排，前端 loadSpaces 后列表会乱跳。
"""

from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from apps.tabtinspace.models import Device, Space
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user


class ListSpacesStableOrderTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.owner = create_test_user(prefix="listord-owner")
        self.organization = create_test_organization(owner=self.owner, prefix="listord")
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint="listord-owner-device",
        )
        self.service = SpaceService(user=self.owner)

    def test_list_spaces_ignores_last_activity_at(self) -> None:
        older = self.service.create_space(
            organization_id=self.organization.id,
            name="Older Space",
            device_id=self.device.id,
            working_dir="/Users/owner/TabTin/older",
            working_dir_type="mixed",
        )
        newer = self.service.create_space(
            organization_id=self.organization.id,
            name="Newer Space",
            device_id=self.device.id,
            working_dir="/Users/owner/TabTin/newer",
            working_dir_type="mixed",
        )
        self.assertIsNotNone(older)
        self.assertIsNotNone(newer)
        assert older is not None and newer is not None

        # 故意把较早创建的 Space 标成最近活跃——旧实现会把它排到最前
        Space.objects.filter(id=older.id).update(
            last_activity_at=timezone.now() + timedelta(hours=1),
            order=0,
        )
        Space.objects.filter(id=newer.id).update(
            last_activity_at=timezone.now() - timedelta(days=7),
            order=0,
        )

        spaces, total = self.service.list_spaces(
            organization_id=self.organization.id,
            is_archived=False,
            space_type="workspace",
        )
        tracked = {older.id, newer.id}
        workspace_ids = [space.id for space in spaces if space.id in tracked]

        self.assertEqual(len(workspace_ids), 2)
        # order 相同 → created_at 降序：newer 在前；与 last_activity_at 无关
        self.assertEqual(workspace_ids, [newer.id, older.id])
        self.assertGreaterEqual(total, 2)

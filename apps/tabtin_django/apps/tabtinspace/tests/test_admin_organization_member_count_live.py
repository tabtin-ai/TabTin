"""#5640: 后台组织列表/详情的 member_count / space_count 必须读实表。

非规范化 Organization.member_count / space_count 可能滞后到定时 reconcile；
后台运营切回页面时期望看到即时人数与 Space 数。
"""

from __future__ import annotations

import uuid

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabtinspace.admin_api import (
    admin_get_organization_detail,
    admin_list_organization_members,
    admin_list_organizations,
)
from apps.tabtinspace.models import Organization, OrganizationMember, Space

User = get_user_model()


class AdminOrganizationMemberCountLiveTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        suffix = uuid.uuid4().hex[:8]
        self.owner = User.objects.create_user(
            username=f"owner_{suffix}",
            email=f"owner_{suffix}@test.com",
            password="test-pass-123",
            is_active=True,
        )
        self.member = User.objects.create_user(
            username=f"member_{suffix}",
            email=f"member_{suffix}@test.com",
            password="test-pass-123",
            is_active=True,
        )
        self.inactive = User.objects.create_user(
            username=f"inactive_{suffix}",
            email=f"inactive_{suffix}@test.com",
            password="test-pass-123",
            is_active=False,
        )
        # 故意把冗余字段写成错误值，模拟 signal/reconcile 滞后
        self.organization = Organization.objects.create(
            name=f"Live Count Org {suffix}",
            owner=self.owner,
            type=Organization.OrganizationType.TEAM,
            member_count=99,
            space_count=99,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.inactive,
            role="viewer",
        )
        self.space_a = Space.objects.create(
            organization=self.organization,
            type=Space.SpaceType.WORKSPACE,
            name=f"live-space-a-{suffix}",
            status="active",
        )
        self.space_b = Space.objects.create(
            organization=self.organization,
            type=Space.SpaceType.WORKSPACE,
            name=f"live-space-b-{suffix}",
            status="active",
            is_archived=True,
        )
        # 再把冗余字段打歪，覆盖 create signal 带来的正确值
        Organization.objects.filter(id=self.organization.id).update(
            member_count=99,
            space_count=99,
        )
        self.organization.refresh_from_db()

    def test_admin_detail_uses_live_member_count(self):
        response = admin_get_organization_detail(request=None, organization_id=self.organization.id)
        self.assertEqual(response["data"]["member_count"], 3)
        self.assertNotEqual(response["data"]["member_count"], self.organization.member_count)

    def test_admin_list_uses_live_member_count(self):
        response = admin_list_organizations(
            request=None,
            keyword=self.organization.name,
            page=1,
            page_size=20,
        )
        items = response["data"]["organizations"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["member_count"], 3)

    def test_admin_members_reflect_user_active_status(self):
        response = admin_list_organization_members(
            request=None,
            organization_id=self.organization.id,
            page=1,
            page_size=20,
        )
        by_user = {item["user_id"]: item["user_status"] for item in response["data"]["members"]}
        self.assertEqual(by_user[str(self.owner.id)], "active")
        self.assertEqual(by_user[str(self.member.id)], "active")
        self.assertEqual(by_user[str(self.inactive.id)], "inactive")

    def test_admin_detail_count_drops_immediately_after_leave(self):
        OrganizationMember.objects.filter(
            organization=self.organization,
            user=self.member,
        ).delete()
        # 人为保持冗余字段未递减
        Organization.objects.filter(id=self.organization.id).update(member_count=99)

        response = admin_get_organization_detail(request=None, organization_id=self.organization.id)
        self.assertEqual(response["data"]["member_count"], 2)

    def test_admin_detail_uses_live_space_count(self):
        response = admin_get_organization_detail(request=None, organization_id=self.organization.id)
        # space_count 计全部 Space 行（含归档）；active_space_count 排除归档
        self.assertEqual(response["data"]["space_count"], 2)
        self.assertEqual(response["data"]["active_space_count"], 1)
        self.assertNotEqual(response["data"]["space_count"], self.organization.space_count)

    def test_admin_list_uses_live_space_count(self):
        response = admin_list_organizations(
            request=None,
            keyword=self.organization.name,
            page=1,
            page_size=20,
        )
        items = response["data"]["organizations"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["space_count"], 2)
        self.assertEqual(items[0]["active_space_count"], 1)

    def test_admin_detail_space_count_drops_immediately_after_delete(self):
        self.space_a.delete()
        Organization.objects.filter(id=self.organization.id).update(space_count=99)

        response = admin_get_organization_detail(request=None, organization_id=self.organization.id)
        self.assertEqual(response["data"]["space_count"], 1)
        self.assertEqual(response["data"]["active_space_count"], 0)


class AdminOrganizationListSortAndSummaryLiveTests(TestCase):
    """列表 sort / summary 也必须走实表，不能被打歪的冗余字段带偏。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        suffix = uuid.uuid4().hex[:8]
        self.keyword = f"LiveSortOrg {suffix}"
        self.owner_low = User.objects.create_user(
            username=f"owner_low_{suffix}",
            email=f"owner_low_{suffix}@test.com",
            password="test-pass-123",
            is_active=True,
        )
        self.owner_high = User.objects.create_user(
            username=f"owner_high_{suffix}",
            email=f"owner_high_{suffix}@test.com",
            password="test-pass-123",
            is_active=True,
        )
        self.extra_member = User.objects.create_user(
            username=f"extra_{suffix}",
            email=f"extra_{suffix}@test.com",
            password="test-pass-123",
            is_active=True,
        )

        # low：实表 1 人 / 0 Space；冗余字段故意写成「人多 Space 多」
        self.org_low = Organization.objects.create(
            name=f"{self.keyword} low",
            owner=self.owner_low,
            type=Organization.OrganizationType.TEAM,
            member_count=100,
            space_count=100,
        )
        OrganizationMember.objects.create(
            organization=self.org_low, user=self.owner_low, role="owner"
        )

        # high：实表 2 人 / 1 Space；冗余字段故意写成「人少无 Space」
        self.org_high = Organization.objects.create(
            name=f"{self.keyword} high",
            owner=self.owner_high,
            type=Organization.OrganizationType.TEAM,
            member_count=1,
            space_count=0,
        )
        OrganizationMember.objects.create(
            organization=self.org_high, user=self.owner_high, role="owner"
        )
        OrganizationMember.objects.create(
            organization=self.org_high, user=self.extra_member, role="editor"
        )
        Space.objects.create(
            organization=self.org_high,
            type=Space.SpaceType.WORKSPACE,
            name=f"sort-space-{suffix}",
            status="active",
        )

        Organization.objects.filter(id=self.org_low.id).update(
            member_count=100, space_count=100
        )
        Organization.objects.filter(id=self.org_high.id).update(
            member_count=1, space_count=0
        )
        self.org_low.refresh_from_db()
        self.org_high.refresh_from_db()

    def test_member_desc_sort_uses_live_member_count(self):
        # 若按冗余字段：low(100) 应排在 high(1) 前；实表则 high(2) 在前
        response = admin_list_organizations(
            request=None,
            keyword=self.keyword,
            page=1,
            page_size=20,
            sort="member_desc",
        )
        items = response["data"]["organizations"]
        ids = [item["id"] for item in items]
        self.assertEqual(ids[:2], [str(self.org_high.id), str(self.org_low.id)])
        by_id = {item["id"]: item for item in items}
        self.assertEqual(by_id[str(self.org_high.id)]["member_count"], 2)
        self.assertEqual(by_id[str(self.org_low.id)]["member_count"], 1)

    def test_space_desc_sort_uses_live_space_count(self):
        # 若按冗余字段：low(100) 应排在 high(0) 前；实表则 high(1) 在前
        response = admin_list_organizations(
            request=None,
            keyword=self.keyword,
            page=1,
            page_size=20,
            sort="space_desc",
        )
        items = response["data"]["organizations"]
        ids = [item["id"] for item in items]
        self.assertEqual(ids[:2], [str(self.org_high.id), str(self.org_low.id)])
        by_id = {item["id"]: item for item in items}
        self.assertEqual(by_id[str(self.org_high.id)]["space_count"], 1)
        self.assertEqual(by_id[str(self.org_low.id)]["space_count"], 0)

    def test_summary_organizations_with_spaces_uses_live_space_rows(self):
        before = admin_list_organizations(
            request=None, page=1, page_size=1
        )["data"]["summary"]["organizations_with_spaces"]

        # 冗余 space_count=0 但实有 Space → summary 应计入
        stale_zero = Organization.objects.create(
            name=f"{self.keyword} stale-zero",
            owner=self.owner_low,
            type=Organization.OrganizationType.TEAM,
            space_count=0,
        )
        Space.objects.create(
            organization=stale_zero,
            type=Space.SpaceType.WORKSPACE,
            name="stale-zero-space",
            status="active",
        )
        Organization.objects.filter(id=stale_zero.id).update(space_count=0)

        mid = admin_list_organizations(
            request=None, page=1, page_size=1
        )["data"]["summary"]["organizations_with_spaces"]
        self.assertEqual(mid, before + 1)

        # 冗余 space_count=99 但实无 Space → summary 不应增加
        stale_high = Organization.objects.create(
            name=f"{self.keyword} stale-high",
            owner=self.owner_high,
            type=Organization.OrganizationType.TEAM,
            space_count=99,
        )
        Organization.objects.filter(id=stale_high.id).update(space_count=99)

        after = admin_list_organizations(
            request=None, page=1, page_size=1
        )["data"]["summary"]["organizations_with_spaces"]
        self.assertEqual(after, mid)

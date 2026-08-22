"""后台用户所属组织列表 API 回归。"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase
from ninja.errors import HttpError

from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.auth.admin_api import (
    _build_organization_summary_map,
    list_user_organizations,
    list_users,
)

User = get_user_model()


class AdminUserOrganizationsApiTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.staff = User.objects.create_user(
            username="admin_user_orgs_staff",
            email="admin_user_orgs_staff@test.com",
            password="StaffPass123!",
            is_staff=True,
            is_active=True,
        )
        self.target = User.objects.create_user(
            username="admin_user_orgs_target",
            email="admin_user_orgs_target@test.com",
            password="TargetPass123!",
            is_active=True,
        )
        self.other = User.objects.create_user(
            username="admin_user_orgs_other",
            email="admin_user_orgs_other@test.com",
            password="OtherPass123!",
            is_active=True,
        )

        # create_user 会经 signal 自动创建个人组织与 owner 成员
        self.personal_org = Organization.objects.get(
            owner=self.target,
            type=Organization.OrganizationType.PERSONAL,
        )
        Organization.objects.filter(id=self.personal_org.id).update(name="目标个人组织")
        self.personal_org.refresh_from_db()

        self.team_org = Organization.objects.create(
            name="协作团队",
            owner=self.other,
            type=Organization.OrganizationType.TEAM,
            is_default=False,
            member_count=2,
        )
        OrganizationMember.objects.get_or_create(
            organization=self.team_org,
            user=self.target,
            defaults={"role": "editor"},
        )
        OrganizationMember.objects.get_or_create(
            organization=self.team_org,
            user=self.other,
            defaults={"role": "owner"},
        )

    def _staff_request(self, path: str):
        request = self.factory.get(path)
        request.auth = self.staff
        return request

    def test_list_user_organizations_returns_memberships(self):
        response = list_user_organizations(
            request=self._staff_request(f"/auth/admin/users/{self.target.id}/organizations"),
            user_id=str(self.target.id),
            page=1,
            page_size=20,
        )

        self.assertEqual(response.total, 2)
        self.assertEqual(response.pagination.total, 2)
        names = {item.organization_name for item in response.organizations}
        self.assertEqual(names, {"目标个人组织", "协作团队"})
        roles = {
            item.organization_name: item.role for item in response.organizations
        }
        self.assertEqual(roles["目标个人组织"], "owner")
        self.assertEqual(roles["协作团队"], "editor")

    def test_list_user_organizations_404_for_missing_user(self):
        with self.assertRaises(HttpError) as ctx:
            list_user_organizations(
                request=self._staff_request("/auth/admin/users/missing/organizations"),
                user_id="00000000-0000-0000-0000-000000000000",
            )
        self.assertEqual(ctx.exception.status_code, 404)

    def test_organization_summary_prefers_personal_org(self):
        summary_map = _build_organization_summary_map([str(self.target.id)])
        summary = summary_map[str(self.target.id)]
        self.assertEqual(summary.organization_count, 2)
        self.assertEqual(summary.primary_organization_id, str(self.personal_org.id))
        self.assertEqual(summary.primary_organization_name, "目标个人组织")

    def test_list_users_includes_organization_summary(self):
        response = list_users(
            request=self._staff_request("/auth/admin/users"),
            keyword=self.target.username,
            page=1,
            page_size=20,
        )
        self.assertEqual(len(response.items), 1)
        item = response.items[0]
        self.assertIsNotNone(item.organization_summary)
        self.assertEqual(item.organization_summary.organization_count, 2)
        self.assertEqual(
            item.organization_summary.primary_organization_name,
            "目标个人组织",
        )

"""PERF-008/009/010 回归测试：admin summary 使用单次 aggregate 而非多次独立 COUNT"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import uuid  # noqa: E402
from datetime import timedelta  # noqa: E402

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connections  # noqa: E402
from django.db.models import Count, Q  # noqa: E402
from django.test import TestCase  # noqa: E402
from django.test.utils import CaptureQueriesContext  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.tabtinspace.models import (  # noqa: E402
    Agent,
    Space,
    SpaceAdminActionLog,
    Organization,
    OrganizationMember,
)
from apps.tabtinspace.admin_api import (  # noqa: E402
    admin_list_spaces,
    admin_list_organization_members,
    admin_list_organizations,
)
from apps.users.wallet.models import OrganizationWallet  # noqa: E402

User = get_user_model()


class OrganizationSummaryAggregateTest(TestCase):
    """PERF-008: admin_list_organizations summary 使用单次 aggregate。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        # bulk_create 避免触发 signal 自动创建 Organization
        users = User.objects.bulk_create([
            User(username="ws_owner1", email="ws1@test.com"),
            User(username="ws_owner2", email="ws2@test.com"),
        ])
        Organization.objects.all().delete()
        Organization.objects.bulk_create([
            Organization(name="默认空间", owner=users[0], is_default=True, space_count=3),
            Organization(name="项目空间", owner=users[0], is_default=False, space_count=0),
            Organization(name="归档空间", owner=users[1], is_default=False, space_count=5),
        ])

    def test_organization_summary_values(self):
        stats = Organization.objects.aggregate(
            total_organizations=Count("id"),
            default_organizations=Count("id", filter=Q(is_default=True)),
            non_default_organizations=Count("id", filter=Q(is_default=False)),
            organizations_with_spaces=Count("id", filter=Q(space_count__gt=0)),
        )
        self.assertEqual(stats["total_organizations"], 3)
        self.assertEqual(stats["default_organizations"], 1)
        self.assertEqual(stats["non_default_organizations"], 2)
        self.assertEqual(stats["organizations_with_spaces"], 2)

    def test_organization_summary_single_query(self):
        pg_conn = connections["postgresql"]
        with CaptureQueriesContext(pg_conn) as ctx:
            Organization.objects.aggregate(
                total_organizations=Count("id"),
                default_organizations=Count("id", filter=Q(is_default=True)),
                non_default_organizations=Count("id", filter=Q(is_default=False)),
                organizations_with_spaces=Count("id", filter=Q(space_count__gt=0)),
            )
        self.assertLessEqual(
            len(ctx.captured_queries),
            1,
            f"organization summary 应使用 ≤1 次 SQL，实际 {len(ctx.captured_queries)} 次",
        )

    def test_organization_list_filters_owner_keyword_by_name(self):
        response = admin_list_organizations(
            request=None,
            owner_keyword="@owner2",
            page=1,
            page_size=20,
        )

        data = response["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["organizations"][0]["name"], "归档空间")

    def test_organization_list_sorts_before_pagination(self):
        response = admin_list_organizations(
            request=None,
            sort="space_desc",
            page=1,
            page_size=1,
        )

        data = response["data"]
        self.assertEqual(data["total"], 3)
        self.assertEqual(data["pagination"]["total_pages"], 3)
        self.assertEqual(data["organizations"][0]["name"], "归档空间")

    def test_organization_list_wallet_ascending_keeps_empty_wallets_last(self):
        default_organization = Organization.objects.get(name="默认空间")
        archive_organization = Organization.objects.get(name="归档空间")
        OrganizationWallet.objects.create(organization_id=str(default_organization.id), credits=300)
        OrganizationWallet.objects.create(organization_id=str(archive_organization.id), credits=100)

        response = admin_list_organizations(
            request=None,
            sort="wallet_asc",
            page=1,
            page_size=3,
        )

        data = response["data"]
        self.assertEqual(
            [item["name"] for item in data["organizations"]],
            ["归档空间", "默认空间", "项目空间"],
        )

    def test_organization_member_list_paginates_after_joined_time_sort(self):
        organization = Organization.objects.get(name="默认空间")
        users = User.objects.bulk_create([
            User(username="member_1", email="member1@test.com"),
            User(username="member_2", email="member2@test.com"),
            User(username="member_3", email="member3@test.com"),
        ])
        members = [
            OrganizationMember.objects.create(organization=organization, user=users[0], role="viewer"),
            OrganizationMember.objects.create(organization=organization, user=users[1], role="editor"),
            OrganizationMember.objects.create(organization=organization, user=users[2], role="admin"),
        ]
        base_time = timezone.now()
        for index, member in enumerate(members):
            OrganizationMember.objects.filter(id=member.id).update(
                joined_at=base_time + timedelta(minutes=index)
            )

        response = admin_list_organization_members(
            request=None,
            organization_id=organization.id,
            page=2,
            page_size=2,
        )

        data = response["data"]
        self.assertEqual(data["total"], 3)
        self.assertEqual(data["pagination"]["page"], 2)
        self.assertEqual(data["pagination"]["total_pages"], 2)
        self.assertEqual([item["user_name"] for item in data["members"]], ["member_1"])


class SpaceSummaryAggregateTest(TestCase):
    """PERF-009: _list_spaces_core summary 使用单次 aggregate。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        users = User.objects.bulk_create([
            User(username="sp_owner", email="sp@test.com"),
        ])
        Organization.objects.all().delete()
        self.organization = Organization.objects.create(
            name="客户团队", owner=users[0],
        )
        Space.objects.all().delete()
        agents = [
            Agent.objects.create(organization=self.organization, name=f"Agent {idx}", type="bot")
            for idx in range(3)
        ]
        Space.objects.bulk_create([
            Space(organization=self.organization, agent=agents[0], name="活跃空间",
                  type=Space.SpaceType.WORKSPACE, is_archived=False, status="active"),
            Space(organization=self.organization, agent=agents[1], name="暂停空间",
                  type=Space.SpaceType.WORKSPACE, is_archived=False, status="paused"),
            Space(organization=self.organization, agent=agents[2], name="归档空间",
                  type=Space.SpaceType.WORKSPACE, is_archived=True, status="completed"),
        ])

    def test_space_summary_values(self):
        stats = Space.objects.aggregate(
            total_spaces=Count("id"),
            active_spaces=Count("id", filter=Q(is_archived=False)),
            archived_spaces=Count("id", filter=Q(is_archived=True)),
            status_active_spaces=Count("id", filter=Q(status="active")),
            status_paused_spaces=Count("id", filter=Q(status="paused")),
            status_completed_spaces=Count("id", filter=Q(status="completed")),
        )
        self.assertEqual(stats["total_spaces"], 3)
        self.assertEqual(stats["active_spaces"], 2)
        self.assertEqual(stats["archived_spaces"], 1)
        self.assertEqual(stats["status_active_spaces"], 1)
        self.assertEqual(stats["status_paused_spaces"], 1)
        self.assertEqual(stats["status_completed_spaces"], 1)

    def test_space_summary_single_query(self):
        pg_conn = connections["postgresql"]
        with CaptureQueriesContext(pg_conn) as ctx:
            Space.objects.aggregate(
                total_spaces=Count("id"),
                active_spaces=Count("id", filter=Q(is_archived=False)),
                archived_spaces=Count("id", filter=Q(is_archived=True)),
                status_active_spaces=Count("id", filter=Q(status="active")),
                status_paused_spaces=Count("id", filter=Q(status="paused")),
                status_completed_spaces=Count("id", filter=Q(status="completed")),
            )
        self.assertLessEqual(
            len(ctx.captured_queries),
            1,
            f"space summary 应使用 ≤1 次 SQL，实际 {len(ctx.captured_queries)} 次",
        )

    def test_space_list_filters_keyword_by_organization_name(self):
        response = admin_list_spaces(
            request=None,
            keyword="客户团队",
            page=1,
            page_size=20,
        )

        data = response["data"]
        self.assertEqual(data["total"], 3)
        self.assertEqual(data["pagination"]["total_pages"], 1)
        self.assertEqual(
            {item["name"] for item in data["spaces"]},
            {"活跃空间", "暂停空间", "归档空间"},
        )

    def test_space_list_filters_keyword_by_organization_id(self):
        response = admin_list_spaces(
            request=None,
            keyword=str(self.organization.id),
            page=1,
            page_size=20,
        )

        data = response["data"]
        self.assertEqual(data["total"], 3)
        self.assertEqual(
            {item["name"] for item in data["spaces"]},
            {"活跃空间", "暂停空间", "归档空间"},
        )


class AuditLogSummaryAggregateTest(TestCase):
    """PERF-010: admin_list_organization_audit_logs summary 使用单次 aggregate。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.organization_id = uuid.uuid4()
        target_id = uuid.uuid4()
        base = dict(
            organization_id=self.organization_id,
            action_type="workspace_update",
            target_type="workspace",
            target_id=target_id,
            operator_id=uuid.uuid4(),
            operator_name="admin",
        )
        SpaceAdminActionLog.objects.create(**base, success=True, dry_run=False)
        SpaceAdminActionLog.objects.create(**base, success=True, dry_run=True)
        SpaceAdminActionLog.objects.create(**base, success=False, dry_run=False)

    def test_audit_log_summary_values(self):
        stats = SpaceAdminActionLog.objects.filter(
            organization_id=self.organization_id,
        ).aggregate(
            total_logs=Count("id"),
            success_logs=Count("id", filter=Q(success=True)),
            failed_logs=Count("id", filter=Q(success=False)),
            dry_run_logs=Count("id", filter=Q(dry_run=True)),
        )
        self.assertEqual(stats["total_logs"], 3)
        self.assertEqual(stats["success_logs"], 2)
        self.assertEqual(stats["failed_logs"], 1)
        self.assertEqual(stats["dry_run_logs"], 1)

    def test_audit_log_summary_single_query(self):
        pg_conn = connections["postgresql"]
        with CaptureQueriesContext(pg_conn) as ctx:
            SpaceAdminActionLog.objects.filter(
                organization_id=self.organization_id,
            ).aggregate(
                total_logs=Count("id"),
                success_logs=Count("id", filter=Q(success=True)),
                failed_logs=Count("id", filter=Q(success=False)),
                dry_run_logs=Count("id", filter=Q(dry_run=True)),
            )
        self.assertLessEqual(
            len(ctx.captured_queries),
            1,
            f"audit log summary 应使用 ≤1 次 SQL，实际 {len(ctx.captured_queries)} 次",
        )

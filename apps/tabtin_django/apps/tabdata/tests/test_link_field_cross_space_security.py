"""
Link 字段跨 Space 安全回归测试。

覆盖：
  SDI-002: get_linkable_records 必须校验目标表 Space 权限
  SDI-003: create_link_field 单向 link 必须校验目标表权限
  SDI-010: get_linkable_fields 必须校验目标表 Space 权限
  BO-020:  check_space_permission Organization Owner 隐式 viewer 权限
  BO-021:  跨库测试基础设施 — TestCase + settings_tabdata_test

运行方式（必须使用 settings_tabdata_test 避免跨库 FK 问题）：
    cd apps/tabtin_django
    python -m pytest apps/tabdata/tests/test_link_field_cross_space_security.py -v \
        --ds=tabtin.settings_tabdata_test

    # 或通过 run_tests.py：
    python apps/tabdata/tests/run_tests.py \
        apps.tabdata.tests.test_link_field_cross_space_security
"""

from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.link_field_service import LinkFieldService
from apps.tabdata.services.base import BaseService

User = get_user_model()

_NATIVE_SYNC_PATCH = patch(
    "apps.tabdata.services.link_field_service.LinkFieldService._sync_native_cells",
    return_value=None,
)
_DDL_ADD_COLUMN_PATCH = patch(
    "apps.tabdata.native.ddl_manager.DDLManager.add_column",
    return_value=None,
)
_INVALIDATE_RESOLVER_PATCH = patch(
    "apps.tabdata.native.name_resolver.invalidate_resolver",
    return_value=None,
)


def _setup_agent_membership(organization, space, user, role):
    """为用户在 Space 中创建 Agent + SpaceMembership。"""
    agent = Agent.objects.filter(
        organization=organization, user=user, type="human", is_active=True,
    ).first()
    if not agent:
        agent = Agent.objects.create(
            organization=organization, user=user,
            name=f"Agent-{user.username}", type="human", is_active=True,
        )
    SpaceMembership.objects.get_or_create(
        workspace=space, agent=agent,
        defaults={"role": role, "is_active": True},
    )
    return agent


class LinkFieldCrossSpaceSecurityTest(TestCase):
    """SDI-002 / SDI-003 / SDI-010 跨 Space 权限校验回归测试

    用户角色：
      - user_a: organization owner，space_a 的 owner
      - user_b: organization 普通成员，space_b 的 owner
      - outsider: 完全不在 organization 中的外部用户
    """

    databases = ["default", "postgresql"]

    def setUp(self):
        self._patches = [
            _NATIVE_SYNC_PATCH,
            _DDL_ADD_COLUMN_PATCH,
            _INVALIDATE_RESOLVER_PATCH,
        ]
        for p in self._patches:
            p.start()

        self.user_a = User.objects.db_manager("default").create_user(
            username=f"sec-user-a-{uuid4().hex[:8]}",
            email=f"sec-a-{uuid4().hex[:8]}@example.com",
            password="testpass123",
        )
        self.user_b = User.objects.db_manager("default").create_user(
            username=f"sec-user-b-{uuid4().hex[:8]}",
            email=f"sec-b-{uuid4().hex[:8]}@example.com",
            password="testpass123",
        )
        self.outsider = User.objects.db_manager("default").create_user(
            username=f"sec-outsider-{uuid4().hex[:8]}",
            email=f"sec-out-{uuid4().hex[:8]}@example.com",
            password="testpass123",
        )

        self.organization = Organization.objects.create(
            name="SecTestOrganization",
            owner=self.user_a,
        )

        self.space_a = Space.objects.create(
            organization=self.organization,
            name="SpaceA",
        )
        self.space_b = Space.objects.create(
            organization=self.organization,
            name="SpaceB",
        )

        _setup_agent_membership(self.organization, self.space_a, self.user_a, "owner")
        _setup_agent_membership(self.organization, self.space_b, self.user_b, "owner")

        self.table_a = Table.objects.create(
            name="TableInSpaceA",
            space_id=self.space_a.id,
            organization_id=self.organization.id,
            owner_id=str(self.user_a.id),
        )
        self.primary_a = TableField.objects.create(
            table=self.table_a, name="Name", field_type="text",
            is_primary=True, order=0,
        )

        self.table_b = Table.objects.create(
            name="TableInSpaceB",
            space_id=self.space_b.id,
            organization_id=self.organization.id,
            owner_id=str(self.user_b.id),
        )
        self.primary_b = TableField.objects.create(
            table=self.table_b, name="Name", field_type="text",
            is_primary=True, order=0,
        )
        self.record_b1 = TableRecord.objects.create(
            table=self.table_b,
            data={str(self.primary_b.id): "SecretRecord1"},
            created_by_id=self.user_b.id,
            updated_by_id=self.user_b.id,
            order=1,
        )
        self.record_b2 = TableRecord.objects.create(
            table=self.table_b,
            data={str(self.primary_b.id): "SecretRecord2"},
            created_by_id=self.user_b.id,
            updated_by_id=self.user_b.id,
            order=2,
        )

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()

    # ─── SDI-003: create_link_field 单向 link 必须校验目标表权限 ───

    def test_sdi003_oneway_link_blocked_for_unauthorized_user(self):
        """外部用户不在 organization/space_b 中，不允许创建指向 table_b 的单向 link 字段"""
        link_field = TableField.objects.create(
            table=self.table_a, name="CrossLink", field_type="link",
            is_primary=False, order=1,
            config={
                "relationship": "ManyOne",
                "foreignTableId": str(self.table_b.id),
                "isOneWay": True,
            },
        )
        with self.assertRaises(PermissionError):
            LinkFieldService.create_link_field(
                link_field, {}, user=self.outsider,
            )

    def test_sdi003_oneway_link_allowed_for_authorized_user(self):
        """用户 B 在 space_b 中，允许创建指向 table_b 的单向 link 字段"""
        link_field = TableField.objects.create(
            table=self.table_a, name="ValidLink", field_type="link",
            is_primary=False, order=1,
            config={
                "relationship": "ManyOne",
                "foreignTableId": str(self.table_b.id),
                "isOneWay": True,
            },
        )
        result = LinkFieldService.create_link_field(
            link_field, {}, user=self.user_b,
        )
        self.assertIsNotNone(result)

    def test_sdi003_system_operation_no_user_bypasses_check(self):
        """系统操作（user=None）不受限"""
        link_field = TableField.objects.create(
            table=self.table_a, name="SystemLink", field_type="link",
            is_primary=False, order=1,
            config={
                "relationship": "ManyOne",
                "foreignTableId": str(self.table_b.id),
                "isOneWay": True,
            },
        )
        result = LinkFieldService.create_link_field(
            link_field, {}, user=None,
        )
        self.assertIsNotNone(result)

    # ─── SDI-002: get_linkable_records 必须校验目标表权限 ───

    def test_sdi002_linkable_records_blocked_for_unauthorized_user(self):
        """外部用户无权查看 space_b 中表格的记录"""
        link_field = TableField.objects.create(
            table=self.table_a, name="LeakLink", field_type="link",
            is_primary=False, order=2,
            config={
                "relationship": "ManyMany",
                "foreignTableId": str(self.table_b.id),
                "lookupFieldId": str(self.primary_b.id),
                "isOneWay": True,
            },
        )
        with self.assertRaises(PermissionError):
            LinkFieldService.get_linkable_records(
                link_field, user=self.outsider,
            )

    def test_sdi002_linkable_records_allowed_for_authorized_user(self):
        """用户 B 有权查看 space_b 中表格的记录"""
        link_field = TableField.objects.create(
            table=self.table_a, name="OKLink", field_type="link",
            is_primary=False, order=2,
            config={
                "relationship": "ManyMany",
                "foreignTableId": str(self.table_b.id),
                "lookupFieldId": str(self.primary_b.id),
                "isOneWay": True,
            },
        )
        records, total = LinkFieldService.get_linkable_records(
            link_field, user=self.user_b,
        )
        self.assertEqual(total, 2)
        self.assertEqual(len(records), 2)

    def test_sdi002_linkable_records_no_user_backwards_compat(self):
        """user=None（内部调用）正常返回，不做权限检查"""
        link_field = TableField.objects.create(
            table=self.table_a, name="InternalLink", field_type="link",
            is_primary=False, order=2,
            config={
                "relationship": "ManyMany",
                "foreignTableId": str(self.table_b.id),
                "lookupFieldId": str(self.primary_b.id),
                "isOneWay": True,
            },
        )
        records, total = LinkFieldService.get_linkable_records(
            link_field, user=None,
        )
        self.assertEqual(total, 2)

    # ─── SDI-010: get_linkable_fields 必须校验目标表权限 ───

    def test_sdi010_linkable_fields_blocked_for_unauthorized_user(self):
        """外部用户无权查看 space_b 中表格的字段元数据"""
        link_field = TableField.objects.create(
            table=self.table_a, name="MetaLeakLink", field_type="link",
            is_primary=False, order=3,
            config={
                "relationship": "ManyMany",
                "foreignTableId": str(self.table_b.id),
                "isOneWay": True,
            },
        )
        with self.assertRaises(PermissionError):
            LinkFieldService.get_linkable_fields(link_field, user=self.outsider)

    def test_sdi010_linkable_fields_allowed_for_authorized_user(self):
        """用户 B 有权查看 space_b 中表格的字段元数据"""
        link_field = TableField.objects.create(
            table=self.table_a, name="MetaOKLink", field_type="link",
            is_primary=False, order=3,
            config={
                "relationship": "ManyMany",
                "foreignTableId": str(self.table_b.id),
                "isOneWay": True,
            },
        )
        result = LinkFieldService.get_linkable_fields(link_field, user=self.user_b)
        self.assertIn("fields", result)
        self.assertTrue(len(result["fields"]) > 0)

    def test_sdi010_linkable_fields_no_user_backwards_compat(self):
        """user=None（内部调用）正常返回，不做权限检查"""
        link_field = TableField.objects.create(
            table=self.table_a, name="InternalMetaLink", field_type="link",
            is_primary=False, order=3,
            config={
                "relationship": "ManyMany",
                "foreignTableId": str(self.table_b.id),
                "isOneWay": True,
            },
        )
        result = LinkFieldService.get_linkable_fields(link_field, user=None)
        self.assertIn("fields", result)
        self.assertTrue(len(result["fields"]) > 0)

    # ─── BO-020: Organization Owner 隐式 viewer 权限 ───

    def test_bo020_organization_owner_has_implicit_viewer_on_all_spaces(self):
        """BO-020 回归：Organization Owner 对其下所有 Space 有隐式 viewer 权限"""
        svc = BaseService(user=self.user_a)
        self.assertTrue(
            svc.check_space_permission(str(self.space_b.id), "viewer"),
            "Organization Owner 应对其下 Space 有隐式 viewer 权限",
        )

    def test_bo020_organization_owner_implicit_does_not_grant_editor(self):
        """BO-020 边界：隐式权限不应升级为 editor/admin"""
        svc = BaseService(user=self.user_a)
        self.assertFalse(
            svc.check_space_permission(str(self.space_b.id), "editor"),
            "隐式 viewer 不应满足 editor 需求",
        )
        self.assertFalse(
            svc.check_space_permission(str(self.space_b.id), "admin"),
            "隐式 viewer 不应满足 admin 需求",
        )

    def test_bo020_non_owner_no_implicit_access(self):
        """BO-020 边界：非 Organization Owner 不享有隐式权限"""
        svc = BaseService(user=self.user_b)
        self.assertFalse(
            svc.check_space_permission(str(self.space_a.id), "viewer"),
            "非 Organization Owner (user_b) 不应获得 space_a 的隐式权限",
        )

    def test_bo020_organization_owner_linkable_records_viewer(self):
        """BO-020 回归：Organization Owner 通过隐式 viewer 可查看 linkable records"""
        link_field = TableField.objects.create(
            table=self.table_a, name="OwnerViewLink", field_type="link",
            is_primary=False, order=4,
            config={
                "relationship": "ManyMany",
                "foreignTableId": str(self.table_b.id),
                "lookupFieldId": str(self.primary_b.id),
                "isOneWay": True,
            },
        )
        records, total = LinkFieldService.get_linkable_records(
            link_field, user=self.user_a,
        )
        self.assertEqual(total, 2)

    # ─── BO-021: 测试基础设施验证 ───

    def test_bo021_cross_db_objects_created_successfully(self):
        """BO-021 回归：跨库对象创建正常（User 在 default，Space/Table 在 postgresql）"""
        self.assertIsNotNone(self.user_a.id)
        self.assertIsNotNone(self.user_b.id)
        self.assertIsNotNone(self.outsider.id)
        self.assertIsNotNone(self.organization.id)
        self.assertIsNotNone(self.space_a.id)
        self.assertIsNotNone(self.space_b.id)
        self.assertIsNotNone(self.table_a.id)
        self.assertIsNotNone(self.table_b.id)
        self.assertEqual(TableRecord.objects.filter(table=self.table_b).count(), 2)

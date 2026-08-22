"""
TabData 模型测试
测试 Organization 和 OrganizationMember 模型的功能
"""

import uuid
from django.test import TestCase
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError

from apps.tabtinspace.models import Organization, OrganizationMember, Space
from apps.tabdata.models import Table, TableField, TableRecord

User = get_user_model()


class OrganizationModelTest(TestCase):
    """组织模型测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.user = User.objects.create_user(
            username='testuser',
            email='test@example.com',
            password='testpass123'
        )

    def test_create_organization(self):
        """测试创建组织"""
        organization = Organization.objects.create(
            name='测试组织',
            description='这是一个测试组织',
            owner=self.user
        )

        self.assertEqual(organization.name, '测试组织')
        self.assertEqual(organization.description, '这是一个测试组织')
        self.assertEqual(organization.owner, self.user)
        self.assertTrue(organization.is_default)  # 使用is_default字段替代is_active
        self.assertIsInstance(organization.id, uuid.UUID)
        self.assertIsNotNone(organization.created_at)
        self.assertIsNotNone(organization.updated_at)

    def test_organization_str_representation(self):
        """测试组织字符串表示"""
        organization = Organization.objects.create(
            name='测试组织',
            owner=self.user
        )
        self.assertEqual(str(organization), '测试组织')

    def test_organization_name_required(self):
        """测试组织名称必填"""
        with self.assertRaises(IntegrityError):
            Organization.objects.create(
                name=None,
                owner=self.user
            )

    def test_organization_owner_required(self):
        """测试组织所有者必填"""
        with self.assertRaises(IntegrityError):
            Organization.objects.create(
                name='测试组织',
                owner=None
            )

    def test_organization_settings_default(self):
        """测试组织设置默认值"""
        organization = Organization.objects.create(
            name='测试组织',
            owner=self.user
        )
        self.assertEqual(organization.settings, {})

    def test_organization_settings_custom(self):
        """测试组织自定义设置"""
        custom_settings = {
            'theme': 'dark',
            'language': 'zh-CN',
            'notifications': True
        }
        organization = Organization.objects.create(
            name='测试组织',
            owner=self.user,
            settings=custom_settings
        )
        self.assertEqual(organization.settings, custom_settings)

    def test_organization_same_name_rejected_by_service(self):
        """全表同名组织应被拒绝"""
        from apps.tabtinspace.services.base import ServiceError
        from apps.tabtinspace.services.organization_service import OrganizationService

        Organization.objects.create(name='测试组织', owner=self.user)

        with self.assertRaises(ServiceError) as ctx:
            OrganizationService.assert_organization_name_available('测试组织')

        self.assertEqual(ctx.exception.code, 'ORGANIZATION_NAME_CONFLICT')
        self.assertEqual(ctx.exception.status, 409)

    def test_organization_same_name_case_insensitive(self):
        """同名校验大小写不敏感"""
        from apps.tabtinspace.services.base import ServiceError
        from apps.tabtinspace.services.organization_service import OrganizationService

        Organization.objects.create(name='Acme Team', owner=self.user)

        with self.assertRaises(ServiceError) as ctx:
            OrganizationService.assert_organization_name_available('acme team')

        self.assertEqual(ctx.exception.code, 'ORGANIZATION_NAME_CONFLICT')

    def test_organization_same_name_different_owners_rejected(self):
        """不同 owner 也不允许同名（全表唯一）"""
        from apps.tabtinspace.services.base import ServiceError
        from apps.tabtinspace.services.organization_service import OrganizationService

        user2 = User.objects.create_user(
            username='testuser2',
            email='test2@example.com',
            password='testpass123'
        )

        Organization.objects.create(name='测试组织', owner=self.user)

        with self.assertRaises(ServiceError) as ctx:
            OrganizationService.assert_organization_name_available('测试组织')

        self.assertEqual(ctx.exception.code, 'ORGANIZATION_NAME_CONFLICT')
        # 明确与 user2 无关：全表已占用即拒绝
        self.assertIsNotNone(user2.id)

    def test_organization_rename_to_self_allowed(self):
        """改回自身原名（含大小写变化）应通过"""
        from apps.tabtinspace.services.organization_service import OrganizationService

        organization = Organization.objects.create(name='Acme', owner=self.user)
        normalized = OrganizationService.assert_organization_name_available(
            'acme', exclude_id=organization.id,
        )
        self.assertEqual(normalized, 'acme')

    def test_organization_deleting_name_reusable(self):
        """删除中的组织不占名，可重建同名"""
        from apps.tabtinspace.services.organization_service import OrganizationService

        Organization.objects.create(
            name='可复用',
            owner=self.user,
            status=Organization.Status.DELETING,
        )
        normalized = OrganizationService.assert_organization_name_available('可复用')
        self.assertEqual(normalized, '可复用')

    def test_allocate_unique_organization_name_suffix(self):
        """系统自动命名撞车时追加序号"""
        from apps.tabtinspace.services.organization_service import OrganizationService

        Organization.objects.create(name='小明的组织', owner=self.user)
        allocated = OrganizationService.allocate_unique_organization_name('小明的组织')
        self.assertEqual(allocated, '小明的组织 (2)')


class OrganizationMemberModelTest(TestCase):
    """组织成员模型测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.owner = User.objects.create_user(
            username='owner',
            email='owner@example.com',
            password='testpass123'
        )

        self.member = User.objects.create_user(
            username='member',
            email='member@example.com',
            password='testpass123'
        )

        self.organization = Organization.objects.create(
            name='测试组织',
            owner=self.owner
        )

    def test_create_organization_member(self):
        """测试创建组织成员"""
        organization_member = OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role='editor'
        )

        self.assertEqual(organization_member.organization, self.organization)
        self.assertEqual(organization_member.user, self.member)
        self.assertEqual(organization_member.role, 'editor')
        self.assertIsInstance(organization_member.id, uuid.UUID)
        self.assertIsNotNone(organization_member.joined_at)

    def test_organization_member_str_representation(self):
        """测试组织成员字符串表示"""
        organization_member = OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role='editor'
        )
        expected_str = f"{self.member.username} - {self.organization.name} (editor)"
        self.assertEqual(str(organization_member), expected_str)

    def test_organization_member_role_choices(self):
        """测试组织成员角色选择"""
        valid_roles = ['owner', 'admin', 'editor', 'viewer']

        for role in valid_roles:
            organization_member = OrganizationMember.objects.create(
                organization=self.organization,
                user=self.member,
                role=role
            )
            self.assertEqual(organization_member.role, role)
            organization_member.delete()  # 清理数据

    def test_organization_member_invalid_role(self):
        """测试无效的组织成员角色"""
        with self.assertRaises(ValidationError):
            organization_member = OrganizationMember(
                organization=self.organization,
                user=self.member,
                role='invalid_role'
            )
            organization_member.full_clean()

    def test_organization_member_unique_constraint(self):
        """测试组织成员唯一性约束"""
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role='editor'
        )

        with self.assertRaises(IntegrityError):
            OrganizationMember.objects.create(
                organization=self.organization,
                user=self.member,
                role='viewer'
            )

    def test_organization_member_permissions_default(self):
        """测试组织成员权限默认值"""
        organization_member = OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role='editor'
        )
        self.assertEqual(organization_member.permissions, {})

    def test_organization_member_permissions_custom(self):
        """测试组织成员自定义权限"""
        custom_permissions = {
            'can_create_project': True,
            'can_delete_project': False,
            'can_invite_members': True
        }
        organization_member = OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role='editor',
            permissions=custom_permissions
        )
        self.assertEqual(organization_member.permissions, custom_permissions)


class OrganizationRelationshipTest(TestCase):
    """组织关系测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.owner = User.objects.create_user(
            username='owner',
            email='owner@example.com',
            password='testpass123'
        )

        self.organization = Organization.objects.create(
            name='测试组织',
            owner=self.owner
        )

    def test_organization_projects_relationship(self):
        """测试组织与项目的关系"""
        space = Space.objects.create(
            name='测试项目',
            organization=self.organization
        )

        self.assertIn(space, self.organization.projects.all())
        self.assertEqual(space.organization, self.organization)

    def test_organization_members_relationship(self):
        """测试组织与成员的关系"""
        member = User.objects.create_user(
            username='member',
            email='member@example.com',
            password='testpass123'
        )

        organization_member = OrganizationMember.objects.create(
            organization=self.organization,
            user=member,
            role='editor'
        )

        self.assertIn(organization_member, self.organization.members.all())
        self.assertEqual(organization_member.organization, self.organization)

    def test_organization_cascade_delete(self):
        """测试组织级联删除"""
        # 创建项目和成员
        space = Space.objects.create(
            name='测试项目',
            organization=self.organization
        )

        member = User.objects.create_user(
            username='member',
            email='member@example.com',
            password='testpass123'
        )

        organization_member = OrganizationMember.objects.create(
            organization=self.organization,
            user=member,
            role='editor'
        )

        # 删除组织
        organization_id = self.organization.id
        self.organization.delete()

        # 验证相关数据被删除
        self.assertFalse(Organization.objects.filter(id=organization_id).exists())
        self.assertFalse(Space.objects.filter(organization_id=organization_id).exists())
        self.assertFalse(OrganizationMember.objects.filter(organization_id=organization_id).exists())


class OrganizationQueryTest(TestCase):
    """组织查询测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.user1 = User.objects.create_user(
            username='user1',
            email='user1@example.com',
            password='testpass123'
        )

        self.user2 = User.objects.create_user(
            username='user2',
            email='user2@example.com',
            password='testpass123'
        )

        # 创建组织
        self.organization1 = Organization.objects.create(
            name='组织1',
            owner=self.user1
        )

        self.organization2 = Organization.objects.create(
            name='组织2',
            owner=self.user2
        )

        # 添加成员
        OrganizationMember.objects.create(
            organization=self.organization2,
            user=self.user1,
            role='editor'
        )

    def test_get_user_organizations(self):
        """测试获取用户的组织"""
        # 用户1拥有的组织
        owned_organizations = Organization.objects.filter(owner=self.user1)
        self.assertIn(self.organization1, owned_organizations)
        self.assertNotIn(self.organization2, owned_organizations)

        # 用户1参与的组织（包括拥有的和作为成员的）
        member_organizations = Organization.objects.filter(
            members__user=self.user1
        )
        self.assertIn(self.organization2, member_organizations)

    def test_get_organizations_by_status(self):
        """测试根据状态获取组织（使用is_default字段作为示例）"""
        # 设置一个组织为默认
        self.organization1.is_default = True
        self.organization1.save()

        default_organizations = Organization.objects.filter(is_default=True)
        non_default_organizations = Organization.objects.filter(is_default=False)

        self.assertIn(self.organization1, default_organizations)
        self.assertIn(self.organization2, non_default_organizations)

    def test_organization_member_count(self):
        """测试组织成员数量"""
        # organization1 只有所有者
        self.assertEqual(self.organization1.members.count(), 0)

        # organization2 有一个额外成员
        self.assertEqual(self.organization2.members.count(), 1)


if __name__ == '__main__':
    import unittest
    unittest.main()

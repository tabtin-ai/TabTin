"""
TabData 服务层测试
"""

import uuid
from unittest.mock import Mock, patch
from django.test import TestCase
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError, PermissionDenied

from apps.tabtinspace.models import Organization, OrganizationMember, Space
from apps.tabdata.models import Table

User = get_user_model()


class OrganizationServiceTest(TestCase):
    """组织服务测试"""

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

    def test_create_organization(self):
        """测试创建组织"""
        organization = Organization.objects.create(
            name='测试组织',
            description='测试描述',
            owner=self.user1
        )

        self.assertEqual(organization.name, '测试组织')
        self.assertEqual(organization.owner, self.user1)
        self.assertTrue(organization.is_active)

    def test_organization_member_management(self):
        """测试组织成员管理"""
        organization = Organization.objects.create(
            name='成员测试组织',
            owner=self.user1
        )

        # 添加成员
        member = OrganizationMember.objects.create(
            organization=organization,
            user=self.user2,
            role='editor',
            invited_by=self.user1
        )

        self.assertEqual(member.user, self.user2)
        self.assertEqual(member.role, 'editor')
        self.assertEqual(member.invited_by, self.user1)

    def test_organization_permissions(self):
        """测试组织权限"""
        organization = Organization.objects.create(
            name='权限测试组织',
            owner=self.user1
        )

        # 添加不同角色的成员
        admin_member = OrganizationMember.objects.create(
            organization=organization,
            user=self.user2,
            role='admin',
            invited_by=self.user1
        )

        # 验证角色
        self.assertEqual(admin_member.role, 'admin')
        self.assertTrue(admin_member.organization == organization)


class PermissionServiceTest(TestCase):
    """权限服务测试"""

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
            name='权限测试组织',
            owner=self.owner
        )

    def test_owner_permissions(self):
        """测试所有者权限"""
        # 所有者拥有完全权限
        self.assertEqual(self.organization.owner, self.owner)
        self.assertTrue(self.organization.is_active)

    def test_member_roles(self):
        """测试成员角色"""
        # 创建不同角色的成员
        admin = OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role='admin',
            invited_by=self.owner
        )

        self.assertEqual(admin.role, 'admin')
        self.assertEqual(admin.organization, self.organization)


if __name__ == '__main__':
    import unittest
    unittest.main()

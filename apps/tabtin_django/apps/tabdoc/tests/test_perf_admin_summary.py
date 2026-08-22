"""
PERF-005 回归测试：list_admin_docs summary 用 Exists 子查询替代 JOIN 避免 O(N×M)
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdoc import admin_api
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabtinspace.models import Space, Organization


class AdminDocSummaryAggregateTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        User = get_user_model()
        self.staff_user = User.objects.create_user(
            username="perf005_staff",
            email="perf005_staff@test.com",
            password="pass123",
            is_staff=True,
        )
        self.organization = Organization.objects.create(
            name="文档测试组织",
            owner=self.staff_user,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="文档测试空间",
        )

        self.active_doc = Document.objects.create(
            title="活跃文档",
            organization_id=self.organization.id,
            space_id=self.space.id,
            status="active",
        )
        self.archived_doc = Document.objects.create(
            title="归档文档",
            organization_id=self.organization.id,
            space_id=self.space.id,
            status="archived",
        )
        self.trashed_doc = Document.objects.create(
            title="回收站文档",
            organization_id=self.organization.id,
            space_id=self.space.id,
            status="active",
        )
        self.trashed_doc.trash(user_id=self.staff_user.id)
        self.doc_with_perm = Document.objects.create(
            title="有权限覆盖的文档",
            organization_id=self.organization.id,
            space_id=self.space.id,
            status="active",
        )
        DocumentPermission.objects.create(
            document=self.doc_with_perm,
            subject_type="user",
            subject_id=str(self.staff_user.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.staff_user.id),
        )
        self.doc_with_inactive_perm = Document.objects.create(
            title="权限已禁用的文档",
            organization_id=self.organization.id,
            space_id=self.space.id,
            status="active",
        )
        DocumentPermission.objects.create(
            document=self.doc_with_inactive_perm,
            subject_type="user",
            subject_id=str(uuid.uuid4()),
            permission="viewer",
            is_active=False,
            granted_by=str(self.staff_user.id),
        )

    def test_summary_counts_match_expected_values(self):
        """验证 Exists 子查询产出的 documents_with_permission_overrides 仅统计 is_active=True"""
        request = SimpleNamespace(auth=self.staff_user)

        response = admin_api.list_admin_docs(request, page=1, page_size=50)

        summary = response.summary
        self.assertEqual(summary.total_documents, 5)
        self.assertEqual(summary.active_documents, 3)
        self.assertEqual(summary.archived_documents, 1)
        self.assertEqual(summary.trashed_documents, 1)
        self.assertEqual(summary.documents_with_permission_overrides, 1)

    def test_summary_filtered_documents_reflects_status_filter(self):
        """验证 filtered_documents 正确反映筛选条件"""
        request = SimpleNamespace(auth=self.staff_user)

        response = admin_api.list_admin_docs(request, status="archived", page=1, page_size=50)

        self.assertEqual(response.summary.filtered_documents, 1)
        self.assertEqual(response.summary.total_documents, 5)

    def test_summary_filtered_documents_reflects_trashed_filter(self):
        """验证回收站筛选只返回逻辑删除文档"""
        request = SimpleNamespace(auth=self.staff_user)

        response = admin_api.list_admin_docs(request, status="trashed", page=1, page_size=50)

        self.assertEqual(response.summary.filtered_documents, 1)
        self.assertEqual(response.items[0].id, str(self.trashed_doc.id))
        self.assertTrue(response.items[0].is_trashed)

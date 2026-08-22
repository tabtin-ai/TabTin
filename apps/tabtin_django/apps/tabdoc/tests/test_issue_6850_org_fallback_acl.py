"""#6850 / ：CAP-004 owner ACL 存在时，组织角色不隐式授权。

历史  曾放开 org fallback 以便组织 editor 删除云盘文档；
#6863 产品口径改为云盘默认私有后，未显式分享的文档对组织成员一律拒绝。
本文件保留用例编号，断言改为收紧语义。
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class Issue6850OrgFallbackAclTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.owner = User.objects.create_user(
            username="i6850-owner",
            email="i6850-owner@example.com",
            password="x",
        )
        self.editor = User.objects.create_user(
            username="i6850-editor",
            email="i6850-editor@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="I6850 Org",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.editor,
            role="editor",
        )
        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            created_by=self.owner,
            updated_by=self.owner,
            title="CAP-004 sealed?",
            description_markdown="x",
            description_plaintext="x",
            is_private=False,
        )
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

    def test_org_editor_denied_when_only_creator_cap004_acl(self):
        """#6863：仅创建者 CAP-004 ACL 时，组织 editor 不可 editor/trash。"""
        service = DocumentService(user=self.editor)
        self.assertFalse(service.check_document_permission(self.doc, "editor"))
        self.assertIsNone(service.compute_user_document_role(self.doc))
        self.assertNotIn(
            self.doc,
            list(
                Document.objects.filter(
                    service._build_permission_filter_q(
                        None,
                        "editor",
                        organization_id=self.organization.id,
                    )
                )
            ),
        )

    def test_org_editor_cannot_trash_when_only_creator_cap004_acl(self):
        service = DocumentService(user=self.editor)
        with self.assertRaises(Exception):
            service.trash_document(self.doc)
        self.doc.refresh_from_db()
        self.assertIsNone(self.doc.trashed_at)

    def test_private_doc_still_blocks_org_editor_without_acl(self):
        self.doc.is_private = True
        self.doc.save(update_fields=["is_private"])
        service = DocumentService(user=self.editor)
        self.assertFalse(service.check_document_permission(self.doc, "editor"))

    def test_explicit_viewer_acl_does_not_elevate_to_editor(self):
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.editor.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        service = DocumentService(user=self.editor)
        self.assertFalse(service.check_document_permission(self.doc, "editor"))
        self.assertEqual(service.compute_user_document_role(self.doc), "viewer")

    def test_explicit_editor_acl_allows_edit_not_admin(self):
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.editor.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        service = DocumentService(user=self.editor)
        self.assertTrue(service.check_document_permission(self.doc, "editor"))
        self.assertFalse(service.check_document_permission(self.doc, "admin"))

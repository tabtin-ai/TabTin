"""#6863：云盘资源默认私有——组织成员看不到/改不了未分享资源。"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase

from apps.tabdata.models import Table, TablePermission
from apps.tabdata.services.base import BaseService as TabDataBaseService
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import (
    ContextItem,
    FilePermission,
    Organization,
    OrganizationMember,
)
from apps.tabtinspace.services.cloud_resource_acl import (
    build_cloud_item_visibility_q,
    check_item_resource_permission,
    capabilities_for_role,
    resolve_tabfiles_role,
)
from apps.tabtinspace.services.context_item_service import ContextItemService
from apps.tabtinspace.services.knowledge_tree_service import KnowledgeTreeService
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class Issue6863CloudPrivateAclTests(TestCase):
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
            username="i6863-owner",
            email="i6863-owner@example.com",
            password="x",
        )
        self.member = User.objects.create_user(
            username="i6863-member",
            email="i6863-member@example.com",
            password="x",
        )
        self.org_admin = User.objects.create_user(
            username="i6863-admin",
            email="i6863-admin@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="I6863 Org",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.org_admin,
            role="admin",
        )

        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            created_by=self.owner,
            updated_by=self.owner,
            title="Private Doc",
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
        ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title=self.doc.title,
            resource_id=str(self.doc.id),
            created_by=self.owner,
            updated_by=self.owner,
        )

        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.owner,
            name="Private Table",
        )
        ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdata",
            title=self.table.name,
            resource_id=str(self.table.id),
            created_by=self.owner,
            updated_by=self.owner,
        )

        from apps.services.oss.models import FileRecord

        self.file_record = FileRecord.objects.create(
            file_name="secret.pdf",
            file_key=f"test/6863/{self.owner.id}/secret.pdf",
            file_path=f"test/6863/{self.owner.id}/secret.pdf",
            file_size=12,
            file_type="document",
            mime_type="application/pdf",
            file_extension="pdf",
            file_hash="d" * 32,
            bucket_name="test",
            upload_user=str(self.owner.id),
            organization_id=str(self.organization.id),
            status="completed",
        )
        self.file_record_id = str(self.file_record.id)
        self.file_item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabfiles",
            title="secret.pdf",
            resource_id=self.file_record_id,
            created_by=self.owner,
            updated_by=self.owner,
        )

    def test_org_member_cannot_see_unshared_cloud_items(self):
        service = ContextItemService(user=self.member)
        items, total = service.list_items_for_organization(self.organization.id)
        self.assertEqual(total, 0)
        self.assertEqual(items, [])

        admin_service = ContextItemService(user=self.org_admin)
        items_admin, total_admin = admin_service.list_items_for_organization(
            self.organization.id,
        )
        self.assertEqual(total_admin, 0)
        self.assertEqual(items_admin, [])

    def test_owner_sees_own_cloud_items(self):
        service = ContextItemService(user=self.owner)
        items, total = service.list_items_for_organization(self.organization.id)
        self.assertEqual(total, 3)
        types = {i.item_type for i in items}
        self.assertEqual(types, {"tabdoc", "tabdata", "tabfiles"})

    def test_tabdata_org_member_denied_without_permission(self):
        service = TabDataBaseService(user=self.member)
        self.assertFalse(service.check_table_permission(str(self.table.id), "viewer"))
        self.assertIsNone(service.get_table_role(str(self.table.id)))

    def test_tabdoc_org_member_denied_without_permission(self):
        service = DocumentService(user=self.member)
        self.assertFalse(service.check_document_permission(self.doc, "viewer"))
        self.assertIsNone(service.compute_user_document_role(self.doc))

    def test_shared_doc_visible_and_openable(self):
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        list_service = ContextItemService(user=self.member)
        items, total = list_service.list_items_for_organization(
            self.organization.id, item_type="tabdoc",
        )
        self.assertEqual(total, 1)
        self.assertEqual(str(items[0].resource_id), str(self.doc.id))

        doc_service = DocumentService(user=self.member)
        self.assertTrue(doc_service.check_document_permission(self.doc, "editor"))
        # editor 不能 trash（需 admin+）
        self.assertFalse(doc_service.check_document_permission(self.doc, "admin"))

    def test_shared_table_visible(self):
        TablePermission.objects.create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        list_service = ContextItemService(user=self.member)
        items, total = list_service.list_items_for_organization(
            self.organization.id, item_type="tabdata",
        )
        self.assertEqual(total, 1)
        self.assertTrue(
            TabDataBaseService(user=self.member).check_table_permission(
                str(self.table.id), "viewer",
            )
        )
        self.assertFalse(
            TabDataBaseService(user=self.member).check_table_permission(
                str(self.table.id), "editor",
            )
        )

    def test_cloud_docs_owned_tree_excludes_resources_shared_with_member(self):
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        TablePermission.objects.create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
        )

        service = KnowledgeTreeService(user=self.member)
        accessible_tree = service.build_tree(
            organization_id=self.organization.id,
            item_types={"tabdoc", "tabdata"},
        )
        owned_tree = service.build_tree(
            organization_id=self.organization.id,
            item_types={"tabdoc", "tabdata"},
            owned_only=True,
        )

        self.assertEqual(
            {node["resource_id"] for node in accessible_tree["roots"]},
            {str(self.doc.id), str(self.table.id)},
        )
        self.assertEqual(owned_tree["roots"], [])

        from apps.tabtinspace.routers.context_item import get_organization_knowledge_tree

        old_request = RequestFactory().get("/knowledge-tree")
        old_request.auth = self.member
        old_response = get_organization_knowledge_tree(
            old_request,
            self.organization.id,
        )
        self.assertEqual(
            {node["resource_id"] for node in old_response["data"]["roots"]},
            {str(self.doc.id), str(self.table.id)},
        )

        owned_request = RequestFactory().get(
            "/knowledge-tree",
            data={"owned_only": "true"},
        )
        owned_request.auth = self.member
        owned_response = get_organization_knowledge_tree(
            owned_request,
            self.organization.id,
        )
        self.assertEqual(owned_response["data"]["roots"], [])

    def test_file_permission_share(self):
        self.assertFalse(
            check_item_resource_permission(self.member, self.file_item, "viewer")
        )
        from uuid import UUID as _UUID

        FilePermission.objects.create(
            file_record_id=_UUID(self.file_record_id),
            subject_type="user",
            subject_id=str(self.member.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        self.assertTrue(
            check_item_resource_permission(self.member, self.file_item, "viewer")
        )
        self.assertFalse(
            check_item_resource_permission(self.member, self.file_item, "editor")
        )
        items, total = ContextItemService(user=self.member).list_items_for_organization(
            self.organization.id, item_type="tabfiles",
        )
        self.assertEqual(total, 1)

    def test_owner_capabilities_include_trash(self):
        caps = capabilities_for_role("owner", is_owner=True)
        self.assertTrue(caps["can_view"])
        self.assertTrue(caps["can_edit"])
        self.assertTrue(caps["can_trash"])
        self.assertTrue(caps["can_delete"])
        self.assertTrue(caps["can_share"])

        editor_caps = capabilities_for_role("editor")
        self.assertTrue(editor_caps["can_edit"])
        self.assertFalse(editor_caps["can_trash"])
        self.assertFalse(editor_caps["can_share"])

    def test_visibility_q_excludes_others(self):
        q = build_cloud_item_visibility_q(self.member)
        self.assertEqual(ContextItem.objects.filter(q).count(), 0)
        q_owner = build_cloud_item_visibility_q(self.owner)
        self.assertEqual(ContextItem.objects.filter(q_owner).count(), 3)

    def test_file_collaborators_list_and_shared_with_me(self):
        from apps.tabtinspace.services.tabfiles_share_service import (
            invite_file_collaborators,
            list_file_collaborators,
            list_files_shared_with_me,
            update_file_collaborator_permission,
        )

        # 兼容旧客户端仍传 editor/admin，但静态文件能力始终归一为只读。
        invite_file_collaborators(
            self.file_record_id,
            [str(self.member.id)],
            "editor",
            self.owner,
        )
        stored_permission = FilePermission.objects.get(
            file_record_id=self.file_record_id,
            subject_type="user",
            subject_id=str(self.member.id),
        )
        self.assertEqual(stored_permission.permission, "viewer")
        self.assertTrue(
            check_item_resource_permission(self.member, self.file_item, "viewer")
        )
        self.assertFalse(
            check_item_resource_permission(self.member, self.file_item, "editor")
        )

        updated = update_file_collaborator_permission(
            self.file_record_id,
            str(self.member.id),
            "admin",
            self.owner,
        )
        self.assertEqual(updated["permission"], "viewer")

        # 历史库中已存在的高角色也只能解析为静态文件 viewer 能力。
        FilePermission.objects.filter(pk=stored_permission.pk).update(permission="admin")
        effective_role = resolve_tabfiles_role(
            self.member,
            self.file_record_id,
            created_by_id=str(self.owner.id),
        )
        self.assertEqual(effective_role, "viewer")
        member_capabilities = capabilities_for_role(effective_role)
        self.assertTrue(member_capabilities["can_view"])
        unavailable_capabilities = (
            "can_edit",
            "can_move",
            "can_share",
            "can_trash",
            "can_delete",
        )
        for capability in unavailable_capabilities:
            self.assertFalse(member_capabilities[capability])

        listed = list_file_collaborators(self.file_record_id, self.owner)
        self.assertEqual(listed["owner"]["user_id"], str(self.owner.id))
        self.assertEqual(len(listed["collaborators"]), 1)
        self.assertEqual(listed["collaborators"][0]["user_id"], str(self.member.id))
        self.assertEqual(listed["collaborators"][0]["permission"], "viewer")

        shared = list_files_shared_with_me(
            self.member,
            organization_id=str(self.organization.id),
        )
        self.assertEqual(len(shared), 1)
        self.assertEqual(shared[0]["file_record_id"], self.file_record_id)
        self.assertEqual(shared[0]["space_id"], "")
        self.assertEqual(shared[0]["permission"], "viewer")

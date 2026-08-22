from __future__ import annotations

import importlib
from types import SimpleNamespace
from unittest.mock import patch

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.db import connections
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdoc.services import share_service
from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import Space, Organization, OrganizationMember
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class _OwnerSsotBase(TestCase):
    databases = {"default", "postgresql"}

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
            username="owner-ssot",
            email="owner-ssot@example.com",
            password="x",
        )
        self.alice = User.objects.create_user(
            username="owner-ssot-alice",
            email="owner-ssot-alice@example.com",
            password="x",
        )
        self.bob = User.objects.create_user(
            username="owner-ssot-bob",
            email="owner-ssot-bob@example.com",
            password="x",
        )
        for user in (self.owner, self.alice, self.bob):
            User.objects.db_manager("postgresql").create_user(
                id=user.id,
                username=user.username,
                email=user.email,
                password="x",
            )
        self.organization = Organization.objects.create(
            name="Owner SSOT Team",
            owner=self.owner,
            type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=self.alice.id,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=self.bob.id,
            role="editor",
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="Owner SSOT Space",
            type="team",
        )

    def _create_doc(self, **overrides):
        values = {
            "organization_id": self.organization.id,
            "space_id": self.space.id,
            "owner_id": self.owner.id,
            "created_by": self.owner,
            "updated_by": self.owner,
            "title": "Owner SSOT Doc",
            "description_markdown": "content",
            "description_plaintext": "content",
        }
        values.update(overrides)
        return Document.objects.create(**values)


class CreateDocumentOwnerSsotTests(_OwnerSsotBase):
    def test_create_document_writes_owner_id_and_owner_permission(self):
        service = DocumentService(user=self.owner)

        with patch.object(service, "check_space_permission", return_value=True), patch.object(
            service, "_ensure_space_context", return_value=self.space,
        ), patch.object(
            service, "_update_search_vector", return_value=None,
        ), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_create",
        ):
            document = service.create_document(
                organization_id=str(self.organization.id),
                space_id=str(self.space.id),
                parent_id=None,
                title="新文档",
                initial_content_pm_json={"type": "doc", "content": []},
                initial_content_markdown="",
                initial_content_plaintext="",
            )

        self.assertEqual(document.owner_id, self.owner.id)
        self.assertTrue(
            DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id=str(self.owner.id),
                permission="owner",
                is_active=True,
            ).exists(),
        )

    def test_owner_id_grants_permission_even_when_active_permissions_exist(self):
        doc = self._create_doc()
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.alice.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        service = DocumentService(user=self.owner)

        self.assertTrue(service.check_document_permission(doc, "admin"))
        self.assertIn(
            doc,
            list(Document.objects.filter(service._build_permission_filter_q(self.space.id))),
        )

    def test_legacy_owner_permission_is_admin_not_owner(self):
        doc = self._create_doc()
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.bob.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        service = DocumentService(user=self.bob)

        self.assertTrue(service.check_document_permission(doc, "admin"))
        self.assertFalse(service.check_document_permission(doc, "owner"))
        self.assertEqual(service.compute_user_document_role(doc), "admin")
        self.assertIn(
            doc,
            list(Document.objects.filter(service._build_permission_filter_q(self.space.id, "admin"))),
        )
        self.assertNotIn(
            doc,
            list(Document.objects.filter(service._build_permission_filter_q(self.space.id, "owner"))),
        )

    def test_owner_id_grants_owner_in_permission_filter(self):
        doc = self._create_doc()
        service = DocumentService(user=self.owner)

        self.assertIn(
            doc,
            list(Document.objects.filter(service._build_permission_filter_q(self.space.id, "owner"))),
        )

    def test_lower_document_permission_does_not_elevate_via_org(self):
        """本人已有 viewer ACL 时不抬权到 editor（与 TabData 显式授权上限一致）。"""
        doc = self._create_doc()
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.bob.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        service = DocumentService(user=self.bob)

        self.assertFalse(service.check_document_permission(doc, "editor"))
        self.assertEqual(service.compute_user_document_role(doc), "viewer")
        self.assertNotIn(
            doc,
            list(Document.objects.filter(
                service._build_permission_filter_q(
                    self.space.id, "editor", organization_id=self.organization.id,
                )
            )),
        )

    def test_cap004_owner_acl_does_not_grant_org_editor(self):
        """#6863：仅有创建者 CAP-004 owner ACL 时，组织 editor 不可隐式获得权限。"""
        doc = self._create_doc()
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        service = DocumentService(user=self.alice)

        self.assertFalse(service.check_document_permission(doc, "editor"))
        self.assertIsNone(service.compute_user_document_role(doc))
        self.assertNotIn(
            doc,
            list(Document.objects.filter(
                service._build_permission_filter_q(
                    self.space.id, "editor", organization_id=self.organization.id,
                )
            )),
        )

    def test_private_document_does_not_fallback_to_space_role(self):
        doc = self._create_doc(is_private=True)
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.bob.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        service = DocumentService(user=self.bob)

        with patch.object(service, "check_space_permission", return_value=True):
            self.assertFalse(service.check_document_permission(doc, "editor"))
            self.assertEqual(service.compute_user_document_role(doc), "viewer")
            self.assertNotIn(
                doc,
                list(Document.objects.filter(service._build_permission_filter_q(self.space.id, "editor"))),
            )


class ListCollaboratorsOwnerSsotTests(_OwnerSsotBase):
    def test_owner_card_comes_from_owner_id_and_legacy_owner_permission_is_admin(self):
        doc = self._create_doc()
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.alice.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.bob.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

        result = share_service.list_collaborators(doc.id, self.owner)

        self.assertEqual(result["owner"]["user_id"], str(self.owner.id))
        self.assertEqual(
            [collaborator["user_id"] for collaborator in result["collaborators"]],
            [str(self.alice.id), str(self.bob.id)],
        )
        self.assertEqual(
            [collaborator["permission"] for collaborator in result["collaborators"]],
            ["editor", "admin"],
        )

    def test_true_owner_cannot_be_downgraded_or_removed(self):
        doc = self._create_doc(owner_id=self.owner.id)
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

        with self.assertRaises(share_service.CollaboratorError) as update_cm:
            share_service.update_collaborator_permission(
                document_id=doc.id,
                user_id=str(self.owner.id),
                permission="viewer",
                operator=self.owner,
            )
        self.assertEqual(update_cm.exception.code, "CANNOT_MODIFY_OWNER")

        with self.assertRaises(share_service.CollaboratorError) as remove_cm:
            share_service.remove_collaborator(
                document_id=doc.id,
                user_id=str(self.owner.id),
                operator=self.owner,
            )
        self.assertEqual(remove_cm.exception.code, "CANNOT_REMOVE_OWNER")

    def test_legacy_owner_permission_can_be_downgraded_by_invite(self):
        doc = self._create_doc(owner_id=self.owner.id)
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.bob.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

        result = share_service.invite_collaborators(
            document_id=doc.id,
            user_ids=[str(self.bob.id)],
            permission="viewer",
            inviter=self.owner,
        )

        self.assertEqual(result["notified"], 1)
        self.assertEqual(result["skipped"], [])
        self.assertEqual(
            DocumentPermission.objects.get(
                document=doc,
                subject_id=str(self.bob.id),
            ).permission,
            "viewer",
        )

    def test_legacy_owner_permission_can_be_updated_and_removed(self):
        doc = self._create_doc(owner_id=self.owner.id)
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.bob.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

        result = share_service.update_collaborator_permission(
            document_id=doc.id,
            user_id=str(self.bob.id),
            permission="editor",
            operator=self.owner,
        )
        self.assertEqual(result["permission"], "editor")

        share_service.remove_collaborator(
            document_id=doc.id,
            user_id=str(self.bob.id),
            operator=self.owner,
        )
        self.assertFalse(
            DocumentPermission.objects.get(
                document=doc,
                subject_id=str(self.bob.id),
            ).is_active,
        )

    def test_owner_id_null_legacy_owner_permission_can_be_removed(self):
        doc = self._create_doc(owner_id=None)
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="admin",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.bob.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

        result = share_service.update_collaborator_permission(
            document_id=doc.id,
            user_id=str(self.bob.id),
            permission="editor",
            operator=self.owner,
        )
        self.assertEqual(result["permission"], "editor")

        share_service.remove_collaborator(
            document_id=doc.id,
            user_id=str(self.bob.id),
            operator=self.owner,
        )
        self.assertFalse(
            DocumentPermission.objects.get(
                document=doc,
                subject_id=str(self.bob.id),
            ).is_active,
        )


class BackfillDocumentOwnerIdMigrationTests(_OwnerSsotBase):
    def test_backfills_only_created_by_with_unique_owner_permission(self):
        doc = self._create_doc(owner_id=None)
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        migration = importlib.import_module(
            "apps.tabdoc.migrations.0013_backfill_document_owner_id",
        )
        schema_editor = SimpleNamespace(connection=connections["postgresql"])

        migration.backfill_document_owner_id(django_apps, schema_editor)

        doc.refresh_from_db()
        self.assertEqual(str(doc.owner_id), str(self.owner.id))

    def test_skips_multiple_active_owner_permissions(self):
        doc = self._create_doc(owner_id=None)
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.alice.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        migration = importlib.import_module(
            "apps.tabdoc.migrations.0013_backfill_document_owner_id",
        )
        schema_editor = SimpleNamespace(connection=connections["postgresql"])

        migration.backfill_document_owner_id(django_apps, schema_editor)

        doc.refresh_from_db()
        self.assertIsNone(doc.owner_id)

    def test_skips_created_by_mismatch(self):
        doc = self._create_doc(owner_id=None)
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.alice.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        migration = importlib.import_module(
            "apps.tabdoc.migrations.0013_backfill_document_owner_id",
        )
        schema_editor = SimpleNamespace(connection=connections["postgresql"])

        migration.backfill_document_owner_id(django_apps, schema_editor)

        doc.refresh_from_db()
        self.assertIsNone(doc.owner_id)

    def test_skips_without_active_owner_permission(self):
        doc = self._create_doc(owner_id=None)
        DocumentPermission.objects.create(
            document=doc,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        migration = importlib.import_module(
            "apps.tabdoc.migrations.0013_backfill_document_owner_id",
        )
        schema_editor = SimpleNamespace(connection=connections["postgresql"])

        migration.backfill_document_owner_id(django_apps, schema_editor)

        doc.refresh_from_db()
        self.assertIsNone(doc.owner_id)

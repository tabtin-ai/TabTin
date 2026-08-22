from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from ninja.errors import HttpError

from apps.tabdoc import admin_api
from apps.tabdoc.admin_api import _validate_permission_entries
from apps.tabdoc.admin_schemas import AdminDocBatchMutationRequestSchema
from apps.tabdoc.models import Document
from apps.tabtinspace.models import Space, Organization


class AdminDocApiValidationTests(SimpleTestCase):
    def test_validate_permission_entries_should_deduplicate_by_subject(self):
        entries = _validate_permission_entries(
            [
                {
                    'subject_type': 'user',
                    'subject_id': 'u-1',
                    'permission': 'viewer',
                    'is_active': True,
                },
                {
                    'subject_type': 'user',
                    'subject_id': 'u-1',
                    'permission': 'admin',
                    'is_active': False,
                },
            ]
        )

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['subject_type'], 'user')
        self.assertEqual(entries[0]['subject_id'], 'u-1')
        self.assertEqual(entries[0]['permission'], 'admin')
        self.assertFalse(entries[0]['is_active'])

    def test_validate_permission_entries_should_reject_invalid_role_subject(self):
        with self.assertRaises(HttpError):
            _validate_permission_entries(
                [
                    {
                        'subject_type': 'role',
                        'subject_id': 'guest',
                        'permission': 'viewer',
                        'is_active': True,
                    }
                ]
            )


class AdminDocTrashApiTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        User = get_user_model()
        self.staff_user = User.objects.create_user(
            username="doc_trash_admin",
            email="doc_trash_admin@test.com",
            password="pass123",
            is_staff=True,
        )
        self.organization = Organization.objects.create(name="文档逻辑删除团队", owner=self.staff_user)
        self.space = Space.objects.create(organization=self.organization, name="文档逻辑删除空间")
        self.document = Document.objects.create(
            title="待逻辑删除文档",
            organization_id=self.organization.id,
            space_id=self.space.id,
            status="active",
        )
        self.request = SimpleNamespace(auth=self.staff_user, META={}, headers={})

    def _payload(self, document_id=None):
        return AdminDocBatchMutationRequestSchema(
            document_ids=[str(document_id or self.document.id)],
            dry_run=False,
            reason="admin api trash test",
        )

    def test_batch_trash_and_untrash_document(self):
        trash_response = admin_api.batch_trash_docs(self.request, self._payload())

        self.assertEqual(trash_response.updated_count, 1)
        self.document.refresh_from_db()
        self.assertIsNotNone(self.document.trashed_at)
        self.assertEqual(self.document.status, "trashed")

        untrash_response = admin_api.batch_untrash_docs(self.request, self._payload())

        self.assertEqual(untrash_response.updated_count, 1)
        self.document.refresh_from_db()
        self.assertIsNone(self.document.trashed_at)
        self.assertEqual(self.document.status, "active")

    def test_status_restore_skips_trashed_document(self):
        admin_api.batch_trash_docs(self.request, self._payload())

        response = admin_api.batch_restore_docs(self.request, self._payload())

        self.assertEqual(response.updated_count, 0)
        self.assertEqual(response.skipped[0].reason, "文档在回收站中，请先使用回收站恢复")
        self.document.refresh_from_db()
        self.assertIsNotNone(self.document.trashed_at)

    def test_validate_permission_entries_should_reject_invalid_permission(self):
        with self.assertRaises(HttpError):
            _validate_permission_entries(
                [
                    {
                        'subject_type': 'user',
                        'subject_id': 'u-2',
                        'permission': 'owner',
                        'is_active': True,
                    }
                ]
            )
